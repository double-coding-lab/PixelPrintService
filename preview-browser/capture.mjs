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

/** Validate the standalone process protocol too; never accept executable operations. */
function validInspection(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const css = (value) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    !/>>|(?:^|\s)(?:xpath|text|id|css)=|:has-text\(|:text\(/i.test(value);
  const number = (value, limit = 24000) =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
  if (
    Object.keys(options).some((key) => !['focusSelector', 'actions'].includes(key)) ||
    (options.focusSelector !== undefined && !css(options.focusSelector))
  )
    return false;
  if (options.actions === undefined) return true;
  if (!Array.isArray(options.actions) || options.actions.length > 12) return false;
  return options.actions.every((action) => {
    if (!action || typeof action !== 'object') return false;
    let allowed = ['type', 'selector'];
    if (action.type !== 'scroll' && !css(action.selector)) return false;
    if (action.type === 'click') {
      /* no extra parameters */
    } else if (action.type === 'swipe') {
      allowed.push('deltaX', 'deltaY', 'pointer', 'during');
      if (
        !number(action.deltaX, 1000) ||
        !number(action.deltaY, 1000) ||
        (!action.deltaX && !action.deltaY) ||
        (action.pointer !== undefined && !['touch', 'mouse'].includes(action.pointer)) ||
        (action.during !== undefined &&
          (!Array.isArray(action.during) ||
            action.during.length < 1 ||
            action.during.length > 3 ||
            !action.during.every(
              (sample, index, all) =>
                sample &&
                Object.keys(sample).length === 2 &&
                Number.isInteger(sample.atStep) &&
                sample.atStep >= 1 &&
                sample.atStep <= 11 &&
                (index === 0 || sample.atStep > all[index - 1].atStep) &&
                sample.expect?.type === 'expect' &&
                ['text', 'attribute'].includes(sample.expect.state) &&
                validInspection({ actions: [sample.expect] }),
            )))
      )
        return false;
    } else if (action.type === 'scroll') {
      allowed.push('x', 'y');
      if (
        (action.selector !== undefined && !css(action.selector)) ||
        !number(action.x) ||
        !number(action.y)
      )
        return false;
    } else if (action.type === 'expect') {
      allowed.push('state');
      if (action.state === 'visible') {
        /* no extra parameters */
      } else if (action.state === 'text') {
        allowed.push('text');
        if (typeof action.text !== 'string' || action.text.length > 256) return false;
      } else if (action.state === 'attribute') {
        allowed.push('attribute', 'value');
        if (
          typeof action.attribute !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(action.attribute) ||
          typeof action.value !== 'string' ||
          action.value.length > 256
        )
          return false;
      } else if (action.state === 'scrollLeft') {
        allowed.push('min', 'max');
        if (
          (action.min === undefined && action.max === undefined) ||
          (action.min !== undefined && !number(action.min)) ||
          (action.max !== undefined && !number(action.max)) ||
          (action.min !== undefined && action.max !== undefined && action.min > action.max)
        )
          return false;
      } else if (action.state === 'centered') {
        allowed.push('container', 'tolerance');
        if (
          !css(action.container) ||
          (action.tolerance !== undefined &&
            (!number(action.tolerance, 100) || action.tolerance < 0))
        )
          return false;
      } else return false;
    } else return false;
    return Object.keys(action).every((key) => allowed.includes(key));
  });
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
  if (input.inspection !== undefined && !validInspection(input.inspection))
    throw new Error('PREVIEW_CAPTURE_INVALID_INPUT');
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
    hasTouch:
      input.inspection?.actions?.some(
        (action) => action.type === 'swipe' && (action.pointer ?? 'touch') === 'touch',
      ) ?? false,
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
          element !== document.documentElement &&
          element !== document.body &&
          element.clientHeight > 0 &&
          element.clientWidth > 0 &&
          ((element.scrollHeight > element.clientHeight + 1 &&
            /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) ||
            (element.scrollWidth > element.clientWidth + 1 &&
              /^(auto|scroll)$/.test(getComputedStyle(element).overflowX))),
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
  const steps = [];
  const interactionStarted = Date.now();
  /** Native CSS resolution stays in the main preview frame and rejects ambiguous targets. */
  async function element(selector) {
    const result = await frame.evaluateHandle((selector) => {
      try {
        const nodes = document.querySelectorAll(selector);
        if (nodes.length !== 1) return nodes.length ? 'ambiguous_selector' : 'not_found';
        return nodes[0];
      } catch {
        return 'invalid_selector';
      }
    }, selector);
    const node = result.asElement();
    if (node) return node;
    const reason = await result.jsonValue();
    await result.dispose();
    throw new Error(reason);
  }
  /** No page exceptions or arbitrary DOM text escape the fixed result protocol. */
  async function perform(action, step) {
    let node;
    let container;
    const during = [];
    try {
      if (Date.now() - interactionStarted >= 18000) throw new Error('interaction_budget_exceeded');
      if (action.selector) node = await element(action.selector);
      if (action.type === 'expect') {
        if (action.state === 'centered') {
          container = await element(action.container);
          if (!(await node.isVisible()) || !(await container.isVisible()))
            throw new Error('not_visible');
        }
        const observed =
          action.state === 'centered'
            ? await node.evaluate((node, parent) => {
                const r = node.getBoundingClientRect();
                const c = parent.getBoundingClientRect();
                return Math.round((r.x + r.width / 2 - c.x - c.width / 2) * 100) / 100;
              }, container)
            : await node.evaluate((node, action) => {
                if (action.state === 'text') return (node.textContent ?? '').slice(0, 257);
                if (action.state === 'attribute')
                  return node.hasAttribute(action.attribute)
                    ? node.getAttribute(action.attribute).slice(0, 257)
                    : false;
                if (action.state === 'scrollLeft') return Math.round(node.scrollLeft * 100) / 100;
                const r = node.getBoundingClientRect();
                if (
                  !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
                  r.width <= 0 ||
                  r.height <= 0
                )
                  return false;
                let left = Math.max(0, r.left),
                  right = Math.min(innerWidth, r.right);
                let top = Math.max(0, r.top),
                  bottom = Math.min(innerHeight, r.bottom);
                let parent = node.parentElement;
                for (let depth = 0; parent && depth < 128; depth++, parent = parent.parentElement) {
                  if (parent === document.body || parent === document.documentElement) continue;
                  const style = getComputedStyle(parent);
                  const bounds = parent.getBoundingClientRect();
                  if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
                    left = Math.max(left, bounds.left);
                    right = Math.min(right, bounds.right);
                  }
                  if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
                    top = Math.max(top, bounds.top);
                    bottom = Math.min(bottom, bounds.bottom);
                  }
                }
                return !parent && left < right && top < bottom;
              }, action);
        const passed =
          action.state === 'visible'
            ? observed === true
            : action.state === 'text'
              ? observed === action.text
              : action.state === 'attribute'
                ? observed === action.value
                : action.state === 'centered'
                  ? Math.abs(observed) <= (action.tolerance ?? 5)
                  : (action.min === undefined || observed >= action.min) &&
                    (action.max === undefined || observed <= action.max);
        steps.push({
          step,
          type: action.type,
          passed,
          reason: passed ? 'matched' : 'assertion_failed',
          observed: typeof observed === 'string' ? observed.slice(0, 256) : observed,
        });
        return;
      }
      if (action.type === 'click') await node.click({ timeout: 1200, noWaitAfter: true });
      else if (action.type === 'scroll') {
        if (node)
          await node.evaluate(
            (node, action) => node.scrollTo({ left: action.x, top: action.y, behavior: 'instant' }),
            action,
          );
        else
          await frame.evaluate(
            (action) => window.scrollTo({ left: action.x, top: action.y, behavior: 'instant' }),
            action,
          );
      } else if (action.type === 'focus') {
        await node.scrollIntoViewIfNeeded({ timeout: 1200 });
      } else if (action.type === 'swipe') {
        await node.scrollIntoViewIfNeeded({ timeout: 1200 });
        const r = await node.boundingBox();
        if (!r || !(await node.isVisible())) throw new Error('not_visible');
        const left = Math.max(1, r.x) + 4;
        const right = Math.min(input.width - 1, r.x + r.width) - 4;
        const top = Math.max(1, r.y) + 4;
        const bottom = Math.min(899, r.y + r.height) - 4;
        if (Math.abs(action.deltaX) > right - left || Math.abs(action.deltaY) > bottom - top)
          throw new Error('gesture_out_of_bounds');
        const x = action.deltaX < 0 ? right : action.deltaX > 0 ? left : (left + right) / 2;
        const y = action.deltaY < 0 ? bottom : action.deltaY > 0 ? top : (top + bottom) / 2;
        const sampleBeforeRelease = async (atStep) => {
          const sample = action.during?.find((value) => value.atStep === atStep);
          if (!sample) return;
          const target = await element(sample.expect.selector);
          try {
            const observed = await target.evaluate(
              (node, expectation) =>
                expectation.state === 'text'
                  ? (node.textContent ?? '').slice(0, 257)
                  : (node.getAttribute(expectation.attribute)?.slice(0, 257) ?? false),
              sample.expect,
            );
            during.push({
              atStep,
              observed: typeof observed === 'string' ? observed.slice(0, 256) : observed,
            });
            if (
              observed !==
              (sample.expect.state === 'text' ? sample.expect.text : sample.expect.value)
            )
              throw new Error('assertion_failed');
          } finally {
            await target.dispose();
          }
        };
        if ((action.pointer ?? 'touch') === 'mouse') {
          await page.mouse.move(x, y);
          await page.mouse.down();
          try {
            for (let n = 1; n <= 12; n++) {
              await page.mouse.move(x + (action.deltaX * n) / 12, y + (action.deltaY * n) / 12);
              await page.waitForTimeout(16);
              await sampleBeforeRelease(n);
            }
          } finally {
            await page.mouse.up();
          }
        } else {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
          });
          try {
            for (let n = 1; n <= 12; n++) {
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                  {
                    x: x + (action.deltaX * n) / 12,
                    y: y + (action.deltaY * n) / 12,
                    id: 1,
                    radiusX: 2,
                    radiusY: 2,
                    force: 1,
                  },
                ],
              });
              await page.waitForTimeout(16);
              await sampleBeforeRelease(n);
            }
          } finally {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
        }
      }
      await page.waitForTimeout(250);
      steps.push({
        step,
        type: action.type,
        passed: true,
        reason: 'completed',
        ...(during.length ? { during } : {}),
      });
    } catch (error) {
      const reasons = [
        'not_found',
        'ambiguous_selector',
        'invalid_selector',
        'not_visible',
        'gesture_out_of_bounds',
        'assertion_failed',
        'interaction_budget_exceeded',
      ];
      const reason =
        error?.name === 'TimeoutError'
          ? 'timeout'
          : reasons.includes(error?.message)
            ? error.message
            : 'action_failed';
      steps.push({ step, type: action.type, passed: false, reason });
    } finally {
      try {
        await node?.dispose();
      } catch {
        /* A detached renderer handle has no state to release. */
      }
      try {
        await container?.dispose();
      } catch {
        /* Do not turn a fixed step failure into a transport failure. */
      }
    }
  }
  for (const [index, action] of (input.inspection?.actions ?? []).entries())
    await perform(action, index + 1);
  let focus;
  if (input.inspection?.focusSelector) {
    await perform({ type: 'focus', selector: input.inspection.focusSelector }, steps.length + 1);
    const result = steps.pop();
    focus = { passed: result.passed, reason: result.reason };
  }
  const interaction = input.inspection
    ? {
        passed: steps.every((step) => step.passed) && focus?.passed !== false,
        steps,
        ...(focus ? { focus } : {}),
      }
    : undefined;
  const focused = focus?.passed === true;
  const dimensions = await measure();
  const originPoint = focused
    ? await frame.evaluate(() => ({
        x: Math.max(0, window.scrollX),
        y: Math.max(0, window.scrollY),
      }))
    : { x: 0, y: 0 };
  height = focused ? 900 : Math.min(12000, Math.max(900, Math.ceil(dimensions.height)));
  const heightLimited = !focused && dimensions.height > height;
  truncated = heightLimited || dimensions.nested;
  if (dimensions.nested) errors.add('NESTED_SCROLL_CONTAINER_CLIPPED');
  if (heightLimited) errors.add('SCREENSHOT_HEIGHT_LIMIT');
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
      clip: { x: originPoint.x, y: originPoint.y, width: input.width, height, scale: 1 },
    });
    image = Buffer.from(result.data, 'base64');
    if (image.length <= 10 * 1024 * 1024) break;
    if (height <= 1) throw new Error('output limit');
    height = Math.max(1, Math.floor(height / 2));
    truncated = true;
    errors.add('SCREENSHOT_BYTE_LIMIT');
  }
  process.stdout.write(
    JSON.stringify({
      image: image.toString('base64'),
      width: input.width,
      height,
      truncated,
      ...(interaction ? { interaction } : {}),
      coverage: {
        mode: focused ? 'focused' : 'page',
        ...(errors.has('SCREENSHOT_BYTE_LIMIT')
          ? { reason: 'byte_limit' }
          : heightLimited
            ? { reason: 'height_limit' }
            : dimensions.nested
              ? { reason: 'nested_scroll' }
              : {}),
        documentHeight: Math.min(1e9, Math.max(0, dimensions.height)),
        x: originPoint.x,
        y: originPoint.y,
        width: input.width,
        height,
        viewportHeight: 900,
        nestedScroll: dimensions.nested,
      },
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
                'PREVIEW_CAPTURE_INVALID_INPUT',
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
