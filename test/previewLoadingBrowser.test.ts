import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);
const entries = ['pages/a/index.tsx', 'pages/b/index.tsx', 'pages/c/index.tsx'];

/** 精确控制每个异步阶段，验证遮罩不会在接口成功但页面尚未加载时提前结束。 */
function gate() {
  let entered!: () => void;
  let release!: () => void;
  const hit = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hit,
    release,
    wait: () => {
      entered();
      return pending;
    },
  };
}

test(
  '入口切换：会话、在线编辑和冻结版本持续显示遮罩，首帧就绪或失败后结束',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 90000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
        import SessionPreviewPanel from './web/src/workspace/SessionPreviewPanel';
        import PreviewPanel from './web/src/workspace/PreviewPanel';
        import{EditWorkspaceSurface}from'./web/src/workspace/EditWorkspace';
        import './web/src/workspace/phonePreview.css';import './web/src/workspace/sessionFeedback.css';
        import './web/src/workspace/editWorkspace.css';
        const files=${JSON.stringify(entries)}.map((path,index)=>({fileId:path,path,kind:'source',revision:1,size:1,content:'export default ()=>null'}));
        const root=createRoot(document.getElementById('root'));let epoch=0;
        window.mount=mode=>flushSync(()=>root.render(<div key={++epoch}>
          {mode==='session'?<SessionPreviewPanel sessionId="source" files={files} previewRevision={0} active/>
            :mode==='version'?<PreviewPanel versionId="version" files={files} target="h5"/>
            :<EditWorkspaceSurface embedded sessionId="source" options={{detached:true}} onClose={()=>{}} onApplied={()=>{}}/>}
        </div>));window.mount('session');`,
      },
      bundle: true,
      write: false,
      outfile: '/tmp/preview-loading/app.js',
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'editor-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/CodeEditor$/ }, () => ({
              path: 'editor',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: 'export default function Editor(){return null}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const server = createServer((req, res) => {
      if (req.url === '/app.js' || req.url === '/app.css') {
        const extension = req.url.slice(4);
        res.setHeader('Content-Type', extension === '.js' ? 'text/javascript' : 'text/css');
        res.end(bundle.outputFiles.find((file) => file.path.endsWith(extension))!.text);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<link rel="stylesheet" href="/app.css"><style>body{margin:0;font-family:system-ui}.icon{width:16px;height:16px}.session-preview{height:800px}#root{padding:16px}</style><div id="root"></div><script src="/app.js"></script>',
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });

    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    let mode = 'session';
    let phase = { lookup: gate(), build: gate(), ticket: gate(), frame: gate() };
    t.after(async () => {
      Object.values(phase).forEach((item) => item.release());
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    let editEntry = entries[0];
    let editBuilding = false;
    const preview = (entryPath: string, status = 'ready') => ({
      previewId: entryPath === entries[1] ? 'pB' : 'pA',
      versionId: 'version',
      entryPath,
      fileRevision: 1,
      validatedFileRevision: 1,
      status,
      target: 'h5',
    });
    const session = (entryPath: string, status = 'ready') => ({
      current: preview(entryPath, status),
      lastReady: null,
      entries,
      fileRevision: 1,
    });
    const copy = () => ({
      editId: 'draft',
      revision: editEntry === entries[1] ? 2 : 1,
      baseFileRevision: 1,
      entryPath: editEntry,
      entries,
      target: 'h5',
      expiresAt: '2099-01-01',
      files: entries.map((path) => ({ path, content: 'export default ()=>null' })),
      preview: {
        status: editBuilding ? 'building' : 'ready',
        url: `/H5_Preview/${editEntry === entries[1] ? 'pB' : 'pA'}/token/index.html`,
      },
    });
    await page.route('**/api/d2c/**', async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const entry =
        url.searchParams.get('entryPath') || request.postDataJSON()?.entryPath || entries[0];
      let value: unknown;
      if (entry === entries[2]) {
        await route.fulfill({
          status: 500,
          json: { success: false, resultMessage: '测试入口构建失败' },
        });
        return;
      }
      if (url.pathname.endsWith('/ticket')) {
        if (url.pathname.includes('/pB/')) await phase.ticket.wait();
        value = {
          url: `/H5_Preview/${url.pathname.includes('/pB/') ? 'pB' : 'pA'}/token/index.html`,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      } else if (url.pathname.includes('/edit')) {
        if (request.method() === 'PUT') {
          await phase.lookup.wait();
          editEntry = entry;
          editBuilding = true;
        } else if (request.method() === 'GET' && editBuilding) {
          await phase.build.wait();
          editBuilding = false;
        }
        value = copy();
      } else {
        if (entry === entries[1]) {
          if (request.method() === 'POST') await phase.build.wait();
          else await phase.lookup.wait();
        }
        value =
          mode === 'version'
            ? preview(entry)
            : session(
                entry,
                entry === entries[1] && request.method() !== 'POST' ? 'building' : 'ready',
              );
      }
      await route.fulfill({ json: { success: true, data: value } });
    });
    await page.route('**/H5_Preview/**', async (route: any) => {
      const next = route.request().url().includes('/pB/');
      if (next) await phase.frame.wait();
      await route.fulfill({ contentType: 'text/html', body: `<h1>页面 ${next ? 'B' : 'A'}</h1>` });
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    for (const kind of ['session', 'version', 'editor']) {
      mode = kind;
      if (kind !== 'session')
        await page.evaluate((value: string) => (window as any).mount(value), kind);
      const currentFrame =
        kind === 'session'
          ? '当前会话浏览器预览'
          : kind === 'version'
            ? '已保存版本浏览器预览'
            : '副本浏览器预览';
      await page.locator('iframe').first().waitFor({ state: 'attached' });
      await page.waitForFunction(
        () =>
          document.querySelector('.phone-preview-shell') &&
          !document.querySelector('.phone-preview-shell')?.classList.contains('is-pending') &&
          !document.querySelector('.phone-preview-loading'),
      );
      phase = { lookup: gate(), build: gate(), ticket: gate(), frame: gate() };
      if (kind === 'session') await page.getByLabel('当前会话预览入口').selectOption(entries[1]);
      else if (kind === 'version')
        await page.locator('.version-preview-controls select').selectOption(entries[1]);
      else {
        await page.getByRole('combobox', { name: '预览入口', exact: true }).click();
        await page.locator('.ant-select-item-option').filter({ hasText: entries[1] }).click();
      }
      const overlay = page.locator('.phone-preview-loading');
      await overlay.waitFor({ state: 'visible' });
      assert.match(await overlay.innerText(), /pages\/b\/index.tsx/);
      assert.equal(await overlay.locator('.ant-spin').count(), 1);
      assert.equal(await page.locator('.phone-preview-stage').getAttribute('inert'), '');
      await phase.lookup.hit;
      assert.equal(await overlay.isVisible(), true);
      if (kind === 'session')
        await page.screenshot({ path: '/tmp/pixelprint-preview-switch-loading.png' });
      phase.lookup.release();
      if (kind !== 'version') {
        await phase.build.hit;
        assert.equal(await overlay.isVisible(), true);
        phase.build.release();
      }
      if (kind !== 'editor') {
        await phase.ticket.hit;
        assert.equal(await overlay.isVisible(), true);
        phase.ticket.release();
      }
      await phase.frame.hit;
      assert.equal(await overlay.isVisible(), true);
      if (kind === 'session') {
        assert.equal(await page.locator(`iframe[title="${currentFrame}"]`).count(), 1);
      }
      phase.frame.release();
      await overlay.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.phone-preview-stage').getAttribute('inert'), null);
      assert.equal(await page.locator('iframe').count(), 1);
      if (kind === 'session') {
        await page.getByLabel('当前会话预览入口').selectOption(entries[2]);
        await page.getByText('测试入口构建失败', { exact: true }).waitFor();
        assert.equal(await overlay.count(), 0);
      }
    }
  },
);
