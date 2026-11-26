import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

type BrowserRoute = {
  request(): {
    url(): string;
    method(): string;
    postDataJSON(): { content: string; mode?: string };
  };
  fulfill(options: { json: unknown; status?: number }): Promise<void>;
};
type BrowserResponse = { url(): string; request(): { method(): string } };

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

test(
  '创建释放busy后进入；聊天草稿身份隔离、刷新恢复及发送/队列/引导结算',
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
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {App} from 'antd';
import WorkspacePanel from './web/src/workspace/WorkspacePanel';import {TeamProvider} from './web/src/workspace/TeamSettings';
window.busy=false;window.selected=[];
function Harness(){const [session,setSession]=useState('session-a');const [visible,setVisible]=useState(true);const [busy,setBusy]=useState(false);
window.switchSession=setSession;window.setVisible=setVisible;
const changeBusy=value=>{window.busy=value;setBusy(value)};
return <App><TeamProvider><button onClick={()=>setVisible(!visible)}>离开或返回</button>{visible&&<WorkspacePanel workspaceId="workspace-a" sessionId={session} blocked={busy} onDirty={()=>{}} onBusy={changeBusy} onDeleted={()=>{}} onSelect={id=>{window.selected.push({id,busy:window.busy});if(!window.busy)setSession(id)}}/>}</TeamProvider></App>}
createRoot(document.getElementById('root')).render(<Harness/>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'unrelated-panels',
          setup(build) {
            build.onResolve(
              {
                filter:
                  /^\.\/(FilesPanel|SessionSharing|SessionCaptainPanel|DiagnosticsPanel|ExecutionProgress)$/,
              },
              (args) => ({ path: args.path, namespace: 'stub' }),
            );
            build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
              contents: 'export default function Stub(){return null}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
      res.end(
        req.url === '/app.js'
          ? bundle.outputFiles[0].text
          : '<div id="root"></div><script src="/app.js"></script>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('disableDraftStorage'))
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('storage disabled');
          },
        });
      (window as any).EventSource = class {
        static CLOSED = 2;
        addEventListener() {}
        close() {}
      };
    });
    let actor = 'alice',
      running = false,
      failure = false,
      createFailure = false;
    let identityGate: Promise<void> | undefined;
    let identityFailure = false;
    let release: (() => void) | undefined;
    let hold = false;
    const sent: { path: string; content: string; mode?: string }[] = [];
    const session = (sessionId: string) => ({
      sessionId,
      workspaceId: 'workspace-a',
      name: sessionId,
      target: 'h5',
      status: 'active',
      latestTimelineSeq: 0,
      activeRunId: running ? 'run-a' : null,
      activeRunStatus: running ? 'running' : null,
    });
    await page.route('**/auth/me', async (route: BrowserRoute) => {
      await identityGate;
      return route.fulfill({ status: identityFailure ? 503 : 200, json: { userId: actor } });
    });
    await page.route('**/api/d2c/**', async (route: BrowserRoute) => {
      const url = new URL(route.request().url()),
        path = url.pathname.replace('/api/d2c', '');
      let data: unknown = {};
      if (path === '/users/me') {
        await identityGate;
        if (identityFailure) return route.fulfill({ status: 503, json: { success: false } });
        data = { eid: actor };
      } else if (path === '/credentials/figma/status')
        data = { configured: true, credentialId: 'credential-secret-never-cached' };
      else if (path === '/teams')
        return route.fulfill({ json: { success: true, rows: [], total: 0 } });
      else if (path === '/workspaces/workspace-a')
        data = { workspaceId: 'workspace-a', name: '工作区', status: 'ready', isOwner: true };
      else if (path === '/workspaces/workspace-a/sessions') {
        if (route.request().method() === 'POST') {
          if (createFailure)
            return route.fulfill({
              status: 500,
              json: { success: false, resultMessage: '创建失败' },
            });
          data = session('session-new');
        } else
          return route.fulfill({
            json: { success: true, rows: [session('session-a'), session('session-b')], total: 2 },
          });
      } else if (/\/sessions\/[^/]+$/.test(path)) data = session(path.split('/')[2]);
      else if (path.endsWith('/timeline')) data = { entries: [], hasMore: false, nextSeq: 0 };
      else if (
        path.endsWith('/messages') ||
        (path.endsWith('/message-queue') && route.request().method() === 'POST')
      ) {
        sent.push({ path, ...route.request().postDataJSON() });
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (failure)
          return route.fulfill({
            status: 503,
            json: { success: false, resultMessage: '发送失败保留草稿' },
          });
        data = { runId: 'run-a', status: 'queued' };
      } else if (path.endsWith('/message-queue')) data = { items: [] };
      return route.fulfill({ json: { success: true, data } });
    });
    const port = (server.address() as { port: number }).port;
    await page.goto(`http://127.0.0.1:${port}`);
    const input = page.getByRole('textbox', { name: '给 Agent 的消息', exact: true });
    await input.waitFor();
    await input.fill('会话A草稿');
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => key.includes('alice')),
    );
    await page.evaluate(() => (window as any).switchSession('session-b'));
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    await input.fill('会话B草稿');
    await page.evaluate(() => (window as any).switchSession('session-a'));
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '会话A草稿',
    );
    await page.reload();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '会话A草稿',
    );
    actor = 'bob';
    await page.reload();
    await input.waitFor();
    await input.fill('Bob草稿');
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.includes('bob')));
    actor = 'alice';
    await page.reload();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '会话A草稿',
    );

    failure = true;
    await input.press('Enter');
    await page.getByText('发送失败保留草稿', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '会话A草稿');
    await page.reload();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '会话A草稿',
    );
    failure = false;
    await input.press('Enter');
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '',
    );
    assert.ok(sent.at(-1)!.path.endsWith('/messages'));

    running = true;
    await page.reload();
    await input.waitFor();
    for (const mode of ['queue', 'guidance']) {
      await input.fill(mode + '正文');
      failure = true;
      if (mode === 'queue') await input.press('Enter');
      else await page.getByRole('button', { name: '立即引导', exact: true }).click();
      await page.getByText('发送失败保留草稿', { exact: true }).first().waitFor();
      assert.equal(await input.inputValue(), mode + '正文');
      failure = false;
      if (mode === 'queue') await input.press('Enter');
      else await page.getByRole('button', { name: '立即引导', exact: true }).click();
      await page.waitForFunction(
        () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '',
      );
      assert.equal(sent.at(-1)!.mode, mode);
      assert.ok(sent.at(-1)!.path.endsWith('/message-queue'));
    }

    hold = true;
    await input.fill('晚到结果原文');
    await input.press('Enter');
    await page.waitForFunction(() => (window as any).busy);
    await page.evaluate(() => (window as any).setVisible(false));
    await page.evaluate(() => (window as any).setVisible(true));
    await input.waitFor();
    await input.fill('后来的新输入');
    assert.ok(release);
    const delivered = page.waitForResponse(
      (response: BrowserResponse) =>
        response.url().includes('/message-queue') && response.request().method() === 'POST',
    );
    release!();
    hold = false;
    await delivered;
    assert.equal(await input.inputValue(), '后来的新输入');
    await page.reload();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '后来的新输入',
    );

    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    createFailure = true;
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.getByText('创建失败', { exact: true }).first().waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).selected), []);
    createFailure = false;
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await page.waitForFunction(() => (window as any).selected.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).selected), [
      { id: 'session-new', busy: false },
    ]);
    assert.equal(await input.inputValue(), '');
    const cache = await page.evaluate(() => Object.values(localStorage).join(''));
    assert.ok(!cache.includes('credential-secret-never-cached'));
    // 身份慢于会话加载：输入不等待身份，身份返回后写入本人作用域。
    actor = 'charlie';
    let identify!: () => void;
    identityGate = new Promise<void>((resolve) => {
      identify = resolve;
    });
    await page.reload();
    await input.waitFor();
    await input.fill('身份延迟时的新输入');
    identify();
    identityGate = undefined;
    await page.waitForFunction(() =>
      Object.keys(localStorage).some((key) => key.includes('charlie')),
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '身份延迟时的新输入',
    );
    identityFailure = true;
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), '');
    await input.fill('身份失败仍可编辑');
    assert.ok(
      !(await page.evaluate(() => Object.values(localStorage).join(''))).includes(
        '身份失败仍可编辑',
      ),
    );
    identityFailure = false;
    await page.evaluate(() => sessionStorage.setItem('disableDraftStorage', '1'));
    await page.reload();
    await input.waitFor();
    await input.fill('禁用存储仍可编辑发送');
    await input.press('Enter');
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value === '',
    );
    assert.equal(sent.at(-1)!.content, '禁用存储仍可编辑发送');
    assert.deepEqual(errors, []);
  },
);
