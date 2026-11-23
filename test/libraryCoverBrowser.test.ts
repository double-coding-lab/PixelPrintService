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

/** 真实列表组件与样式配受控API，验证两种列表、坏图回退和键盘导航；不连接业务服务。 */
test(
  '作品库两类列表显示封面，空图/坏图安全回退，窄屏和键盘可操作',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 60000,
  },
  async (t) => {
    const result = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';
        import WorksPanel from './web/src/workspace/WorksPanel';
        import CommunityPanel from './web/src/workspace/CommunityPanel';
        import {TeamProvider} from './web/src/workspace/TeamSettings';
        import './web/src/styles.css';import './web/src/workspace/works.css';
        const app=createRoot(document.getElementById('root'));
        window.selected=null;
        window.mount=(saved=false)=>app.render(<TeamProvider>{saved
          ? <CommunityPanel key="saved" kind="my-works" resourceId="" onSelect={id=>window.selected=id}/>
          : <WorksPanel key="versions" versionId="" onSelect={id=>window.selected=id}/>
        }</TeamProvider>);window.mount();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/library-cover-browser/app.js',
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
              contents:
                'export default function Editor(){return null};export function EditWorkspaceSurface(){return null}',
              loader: 'js',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const js = result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = result.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://local');
      requests.push(url.pathname);
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(js);
        return;
      }
      if (url.pathname === '/app.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(css);
        return;
      }
      if (url.pathname === '/cover.svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="750" height="1500"><rect width="750" height="1500" fill="#edf2ff"/><rect x="40" y="50" width="670" height="250" rx="24" fill="#7595dc"/><rect x="40" y="340" width="320" height="400" rx="16" fill="#fff"/><rect x="390" y="340" width="320" height="400" rx="16" fill="#fff"/></svg>',
        );
        return;
      }
      const send = (data: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data }));
      };
      const versions = [
        { versionId: 'one', name: '有图版本', coverUrl: '/cover.svg' },
        { versionId: 'none', name: '无图版本', coverUrl: null },
        { versionId: 'broken', name: '坏图版本', coverUrl: '/missing.png' },
        { versionId: 'unsafe', name: '危险地址', coverUrl: 'javascript:window.injected=true' },
      ].map((item) => ({
        ...item,
        target: 'h5',
        status: 'ready',
        sourceFileRevision: 2,
        createdUserId: null,
        creatorName: '演示作者',
        createdAt: '2026-11-23T01:00:00Z',
        validationSummary: { status: 'passed' },
      }));
      if (url.pathname === '/api/d2c/versions')
        return send({ rows: versions, total: 4, page: 1, pageSize: 12 });
      if (url.pathname === '/api/d2c/my-works')
        return send({
          items: versions.map((item) => ({
            ...item,
            workId: item.versionId,
            name: item.name.replace('版本', '作品'),
            revision: 1,
          })),
          total: 4,
          page: 1,
          pageSize: 12,
        });
      if (url.pathname === '/api/d2c/teams') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, rows: [], total: 0 }));
        return;
      }
      if (url.pathname.startsWith('/api/')) return send({ rows: [], total: 0 });
      if (url.pathname === '/missing.png') {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/><link rel="stylesheet" href="/app.css"/></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
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
    for (const saved of [false, true]) {
      if (saved)
        await page.evaluate(() => {
          (window as any).mount(true);
        });
      const name = saved ? '有图作品' : '有图版本';
      const cover = page.getByRole('button', { name: `打开作品：${name}`, exact: true });
      await cover.locator('img').waitFor();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('.work-cover img')).every(
          (img) => (img as HTMLImageElement).complete,
        ),
      );
      await page
        .getByRole('button', { name: `打开作品：${saved ? '坏图作品' : '坏图版本'}`, exact: true })
        .getByText('暂无作品图片')
        .waitFor();
      assert.equal(await page.getByText('暂无作品图片', { exact: true }).count(), 3);
      assert.equal(await cover.locator('img').getAttribute('loading'), 'lazy');
      assert.equal(await cover.locator('img').getAttribute('alt'), `${name}作品图片`);
      assert.equal(
        await cover.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
        true,
      );
      assert.equal(await page.getByRole('alert').count(), 0);
      const imageBounds = await cover.boundingBox();
      const bodyBounds = await cover
        .locator('xpath=ancestor::article[1]')
        .locator('.work-card-body')
        .boundingBox();
      assert.ok(imageBounds && bodyBounds && imageBounds.x >= bodyBounds.x + bodyBounds.width);
      const imageSize = await cover.locator('img').boundingBox();
      assert.ok(imageSize && Math.abs(imageSize.height / imageSize.width - 2) < 0.02);
      const scroller = cover.locator('.work-cover-image');
      assert.equal(
        await scroller.evaluate((node: HTMLElement) => node.scrollHeight > node.clientHeight),
        true,
      );
      await scroller.hover();
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('.work-cover-image')).some(
          (node) => node.scrollTop > 0,
        ),
      );
      await page.screenshot({ path: `/tmp/library-cover-${saved ? 'saved' : 'versions'}.png` });
      await page.evaluate(() => {
        (window as any).selected = null;
      });
      await cover.focus();
      await page.keyboard.press('Home');
      assert.equal(await scroller.evaluate((node: HTMLElement) => node.scrollTop), 0);
      await page.keyboard.press('ArrowDown');
      assert.ok(await scroller.evaluate((node: HTMLElement) => node.scrollTop > 0));
      assert.equal(await page.evaluate(() => (window as any).selected), null);
      await page.keyboard.press('End');
      assert.ok(
        await scroller.evaluate(
          (node: HTMLElement) => node.scrollTop >= node.scrollHeight - node.clientHeight - 1,
        ),
      );
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => (window as any).selected), 'one');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.screenshot({
        path: `/tmp/library-cover-${saved ? 'saved' : 'versions'}-mobile.png`,
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => (window as any).injected), undefined);
    assert.ok(
      !requests.some((path) => /\/versions\/|\/my-works\//.test(path)),
      '封面不逐个请求详情或创建预览',
    );
  },
);
