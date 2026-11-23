import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright =
  process.env.PIXELPRINT_PLAYWRIGHT_MODULE ??
  fileURLToPath(
    new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
  );

/** 真实组件配隔离接口验证确认、冲突及默认入口；不删除任何业务数据。 */
test(
  '作品删除确认和失败保留，多入口默认首页且尊重手动选择',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 60000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
      import WorksPanel from './web/src/workspace/WorksPanel';
      import CommunityPanel from './web/src/workspace/CommunityPanel';
      import PreviewPanel from './web/src/workspace/PreviewPanel';
      import {TeamProvider} from './web/src/workspace/TeamSettings';
      import './web/src/styles.css';import './web/src/workspace/works.css';
      const app=createRoot(document.getElementById('root'));
      window.selected=null;
      window.mount=(kind='versions',resourceId='',paths)=>app.render(<App><TeamProvider>{kind==='preview'
        ? <PreviewPanel key="preview" versionId="owned" target="h5" files={(paths||['pages/page/blocks/card/index.tsx','pages/page/index.tsx']).map(path=>({fileId:path,path,kind:'source',revision:1,size:10}))}/>
        : kind==='saved' ? <CommunityPanel key="saved" kind="my-works" resourceId={resourceId} onSelect={id=>window.selected=id}/>
        : <WorksPanel key="versions" versionId={resourceId} onSelect={id=>window.selected=id}/>
      }</TeamProvider></App>);window.mount();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/library-management/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolate-editors',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/(?:EditWorkspace|CodePreview)$/ }, () => ({
              path: 'editor',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `import React from 'react'; export default function Editor({onSaved}){return <button onClick={async()=>{const response=await fetch('/fixture/save',{method:'POST'});if(response.ok)onSaved?.()}}>模拟保存作品</button>};export function EditWorkspaceSurface(){return null}`,
              loader: 'jsx',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    let versions = [
      { versionId: 'owned', name: '本人版本', canDelete: true },
      { versionId: 'foreign', name: '他人版本', canDelete: false },
    ];
    let workRevision = 1;
    let saved = true;
    let extraWorks = 0;
    let failSave = false;
    let workReads = 0;
    let rejectDelete = false;
    const mutations: { path: string; body: any; csrf: string | undefined }[] = [];
    const reads: string[] = [];
    const previewBodies: string[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/app.js' || url.pathname === '/app.css') {
        res.setHeader('Content-Type', url.pathname.endsWith('js') ? 'text/javascript' : 'text/css');
        res.end(
          bundle.outputFiles.find((file) => file.path.endsWith(url.pathname.slice(-3)))!.text,
        );
        return;
      }
      const send = (data: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data }));
      };
      const version = (row: (typeof versions)[number]) => ({
        ...row,
        target: 'h5',
        status: 'ready',
        createdUserId: 'owner',
        creatorName: '作者',
        createdAt: '2026-11-23T01:00:00Z',
        sourceFileRevision: 1,
        validationSummary: { status: 'passed' },
        files: [],
      });
      const work = () => ({
        workId: 'work',
        name: '本人作品',
        target: 'h5',
        revision: workRevision,
        canManage: true,
      });
      if (url.pathname === '/fixture/save' && req.method === 'POST') {
        if (failSave) {
          res.statusCode = 503;
          res.end();
          return;
        }
        workRevision += 1;
        return send(work());
      }
      if (req.method === 'DELETE') {
        let text = '';
        for await (const chunk of req) text += chunk;
        mutations.push({
          path: url.pathname,
          body: text ? JSON.parse(text) : null,
          csrf: req.headers['x-requested-with'] as string | undefined,
        });
        if (rejectDelete) {
          res.statusCode = 409;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({ success: false, resultMessage: '个人作品已更新，请刷新后重试' }),
          );
          return;
        }
        if (url.pathname.endsWith('/work')) saved = false;
        else versions = versions.filter((row) => !url.pathname.endsWith('/' + row.versionId));
        return send({ deleted: true });
      }
      if (url.pathname === '/api/d2c/versions') {
        const page = Number(url.searchParams.get('page') || 1);
        return send({
          rows: versions.slice((page - 1) * 12, page * 12).map(version),
          total: versions.length,
          page,
          pageSize: 12,
        });
      }
      if (url.pathname === '/api/d2c/versions/owned')
        return send(version({ versionId: 'owned', name: '本人版本', canDelete: true }));
      if (url.pathname === '/api/d2c/my-works') {
        const page = Number(url.searchParams.get('page') || 1);
        const items = [
          ...Array.from({ length: extraWorks }, (_, n) => ({
            ...work(),
            workId: `keep-${n}`,
            name: `已保存${n}`,
          })),
          ...(saved ? [work()] : []),
        ];
        return send({
          items: items.slice((page - 1) * 12, page * 12),
          total: items.length,
          page,
          pageSize: 12,
        });
      }
      if (url.pathname === '/api/d2c/my-works/work') {
        workReads++;
        return send(work());
      }
      if (url.pathname.endsWith('/previews')) {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const { entryPath } = JSON.parse(body);
          previewBodies.push(entryPath);
          return send({
            previewId: 'preview',
            versionId: 'owned',
            status: 'failed',
            target: 'h5',
            entryPath,
          });
        }
        reads.push(url.searchParams.get('entryPath') || '');
        return send(null);
      }
      if (url.pathname === '/api/d2c/teams') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, rows: [], total: 0 }));
        return;
      }
      if (url.pathname.startsWith('/api/')) return send({ rows: [], total: 0 });
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<html><head><link rel="stylesheet" href="/app.css"/></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const owned = page.getByRole('button', { name: '删除会话版本：本人版本', exact: true });
    await owned.waitFor();
    assert.equal(await page.getByRole('button', { name: '删除会话版本：他人版本' }).count(), 0);
    await owned.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(mutations.length, 0);
    await owned.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await owned.waitFor({ state: 'hidden' });
    await page.getByText('他人版本', { exact: true }).waitFor();
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].csrf, 'PixelPrint');
    await page.evaluate(() => (window as any).mount('saved'));
    const removeWork = page.getByRole('button', { name: '删除作品：本人作品', exact: true });
    await removeWork.waitFor();
    rejectDelete = true;
    workRevision = 2;
    await removeWork.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await page.getByRole('alert').getByText('个人作品已更新，请刷新后重试').waitFor();
    assert.equal(mutations.at(-1)!.body.expectedRevision, 1);
    assert.equal(saved, true);
    await page.getByRole('alert').getByRole('button', { name: '刷新', exact: true }).click();
    await removeWork.waitFor();
    rejectDelete = false;
    await removeWork.click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await removeWork.waitFor({ state: 'hidden' });
    await page.getByText(/暂无已保存作品/).waitFor();
    assert.equal(mutations.at(-1)!.body.expectedRevision, 2);
    await page.evaluate(() => (window as any).mount('versions', 'owned'));
    await page.getByRole('button', { name: '删除会话版本：本人版本' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await page.waitForFunction(() => (window as any).selected === '');
    await page.evaluate(() => (window as any).mount('preview'));
    const select = page.locator('.version-preview-panel select');
    await select.waitFor();
    assert.equal(await select.inputValue(), 'pages/page/index.tsx');
    await select.selectOption('pages/page/blocks/card/index.tsx');
    await page.evaluate(() =>
      (window as any).mount('preview', '', [
        'pages/page/index.tsx',
        'pages/page/blocks/card/index.tsx',
      ]),
    );
    assert.equal(await select.inputValue(), 'pages/page/blocks/card/index.tsx');
    await page.getByRole('button', { name: '生成预览', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent?.includes('预览生成失败'));
    assert.deepEqual(previewBodies, ['pages/page/blocks/card/index.tsx']);
    await page.evaluate(() => (window as any).mount('preview', '', ['pages/page/index.tsx']));
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLSelectElement>('.version-preview-panel select')?.value ===
        'pages/page/index.tsx',
    );
    assert.ok(reads.includes('pages/page/index.tsx'));
    assert.ok(reads.includes('pages/page/blocks/card/index.tsx'));
    versions = [
      ...Array.from({ length: 12 }, (_, n) => ({
        versionId: `v${n}`,
        name: `版本${n}`,
        canDelete: false,
      })),
      { versionId: 'owned', name: '本人版本', canDelete: true },
    ];
    await page.evaluate(() => (window as any).mount('versions'));
    await page.locator('.ant-pagination-item-2').click();
    await page.getByRole('button', { name: '删除会话版本：本人版本' }).waitFor();
    await page.evaluate(() => {
      (window as any).selected = null;
      (window as any).mount('versions', 'owned');
    });
    await page.getByRole('button', { name: '删除会话版本：本人版本' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await page.waitForFunction(() => (window as any).selected === '');
    await page.evaluate(() => (window as any).mount('versions'));
    await page.getByText('版本0', { exact: true }).waitFor();
    assert.equal(await page.locator('.ant-pagination').count(), 0);
    saved = true;
    extraWorks = 12;
    await page.evaluate(() => (window as any).mount('saved'));
    await page.locator('.ant-pagination-item-2').click();
    await page.getByRole('button', { name: '删除作品：本人作品', exact: true }).waitFor();
    await page.evaluate(() => {
      (window as any).selected = null;
      (window as any).mount('saved', 'work');
    });
    await page.getByRole('button', { name: '模拟保存作品', exact: true }).waitFor();
    failSave = true;
    const beforeFailed = workReads;
    const failedResponse = page.waitForResponse((response) =>
      response.url().endsWith('/fixture/save'),
    );
    await page.getByRole('button', { name: '模拟保存作品', exact: true }).click();
    await failedResponse;
    assert.equal(workReads, beforeFailed, 'failed save must not refresh the parent revision');
    failSave = false;
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith('/api/d2c/my-works/work'),
    );
    await page.getByRole('button', { name: '模拟保存作品', exact: true }).click();
    await refreshed;
    await page.getByRole('button', { name: '删除作品：本人作品', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /删\s*除/ })
      .click();
    await page.waitForFunction(() => (window as any).selected === '');
    assert.equal(mutations.at(-1)!.body.expectedRevision, workRevision);
    assert.equal(workRevision, 3);
    await page.evaluate(() => (window as any).mount('saved'));
    await page.getByRole('button', { name: '已保存0', exact: true }).waitFor();
    assert.equal(await page.locator('.ant-pagination').count(), 0);
    assert.deepEqual(errors, []);
  },
);
