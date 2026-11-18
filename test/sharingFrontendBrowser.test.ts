import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwrightPath = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);

/** 真实 React/Antd 生命周期；只替身 Monaco 输入控件，不替身副本控制器和网络层。 */
test(
  '浏览器：发布权限、广场只读、历史/图片/子 Agent、保存作品并再次编辑',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwrightPath),
    timeout: 90000,
  },
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
          name: 'editor-input',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/CodeEditor$/ }, () => ({
              path: 'editor',
              namespace: 'fixture',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: `import React from 'react'; export default function Editor({files,path,onChange,readOnly}) {
          return <textarea aria-label="测试副本源码" value={files.find(f=>f.path===path)?.content ?? ''}
            readOnly={readOnly} onChange={event=>onChange(path,event.target.value)} />; }`,
              loader: 'tsx',
              resolveDir: fileURLToPath(new URL('..', import.meta.url)),
            }));
          },
        },
      ],
    });
    const calls: { path: string; method: string; body: any }[] = [];
    let published = false;
    let canManage = true;
    let work: any = null;
    let draft: any;
    const session = {
      shareId: 'share',
      sessionId: 'original',
      name: '公开页面',
      target: 'h5',
      creatorName: '作者',
      createdEid: 'author',
      fileRevision: 3,
      timelineSeq: 8,
      createdAt: '2026-11-18',
    };
    const entry = (seq: number, kind: string, data: any) => ({
      entryId: `e${seq}`,
      sessionId: 'original',
      runId: 'r1',
      seq,
      kind,
      data,
      at: '2026-11-18T00:00:00Z',
    });
    const files = [
      { fileId: 'source', path: 'src/App.tsx', kind: 'source', size: 8, revision: 1 },
      {
        fileId: 'image',
        path: 'image.png',
        kind: 'asset',
        mimeType: 'image/png',
        size: 68,
        revision: 1,
        url: '/api/d2c/sessions/original/files/image',
      },
    ];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=',
      'base64',
    );
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle.outputFiles[0].text);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>',
        );
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const path = url.pathname.replace('/api/d2c', '');
      const method = req.method ?? 'GET';
      const input = body ? JSON.parse(body) : {};
      calls.push({ path: `${path}${url.search}`, method, body: input });
      const send = (data: any, extra: any = {}) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data, ...extra }));
      };
      if (path.startsWith('/teams') || path === '/workspaces')
        return send(null, { rows: [], total: 0 });
      if (path === '/plaza/sessions')
        return send({ items: [session], total: 1, page: 1, pageSize: 12 });
      if (path === '/plaza/sessions/share') return send(session);
      if (path === '/plaza/sessions/share/files') return send(files);
      if (path.endsWith('/files/source'))
        return send({ ...files[0], content: 'export default 1;' });
      if (path.endsWith('/files/image') || path.includes('/attachments/')) {
        res.setHeader('Content-Type', 'image/png');
        res.end(png);
        return;
      }
      if (path.endsWith('/timeline'))
        return send({
          entries:
            url.searchParams.get('beforeSeq') === '5'
              ? [entry(1, 'message', { role: 'user', text: '更早的需求' })]
              : [
                  entry(5, 'message', {
                    role: 'user',
                    text: '请生成页面',
                    attachments: [
                      {
                        attachmentId: 'attachment',
                        url: '/api/d2c/sessions/original/attachments/attachment',
                        mimeType: 'image/png',
                        width: 1,
                        height: 1,
                        size: 68,
                      },
                    ],
                  }),
                  entry(6, 'stage', {
                    stage: 'subagent',
                    agentId: 'agent',
                    role: 'ui',
                    status: 'completed',
                  }),
                  entry(7, 'message', { role: 'assistant', text: '页面已生成' }),
                  entry(8, 'run_status', { status: 'succeeded' }),
                ],
          nextSeq: 8,
          previousSeq: url.searchParams.get('beforeSeq') === '5' ? 1 : 5,
          hasMore: url.searchParams.get('beforeSeq') !== '5',
        });
      if (path.endsWith('/subagents/agent/events'))
        return send({
          agentId: 'agent',
          entries: [
            entry(6, 'stage', {
              stage: 'subagent',
              agentId: 'agent',
              role: 'ui',
              status: 'completed',
              text: '子任务完成',
            }),
          ],
          nextSeq: 8,
          hasMore: false,
        });
      if (path === '/my-works')
        return send({ items: work ? [work] : [], total: work ? 1 : 0, page: 1, pageSize: 12 });
      if (path === '/my-works/work') return send(work);
      if (/\/(?:plaza\/sessions\/share|my-works\/work)\/edit/.test(path)) {
        if (method === 'DELETE') return send({});
        if (path.endsWith('/save')) {
          assert.equal(input.baseRevision, draft.revision);
          work = {
            workId: 'work',
            name: '我的副本',
            target: 'h5',
            revision: (work?.revision ?? 0) + 1,
            createdAt: '2026-11-18',
            canManage: true,
          };
          return send(work);
        }
        if (method === 'POST')
          draft = {
            editId: 'draft',
            revision: 1,
            baseFileRevision: work?.revision ?? 3,
            files: [{ path: 'src/App.tsx', content: work ? 'saved source' : 'original source' }],
            entries: ['src/App.tsx'],
            entryPath: 'src/App.tsx',
            target: 'h5',
            expiresAt: '2099-01-01',
            preview: { status: 'idle' },
          };
        if (method === 'PUT')
          draft = {
            ...draft,
            revision: draft.revision + 1,
            files: input.files.length ? input.files : draft.files,
          };
        return send(draft);
      }
      // 私有页仅用于验证创建者开关；其余私有操作不会被调用。
      if (path === '/sessions/original/sharing') {
        if (method === 'PUT') {
          assert.equal(canManage, true);
          published = input.public;
        }
        return send({ public: published, shareId: published ? 'share' : null, canManage });
      }
      if (path === '/sessions/original/message-queue') return send({ items: [] });
      if (path === '/sessions/original')
        return send({ ...session, workspaceId: 'ws', activeRunId: null, activeRunStatus: null });
      if (path === '/workspaces/ws')
        return send({ workspaceId: 'ws', name: '工作区', target: 'h5', status: 'ready' });
      if (path === '/workspaces/ws/sessions')
        return send(null, { rows: [{ ...session, sessionId: 'original' }], total: 1 });
      if (path === '/sessions/original/files') return send({ fileRevision: 0, files: [] });
      if (path === '/sessions/original/timeline')
        return send({ entries: [], nextSeq: 0, previousSeq: 0, hasMore: false });
      if (path === '/sessions/original/previews')
        return send({ current: null, lastReady: null, entries: [], fileRevision: 0 });
      if (path.endsWith('/events')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end();
        return;
      }
      return send(null, { rows: [], total: 0 });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwrightPath).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error: Error) => pageErrors.push(error.stack ?? error.message));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(`${origin}/?view=plaza`);
    await page.getByRole('button', { name: '查看会话', exact: true }).click();
    await page.getByText('页面已生成', { exact: true }).waitFor();
    assert.equal(await page.locator('.composer').count(), 0);
    assert.equal(await page.getByRole('button', { name: '应用到当前工作区' }).count(), 0);
    await page.getByRole('button', { name: '加载更早记录' }).click();
    await page.getByText('更早的需求', { exact: true }).waitFor();
    await page.locator('.conversation-round-process summary').first().click();
    await page.getByRole('button', { name: /查看子 Agent/ }).click();
    await page.locator('.subagent-drawer').waitFor();
    await page.locator('.subagent-drawer .ant-drawer-close').click();
    await page.getByRole('tab', { name: '产物 (2)', exact: true }).click();
    await page.getByText('export default 1;', { exact: false }).waitFor();
    await page.getByRole('combobox', { name: '选择产物' }).click();
    await page
      .locator('.ant-select-item-option-content')
      .getByText('image.png', { exact: true })
      .click();
    await page.locator('img[src="/api/d2c/plaza/sessions/share/files/image"]').waitFor();
    assert.equal(
      calls.some((call) => /^\/sessions\//.test(call.path)),
      false,
    );
    await page.getByRole('button', { name: '在线编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '测试副本源码' }).fill('my independent edit');
    assert.equal(await page.getByRole('button', { name: '应用到当前工作区' }).count(), 0);
    await page.getByRole('button', { name: '保存到我的作品', exact: true }).click();
    await page.getByRole('link', { name: '查看作品', exact: true }).waitFor();
    assert.equal(work.revision, 1);
    assert.ok(
      calls.some(
        (call) => call.path === '/plaza/sessions/share/edit/draft' && call.method === 'PUT',
      ),
    );
    await page.getByRole('link', { name: '查看作品', exact: true }).click();
    await page.getByRole('button', { name: '再次编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '测试副本源码' }).fill('reedit my work');
    await page.getByRole('button', { name: '保存到我的作品', exact: true }).click();
    await page.getByRole('link', { name: '查看作品', exact: true }).waitFor();
    assert.equal(work.revision, 2);
    assert.ok(
      calls.some(
        (call) => call.path === '/my-works/work/edit/draft/save' && call.method === 'POST',
      ),
    );
    assert.equal(
      calls.some((call) => /\/(apply|pause|resume)(?:$|\?)/.test(call.path)),
      false,
    );
    await page.getByRole('button', { name: '退出', exact: true }).click();
    // 同一作品库集合能重新找到保存副本。
    await page.getByRole('button', { name: '返回我的作品', exact: true }).click();
    await page.getByRole('button', { name: '我的副本', exact: true }).waitFor();
    // 发布开关只在服务端判定创建者时出现。
    await page.goto(`${origin}/?workspace=ws&session=original`);
    try {
      await page.getByRole('button', { name: '发布到广场', exact: true }).click({ timeout: 10000 });
    } catch (error) {
      throw new Error(
        `发布入口不可见：${await page.locator('body').innerText()}; 错误=${JSON.stringify(pageErrors)}; 请求=${JSON.stringify(calls.slice(-12))}`,
        { cause: error },
      );
    }
    await page.getByRole('button', { name: '从广场下架', exact: true }).waitFor();
    assert.equal(published, true);
    await page.getByRole('button', { name: '从广场下架', exact: true }).click();
    await page.getByRole('button', { name: '发布到广场', exact: true }).waitFor();
    assert.equal(published, false);
    canManage = false;
    await page.reload();
    await page.getByRole('button', { name: '执行诊断', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '发布到广场', exact: true }).count(), 0);
  },
);
