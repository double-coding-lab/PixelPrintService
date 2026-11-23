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

/** 验证列表更新与图片重试相互独立，同修订更新不丢失已显示的图片。 */
test(
  '设计稿截图：列表自动更新保留原图，失败可重试，窄面板仅保留全屏操作',
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
        resolveDir: root,
        loader: 'tsx',
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
          import {flushSync} from 'react-dom';
          import DesignReferencePanel from './web/src/workspace/DesignReferencePanel';
          import './web/src/workspace/designReference.css';
          import './web/src/workspace/phonePreview.css';
          function Fixture({broken=false}){
            const [loading,setLoading]=useState(false); const [revision,setRevision]=useState(1);
            const file={fileId:'reference',path:'design-reference/root-69_1739.png',kind:'attachment',
              size:100,revision,url:broken?'/broken.png':'/reference.png'};
            window.startRefresh=()=>setLoading(true);
            window.finishRefresh=(next=1)=>{setRevision(next);setLoading(false)};
            return <DesignReferencePanel files={[file]} loading={loading}/>;
          }
          const root=createRoot(document.getElementById('root'));let epoch=0;
          window.mount=(props={})=>{flushSync(()=>root.render(<Fixture key={++epoch} {...props}/>))};
          window.mount();`,
      },
      bundle: true,
      write: false,
      outfile: '/tmp/design-reference-fixture/app.js',
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    let broken = true;
    const server = createServer((req, res) => {
      if (req.url === '/app.js' || req.url === '/app.css') {
        const extension = req.url.slice(4);
        res.setHeader('Content-Type', extension === '.js' ? 'text/javascript' : 'text/css');
        res.end(bundle.outputFiles.find((file) => file.path.endsWith(extension))!.text);
      } else if (req.url?.endsWith('.png')) {
        if (req.url === '/broken.png' && broken) {
          res.writeHead(503).end();
          return;
        }
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="375" height="1100"><rect width="375" height="1100" fill="#c3d4f7"/></svg>',
        );
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<link rel="stylesheet" href="/app.css"><style>body{margin:0;font-family:system-ui}.icon{width:16px;height:16px}#root{max-width:540px}</style><div id="root"></div><script src="/app.js"></script>',
        );
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 960 } });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const fullscreen = page.getByRole('button', { name: '全屏预览', exact: true });
    await page.waitForFunction(
      () => !document.querySelector('.phone-preview-shell')?.classList.contains('is-pending'),
    );
    await page
      .locator('.design-reference-canvas img')
      .evaluate((image: HTMLElement) => (image.dataset.original = 'yes'));
    assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).count(), 0);
    await page.evaluate(() => (window as any).startRefresh());
    assert.equal(await fullscreen.isEnabled(), true);
    assert.equal(await page.getByRole('status').count(), 0);
    await page.evaluate(() => (window as any).finishRefresh());
    assert.equal(
      await page.locator('.design-reference-canvas img').getAttribute('data-original'),
      'yes',
    );
    await page.evaluate(() => (window as any).finishRefresh(2));
    await page.getByText('图片修订 r2', { exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.phone-preview-shell')?.classList.contains('is-pending'),
    );
    for (const width of [540, 360]) {
      await page.setViewportSize({ width, height: 960 });
      if (width === 540 && process.env.PIXELPRINT_SCREENSHOT) {
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.design-reference-meta').length === 1 &&
            !document
              .querySelector('.design-reference-actions button:last-child')
              ?.hasAttribute('disabled'),
        );
        await page.screenshot({ path: process.env.PIXELPRINT_SCREENSHOT });
      }
      const boxes = await page
        .locator('.design-reference-actions button')
        .evaluateAll((buttons: HTMLElement[]) =>
          buttons.map((button) => {
            const box = button.getBoundingClientRect();
            return { top: box.top, right: box.right };
          }),
        );
      assert.equal(boxes.length, 1);
      assert.ok(boxes.every((box: { right: number }) => box.right <= width));
    }
    await page.evaluate(() => (window as any).mount({ broken: true }));
    await page.getByText('设计稿截图暂不可用', { exact: true }).waitFor();
    broken = false;
    await page.getByRole('button', { name: '重新加载图片', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.phone-preview-shell')?.classList.contains('is-pending'),
    );
    assert.equal(await page.getByText('设计稿截图暂不可用', { exact: true }).count(), 0);
    await page.evaluate(() => (window as any).mount());
    assert.equal(await page.getByRole('button', { name: /刷新|检查更新/ }).count(), 0);
  },
);
