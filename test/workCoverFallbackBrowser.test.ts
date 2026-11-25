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

test(
  '广场WebP封面坏图回退原图，均失败时占位且不循环重试，长图仍可滚动',
  {
    skip:
      process.env.PIXELPRINT_BROWSER_TESTS !== '1' ||
      !existsSync(chrome) ||
      !existsSync(playwright),
    timeout: 30000,
  },
  async (t) => {
    const bundle = await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import WorkCover from './web/src/workspace/WorkCover';
    const root=createRoot(document.getElementById('root'));window.opened=0;
    window.mount=(broken=false)=>root.render(<article className="library-work-card"><WorkCover url={broken?'/both.webp':'/small.webp'} fallbackUrl={broken?'/missing.png':'/original.svg'} name="长图" onOpen={()=>window.opened++}/></article>);window.mount();`,
      },
      bundle: true,
      write: false,
      outfile: '/tmp/work-cover-fallback/app.js',
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    const counts = new Map<string, number>();
    const server = createServer((req, res) => {
      const url = req.url!;
      counts.set(url, (counts.get(url) ?? 0) + 1);
      if (url === '/app.js' || url === '/app.css') {
        const extension = url.slice(4);
        res.setHeader('Content-Type', extension === '.js' ? 'text/javascript' : 'text/css');
        res.end(bundle.outputFiles.find((file) => file.path.endsWith(extension))!.text);
      } else if (url === '/original.svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="2400"><rect width="320" height="2400" fill="#aac1e8"/></svg>',
        );
      } else if (url.endsWith('.webp') || url.endsWith('.png')) res.writeHead(404).end();
      else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(async () => {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => {
      const img = document.querySelector('img');
      return img?.getAttribute('src') === '/original.svg' && img.complete && img.naturalWidth > 0;
    });
    assert.equal(counts.get('/small.webp'), 1);
    assert.equal(counts.get('/original.svg'), 1);
    const image = page.locator('.work-cover-image');
    await image.evaluate((element: HTMLElement) => (element.scrollTop = 100));
    assert.ok(await image.evaluate((element: HTMLElement) => element.scrollTop > 0));
    await page.getByRole('button', { name: '打开作品：长图' }).click();
    assert.equal(await page.evaluate(() => (window as any).opened), 1);
    await page.evaluate(() => (window as any).mount(true));
    await page.getByText('暂无运行截图', { exact: true }).waitFor();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(counts.get('/both.webp'), 1);
    assert.equal(counts.get('/missing.png'), 1);
  },
);
