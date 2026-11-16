import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Always resolve the pinned browser beside this script, independent of HOME or parent env. */
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('./.browsers', import.meta.url));

const errors = new Set();
const missing = new Set();
/** Bounded diagnostics contain resource locations only, never console messages or stacks. */
function asset(value) {
  if (missing.size < 2000) missing.add(value.slice(0, 2048));
}
/** Read only the bounded host manifest. Generated scripts never execute in Node. */
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 192 * 1024 * 1024) throw new Error('input limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

let browser;
let server;
const deadline = setTimeout(() => process.exit(124), 40_000);
try {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('PREVIEW_CAPTURE_DEPENDENCY_UNAVAILABLE');
  }
  if (!existsSync(chromium.executablePath()))
    throw new Error('PREVIEW_CAPTURE_BROWSER_NOT_INSTALLED');
  const input = await readInput();
  const assetBase = new URL(input.assetBase);
  if (
    !/^https?:$/.test(assetBase.protocol) ||
    assetBase.username ||
    assetBase.password ||
    assetBase.search ||
    assetBase.hash
  )
    throw new Error('invalid asset base');
  const files = new Map(
    input.files.map((file) => [
      file.path,
      {
        content: Buffer.from(file.content, 'base64'),
        mimeType: file.mimeType,
      },
    ]),
  );
  const cdn = new Map(
    (input.assets ?? []).map((file) => [
      file.url,
      {
        content: Buffer.from(file.content, 'base64'),
        mimeType: file.mimeType,
      },
    ]),
  );
  let origin;
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, origin).pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = pathname.startsWith('/dist/') && files.get(pathname.slice(6));
    if (!file) {
      asset(pathname);
      response.writeHead(404).end();
      return;
    }
    if (
      file.mimeType.startsWith('text/html') &&
      (pathname !== '/dist/index.html' || request.headers['sec-fetch-dest'] !== 'document')
    ) {
      response.writeHead(403).end();
      return;
    }
    const base = `${origin}/dist/`;
    response.setHeader(
      'Content-Security-Policy',
      `sandbox allow-scripts; default-src 'none'; script-src ${base}; style-src 'unsafe-inline' ${base}; img-src ${base} data: blob: ${assetBase.href}; font-src ${base} data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    );
    response.setHeader('Content-Type', file.mimeType);
    response.end(file.content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  /** Use the version-matched local Chromium; CSP and routing enforce the page boundary. */
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: [
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--no-proxy-server',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
  } catch {
    throw new Error('PREVIEW_CAPTURE_BROWSER_LAUNCH_FAILED');
  }
  const context = await browser.newContext({
    viewport: { width: input.width, height: 900 },
    deviceScaleFactor: 1,
    /**
     * Opaque sandbox + worker-src none already forbid service workers. Playwright's
     * 'block' initializer reads navigator.serviceWorker and throws in an opaque frame.
     */
    acceptDownloads: false,
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      request.method() === 'GET' &&
      url.pathname.startsWith('/dist/') &&
      !url.search
    ) {
      await route.continue();
    } else if (
      cdn.has(url.href) &&
      request.method() === 'GET' &&
      request.resourceType() === 'image'
    ) {
      const file = cdn.get(url.href);
      await route.fulfill({
        status: 200,
        body: file.content,
        contentType: file.mimeType,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    } else {
      asset(request.url());
      errors.add(
        url.origin === assetBase.origin && url.href.startsWith(assetBase.href)
          ? 'CDN_ASSET_NOT_PREFETCHED'
          : 'NETWORK_BLOCKED',
      );
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  page.on('pageerror', () => errors.add('PAGE_RUNTIME_ERROR'));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.add('PAGE_CONSOLE_ERROR');
  });
  page.on('requestfailed', (request) => asset(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) asset(response.url());
  });
  /**
   * The fresh top-level document is itself opaque via the response CSP sandbox.
   * There is no parent app or authenticated browsing context in this browser.
   */
  await page.goto(`${origin}/dist/index.html`, { waitUntil: 'load', timeout: 10_000 });
  const frame = page.mainFrame();
  const cdp = await context.newCDPSession(page);
  let height = 900;
  let truncated = false;
  /** Measure inside the opaque renderer without reading generated code on the host. */
  async function measure() {
    return frame.evaluate(() => ({
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      nested: [...document.querySelectorAll('*')].some(
        (element) =>
          element.clientHeight > 0 &&
          element.scrollHeight > element.clientHeight + 1 &&
          /^(auto|scroll)$/.test(getComputedStyle(element).overflowY),
      ),
    }));
  }
  /**
   * Keep the layout viewport fixed at input.width x 900 for the entire capture.
   * Scroll only to trigger lazy assets; never resize viewport/DOM to match scrollHeight.
   */
  for (let pass = 0; pass < 2; pass++) {
    const dimensions = await measure();
    const limit = Math.min(12000, Math.max(900, dimensions.height));
    for (let y = 0; y < limit; y += 800) {
      await frame.evaluate((y) => window.scrollTo({ left: 0, top: y, behavior: 'instant' }), y);
      await page.waitForTimeout(30);
    }
    await frame.evaluate(async () => {
      await Promise.race([
        Promise.all([
          document.fonts.ready,
          ...Array.from(document.images, (image) =>
            image.complete
              ? undefined
              : new Promise((resolve) => {
                  image.addEventListener('load', resolve, { once: true });
                  image.addEventListener('error', resolve, { once: true });
                }),
          ),
        ]),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    });
  }
  await frame.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
  await page.waitForTimeout(150);
  const dimensions = await measure();
  height = Math.min(12000, Math.max(900, Math.ceil(dimensions.height)));
  truncated = dimensions.height > height || dimensions.nested;
  if (dimensions.nested) errors.add('NESTED_SCROLL_CONTAINER_CLIPPED');
  if (dimensions.height > height) errors.add('SCREENSHOT_HEIGHT_LIMIT');
  const broken = await frame.evaluate(() =>
    [...document.images]
      .filter((image) => !image.complete || image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src),
  );
  for (const url of broken) asset(url);
  let image;
  /** Crop height instead of recompressing/rescaling PNGs that exceed the byte budget. */
  for (;;) {
    /**
     * Capture beyond the viewport without Emulation.setDeviceMetricsOverride or layout
     * resizing. Clip bounds limit raster size while CSS vh retains its 900px reference.
     */
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: input.width, height, scale: 1 },
    });
    image = Buffer.from(result.data, 'base64');
    if (image.length <= 10 * 1024 * 1024) break;
    if (height <= 900) throw new Error('output limit');
    height = Math.max(900, Math.floor(height / 2));
    truncated = true;
    errors.add('SCREENSHOT_BYTE_LIMIT');
  }
  process.stdout.write(
    JSON.stringify({
      image: image.toString('base64'),
      width: input.width,
      height,
      truncated,
      errors: [...errors].slice(0, 100).map((code) => ({ code })),
      missingAssets: [...missing],
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error:
        error?.name === 'TimeoutError'
          ? 'PREVIEW_CAPTURE_TIMEOUT'
          : [
                'PREVIEW_CAPTURE_DEPENDENCY_UNAVAILABLE',
                'PREVIEW_CAPTURE_BROWSER_NOT_INSTALLED',
                'PREVIEW_CAPTURE_BROWSER_LAUNCH_FAILED',
              ].includes(error?.message)
            ? error.message
            : 'PREVIEW_CAPTURE_FAILED',
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    server?.close();
    clearTimeout(deadline);
  }
}
