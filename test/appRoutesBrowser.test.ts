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
  },
);
