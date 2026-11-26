import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);
type Route = {
  request(): { url(): string; method(): string; postDataJSON(): Record<string, unknown> };
  fulfill(input: {
    status?: number;
    json?: unknown;
    contentType?: string;
    body?: string;
  }): Promise<void>;
};

/** 真实入口与 CSS：提示存在时仍可点击，弹层互斥及创建导航保留未保存保护。 */
test(
  '提示穿透、互斥浮层、团队带回工作区及返回根首页',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 90000,
  },
  async (t) => {
    const bundle = await build({
      entryPoints: [root + '/web/src/main.tsx'],
      bundle: true,
      write: false,
      outdir: '/tmp/pixelprint-header-bundle',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'isolated-editor',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/CodeEditor$/ }, () => ({
              path: 'editor',
              namespace: 'stub',
            }));
            builder.onResolve({ filter: /^\.\/SessionPanel$/ }, () => ({
              path: 'session',
              namespace: 'stub',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
              contents:
                args.path === 'session'
                  ? 'import React,{useState} from "react";export default function Session(p){const [v,set]=useState("");return <input aria-label="测试会话草稿" value={v} onChange={e=>{set(e.target.value);p.onDirty(!!e.target.value)}}/>}'
                  : 'export default function Editor(){return null}',
              loader: 'tsx',
              resolveDir: root,
            }));
          },
        },
      ],
    });
    const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
    const css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
    const server = createServer((req, res) => {
      const asset = req.url === '/app.js' ? js : req.url === '/app.css' ? css : null;
      res.setHeader(
        'Content-Type',
        req.url === '/app.js'
          ? 'text/javascript'
          : req.url === '/app.css'
            ? 'text/css'
            : 'text/html; charset=utf-8',
      );
      res.end(
        asset ??
          (req.url === '/'
            ? '<h1>宣传首页</h1>'
            : '<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>'),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({
      headless: true,
      executablePath: chrome,
      chromiumSandbox: false,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
    const teams = [
      {
        teamId: 't1',
        name: '设计组',
        isOwner: true,
        memberCount: 1,
        createdUserId: 'owner',
        createdEid: 'owner',
      },
    ];
    const workspaces: Record<string, unknown>[] = [];
    const sessions: Record<string, unknown>[] = [];
    await page.route('**/auth/me', (route: Route) =>
      route.fulfill({
        json: { userId: 'owner', name: 'Owner', provider: 'local', githubEnabled: true },
      }),
    );
    await page.route('**/api/d2c/**', async (route: Route) => {
      const request = route.request();
      const u = new URL(request.url());
      const path = u.pathname.slice('/api/d2c'.length);
      const method = request.method();
      const body = method === 'GET' ? {} : (request.postDataJSON() ?? {});
      calls.push({ path, method, body });
      let data: unknown;
      if (path === '/teams' && method === 'POST') {
        data = {
          teamId: 't-new',
          name: String(body.name),
          isOwner: true,
          memberCount: 1,
          createdUserId: 'owner',
          createdEid: 'owner',
        };
        teams.push(data as (typeof teams)[number]);
      } else if (path === '/teams')
        return route.fulfill({ json: { success: true, rows: teams, total: teams.length } });
      else if (path.startsWith('/teams/'))
        data = {
          ...teams.find((x) => x.teamId === path.split('/')[2]),
          members: [{ userId: 'owner', eid: 'owner', role: 'owner' }],
        };
      else if (path === '/credentials/figma/status' || path === '/credentials/figma')
        data = { configured: true, credentialId: 'c1', revision: 2 };
      else if (path === '/credentials/model/status') data = { configured: false, modelName: '' };
      else if (path === '/sessions/active')
        return route.fulfill({ json: { success: true, rows: [], total: 0 } });
      else if (path === '/workspaces' && method === 'POST') {
        data = {
          workspaceId: 'w-new',
          name: body.name,
          teamId: body.teamId,
          status: 'ready',
          configRevision: 1,
          resource: null,
          isOwner: true,
        };
        workspaces.push(data as Record<string, unknown>);
      } else if (path === '/workspaces')
        return route.fulfill({
          json: { success: true, rows: workspaces, total: workspaces.length },
        });
      else if (path === '/workspaces/w-new') data = workspaces[0];
      else if (path === '/workspaces/w-new/sessions' && method === 'POST') {
        data = {
          sessionId: 's-new',
          workspaceId: 'w-new',
          name: body.name,
          target: 'h5',
          status: 'idle',
        };
        sessions.push(data as Record<string, unknown>);
      } else if (path === '/workspaces/w-new/sessions')
        return route.fulfill({ json: { success: true, rows: sessions, total: sessions.length } });
      else data = {};
      return route.fulfill({ json: { success: true, data } });
    });
    const base = 'http://127.0.0.1:' + String((server.address() as { port: number }).port);
    await page.goto(base + '/workbench');
    await page.getByRole('button', { name: 'Figma 凭据' }).click();
    await page.getByLabel('Figma Token', { exact: true }).fill('fixture-not-a-real-token');
    await page.getByRole('button', { name: '保存凭据', exact: true }).click();
    await page.getByText('Figma 凭据已加密保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '进行中会话', exact: true }).click({ timeout: 800 });
    assert.equal(
      await page.getByRole('button', { name: 'Figma 凭据' }).getAttribute('aria-expanded'),
      'false',
    );
    assert.equal(
      await page
        .getByRole('button', { name: '进行中会话', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    if (existsSync(root + '/web/src/workspace/ModelCredentialSettings.tsx')) {
      await page.getByRole('button', { name: '模型凭据', exact: true }).click({ timeout: 800 });
      assert.equal(
        await page
          .getByRole('button', { name: '进行中会话', exact: true })
          .getAttribute('aria-expanded'),
        'false',
      );
      await page.getByLabel('模型 Token', { exact: true }).fill('fixture-secret');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '模型凭据', exact: true }).click();
      assert.equal(await page.getByLabel('模型 Token', { exact: true }).inputValue(), '');
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建工作区', exact: true }).click();
    await page.getByLabel('工作区名称', { exact: true }).fill('联动页面');
    await page.getByRole('dialog').getByRole('button', { name: '新建团队', exact: true }).click();
    await page.getByLabel('团队名称', { exact: true }).fill('新团队');
    await page.getByRole('button', { name: '创建团队', exact: true }).click();
    await page.getByLabel('工作区名称', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('工作区名称', { exact: true }).inputValue(), '联动页面');
    await page.waitForFunction(() =>
      document.querySelector('.workspace-team-choice')?.textContent?.includes('新团队'),
    );
    await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
    await page.waitForURL('**/workbench/w-new');
    assert.equal(
      calls.find((c) => c.path === '/workspaces' && c.method === 'POST')?.body.teamId,
      't-new',
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: '创建会话', exact: true }).click();
    await page.waitForURL('**/workbench/w-new/sessions/s-new');
    await page.getByLabel('测试会话草稿').fill('尚未保存的编辑');
    await page.getByRole('link', { name: '返回首页' }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.match(page.url(), /sessions\/s-new$/);
    await page.getByRole('link', { name: '返回首页' }).click();
    await page.getByRole('button', { name: '放弃修改并返回', exact: true }).click();
    await page.waitForURL(base + '/');
    await page.getByRole('heading', { name: '宣传首页' }).waitFor();
  },
);
