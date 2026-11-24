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
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

/** 复用离线 browser fixture：真实广场、编辑控制器、凭据、弹窗及路径导航，仅替换 Monaco。 */
test(
  '公仓广场创建分支：本人双凭据、全部分页、草稿保护与通用组件 Figma 模式',
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
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import{App}from'antd';
          import CommunityPanel from './web/src/workspace/CommunityPanel';
          import CredentialSettings from './web/src/workspace/CredentialSettings';
          import ModelCredentialSettings from './web/src/workspace/ModelCredentialSettings';
          import ForkSession from './web/src/workspace/ForkSession';
          import{createAppHistory,readAppRoute}from'./web/src/workspace/appRoutes';
          import './web/src/styles.css';import './web/src/workspace/works.css';
          function Fixture(){
            const [figmaOnly]=React.useState(()=>new URLSearchParams(location.search).has('figmaOnly'));
            const [route,setRoute]=React.useState(()=>readAppRoute(new URL(location.href)));
            const [dirty,setDirty]=React.useState(false);const [busy,setBusy]=React.useState(false);
            const guard=React.useRef({dirty,busy});guard.current={dirty,busy};
            window.guard=guard.current;window.busyEvents??=[];window.openEvents??=[];window.confirmations??=0;
            const navigation=React.useRef(null);
            React.useEffect(()=>{navigation.current=createAppHistory(window,{
              isBlocked:()=>guard.current.dirty||guard.current.busy,
              canLeave:async()=>{if(guard.current.busy)return false;if(guard.current.dirty){window.confirmations++;return false;}return true;},
              onRoute:next=>{setRoute(next);setDirty(false);}
            });return()=>navigation.current.dispose();},[]);
            const changeBusy=React.useCallback(value=>{window.busyEvents.push(value);setBusy(value);},[]);
            const open=React.useCallback((workspaceId,sessionId)=>{
              window.openEvents.push({workspaceId,sessionId,busy:guard.current.busy,dirty:guard.current.dirty});
              void navigation.current.navigate({view:'workbench',workspaceId,sessionId});
            },[]);
            return <><header className="app-header"><CredentialSettings/>
              {!figmaOnly&&<ModelCredentialSettings/>}
              <button disabled={busy} onClick={()=>navigation.current.navigate({view:'works'})}>作品库导航</button></header>
              {route.view==='plaza'?(figmaOnly?<ForkSession shareId="share" sourceName="公开作品" disabled={busy} onBusy={changeBusy} onOpenSession={open}/>:<CommunityPanel kind="plaza" resourceId={route.resourceId} navigationDisabled={busy}
                onSelect={resourceId=>navigation.current.navigate({view:'plaza',resourceId})}
                onDirty={setDirty} onBusy={changeBusy} onOpenSession={open}/>):<p>已进入新会话</p>}</>;
          }
          createRoot(document.getElementById('root')).render(<App><Fixture/></App>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/plaza-fork/app.js',
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
              namespace: 'fork-fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fork-fixture' }, () => ({
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
    const reads: string[] = [];
    const unexpected: string[] = [];
    const forks: { body: any; csrf: string | undefined }[] = [];
    let configured = true;
    let modelConfigured = true;
    let failModelStatus = false;
    let modelSaves = 0;
    let credentialId = 'own-credential-at-open';
    let credentialSaves = 0;
    let failStatus = false;
    let empty = false;
    let failPage = false;
    let failFork = true;
    let forkFailureStatus = 404;
    let forkFailureMessage = '源作品已不再公开';
    let hold = false;
    let releaseFork: (() => void) | undefined;
    let onHeld = () => {};
    const session = {
      shareId: 'share',
      sessionId: 'source-session',
      name: '公开作品',
      target: 'h5',
      createdEid: 'source-author',
      creatorName: '原作者',
      createdAt: '2026-11-23T01:00:00Z',
      timelineSeq: 3,
      fileRevision: 1,
    };
    const workspaces = Array.from({ length: 41 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      name: `工作区 ${index}`,
      status: 'preparing',
      teamId: null as string | null,
      isOwner: true as boolean | undefined,
    }));
    workspaces[20] = { ...workspaces[20], status: 'ready', name: '本人就绪工作区' };
    workspaces[21] = { ...workspaces[21], status: 'ready', isOwner: false };
    workspaces[22] = { ...workspaces[22], status: 'ready', teamId: 'team' };
    workspaces[40] = {
      ...workspaces[40],
      status: 'ready',
      teamId: '',
      isOwner: undefined,
      name: '第三页个人工作区',
    };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/app.js' || url.pathname === '/app.css') {
        res.setHeader(
          'Content-Type',
          url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
        );
        res.end(url.pathname.endsWith('.js') ? js : css);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
        );
        return;
      }
      const send = (data: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data }));
      };
      const fail = (status: number, message: string) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, resultMessage: message }));
      };
      if (req.method === 'GET') reads.push(url.pathname + url.search);
      if (url.pathname === '/api/d2c/plaza/sessions/share') return send(session);
      if (url.pathname === '/api/d2c/workspaces') {
        const current = Number(url.searchParams.get('page'));
        assert.equal(url.searchParams.get('scope'), 'personal');
        assert.equal(url.searchParams.get('pageSize'), '20');
        if (failPage && current === 2) return fail(503, '第二页读取失败');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            rows: empty ? [] : workspaces.slice((current - 1) * 20, current * 20),
            total: empty ? 0 : workspaces.length,
          }),
        );
        return;
      }
      if (url.pathname === '/api/d2c/credentials/figma/status') {
        if (failStatus) return fail(503, '本人凭据状态暂不可用');
        return send({
          configured,
          credentialId: configured ? credentialId : undefined,
          revision: 1,
        });
      }
      if (url.pathname === '/api/d2c/credentials/model/status') {
        if (failModelStatus) return fail(503, '本人模型凭据状态暂不可用');
        return send({
          configured: modelConfigured,
          credentialId: modelConfigured ? 'own-model-credential' : undefined,
          modelName: 'fixture-default-model',
        });
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/d2c/plaza/sessions/share/edit/draft' && req.method === 'DELETE')
        return send({ deleted: true });
      if (url.pathname === '/api/d2c/credentials/figma' && req.method === 'POST') {
        credentialSaves++;
        configured = true;
        credentialId = 'own-configured-credential';
        return send({ configured, credentialId, revision: 2 });
      }
      if (url.pathname === '/api/d2c/credentials/model' && req.method === 'POST') {
        modelSaves++;
        modelConfigured = true;
        return send({
          configured: true,
          credentialId: 'own-model-credential',
          modelName: 'fixture-default-model',
        });
      }
      if (url.pathname === '/api/d2c/plaza/sessions/share/forks' && req.method === 'POST') {
        forks.push({ body, csrf: req.headers['x-requested-with'] as string | undefined });
        if (hold) {
          const waiting = new Promise<void>((done) => (releaseFork = done));
          onHeld();
          await waiting;
        }
        if (failFork) return fail(forkFailureStatus, forkFailureMessage);
        return send({
          workspaceId: body.workspaceId,
          sessionId: 'fork-session',
          name: body.name,
          target: 'h5',
        });
      }
      if (url.pathname === '/api/d2c/plaza/sessions/share/edit' && req.method === 'POST') {
        return send({
          editId: 'draft',
          revision: 1,
          baseFileRevision: 1,
          files: [{ path: 'src/App.tsx', content: 'original' }],
          entries: ['src/App.tsx'],
          entryPath: 'src/App.tsx',
          target: 'h5',
          expiresAt: '2099-01-01',
          preview: { status: 'idle' },
        });
      }
      unexpected.push(`${req.method} ${url.pathname}`);
      fail(500, '未声明的离线 fixture 接口');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      releaseFork?.();
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.route('**/*', (route: any) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto(`${origin}/plaza/share`);
    const draft = page.getByRole('textbox', { name: '副本正文' });
    await draft.waitFor();
    const open = page.getByRole('button', { name: '创建分支并继续', exact: true });
    assert.equal(
      await open.evaluate((node: HTMLElement) => !!node.closest('.community-actions')),
      true,
    );
    await draft.fill('尚未保存的编辑');
    await page.waitForFunction(() => (window as any).guard.dirty);
    assert.equal(await open.isDisabled(), true);
    await page.getByRole('button', { name: '作品库导航' }).click();
    await page.waitForFunction(() => (window as any).confirmations === 1);
    assert.equal(new URL(page.url()).pathname, '/plaza/share');
    assert.equal(await draft.inputValue(), '尚未保存的编辑');
    await draft.fill('original');
    await page.waitForFunction(() => !(window as any).guard.dirty);

    const dialog = page.getByRole('dialog', { name: '创建分支并继续', exact: true });
    const name = dialog.getByRole('textbox', { name: '分支名称' });
    const workspace = dialog.getByRole('combobox', { name: '个人工作区' });
    const create = dialog.getByRole('button', { name: /创建分支$/ });
    const cancel = dialog.getByRole('button', { name: /取\s*消/ });
    const recheck = dialog.getByRole('button', { name: '重新检查工作区和凭据' });
    const close = async () => {
      await cancel.click();
      await dialog.waitFor({ state: 'hidden' });
    };
    const ready = async () => {
      await workspace.locator('option[value="workspace-40"]').waitFor({ state: 'attached' });
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')
            ?.disabled === false,
      );
      assert.equal(await create.isDisabled(), false);
    };
    await open.click();
    await ready();
    assert.equal(await name.inputValue(), '公开作品 分支');
    assert.equal(await name.getAttribute('maxlength'), '200');
    assert.deepEqual(await workspace.locator('option').allTextContents(), [
      '请选择工作区',
      '本人就绪工作区',
      '第三页个人工作区',
    ]);
    for (const current of [1, 2, 3]) {
      assert.ok(reads.includes(`/api/d2c/workspaces?scope=personal&page=${current}&pageSize=20`));
    }
    await dialog.getByText('将复制公开聊天和当前代码', { exact: false }).waitFor();
    await close();
    assert.equal(forks.length, 0);

    modelConfigured = false;
    await open.click();
    await dialog.getByText('需要本人的模型 Token', { exact: true }).waitFor();
    await dialog.getByText('页面顶部的「模型凭据」', { exact: false }).waitFor();
    assert.equal(await create.isDisabled(), true);
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    await close();
    const modelSettings = page.locator('.credential').filter({ hasText: '连接模型' });
    await modelSettings.locator('summary').click();
    await modelSettings
      .getByLabel('模型 Token', { exact: true })
      .fill('offline-model-fixture-token');
    await modelSettings.getByRole('button', { name: '保存凭据', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('#model-token')?.value === '',
    );
    assert.equal(modelSaves, 1);
    await modelSettings.locator('summary').click();

    await open.click();
    await ready();
    await name.fill('保留模型凭据失败时的名称');
    await workspace.selectOption('workspace-40');
    modelConfigured = false;
    await create.click();
    await dialog
      .getByText('请先在页面顶部的「模型凭据」中保存本人的模型 Token，再重新检查', { exact: true })
      .waitFor();
    assert.equal(forks.length, 0);
    assert.equal(await name.inputValue(), '保留模型凭据失败时的名称');
    assert.equal(await workspace.inputValue(), 'workspace-40');
    assert.equal(await page.evaluate(() => (window as any).guard.busy), false);
    modelConfigured = true;
    await recheck.click();
    await ready();
    failModelStatus = true;
    await create.click();
    await dialog.getByText('本人模型凭据状态暂不可用', { exact: true }).waitFor();
    assert.equal(forks.length, 0);
    assert.equal(await name.inputValue(), '保留模型凭据失败时的名称');
    failModelStatus = false;
    await close();

    empty = true;
    await open.click();
    await dialog.getByText('暂无就绪的个人工作区', { exact: false }).waitFor();
    assert.equal(await create.isDisabled(), true);
    await close();
    empty = false;
    failPage = true;
    await open.click();
    await name.fill('分页失败仍保留输入');
    await dialog.getByText('第二页读取失败', { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), true);
    failPage = false;
    await recheck.click();
    await ready();
    assert.equal(await name.inputValue(), '分页失败仍保留输入');
    await close();

    configured = false;
    await open.click();
    await dialog.getByText('需要本人的 Figma 凭据', { exact: true }).waitFor();
    await dialog.getByText('页面顶部', { exact: false }).waitFor();
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    assert.equal(await create.isDisabled(), true);
    await close();
    const figmaSettings = page.locator('.credential').filter({ hasText: '连接 Figma' });
    await figmaSettings.locator('summary').click();
    const token = page.getByLabel('Figma Token', { exact: true });
    await token.fill('offline-fixture-token');
    await figmaSettings.getByRole('button', { name: '保存凭据', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('#figma-token')?.value === '',
    );
    assert.equal(credentialSaves, 1);
    assert.equal(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
      '{}',
    );
    await figmaSettings.locator('summary').click();

    await open.click();
    await ready();
    await name.fill('   ');
    await create.click();
    await dialog.getByText('分支名称须为', { exact: false }).waitFor();
    assert.equal(forks.length, 0);
    await name.fill('  我的独立分支  ');
    await workspace.selectOption('workspace-40');
    for (const event of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 },
    ]) {
      await name.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, ...event });
      await name.dispatchEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
      assert.equal(forks.length, 0);
    }
    configured = false;
    await name.press('Enter');
    await dialog
      .getByText('请先在页面顶部配置本人的 Figma 凭据，再重新检查', { exact: true })
      .waitFor();
    assert.equal(forks.length, 0);
    assert.equal(await name.inputValue(), '  我的独立分支  ');
    configured = true;
    await recheck.click();
    await ready();
    failStatus = true;
    await create.click();
    await dialog.getByText('本人凭据状态暂不可用', { exact: true }).waitFor();
    assert.equal(forks.length, 0);
    assert.equal(await page.evaluate(() => (window as any).guard.busy), false);
    failStatus = false;
    credentialId = 'own-credential-refreshed-on-submit';
    await create.click();
    await dialog.getByText('源作品已不再公开', { exact: true }).waitFor();
    assert.equal(await name.inputValue(), '  我的独立分支  ');
    assert.equal(await workspace.inputValue(), 'workspace-40');
    assert.equal(await draft.inputValue(), 'original');
    assert.equal(forks.length, 1);
    assert.deepEqual(Object.keys(forks[0].body).sort(), [
      'clientRequestId',
      'credentialId',
      'name',
      'workspaceId',
    ]);
    assert.equal(forks[0].body.credentialId, credentialId);
    assert.equal(forks[0].body.name, '我的独立分支');
    assert.equal(forks[0].csrf, 'PixelPrint');
    assert.match(forks[0].body.clientRequestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    forkFailureStatus = 422;
    forkFailureMessage = '凭据已不可用，请重新配置';
    await create.click();
    await dialog.getByText(forkFailureMessage, { exact: true }).waitFor();
    await page.waitForFunction(() => !(window as any).guard.busy);
    assert.equal(forks.length, 2);
    assert.equal(forks[1].body.clientRequestId, forks[0].body.clientRequestId);
    assert.equal(await name.inputValue(), '  我的独立分支  ');
    assert.equal(await workspace.inputValue(), 'workspace-40');
    assert.deepEqual(await page.evaluate(() => (window as any).openEvents), []);
    await close();

    await open.click();
    await ready();
    assert.equal(await name.inputValue(), '公开作品 分支');
    await workspace.selectOption('workspace-40');
    failFork = false;
    hold = true;
    const held = new Promise<void>((done) => (onHeld = done));
    await create.click();
    await held;
    await page.waitForFunction(() => (window as any).guard.busy);
    assert.equal(forks.length, 3);
    assert.notEqual(forks[2].body.clientRequestId, forks[0].body.clientRequestId);
    assert.equal(await create.isDisabled(), true);
    assert.equal(await cancel.isDisabled(), true);
    assert.equal(await name.isDisabled(), true);
    assert.equal(await workspace.isDisabled(), true);
    assert.equal(await dialog.locator('.ant-modal-close').count(), 0);
    assert.equal(await page.getByRole('button', { name: '作品库导航' }).isDisabled(), true);
    await create.dispatchEvent('click');
    await name.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      keyCode: 13,
    });
    await cancel.dispatchEvent('click');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(forks.length, 3);
    const screenshot = `/tmp/plaza-fork-${process.pid}.png`;
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    t.diagnostic(`分支创建交互截图：${screenshot}`);
    releaseFork!();
    await page.getByText('已进入新会话', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/workbench/workspace-40/sessions/fork-session');
    assert.deepEqual(await page.evaluate(() => (window as any).openEvents), [
      { workspaceId: 'workspace-40', sessionId: 'fork-session', busy: false, dirty: false },
    ]);
    assert.equal(await page.evaluate(() => (window as any).guard.busy), false);
    // 默认接口仍只依赖 Figma；模型状态不可用时也不请求模型接口。
    const modelReads = () =>
      reads.filter((path) => path === '/api/d2c/credentials/model/status').length;
    const beforeGeneric = modelReads();
    modelConfigured = false;
    failModelStatus = true;
    hold = false;
    await page.goto(`${origin}/plaza/share?figmaOnly=1`);
    await open.click();
    await ready();
    assert.equal(await dialog.getByText('需要本人的模型 Token', { exact: true }).count(), 0);
    await create.click();
    await page.getByText('已进入新会话', { exact: true }).waitFor();
    assert.equal(modelReads(), beforeGeneric);
    assert.equal(forks.length, 4);
    assert.equal(forks[3].body.credentialId, credentialId);
    assert.equal('modelCredentialId' in forks[3].body, false);
    assert.equal(new URL(page.url()).pathname, '/workbench/workspace-20/sessions/fork-session');
    assert.deepEqual(unexpected, []);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  },
);
