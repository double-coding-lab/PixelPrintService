import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

type Route = {
  request(): { url(): string };
  fulfill(options: { json: unknown; status?: number }): Promise<void>;
};
const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

test(
  '作品库空态区分筛选与未选团队，加载/失败不报空态，工作台按钮沿用导航回调',
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
import WorksPanel from './web/src/workspace/WorksPanel';import {TeamProvider} from './web/src/workspace/TeamSettings';import './web/src/styles.css';import './web/src/workspace/works.css';
window.calls=[];window.allowLeave=false;window.opened=false;window.selected='';
createRoot(document.getElementById('root')).render(<App><TeamProvider><WorksPanel versionId="" onSelect={value=>window.selected=value} onOpenSession={(...args)=>{window.calls.push(args);if(window.allowLeave)window.opened=true}}/></TeamProvider></App>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/works-empty-test/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'unrelated-preview',
          setup(builder) {
            builder.onResolve(
              { filter: /^\.\/(CodePreview|PreviewPanel|DesignReferencePanel)$/ },
              (args) => ({ path: args.path, namespace: 'stub' }),
            );
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents: 'export default function Stub(){return null}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const server = createServer((req, res) => {
      const script = req.url === '/app.js',
        css = req.url === '/app.css';
      res.setHeader('Content-Type', script ? 'text/javascript' : css ? 'text/css' : 'text/html');
      res.end(
        script
          ? bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text
          : css
            ? bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text
            : '<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    let teamError = false,
      listError = false,
      hasTeams = true,
      hasVersions = false;
    let listGate: Promise<void> | undefined, teamGate: Promise<void> | undefined;
    const requests: string[] = [];
    await page.route('**/api/d2c/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/teams')) {
        await teamGate;
        return route.fulfill({
          status: teamError ? 503 : 200,
          json: teamError
            ? { success: false, resultMessage: '团队目录读取失败' }
            : {
                success: true,
                rows: hasTeams ? [{ teamId: 'team-a', name: '设计团队' }] : [],
                total: hasTeams ? 1 : 0,
              },
        });
      }
      if (url.pathname.endsWith('/versions')) {
        requests.push(url.search);
        await listGate;
        return route.fulfill({
          status: listError ? 503 : 200,
          json: listError
            ? { success: false, resultMessage: '版本服务读取失败' }
            : {
                success: true,
                data: {
                  rows: hasVersions
                    ? [
                        {
                          versionId: 'v1',
                          name: '真实会话版本',
                          target: 'h5',
                          createdAt: '2026-11-26T00:00:00Z',
                          createdEid: null,
                          createdUserId: null,
                          creatorName: '作者',
                          validationSummary: null,
                        },
                      ]
                    : [],
                  total: hasVersions ? 1 : 0,
                  page: 1,
                  pageSize: 12,
                },
              },
        });
      }
      return route.fulfill({ json: { success: true, data: {}, rows: [], total: 0 } });
    });
    let releaseList!: () => void;
    listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const port = (server.address() as { port: number }).port;
    await page.goto(`http://127.0.0.1:${port}/works`);
    const empty = page.getByRole('status', { name: '作品库空态' });
    await page.getByRole('status', { name: '正在加载作品' }).waitFor();
    assert.equal(await empty.count(), 0);
    releaseList();
    listGate = undefined;
    await empty.getByRole('heading', { name: '还没有暂存的版本' }).waitFor();
    assert.ok((await empty.innerText()).includes('暂存版本'));
    const before = page.url();
    await empty.getByRole('button', { name: '前往工作台' }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).calls), [['', '']]);
    assert.equal(await page.evaluate(() => (window as any).opened), false);
    assert.equal(page.url(), before);
    await page.evaluate(() => {
      (window as any).allowLeave = true;
    });
    await empty.getByRole('button', { name: '前往工作台' }).click();
    assert.equal(await page.evaluate(() => (window as any).opened), true);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const box = await page.locator('.works-empty-card').boundingBox();
      assert.ok(box && Math.abs(box.x + box.width / 2 - width / 2) < 2, '卡片水平居中');
      assert.ok(box!.x >= 0 && box!.x + box!.width <= width);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.ant-segmented-item').filter({ hasText: '全部版本' }).click();
    await empty.getByRole('heading', { name: '作品库暂无会话版本' }).waitFor();
    await page.locator('.ant-segmented-item').filter({ hasText: '团队版本' }).click();
    await empty.getByRole('heading', { name: '该团队暂无会话版本' }).waitFor();
    assert.ok(
      requests.some((query) => query.includes('scope=team') && query.includes('teamId=team-a')),
    );
    await page.locator('.works-team-select').hover();
    await page.locator('.works-team-select .ant-select-clear').click();
    await empty.getByRole('heading', { name: '先选择一个团队' }).waitFor();
    assert.ok((await empty.innerText()).includes('在上方选择团队'));
    assert.ok(
      !requests.some((query) => query.includes('scope=team') && !query.includes('teamId=team-a')),
    );

    hasTeams = false;
    await page.reload();
    await empty.waitFor();
    await page.locator('.ant-segmented-item').filter({ hasText: '团队版本' }).click();
    await empty.getByRole('heading', { name: '先选择一个团队' }).waitFor();
    assert.ok((await empty.innerText()).includes('加入或创建团队'));

    listError = true;
    await page.reload();
    await page.getByText('版本服务读取失败', { exact: true }).waitFor();
    assert.equal(await empty.count(), 0);
    listError = false;
    teamError = true;
    await page.reload();
    await page.getByText('团队目录读取失败', { exact: true }).waitFor();
    assert.equal(await empty.count(), 0);
    teamError = false;
    let releaseTeams!: () => void;
    teamGate = new Promise<void>((resolve) => {
      releaseTeams = resolve;
    });
    await page.reload();
    await page.getByRole('status', { name: '正在加载作品' }).waitFor();
    assert.equal(await empty.count(), 0);
    releaseTeams();
    teamGate = undefined;
    await empty.waitFor();
    hasVersions = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('link', { name: '真实会话版本', exact: true }).waitFor();
    assert.equal(await empty.count(), 0);
    await page.getByRole('link', { name: '真实会话版本', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).selected), 'v1');
    assert.deepEqual(errors, []);
  },
);
