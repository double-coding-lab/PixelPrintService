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

test(
  '进行中会话快捷入口按需刷新、分页直达、保留导航保护并适配窄屏',
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
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';
 import ActiveSessions from './web/src/workspace/ActiveSessions';import {TeamProvider} from './web/src/workspace/TeamSettings';import {createAppHistory} from './web/src/workspace/appRoutes';
 import './web/src/styles.css';import './web/src/workspace/appNavigation.css';
 window.allowLeave=true;window.dirty=false;window.navigationCalls=0;
 const history=createAppHistory(window,{isBlocked:()=>window.dirty,canLeave:async()=>window.allowLeave,onRoute:route=>{window.currentRoute=route;window.setCurrent?.(route.sessionId||'')}});
 function Harness(){const [busy,setBusy]=useState(false);const [current,setCurrent]=useState('');window.setCurrent=setCurrent;window.setBusy=setBusy;
 return <ConfigProvider><App><TeamProvider><header className="app-header"><div className="header-leading"><strong>PixelPrint</strong><nav className="primary-navigation"><button>工作台</button><button>作品库</button><button>广场</button></nav></div><div className="header-actions"><ActiveSessions blocked={busy} currentSessionId={current} onSelect={async(workspaceId,sessionId)=>{window.navigationCalls++;return history.navigate({view:'workbench',workspaceId,sessionId})}}/></div></header></TeamProvider></App></ConfigProvider>}
 createRoot(document.getElementById('root')).render(<Harness/>);`,
        resolveDir: root,
        loader: 'tsx',
      },
      bundle: true,
      write: false,
      outfile: '/tmp/active-sessions-browser/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const script = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text,
      css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text || '';
    const allRows = Array.from({ length: 22 }, (_, n) => ({
      sessionId: 'session-' + n,
      workspaceId: 'workspace-team',
      name: '活动会话' + n,
      workspaceName: '首页还原',
      teamId: 'team-a',
      target: n % 2 ? 'rn' : 'h5',
      runId: 'run-' + n,
      status: n === 0 ? 'waiting_input' : n === 1 ? 'queued' : 'running',
      updatedAt: '2026-11-23T07:00:00Z',
    }));
    let rows = allRows,
      fail = false,
      requests = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/app.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(script);
        return;
      }
      if (url.pathname === '/app.css') {
        res.setHeader('Content-Type', 'text/css');
        res.end(css);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/d2c/sessions/active') {
          requests++;
          if (fail) {
            res.statusCode = 503;
            res.end(JSON.stringify({ success: false, resultMessage: '列表暂不可用' }));
            return;
          }
          const page = Number(url.searchParams.get('page') || 1);
          res.end(
            JSON.stringify({
              success: true,
              rows: rows.slice((page - 1) * 20, page * 20),
              total: rows.length,
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            success: true,
            rows: [{ teamId: 'team-a', name: '设计团队', memberCount: 2, isOwner: false }],
            total: 1,
            data: {},
          }),
        );
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
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
    await page.addInitScript(() => {
      const original = window.setInterval.bind(window),
        clear = window.clearInterval.bind(window);
      const callbacks = new Map<number, () => void>();
      window.setInterval = ((callback: () => void, delay: number, ...args: unknown[]) => {
        const n = original(callback, delay, ...args);
        if (delay === 15000) callbacks.set(n, callback);
        return n;
      }) as typeof window.setInterval;
      window.clearInterval = ((n?: number) => {
        callbacks.delete(n!);
        clear(n);
      }) as typeof window.clearInterval;
      (window as any).tickActive = () => callbacks.forEach((fn) => fn());
    });
    const port = (server.address() as { port: number }).port;
    await page.goto('http://127.0.0.1:' + port + '/plaza');
    const trigger = page.getByRole('button', { name: '进行中会话', exact: true });
    await trigger.waitFor();
    assert.equal(requests, 0, '收起时不读跨工作区列表');
    await trigger.click();
    const panel = page.getByRole('region', { name: '进行中会话' });
    await panel.getByRole('button', { name: /活动会话0 / }).waitFor();
    assert.ok((await panel.innerText()).includes('等待回答'));
    assert.ok((await panel.innerText()).includes('设计团队'));
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    const last = panel.getByRole('button', { name: /活动会话21 / });
    await last.waitFor();
    await page.evaluate(() => {
      (window as any).allowLeave = false;
      (window as any).dirty = true;
    });
    await last.click();
    assert.ok(page.url().endsWith('/plaza'));
    assert.equal(await panel.isVisible(), true, '草稿确认取消后保持入口和当前页面');
    await page.evaluate(() => {
      (window as any).setBusy(true);
    });
    await page.waitForFunction(
      () => document.querySelector<HTMLButtonElement>('.active-session-row')?.disabled,
    );
    assert.equal(await last.isDisabled(), true);
    await page.evaluate(() => {
      (window as any).setBusy(false);
      (window as any).allowLeave = true;
      (window as any).dirty = false;
    });
    await last.click();
    await page.waitForURL('**/workbench/workspace-team/sessions/session-21');
    await panel.waitFor({ state: 'hidden' });
    const previous = requests;
    await page.evaluate(() => (window as any).tickActive());
    assert.equal(requests, previous, '收起后取消轮询');
    await page.goBack();
    await page.waitForURL('**/plaza');
    await trigger.click();
    await panel.getByRole('button', { name: /活动会话0 / }).waitFor();
    rows = allRows.slice(1);
    await page.evaluate(() => (window as any).tickActive());
    await page.waitForFunction(
      () => !document.querySelector('.active-sessions-list')?.textContent?.includes('活动会话0'),
    );
    fail = true;
    await panel.getByRole('button', { name: '刷新进行中会话', exact: true }).click();
    await panel.getByText('列表暂不可用', { exact: true }).waitFor();
    assert.equal(await panel.locator('.active-session-row').count(), 0);
    fail = false;
    rows = [];
    await panel.getByRole('button', { name: '刷新进行中会话', exact: true }).click();
    await panel.getByText('暂无进行中的会话', { exact: true }).waitFor();
    rows = allRows;
    await panel.getByRole('button', { name: '刷新进行中会话', exact: true }).click();
    await panel.getByRole('button', { name: /活动会话0 / }).waitFor();
    await page.screenshot({ path: '/tmp/active-sessions-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await panel.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, '窄屏不横向溢出');
    await panel.getByRole('button', { name: '刷新进行中会话', exact: true }).focus();
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
  },
);
