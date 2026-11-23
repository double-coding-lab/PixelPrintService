import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playwright = fileURLToPath(
  new URL('../preview-browser/node_modules/playwright-core/index.mjs', import.meta.url),
);
test(
  '路径导航支持刷新、前后退与未保存/忙碌保护',
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
        contents: `
    import {createAppHistory,readAppRoute,appPath} from './web/src/workspace/appRoutes';
    window.blocked=false; window.allowed=false; window.confirmations=0;
    window.current=appPath(readAppRoute(new URL(location.href)));
    const history=createAppHistory(window,{
      isBlocked:()=>window.blocked,
      canLeave:async()=>{if(window.blocked){window.confirmations++;return window.allowed;}return true;},
      onRoute:route=>{window.current=appPath(route);}
    });
    window.go=route=>history.navigate(route);
  `,
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
    });
    const server = createServer((req, res) => {
      res.setHeader(
        'Content-Type',
        req.url === '/bundle.js' ? 'application/javascript' : 'text/html',
      );
      res.end(
        req.url === '/bundle.js'
          ? bundle.outputFiles[0].text
          : '<!doctype html><html><body><script src="/bundle.js"></script></body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ headless: true, executablePath: chrome });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin + '/?view=plaza&share=first');
    await page.waitForFunction('window.current === "/plaza/first"');
    assert.equal(new URL(page.url()).pathname, '/plaza/first');
    await page.evaluate('window.go({view:"works"})');
    await page.evaluate('window.go({view:"works",versionId:"v1"})');
    await page.goBack();
    await page.waitForFunction('window.current === "/works"');
    await page.goForward();
    await page.waitForFunction('window.current === "/works/versions/v1"');
    await page.evaluate('window.blocked=true;window.allowed=false;history.back()');
    await page.waitForFunction(
      'window.confirmations === 1 && location.pathname === "/works/versions/v1"',
    );
    assert.equal(await page.evaluate('window.current'), '/works/versions/v1');
    assert.equal(await page.evaluate('window.go({view:"plaza"})'), false);
    await page.evaluate('window.allowed=true;history.back()');
    await page.waitForFunction('window.current === "/works" && location.pathname === "/works"');
    await page.evaluate('window.blocked=false;history.forward()');
    await page.waitForFunction('window.current === "/works/versions/v1"');
    await page.reload();
    await page.waitForFunction('window.current === "/works/versions/v1"');
    await page.evaluate('window.go({view:"workbench",workspaceId:"w",sessionId:"s"})');
    assert.equal(new URL(page.url()).pathname, '/workbench/w/sessions/s');
    await page.reload();
    await page.waitForFunction('window.current === "/workbench/w/sessions/s"');
    await page.evaluate('window.go({view:"my-works",resourceId:"saved-a"})');
    await page.waitForFunction('window.current === "/plaza/saved/saved-a"');
    await page.evaluate('window.go({view:"plaza",resourceId:"shared-a"})');
    await page.goBack();
    await page.waitForFunction('window.current === "/plaza/saved/saved-a"');
    await page.reload();
    await page.waitForFunction('window.current === "/plaza/saved/saved-a"');
    for (const legacy of ['/works/saved', '/works/saved/old', '/?view=my-works&work=old']) {
      await page.goto(origin + legacy);
      await page.waitForFunction('location.pathname.startsWith("/plaza/saved")');
      assert.equal(new URL(page.url()).search, '');
      assert.equal(
        await page.evaluate('window.current'),
        legacy.endsWith('/saved') ? '/plaza/saved' : '/plaza/saved/old',
      );
    }
  },
);

/** Mount the real app/history/confirmation flow; business panels are offline boundary fixtures. */
test(
  '真实主导航将已保存作品归属广场，分类切换保留离开保护及删除后的强制返回',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 60000,
  },
  async (t) => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../web/src/main.tsx', import.meta.url))],
      bundle: true,
      write: false,
      outfile: '/tmp/plaza-navigation/app.js',
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'offline-business-panels',
          setup(builder) {
            builder.onResolve(
              {
                filter:
                  /^\.\/workspace\/(?:CommunityPanel|WorkspacePanel|WorkspaceHome|WorkspaceSwitcher|WorksPanel|CredentialSettings|TeamSettings)$/,
              },
              ({ path }) => ({
                path: path.split('/').pop()!,
                namespace: 'fixture',
              }),
            );
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
              loader: 'tsx',
              resolveDir: root,
              contents:
                path === 'TeamSettings'
                  ? `export const TeamProvider=({children})=>children;export default function Settings(){return null}`
                  : path === 'CommunityPanel'
                    ? `import React from 'react'; export default function Panel({kind,resourceId,onSelect,onDirty,onBusy,onDeleted,plazaScope='all',onScopeChange,onKindChange,navigationDisabled}){return <section data-testid="community" data-kind={kind} data-resource={resourceId} data-scope={plazaScope}>
                {!resourceId && <nav aria-label="广场分类">{[['all','全部作品'],['mine','我发布的作品'],['saved','已保存作品']].map(([value,label])=><button key={value} disabled={navigationDisabled} aria-current={(value==='saved'?kind==='my-works':kind==='plaza'&&plazaScope===value)?'page':undefined} onClick={()=>{if(value==='saved'){if(kind!=='my-works')onKindChange?.('my-works');}else{onScopeChange?.(value);if(kind!=='plaza')onKindChange?.('plaza');}}}>{label}</button>)}</nav>}
                <button onClick={()=>onSelect('item-a')}>打开详情</button>
                <button onClick={()=>onDirty?.(true)}>修改未保存</button>
                <button onClick={()=>onBusy?.(true)}>开始保存</button>
                <button onClick={()=>onBusy?.(false)}>结束保存</button>
                <button onClick={()=>onDeleted?.()}>删除成功返回</button>
              </section>}`
                    : path === 'WorksPanel'
                      ? `import React from 'react';export default function Works({onOpenSession}){return <section data-testid="versions">会话版本列表<button onClick={()=>onOpenSession('source-workspace','source-session')}>查看来源会话</button></section>}`
                      : `export default function Empty(){return null}`,
            }));
          },
        },
      ],
    });
    const server = createServer((req, res) => {
      if (req.url === '/app.js' || req.url === '/app.css') {
        const extension = req.url.endsWith('.js') ? '.js' : '.css';
        res.setHeader('Content-Type', extension === '.js' ? 'text/javascript' : 'text/css');
        return res.end(bundle.outputFiles.find((file) => file.path.endsWith(extension))!.text);
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ headless: true, executablePath: chrome });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.goto(origin + '/works/saved/work-a');
    const mainNav = page.getByRole('navigation', { name: '主导航', exact: true });
    const plazaNav = page.getByRole('navigation', { name: '广场分类', exact: true });
    await page.waitForURL(origin + '/plaza/saved/work-a');
    await page.locator('[data-kind="my-works"][data-resource="work-a"]').waitFor();
    assert.equal(
      await mainNav.getByRole('button', { name: '广场', exact: true }).getAttribute('aria-current'),
      'page',
    );
    assert.equal(
      await mainNav
        .getByRole('button', { name: '作品库', exact: true })
        .getAttribute('aria-current'),
      null,
    );
    assert.equal(await plazaNav.count(), 0, '详情不显示分类导航');
    await mainNav.getByRole('button', { name: '作品库', exact: true }).click();
    await page.locator('[data-testid="versions"]').waitFor();
    assert.equal(new URL(page.url()).pathname, '/works');
    await page.getByRole('button', { name: '查看来源会话', exact: true }).click();
    await page.waitForURL(origin + '/workbench/source-workspace/sessions/source-session');
    await page.goBack();
    await page.waitForURL(origin + '/works');
    assert.equal(await page.getByRole('button', { name: '已保存作品', exact: true }).count(), 0);
    await mainNav.getByRole('button', { name: '广场', exact: true }).click();
    await page.waitForURL(origin + '/plaza');
    await plazaNav.getByRole('button', { name: '已保存作品', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved');
    assert.equal(await plazaNav.count(), 1);
    assert.equal(await page.locator('.plaza-navigation').count(), 0);
    await plazaNav.getByRole('button', { name: '我发布的作品', exact: true }).click();
    await page.waitForURL(origin + '/plaza');
    await plazaNav.getByRole('button', { name: '已保存作品', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved');
    assert.equal(
      await page.locator('[data-testid="community"]').getAttribute('data-scope'),
      'mine',
    );
    await mainNav.getByRole('button', { name: '广场', exact: true }).click();
    await page.waitForURL(origin + '/plaza');
    assert.equal(
      await plazaNav
        .getByRole('button', { name: '我发布的作品', exact: true })
        .getAttribute('aria-current'),
      'page',
      '跨分类重新进入广场保留 mine',
    );
    await plazaNav.getByRole('button', { name: '已保存作品', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved');
    await page.getByRole('button', { name: '打开详情', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved/item-a');
    await page.getByRole('button', { name: '修改未保存', exact: true }).click();
    await mainNav.getByRole('button', { name: '广场', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).pathname, '/plaza/saved/item-a');
    await page.goBack();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForURL(origin + '/plaza/saved/item-a');
    await page.getByRole('button', { name: '开始保存', exact: true }).click();
    assert.equal(await plazaNav.count(), 0, '忙碌详情仍无分类导航');
    assert.equal(
      await mainNav.getByRole('button', { name: '作品库', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '结束保存', exact: true }).click();
    const historyLength = await page.evaluate(() => history.length);
    await page.getByRole('button', { name: '删除成功返回', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(
      await page.evaluate(() => history.length),
      historyLength,
      '删除后替换失效详情，不新增历史条目',
    );
    await page.getByRole('button', { name: '开始保存', exact: true }).click();
    assert.equal(
      await plazaNav.getByRole('button', { name: '全部作品', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: '结束保存', exact: true }).click();
    await page.getByRole('button', { name: '修改未保存', exact: true }).click();
    await plazaNav.getByRole('button', { name: '全部作品', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /取\s*消/ })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(new URL(page.url()).pathname, '/plaza/saved');
    await plazaNav.getByRole('button', { name: '全部作品', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '放弃并进入', exact: true }).click();
    await page.waitForURL(origin + '/plaza');
    await page.goBack();
    await page.waitForURL(origin + '/plaza/saved');
    await page.goForward();
    await page.waitForURL(origin + '/plaza');
    await page.setViewportSize({ width: 390, height: 844 });
    await plazaNav.getByRole('button', { name: '已保存作品', exact: true }).click();
    await page.waitForURL(origin + '/plaza/saved');
    assert.deepEqual(errors, []);
  },
);
