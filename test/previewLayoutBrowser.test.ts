import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const browser = process.env.PREVIEW_CAPTURE_LOCAL_TEST === '1';
type LayoutIssue = { code: string; selector: string; expected?: number; actual?: number };
type Capture = {
  error?: string;
  image: string;
  width: number;
  layout: { durationMs: number; checked: number; issues: LayoutIssue[]; truncated: boolean };
};

/** Exercise the trusted subprocess directly without depending on the host schema rollout. */
async function capture(
  html: string,
  layoutChecks?: unknown,
  actions?: unknown[],
): Promise<Capture> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../preview-browser/capture.mjs', import.meta.url))],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 40000,
    },
  );
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`capture exit ${code}: ${Buffer.concat(errors)}`)),
    );
  });
  child.stdin.on('error', () => {});
  child.stdin.end(
    JSON.stringify({
      width: 375,
      assetBase: 'https://assets.example.test/',
      inspection: {
        ...(layoutChecks === undefined ? {} : { layoutChecks }),
        ...(actions ? { actions } : {}),
      },
      files: [
        {
          path: 'index.html',
          mimeType: 'text/html',
          content: Buffer.from(`<!doctype html><style>body{margin:0}</style>${html}`).toString(
            'base64',
          ),
        },
      ],
    }),
  );
  await completed;
  return JSON.parse(Buffer.concat(output).toString());
}

test(
  'real Chromium: actual percentage width, flex shrink and offcenter text despite decorative glow',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await capture(
      `
    <div style="width:200px"><div id="percent" style="width:100%;height:20px"></div></div>
    <div style="display:flex;width:200px"><div id="shrunk" style="width:200px;height:20px"></div><div style="width:200px;height:20px"></div></div>
    <div id="container" style="position:relative;width:300px;height:80px">
      <div style="position:absolute;inset:0;box-shadow:0 0 50px red"></div>
      <div id="text" style="position:absolute;left:20px;top:10px;width:100px;height:20px">Title</div>
    </div>`,
      [
        { selector: '#percent', width: 375 },
        { selector: '#shrunk', width: 200 },
        { selector: '#text', centerX: true, centerY: true, container: '#container' },
      ],
    );
    assert.equal(result.error, undefined);
    assert.equal(result.width, 375);
    assert.equal(result.layout.checked, 3);
    assert.deepEqual(result.layout.issues, [
      { code: 'width_mismatch', selector: '#percent', expected: 375, actual: 200 },
      { code: 'width_mismatch', selector: '#shrunk', expected: 200, actual: 100 },
      { code: 'center_x_mismatch', selector: '#text', expected: 0, actual: -80 },
      { code: 'center_y_mismatch', selector: '#text', expected: 0, actual: -20 },
    ]);
    assert.ok(result.image.length > 0);
    assert.ok(result.layout.durationMs >= 0);
    assert.equal(result.layout.truncated, false);
  },
);

test(
  'real Chromium: correct flexible layout, tolerance and intentional clipping pass without automatic noise',
  { skip: !browser, timeout: 45000 },
  async () => {
    const html = `<div id="parent" style="display:flex;align-items:center;justify-content:center;width:100%;height:100px"><div id="child" style="width:50%;height:20px;text-shadow:0 0 40px red">Title</div></div><div data-node-id="ellipsis" style="width:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Intentionally clipped text</div>`;
    const plain = await capture(html);
    const checked = await capture(html, [
      {
        selector: '#child',
        width: 187.5,
        height: 20,
        centerX: true,
        centerY: true,
        container: '#parent',
      },
      { selector: '#child', width: 190.5 },
    ]);
    assert.deepEqual(checked.layout.issues, []);
    assert.equal(checked.layout.checked, 2);
    assert.equal(plain.layout.checked, 0);
    assert.deepEqual(plain.layout.issues, []);
    assert.equal(plain.image, checked.image, 'audit must not mutate layout or screenshot');
  },
);

test(
  'real Chromium: bounded issues, unique containers, missing and invisible targets',
  { skip: !browser, timeout: 45000 },
  async () => {
    const html = `<div class="dup"></div><div class="dup"></div><div id="hidden" style="display:none"></div><div style="overflow:hidden;height:10px"><div id="clipped" style="margin-top:50px;height:10px">clipped</div></div><div id="box" style="width:100px;height:20px"></div>`;
    const result = await capture(html, [
      { selector: '#missing', width: 1 },
      { selector: '.dup', width: 1 },
      { selector: '#hidden', width: 1 },
      { selector: '#clipped', height: 10 },
      { selector: '#box', centerX: true, container: '.dup' },
      { selector: '#box', centerY: true, container: '#missing' },
    ]);
    assert.deepEqual(
      result.layout.issues.map(({ code, selector }) => [code, selector]),
      [
        ['not_found', '#missing'],
        ['ambiguous_selector', '.dup'],
        ['not_visible', '#hidden'],
        ['not_visible', '#clipped'],
        ['ambiguous_selector', '.dup'],
        ['not_found', '#missing'],
      ],
    );
    const capped = await capture(
      html,
      Array.from({ length: 32 }, () => ({ selector: '#box', width: 1, height: 1 })),
    );
    assert.equal(capped.layout.checked, 32);
    assert.equal(capped.layout.issues.length, 40);
    assert.equal(capped.layout.truncated, true);
    const exact = await capture(
      html,
      Array.from({ length: 20 }, () => ({ selector: '#box', width: 1, height: 1 })),
    );
    assert.equal(exact.layout.issues.length, 40);
    assert.equal(exact.layout.truncated, false);
  },
);

test(
  'real Chromium: invalid declarations and malformed CSS fail closed',
  { skip: !browser, timeout: 45000 },
  async () => {
    const invalid = [
      null,
      {},
      Array.from({ length: 33 }, () => ({ selector: 'body' })),
      [{ selector: 'body', centerX: true }],
      [{ selector: 'body', centerY: true, container: '.x', tolerance: -1 }],
      [{ selector: 'body', width: -1 }],
      [{ selector: 'body', width: 24001 }],
      [{ selector: 'body', height: '20' }],
      [{ selector: 'body', centerX: 1 }],
      [{ selector: 'body', code: 'alert(1)' }],
      [{ selector: 'iframe >> body', width: 20 }],
      [{ selector: 'xpath=//*' }],
      [{ selector: 'x'.repeat(257) }],
      [{ selector: 'body\n' }],
      [{ selector: '[', width: 20 }],
    ];
    for (const checks of invalid) {
      const result = await capture('<div></div>', checks);
      assert.equal(result.error, 'PREVIEW_CAPTURE_INVALID_INPUT', JSON.stringify(checks));
    }
  },
);

test(
  'real Chromium: layout observes the same post-action state used by screenshot',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await capture(
      '<div id="box" style="height:30px;width:200px;overflow:auto"><div style="width:400px;height:30px"></div></div>',
      [{ selector: '#box', width: 200, height: 30 }],
      [
        { type: 'scroll', selector: '#box', x: 100, y: 0 },
        { type: 'expect', selector: '#box', state: 'scrollLeft', min: 100, max: 100 },
      ],
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(result.layout.issues, []);
    assert.equal(result.layout.checked, 1);
  },
);
