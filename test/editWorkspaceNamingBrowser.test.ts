import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

/** 保留真实 Surface、控制器和 AntD；仅用 textarea 替代 Monaco 的编辑器基础设施。 */
test(
  '保存作品命名：默认名、取消保留草稿、IME、失败重试、互斥和已有作品名称',
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
        contents: `import React from 'react';import{createRoot}from'react-dom/client';
          import {EditWorkspaceSurface} from './web/src/workspace/EditWorkspace';
          import './web/src/styles.css';import './web/src/workspace/editWorkspace.css';
          const root=createRoot(document.getElementById('root'));
          window.saved=0;window.closeCount=0;window.dirty=false;
          window.mount=(existing=false)=>root.render(<EditWorkspaceSurface key={String(existing)} embedded sessionId="source" sourceName={existing?'已有作品 · 1118':'广场作品'} options={{detached:true,root:existing?'/my-works/work/edit':'/plaza/sessions/source/edit'}} onApplied={()=>{}} onClose={()=>window.closeCount++} onSaved={()=>window.saved++} onDirty={value=>window.dirty=value}/>);
          window.mount();`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/edit-workspace-naming/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolate-monaco',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/CodeEditor$/ }, () => ({
              path: 'editor',
              namespace: 'naming-fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'naming-fixture' }, () => ({
              contents: `import React from 'react';export default function Editor({files,path,onChange,readOnly}){return <textarea aria-label="副本正文" readOnly={readOnly} value={files.find(f=>f.path===path)?.content??''} onChange={e=>onChange(path,e.target.value)}/>}`,
              loader: 'tsx',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const js = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text;
    const writes: { path: string; body: any }[] = [];
    let fail = false;
    let releaseSave: (() => void) | undefined;
    let onSaveHeld = () => {};
    let hold = false;
    let copy = {
      editId: 'draft',
      revision: 1,
      baseFileRevision: 1,
      files: [{ path: 'src/App.tsx', content: 'original' }],
      entries: ['src/App.tsx'],
      entryPath: 'src/App.tsx',
      target: 'h5',
      expiresAt: '2099-01-01',
      preview: { status: 'idle' },
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(js);
        return;
      }
      if (!url.pathname.startsWith('/api/d2c/')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<style>${css}</style><div id="root"></div><script src="/app.js"></script>`);
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const save = url.pathname.endsWith('/save');
      if (save || req.method === 'PUT') writes.push({ path: url.pathname, body });
      if (req.method === 'PUT') copy = { ...copy, files: body.files, revision: copy.revision + 1 };
      if (save && hold) {
        const waiting = new Promise<void>((done) => (releaseSave = done));
        onSaveHeld();
        await waiting;
      }
      res.setHeader('Content-Type', 'application/json');
      if (save && fail) {
        res.statusCode = 503;
        res.end(JSON.stringify({ success: false, resultMessage: '暂时保存失败，请重试' }));
      } else {
        res.end(
          JSON.stringify({
            success: true,
            data: save
              ? { workId: 'work', name: body.name, revision: 2, target: 'h5', createdAt: '' }
              : copy,
          }),
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      releaseSave?.();
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const draft = page.getByRole('textbox', { name: '副本正文' });
    await draft.waitFor();
    assert.equal(await page.evaluate(() => (window as any).dirty), false);
    const open = page.locator('.edit-workspace-footer button').filter({ hasText: /^保存为作品$/ });
    const dialog = page.getByRole('dialog', { name: '保存为作品', exact: true });
    const input = dialog.getByRole('textbox', { name: '作品名称' });
    const confirm = dialog.getByRole('button', { name: /保存作品/ });
    await open.click();
    await page.waitForFunction(() => (window as any).dirty === true);
    const expected = await page.evaluate(() => {
      const now = new Date();
      return `广场作品 · ${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    });
    assert.equal(await input.inputValue(), expected);
    assert.equal(await input.getAttribute('maxlength'), '200');
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => (window as any).dirty === false);
    await draft.fill('保留这份草稿');
    await open.click();
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0);
    assert.equal(await draft.inputValue(), '保留这份草稿');
    await open.click();
    await input.fill('   ');
    await confirm.click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(writes.length, 0);
    await input.fill('  自定义中文作品  ');
    for (const event of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ]) {
      await input.dispatchEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        ...event,
      });
      await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
      // 等过一个事件循环，确保事件处理产生的异步请求有机会暴露。
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 40)));
      assert.equal(writes.length, 0);
    }
    fail = true;
    await input.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: '暂时保存失败' }).waitFor();
    assert.equal(await input.inputValue(), '  自定义中文作品  ');
    assert.equal(await draft.inputValue(), '保留这份草稿');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].body.name, '自定义中文作品');
    assert.equal(await page.evaluate(() => (window as any).saved), 0);
    fail = false;
    hold = true;
    const saveHeld = new Promise<void>((done) => (onSaveHeld = done));
    await confirm.click();
    await saveHeld;
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('#edit-work-name')?.disabled,
    );
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: /取\s*消/ }).isDisabled(), true);
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      keyCode: 13,
    });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).closeCount === 0);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(writes.length, 3);
    assert.equal(writes[2].body.name, '自定义中文作品');
    assert.ok(releaseSave);
    releaseSave();
    hold = false;
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => (window as any).saved), 1);
    await open.click();
    assert.equal(await input.inputValue(), '自定义中文作品');
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(() => (window as any).mount(true));
    await open.click();
    assert.equal(await input.inputValue(), '已有作品 · 1118');
    const screenshot = `/tmp/edit-workspace-naming-${process.pid}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    t.diagnostic(`命名界面截图：${screenshot}`);
    await input.fill('已有作品重命名');
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes.at(-1)?.path, '/api/d2c/my-works/work/edit/draft/save');
    assert.equal(writes.at(-1)?.body.name, '已有作品重命名');
    assert.equal(await page.evaluate(() => (window as any).saved), 2);
    assert.deepEqual(errors, []);
  },
);
