import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationRound from '../web/src/workspace/ConversationRound';
import type * as Teams from '../web/src/workspace/TeamSettings';
import type * as Works from '../web/src/workspace/WorksPanel';
import type { Team, TeamDetail } from '../web/src/workspace/types';

/** 内存编译真实组件，与现有 UI 测试一样共享 React/Antd，忽略样式资源。 */
const compiled = await build({
  stdin: {
    contents: `export * from './web/src/workspace/TeamSettings'; export { worksListPath } from './web/src/workspace/WorksPanel';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'shared-packages',
      setup(builder) {
        builder.onResolve({ filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|antd)$/ }, ({ path }) => ({
          path: import.meta.resolve(path),
          external: true,
        }));
      },
    },
  ],
});
const ui = (await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
)) as typeof Teams & typeof Works;

const team: TeamDetail = {
  teamId: 'team/one',
  name: '设计组',
  createdUserId: 'owner',
  creatorName: '创建人',
  isOwner: true,
  memberCount: 2,
  members: [
    { userId: 'owner', role: 'owner' },
    { userId: '<member>', role: 'member' },
  ],
};

test('真实成员组件仅允许创建者管理普通成员，转义用户账号且不暴露凭据', () => {
  for (const isOwner of [true, false]) {
    const html = renderToStaticMarkup(
      createElement(ui.TeamMembers, {
        team: { ...team, isOwner },
        pending: false,
        onRemove: () => assert.fail('SSR 不应写入'),
      }),
    );
    assert.match(html, /&lt;member&gt;/);
    assert.equal(html.includes('移除成员'), isOwner);
    assert.doesNotMatch(html, /移除成员 owner|Token|credential/);
    assert.match(html, /创建者/);
  }
  const pending = renderToStaticMarkup(
    createElement(ui.TeamMembers, { team, pending: true, onRemove() {} }),
  );
  assert.match(pending, /disabled=""/);
});

test('工作区括号归属兼容个人历史值和未知团队，不展示创建人或私有团队名', () => {
  for (const teamId of [undefined, null, '', 'inaccessible-team']) {
    const html = renderToStaticMarkup(
      createElement(
        ui.TeamProvider,
        null,
        createElement(ui.WorkspaceAttribution, {
          workspace: {
            workspaceId: 'w',
            name: '页面',
            status: 'ready',
            configRevision: 1,
            resource: null,
            teamId,
            creatorName: '私有创建人',
            createdUserId: 'private-userId',
          },
        }),
      ),
    );
    assert.equal(
      html,
      `<span class="workspace-attribution">（${teamId ? '团队' : '个人'}）</span>`,
    );
  }
});

test('真实消息组件区分本人和队友用户账号，旧消息继续显示你，助手不冒用操作者', () => {
  for (const [role, authorUserId, expected] of [
    ['user', 'my-userId', 'my-userId'],
    ['user', 'teammate-userId', 'teammate-userId'],
    ['user', undefined, '你'],
    ['assistant', 'teammate-userId', 'PixelPrint'],
    ['user', '<userId>', '&lt;userId&gt;'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ConversationRound, {
        entries: [
          {
            entryId: 'e',
            seq: 1,
            sessionId: 's',
            runId: null,
            at: '2026-11-11T00:00:00Z',
            kind: 'message',
            data: { role, authorUserId, text: '正文' },
          },
        ],
        active: false,
        onLayoutChange() {},
        renderMessage: () => createElement('span', null, '正文'),
      }),
    );
    assert.ok(html.includes(`<div class="event-meta"><span>${expected}</span>`));
  }
});

test('范围构造沿用工作区与版本协议，保留分页，编码团队ID且刷新保留有效选择', () => {
  for (const [scope, expected] of [
    ['all', null],
    ['personal', 'personal'],
    ['team:team/one', null],
  ] as const) {
    const url = new URL(ui.workspaceListPath(scope, 3), 'https://test.invalid');
    assert.equal(url.pathname, '/workspaces');
    assert.equal(url.searchParams.get('scope'), expected);
    assert.equal(url.searchParams.get('teamId'), scope.startsWith('team:') ? 'team/one' : null);
    assert.equal(url.searchParams.get('page'), '3');
    assert.equal(url.searchParams.get('pageSize'), '20');
  }
  for (const scope of ['mine', 'all', 'team'] as const) {
    const url = new URL(ui.worksListPath(scope, 'team/one?x', 2), 'https://test.invalid');
    assert.equal(url.pathname, '/versions');
    assert.equal(url.searchParams.get('scope'), scope);
    assert.equal(url.searchParams.get('teamId'), scope === 'team' ? 'team/one?x' : null);
  }
  assert.equal(ui.availableWorkspaceScope('team:team/one', [team]), 'team:team/one');
  assert.equal(ui.availableWorkspaceScope('team:team/one', []), 'all');
  assert.equal(ui.availableWorkspaceScope('personal', []), 'personal');
});

test('团队目录读取真实分页响应，不因首屏未命中而清除选择；失败与取消向上传递', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const paths: string[] = [];
  globalThis.fetch = async (path, init) => {
    paths.push(String(path));
    assert.equal(init?.credentials, 'same-origin');
    return Response.json({
      success: true,
      rows: paths.length === 1 ? [{ ...team, teamId: 'first' }] : [team],
      total: 2,
    });
  };
  assert.deepEqual(
    (await ui.loadTeams()).map((team: Team) => team.teamId),
    ['first', 'team/one'],
  );
  assert.match(paths[1], /page=2&pageSize=100/);
  globalThis.fetch = async () => Response.json({ success: true, rows: [], total: 2 });
  await assert.rejects(ui.loadTeams(), /团队列表不完整/);
  globalThis.fetch = async () =>
    Response.json({ success: false, resultMessage: '成员已移除' }, { status: 403 });
  await assert.rejects(ui.loadTeams(), /成员已移除/);
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async (_path, init) => {
    assert.equal(init?.signal, controller.signal);
    throw new DOMException('Aborted', 'AbortError');
  };
  await assert.rejects(ui.loadTeams(controller.signal), { name: 'AbortError' });
});

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path): path is string => !!path && existsSync(path));

/** 通过浏览器原生 DevTools 协议跑真实 React 生命周期，无额外测试依赖。 */
test(
  '真实工作台：团队管理、同步筛选、创建/归属、作品、草稿和成员移除',
  { skip: !chrome || process.env.PIXELPRINT_BROWSER_TESTS !== '1', timeout: 90000 },
  async (t) => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../web/src/main.tsx', import.meta.url))],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolated-session-rendering',
          setup(builder) {
            // 编辑器由独立测试覆盖，此处隔离 Vite 专属 worker 导入。
            builder.onResolve({ filter: /^\.\/CodeEditor$/ }, () => ({
              path: 'code-editor',
              namespace: 'editor-fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'editor-fixture' }, () => ({
              contents: 'export default function CodeEditor() { return null; }',
              loader: 'js',
            }));
            builder.onResolve({ filter: /^\.\/SessionPanel$/ }, () => ({
              path: 'session-draft',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `import {useState} from 'react'; export default function Session(props) { const [draft,setDraft]=useState(''); return <input aria-label="测试会话草稿" value={draft} onChange={e=>{setDraft(e.target.value);props.onDirty(!!e.target.value)}} />; }`,
              loader: 'tsx',
              resolveDir: fileURLToPath(new URL('..', import.meta.url)),
            }));
          },
        },
      ],
    });
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
    let teams: TeamDetail[] = [
      { ...team, teamId: 't1', name: '设计组' },
      { ...team, teamId: 't2', name: '研发组', isOwner: false },
    ];
    const workspaces = [
      {
        workspaceId: 'w1',
        name: '团队页面',
        status: 'ready',
        teamId: 't1',
        createdUserId: 'owner',
        creatorName: '创建人',
        isOwner: true,
        configRevision: 1,
        resource: null,
      },
      {
        workspaceId: 'w2',
        name: '个人页面',
        status: 'ready',
        teamId: null as string | null,
        createdUserId: 'owner',
        creatorName: '创建人',
        isOwner: true,
        configRevision: 1,
        resource: null,
      },
    ];
    let failCreate = false;
    let failTeams = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle.outputFiles[0].text);
        return;
      }
      if (!url.pathname.startsWith('/api/d2c')) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const path = url.pathname.slice('/api/d2c'.length);
      const method = req.method ?? 'GET';
      calls.push({ path: `${path}${url.search}`, method, body });
      res.setHeader('Content-Type', 'application/json');
      const send = (data: unknown) => res.end(JSON.stringify({ success: true, data }));
      if (path === '/teams' && method === 'GET') {
        if (failTeams) {
          res.statusCode = 503;
          res.end(JSON.stringify({ success: false, resultMessage: '团队暂不可用' }));
        } else res.end(JSON.stringify({ success: true, rows: teams, total: teams.length }));
      } else if (path === '/teams' && method === 'POST') {
        const created = { ...team, teamId: 't3', name: String(body.name) };
        teams.push(created);
        send(created);
      } else if (/^\/teams\/[^/]+$/.test(path))
        send(teams.find((team) => team.teamId === path.split('/')[2]));
      else if (path.includes('/members')) {
        const current = teams.find((team) => team.teamId === path.split('/')[2])!;
        if (method === 'POST')
          current.members = [...current.members, { userId: String(body.userId), role: 'member' }];
        else
          current.members = current.members.filter(
            (member) => member.userId !== decodeURIComponent(path.split('/').at(-1)!),
          );
        current.memberCount = current.members.length;
        send(current);
      } else if (path === '/workspaces' && method === 'POST') {
        if (failCreate) {
          res.statusCode = 403;
          res.end(JSON.stringify({ success: false, resultMessage: '团队访问已失效' }));
        } else {
          const created = {
            ...workspaces[0],
            workspaceId: 'w3',
            name: String(body.name),
            teamId: body.teamId as string | null,
          };
          workspaces.push(created);
          send(created);
        }
      } else if (path === '/workspaces') {
        const rows = workspaces.filter((workspace) =>
          url.searchParams.has('teamId')
            ? workspace.teamId === url.searchParams.get('teamId')
            : url.searchParams.get('scope') === 'personal'
              ? !workspace.teamId
              : true,
        );
        res.end(JSON.stringify({ success: true, rows, total: rows.length }));
      } else if (path.endsWith('/team')) {
        const current = workspaces.find(
          (workspace) => workspace.workspaceId === path.split('/')[2],
        )!;
        current.teamId = body.teamId as string | null;
        send(current);
      } else if (path.endsWith('/sessions'))
        res.end(
          JSON.stringify({
            success: true,
            rows: [{ sessionId: 's1', name: '共同编辑', target: 'h5', workspaceId: 'w1' }],
            total: 1,
          }),
        );
      else if (path.startsWith('/workspaces/')) {
        const workspace = workspaces.find(
          (workspace) => workspace.workspaceId === path.split('/')[2],
        );
        if (method === 'PATCH' && workspace) workspace.name = String(body.name);
        send(workspace);
      } else if (path === '/versions')
        send({
          rows: [
            {
              versionId: 'v1',
              name: '共享作品',
              target: 'h5',
              createdUserId: 'author',
              creatorName: '作品作者',
              createdAt: '2026-11-11T00:00:00Z',
              validationSummary: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 12,
        });
      else if (path === '/versions/v1')
        send({
          versionId: 'v1',
          name: '共享作品',
          target: 'h5',
          files: [],
          createdAt: '2026-11-11T00:00:00Z',
          validationSummary: null,
        });
      else if (path.startsWith('/versions/v1/')) send({ status: 'idle' });
      else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, resultMessage: `未替身接口 ${path}` }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address() as { port: number };
    const profile = await mkdtemp(join(tmpdir(), 'pixelprint-team-ui-'));
    const child = spawn(
      chrome!,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    t.after(async () => {
      child.kill('SIGKILL');
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const debuggerUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome DevTools 启动超时')), 30000);
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome 退出 ${code}`));
      });
    });
    const socket = new WebSocket(debuggerUrl);
    await once(socket, 'open');
    t.after(() => socket.close());
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (reason: unknown) => void }
    >();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const item = pending.get(message.id);
      if (item) {
        pending.delete(message.id);
        if (message.error) item.reject(message.error);
        else item.resolve(message.result);
      }
    });
    const command = (method: string, params: object = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    /** 浏览器执行真实点击与输入，异常返回 Node 断言，不替身 React hooks。 */
    async function evaluate<T = unknown>(expression: string): Promise<T> {
      const value = await command(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (value.exceptionDetails)
        throw new Error(
          value.exceptionDetails.exception?.description || value.exceptionDetails.text,
        );
      return value.result.value as T;
    }
    async function wait(expression: string) {
      try {
        await evaluate(
          `(async()=>{for(let i=0;i<150;i++){if(${expression})return;await new Promise(r=>setTimeout(r,25));}throw new Error('等待失败: '+${JSON.stringify(expression)}+'\\n'+document.body.innerText)})()`,
        );
      } catch (reason) {
        throw new Error(`${String(reason)}\n最近请求：${JSON.stringify(calls.slice(-12))}`);
      }
    }
    async function click(text: string) {
      await evaluate(
        `(()=>{const button=[...document.querySelectorAll('button')].findLast(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled&&e.getClientRects().length);if(!button)throw new Error('无可用按钮 '+${JSON.stringify(text)});button.click()})()`,
      );
    }
    async function input(selector: string, value: string) {
      await evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('无输入框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    }
    async function select(label: string, option: string) {
      const field = `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
      const popup = `document.getElementById(${field}?.getAttribute('aria-controls'))?.closest('.ant-select-dropdown')`;
      async function key(key: string, code: number) {
        await command(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', key, windowsVirtualKeyCode: code },
          sessionId,
        );
        await command(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key, windowsVirtualKeyCode: code },
          sessionId,
        );
        await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
      }
      await wait(`!!${field} && !${field}?.closest('.ant-select-disabled')`);
      await evaluate(`${field}.focus()`);
      await key('ArrowDown', 40);
      await wait(
        `[...(${popup}?.querySelectorAll('.ant-select-item-option')??[])].some(e=>e.getAttribute('title')===${JSON.stringify(option)})`,
      );
      for (let i = 0; i < 10; i++) {
        if (
          await evaluate<boolean>(
            `${popup}?.querySelector('.ant-select-item-option-active')?.getAttribute('title')===${JSON.stringify(option)}`,
          )
        )
          break;
        await key('ArrowDown', 40);
      }
      await key('Enter', 13);
      try {
        await wait(
          `${field}?.closest('.ant-select').textContent.includes(${JSON.stringify(option)})`,
        );
      } catch (reason) {
        throw new Error(
          String(reason) +
            '\n控件状态：' +
            (await evaluate(
              `JSON.stringify({field:${field}?.outerHTML,active:document.activeElement?.outerHTML,popup:${popup}?.outerHTML})`,
            )),
        );
      }
    }
    await command(
      'Page.navigate',
      { url: `http://127.0.0.1:${address.port}/?workspace=w1&session=s1` },
      sessionId,
    );
    await wait(
      `!!document.querySelector('[aria-label="测试会话草稿"]') && document.body.innerText.includes('团队页面')`,
    );
    await input('[aria-label="测试会话草稿"]', '保留的草稿');
    await wait(
      `document.querySelector('.workspace-switcher-trigger')?.textContent==='团队页面（设计组）'`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.workspace-name-button').textContent`),
      '团队页面（设计组）',
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('.workspace-context .workspace-attribution').length`,
      ),
      1,
    );
    await evaluate(`document.querySelector('[aria-label="修改工作区名称"]').click()`);
    await wait(`!!document.querySelector('[aria-label="工作区名称"]')`);
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="工作区名称"]').value`),
      '团队页面',
    );
    await input('[aria-label="工作区名称"]', '团队页面改名');
    await click('保存');
    await wait(
      `document.querySelector('.workspace-switcher-trigger')?.textContent==='团队页面改名（设计组）'`,
    );
    assert.deepEqual(calls.find((call) => call.method === 'PATCH')?.body, { name: '团队页面改名' });
    // 当前列表不含所选工作区时，顶部继续使用详情中的名称与归属。
    await evaluate(`document.querySelector('[aria-label="切换工作区"]').click()`);
    await wait(`!!document.querySelector('.workspace-switcher-panel')`);
    await select('工作区范围', '个人工作区');
    await wait(
      `document.querySelector('.workspace-switcher-panel .nav-item-name')?.textContent==='个人页面（个人）'`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.workspace-switcher-trigger').textContent`),
      '团队页面改名（设计组）',
    );
    await select('工作区范围', '全部工作区');
    await wait(
      `document.querySelector('.workspace-switcher-panel .nav-item-name')?.textContent==='团队页面改名（设计组）'`,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.workspace-switcher-panel .list-item')].every(e=>e.querySelectorAll('.workspace-attribution').length===1)`,
      ),
      true,
    );
    await evaluate(`document.querySelector('[aria-label="切换工作区"]').click()`);

    await click('修改归属');
    await wait(
      `document.querySelector('.ant-modal:not([style*="display: none"])') && !document.querySelector('.ant-select-disabled')`,
    );
    await select('工作区归属', '研发组');
    await click('保存归属');
    await wait(`!document.querySelector('.ant-modal-wrap:not([style*="display: none"])')`);
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="测试会话草稿"]').value`),
      '保留的草稿',
    );
    assert.equal(await evaluate('location.pathname'), '/workbench/w1/sessions/s1');
    assert.deepEqual(calls.find((call) => call.method === 'PUT')?.body, { teamId: 't2' });
    await click('团队管理');
    await wait(`!!document.querySelector('#team-member-userId')`);
    await input('#team-member-userId', 'new/userId');
    await click('添加成员');
    await wait(`document.querySelector('.team-members')?.textContent.includes('new/userId')`);
    assert.deepEqual(
      calls.find((call) => call.method === 'POST' && call.path.includes('/members'))?.body,
      { userId: 'new/userId' },
    );
    await evaluate(`document.querySelector('[aria-label="移除成员 new/userId"]').click()`);
    await wait(`document.querySelector('.ant-modal-confirm')`);
    await click('移除');
    await wait(
      `document.querySelector('.team-members') && !document.querySelector('.team-members').textContent.includes('new/userId')`,
    );
    assert.ok(
      calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/members/new%2FuserId')),
    );
    await wait(`!document.querySelector('.ant-modal-confirm')`);
    await select('选择团队', '研发组');
    await wait(`document.querySelector('.team-heading')?.textContent.includes('研发组')`);
    assert.equal(await evaluate(`!!document.querySelector('#team-member-userId')`), false);
    await click('新建团队');
    await input('#team-name', '新团队');
    await click('创建团队');
    await wait(`document.querySelector('.team-heading')?.textContent.includes('新团队')`);
    await evaluate(
      `[...document.querySelectorAll('.ant-modal-close')].find(e=>e.getClientRects().length).click()`,
    );
    await wait(
      `![...document.querySelectorAll('.ant-modal-wrap')].some(e=>e.getClientRects().length)`,
    );
    assert.equal(
      await evaluate(`document.querySelector('[aria-label="测试会话草稿"]').value`),
      '保留的草稿',
    );
    await click('工作台');
    await wait('!!document.querySelector(".workspace-switcher-trigger")');
    await evaluate('document.querySelector(".workspace-switcher-trigger").click()');
    await wait(
      `!!document.querySelector('[aria-label="返回工作区列表"]')?.getClientRects().length`,
    );
    await evaluate(`document.querySelector('[aria-label="返回工作区列表"]').click()`);
    await wait(`document.querySelector('.ant-modal-confirm')`);
    await click('取消');
    await wait(`!document.querySelector('.ant-modal-confirm')`);
    assert.equal(await evaluate('location.pathname'), '/workbench/w1/sessions/s1');
    await input('[aria-label="测试会话草稿"]', '');
    await click('工作台');
    await wait('!!document.querySelector(".workspace-switcher-trigger")');
    await evaluate('document.querySelector(".workspace-switcher-trigger").click()');
    await wait(
      `!!document.querySelector('[aria-label="返回工作区列表"]')?.getClientRects().length`,
    );
    await evaluate(`document.querySelector('[aria-label="返回工作区列表"]').click()`);
    await wait(`!!document.querySelector('.workspace-home-list')`);
    await select('工作区范围', '个人工作区');
    await wait(`document.querySelectorAll('.workspace-home-row').length===1`);
    assert.equal(
      await evaluate(`document.querySelector('.workspace-home-name').textContent`),
      '个人页面（个人）',
    );
    assert.ok(calls.some((call) => call.path.includes('scope=personal')));
    await select('工作区范围', '研发组');
    await wait(`document.querySelector('.workspace-home-list')?.textContent.includes('团队页面')`);
    await evaluate(`document.querySelector('[aria-label="切换工作区"]').click()`);
    await wait(`!!document.querySelector('.workspace-switcher-panel')`);
    assert.equal(
      await evaluate(`document.querySelectorAll('[aria-label="工作区范围"]').length`),
      2,
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.workspace-switcher-panel .ant-select').textContent.includes('研发组')`,
      ),
      true,
    );
    await evaluate(`document.querySelector('[aria-label="切换工作区"]').click()`);
    await click('新建工作区');
    await input('#workspace-name', '新页面');
    failCreate = true;
    await click('创建');
    await wait(`document.body.innerText.includes('团队访问已失效')`);
    assert.equal(await evaluate(`document.querySelector('#workspace-name').value`), '新页面');
    failCreate = false;
    await click('创建');
    // 创建成功自动进入新工作区，无需再点击列表。

    await wait(`location.pathname==='/workbench/w3'`);
    assert.deepEqual(
      calls.filter((call) => call.path === '/workspaces' && call.method === 'POST').at(-1)?.body,
      { name: '新页面', teamId: 't2' },
    );
    await click('作品库');
    await wait(`document.body.innerText.includes('共享作品')`);
    await evaluate(
      `[...document.querySelectorAll('.ant-segmented-item')].find(e=>e.textContent.includes('全部版本')).click()`,
    );
    await wait(`document.body.innerText.includes('共享作品')`);
    await click('查看版本');
    await wait(
      `location.pathname==='/works/versions/v1' && document.querySelector('.works-heading h1')?.textContent==='共享作品'`,
    );
    assert.equal(await evaluate('location.pathname'), '/works/versions/v1');
    assert.equal(await evaluate(`new URLSearchParams(location.search).has('teamId')`), false);
    await click('返回会话版本');
    await wait(`document.body.innerText.includes('共享作品')`);
    await evaluate(
      `[...document.querySelectorAll('.ant-segmented-item')].find(e=>e.textContent.includes('团队版本')).click()`,
    );
    await wait(`!!document.querySelector('[aria-label="作品团队"]')`);
    await select('作品团队', '研发组');
    await wait(`document.body.innerText.includes('共享作品')`);
    assert.ok(
      calls.some(
        (call) =>
          call.path.startsWith('/versions?') &&
          new URL(call.path, 'http://x').searchParams.get('scope') === 'team' &&
          call.path.includes('teamId=t2'),
      ),
    );
    failTeams = true;
    await click('刷新');
    await wait(`document.body.innerText.includes('团队暂不可用')`);
    assert.equal(
      await evaluate(`document.querySelector('.works-team-select').textContent.includes('研发组')`),
      true,
    );
    failTeams = false;
    await click('刷新');
    await wait(
      `!document.body.innerText.includes('团队暂不可用') && !document.querySelector('.works-team-select.ant-select-disabled') && !document.querySelector('.works-heading .ant-btn-loading')`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.works-team-select').textContent.includes('研发组')`),
      true,
    );
    teams = teams.filter((team) => team.teamId !== 't2');
    await click('刷新');
    await wait(`!document.querySelector('[aria-label="作品团队"]')`);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.ant-segmented-item')].find(e=>e.querySelector('input')?.checked)?.textContent`,
      ),
      '我的版本',
    );
    await click('工作台');
    await wait('!!document.querySelector(".workspace-switcher-trigger")');
    await evaluate('document.querySelector(".workspace-switcher-trigger").click()');
    await wait(
      `!!document.querySelector('[aria-label="返回工作区列表"]')?.getClientRects().length`,
    );
    await evaluate(`document.querySelector('[aria-label="返回工作区列表"]').click()`);
    await wait(
      `document.querySelector('.workspace-home-toolbar .ant-select').textContent.includes('全部工作区')`,
    );
    await wait(
      `document.querySelector('.workspace-home-name')?.textContent==='团队页面改名（团队）'`,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.workspace-home-name')].every(e=>e.querySelectorAll('.workspace-attribution').length===1)`,
      ),
      true,
    );
    // 按完整路由段检查，正常的 /workspaces 不能被误判为废弃的 /works。
    const unexpectedPaths = calls
      .map((call) => new URL(call.path, 'http://localhost').pathname)
      .filter((path) => /^\/(?:works|me)(?:\/|$)/.test(path));
    assert.deepEqual(unexpectedPaths, []);
  },
);
