import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { runLocalPreviewCapture, PreviewCaptureError } from '../src/functions/d2c/preview/capture';
import {
  previewInspectionOptionsSchema,
  type PreviewInspectionOptions,
} from '../src/functions/d2c/preview/interaction';

const browser = process.env.PREVIEW_CAPTURE_LOCAL_TEST === '1';
/** Only this fixture's bundled JS executes in the isolated renderer. */
function fixture(script: string, inspection?: PreviewInspectionOptions) {
  return {
    target: 'h5' as const,
    signal: new AbortController().signal,
    inspection,
    files: [
      {
        path: 'index.html',
        mimeType: 'text/html',
        content: Buffer.from(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script src="./main.js"></script></body></html>',
        ),
      },
      { path: 'main.js', mimeType: 'text/javascript', content: Buffer.from(script) },
    ],
  };
}
/** First pixel predictors are zero for every PNG filter; no recompression library is needed. */
function firstPixel(image: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < image.length; ) {
    const size = image.readUInt32BE(offset);
    if (image.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(image.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}

test('inspection is an extendable strict schema with state-specific bounds and no executable actions', async () => {
  assert.ok(
    previewInspectionOptionsSchema
      .extend({})
      .safeParse({ actions: [{ type: 'expect', selector: '#name', state: 'text', text: 'A' }] })
      .success,
  );
  const invalid = [
    null,
    { actions: Array.from({ length: 13 }, () => ({ type: 'click', selector: '#a' })) },
    { actions: [{ type: 'evaluate', code: 'process.env' }] },
    { actions: [{ type: 'click', selector: 'iframe >> body' }] },
    { focusSelector: 'xpath=//*' },
    { focusSelector: 'x'.repeat(257) },
    { actions: [{ type: 'swipe', selector: '#a', deltaX: NaN, deltaY: 0 }] },
    { actions: [{ type: 'swipe', selector: '#a', deltaX: 0, deltaY: 0 }] },
    { actions: [{ type: 'scroll', x: 1e6, y: 0 }] },
    { actions: [{ type: 'expect', selector: '#a', state: 'text' }] },
    { actions: [{ type: 'expect', selector: '#a', state: 'attribute', attribute: 'data-index' }] },
    { actions: [{ type: 'expect', selector: '#a', state: 'scrollLeft' }] },
    { actions: [{ type: 'expect', selector: '#a', state: 'scrollLeft', min: 10, max: 0 }] },
    { actions: [{ type: 'expect', selector: '#a', state: 'centered' }] },
    { actions: [{ type: 'click', selector: '#a', shell: 'bad' }] },
  ];
  for (const value of invalid) {
    assert.equal(
      previewInspectionOptionsSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
    await assert.rejects(
      runLocalPreviewCapture({ ...fixture(''), inspection: value as PreviewInspectionOptions }),
      (error: unknown) =>
        error instanceof PreviewCaptureError && error.reason === 'PREVIEW_CAPTURE_INVALID_INPUT',
    );
  }
});

const carousel = `
document.body.style.margin='0';
document.body.innerHTML='<button id="last">last</button><div id="names"><div id="track">'+['A','B','C','D'].map((name,i)=>'<span id="n'+i+'">'+name+'</span>').join('')+'</div></div><output id="selected">A</output>';
const style=document.createElement('style');style.textContent='#names{width:240px;height:80px;overflow:auto;touch-action:none;margin:0}#track{display:flex;width:max-content;padding:0 80px}span{display:block;flex:0 0 80px;text-align:center}';document.head.append(style);
const names=document.querySelector('#names');const out=document.querySelector('#selected');let index=0;let start;let mode;let trusted=false;
function select(next){index=(next+4)%4;out.textContent=['A','B','C','D'][index];out.setAttribute('data-index',String(index));names.scrollLeft=index*80;}
document.querySelector('#last').onclick=e=>{out.setAttribute('data-click',String(e.isTrusted));select(3)};
names.addEventListener('touchstart',e=>{mode='touch';start=e.touches[0].clientX;trusted=e.isTrusted},{passive:true});
names.addEventListener('touchend',e=>{if(start!==undefined){select(index+(e.changedTouches[0].clientX<start?1:-1));out.setAttribute('data-touch',String(trusted&&e.isTrusted));start=undefined}},{passive:true});
names.addEventListener('mousedown',e=>{mode='mouse';start=e.clientX;trusted=e.isTrusted});
names.addEventListener('mouseup',e=>{if(mode==='mouse'&&start!==undefined){select(index+(e.clientX<start?1:-1));out.setAttribute('data-mouse',String(trusted&&e.isTrusted));start=undefined}});
select(0);
`;

test(
  'real Chromium: trusted click, bidirectional touch wrap-around, mouse drag and centered/scroll assertions',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await runLocalPreviewCapture(
      fixture(carousel, {
        actions: [
          { type: 'click', selector: '#last' },
          {
            type: 'expect',
            selector: '#selected',
            state: 'attribute',
            attribute: 'data-click',
            value: 'true',
          },
          { type: 'swipe', selector: '#names', deltaX: -120, deltaY: 0, pointer: 'touch' },
          { type: 'expect', selector: '#selected', state: 'text', text: 'A' },
          {
            type: 'expect',
            selector: '#selected',
            state: 'attribute',
            attribute: 'data-touch',
            value: 'true',
          },
          { type: 'swipe', selector: '#names', deltaX: 120, deltaY: 0, pointer: 'touch' },
          { type: 'expect', selector: '#selected', state: 'text', text: 'D' },
          { type: 'expect', selector: '#n3', state: 'centered', container: '#names', tolerance: 2 },
          { type: 'expect', selector: '#names', state: 'scrollLeft', min: 239, max: 241 },
          { type: 'swipe', selector: '#names', deltaX: 120, deltaY: 0, pointer: 'mouse' },
          { type: 'expect', selector: '#selected', state: 'text', text: 'C' },
          {
            type: 'expect',
            selector: '#selected',
            state: 'attribute',
            attribute: 'data-mouse',
            value: 'true',
          },
        ],
      }),
    );
    assert.equal(result.interaction?.steps.length, 12);
    assert.equal(result.interaction?.passed, true, JSON.stringify(result.interaction));
    assert.equal(result.coverage?.reason, 'nested_scroll');
    assert.equal(result.truncated, true);
    assert.ok(!result.errors.some((item) => item.code === 'SCREENSHOT_HEIGHT_LIMIT'));
  },
);

test(
  'real Chromium: page/container scroll, bottom focus beyond 12000px and exact viewport raster',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await runLocalPreviewCapture(
      fixture(
        `
    document.body.style.cssText='margin:0;background:rgb(0,255,0)';
    document.body.innerHTML='<div style="height:18000px;background:red"></div><div id="bottom" style="height:1000px"><div id="box" style="width:200px;height:100px;overflow:auto"><div style="width:800px;height:500px"></div></div></div>';
  `,
        {
          focusSelector: '#bottom',
          actions: [
            { type: 'scroll', x: 0, y: 18000 },
            { type: 'expect', selector: '#bottom', state: 'visible' },
            { type: 'scroll', selector: '#box', x: 120, y: 100 },
            { type: 'expect', selector: '#box', state: 'scrollLeft', min: 119, max: 121 },
          ],
        },
      ),
    );
    assert.equal(result.interaction?.passed, true, JSON.stringify(result.interaction));
    assert.equal(result.interaction?.steps.length, 4);
    assert.equal(result.interaction?.focus?.passed, true);
    assert.equal(result.coverage?.mode, 'focused');
    assert.ok(result.coverage!.y >= 18000);
    assert.equal(result.coverage?.documentHeight, 19000);
    assert.equal(result.height, 900);
    assert.deepEqual(firstPixel(result.image), [0, 255, 0]);
    assert.equal(result.coverage?.reason, 'nested_scroll');
    assert.ok(!result.errors.some((item) => item.code === 'SCREENSHOT_HEIGHT_LIMIT'));
  },
);

test(
  'real Chromium: failures remain explicit, selectors are unique CSS, text is bounded, no false empty attributes',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await runLocalPreviewCapture(
      fixture(
        `document.body.innerHTML='<button class="b">A</button><button class="b">B</button><div id="long"></div>';document.querySelector('#long').textContent='x'.repeat(600);`,
        {
          focusSelector: '#missing',
          actions: [
            { type: 'expect', selector: '#long', state: 'text', text: 'wrong' },
            {
              type: 'expect',
              selector: '#long',
              state: 'attribute',
              attribute: 'data-missing',
              value: '',
            },
            { type: 'click', selector: '#absent' },
            { type: 'click', selector: '.b' },
            { type: 'expect', selector: '[', state: 'visible' },
          ],
        },
      ),
    );
    assert.equal(result.interaction?.passed, false);
    assert.equal(result.interaction?.steps.length, 5);
    assert.deepEqual(
      result.interaction?.steps.map((step) => step.reason),
      [
        'assertion_failed',
        'assertion_failed',
        'not_found',
        'ambiguous_selector',
        'invalid_selector',
      ],
    );
    assert.ok(result.interaction!.steps.every((step) => step.passed === false));
    assert.equal((result.interaction!.steps[0].observed as string).length, 256);
    assert.deepEqual(result.interaction?.focus, { passed: false, reason: 'not_found' });
    assert.equal(result.coverage?.mode, 'page');
  },
);

test(
  'real Chromium: page height limit is distinct from focused/nested coverage and network stays offline',
  { skip: !browser, timeout: 45000 },
  async (t) => {
    let externalRequests = 0;
    const server = createServer((_req, res) => {
      externalRequests++;
      res.end('not allowed');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    const result = await runLocalPreviewCapture(
      fixture(
        `
    document.body.style.cssText='margin:0;height:19000px';
    const img=new Image();img.src='http://127.0.0.1:${port}/secret';document.body.append(img);
    fetch('http://127.0.0.1:${port}/api').catch(()=>{});
    document.body.dataset.sandbox=String(origin==='null');
  `,
        {
          actions: [
            {
              type: 'expect',
              selector: 'body',
              state: 'attribute',
              attribute: 'data-sandbox',
              value: 'true',
            },
          ],
        },
      ),
    );
    assert.equal(result.interaction?.passed, true);
    assert.equal(result.height, 12000);
    assert.equal(result.coverage?.reason, 'height_limit');
    assert.equal(result.coverage?.y, 0);
    assert.equal(result.coverage?.documentHeight, 19000);
    assert.equal(externalRequests, 0);
    assert.ok(result.image.length <= 10 * 1024 * 1024);
    assert.ok(result.missingAssets.some((value) => value.includes('/secret')));
  },
);

test(
  'real Chromium: high-entropy PNG reports byte cap without misreporting height cap',
  { skip: !browser, timeout: 45000 },
  async () => {
    const input = fixture(
      `
    document.body.style.margin='0';
    const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=12000;canvas.style.display='block';document.body.append(canvas);
    const context=canvas.getContext('2d');const data=context.createImageData(1440,12000);let seed=7211;
    for(let i=0;i<data.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data.data[i]=seed&255;data.data[i+1]=(seed>>>8)&255;data.data[i+2]=(seed>>>16)&255;data.data[i+3]=255;}
    context.putImageData(data,0,0);
  `,
      {},
    );
    const result = await runLocalPreviewCapture({ ...input, width: 1440 });
    assert.equal(result.interaction?.passed, true);
    assert.equal(result.coverage?.documentHeight, 12000);
    assert.equal(result.coverage?.reason, 'byte_limit');
    assert.ok(result.height < 12000);
    assert.ok(result.image.length <= 10 * 1024 * 1024);
    assert.ok(result.errors.some((item) => item.code === 'SCREENSHOT_BYTE_LIMIT'));
    assert.ok(!result.errors.some((item) => item.code === 'SCREENSHOT_HEIGHT_LIMIT'));
  },
);

test(
  'real Chromium: overflow-clipped elements and failed focus cannot masquerade as visible coverage',
  { skip: !browser, timeout: 45000 },
  async () => {
    const result = await runLocalPreviewCapture(
      fixture(
        `document.body.innerHTML='<div style="width:200px;height:40px;overflow:hidden"><div id="clipped" style="margin-top:100px">clipped</div></div>';`,
        {
          focusSelector: '#missing',
          actions: [{ type: 'expect', selector: '#clipped', state: 'visible' }],
        },
      ),
    );
    assert.equal(result.interaction?.passed, false);
    assert.deepEqual(result.interaction?.steps, [
      { step: 1, type: 'expect', passed: false, reason: 'assertion_failed', observed: false },
    ]);
    assert.equal(result.coverage?.mode, 'page');
  },
);

test(
  'real Chromium: default and empty-action screenshots preserve original mouse media and PNG bytes',
  { skip: !browser, timeout: 45000 },
  async () => {
    const input = fixture(
      `document.body.style.cssText='margin:0;background:rgb(0,255,0)';const style=document.createElement('style');style.textContent='@media(pointer:coarse){body{background:rgb(255,0,0)!important}}';document.head.append(style);`,
    );
    const plain = await runLocalPreviewCapture(input);
    const empty = await runLocalPreviewCapture({ ...input, inspection: {} });
    assert.deepEqual(firstPixel(plain.image), [0, 255, 0]);
    assert.deepEqual(plain.image, empty.image);
    assert.equal(plain.interaction, undefined);
    assert.deepEqual(empty.interaction, { passed: true, steps: [] });
  },
);

test('静态列表的滑动加可见性断言不能被认作循环交互通过', { skip: !browser }, async () => {
  const { interactionStateEvidence } = await import(
    '../src/functions/d2c/run/agent/incrementalVerification'
  );
  const actions: NonNullable<PreviewInspectionOptions['actions']> = [-80, 80, -80].flatMap(
    (deltaX) => [
      { type: 'swipe' as const, selector: '#tabs', deltaX, deltaY: 0, pointer: 'touch' as const },
      { type: 'expect' as const, selector: 'body', state: 'visible' as const },
    ],
  );
  const result = await runLocalPreviewCapture(
    fixture(
      'document.body.innerHTML=\'<div id="tabs" style="height:120px;width:300px;overflow:hidden">static names</div>\'',
      { actions },
    ),
  );
  assert.equal(result.interaction?.passed, true, '浏览器只能确认所要求的动作及可见性断言');
  assert.equal(
    interactionStateEvidence('循环滚动并支持滑动', actions, result.interaction?.steps),
    false,
    '必须有真实选中态或滚动位置变化',
  );
});

test('真实跨首末项回环与选中态变化可通过主端交互验收', { skip: !browser }, async () => {
  const { interactionStateEvidence, satisfiesInteractionPlan } = await import(
    '../src/functions/d2c/run/agent/incrementalVerification'
  );
  const actions: NonNullable<PreviewInspectionOptions['actions']> = [
    { type: 'expect', selector: '#selected', state: 'text', text: 'A' },
    { type: 'click', selector: '#last' },
    { type: 'expect', selector: '#selected', state: 'text', text: 'D' },
    {
      type: 'expect',
      selector: '#selected',
      state: 'attribute',
      attribute: 'data-click',
      value: 'true',
    },
    { type: 'swipe', selector: '#names', deltaX: -120, deltaY: 0, pointer: 'touch' },
    { type: 'expect', selector: '#selected', state: 'text', text: 'A' },
    { type: 'swipe', selector: '#names', deltaX: 120, deltaY: 0, pointer: 'mouse' },
    { type: 'expect', selector: '#selected', state: 'text', text: 'D' },
    { type: 'swipe', selector: '#names', deltaX: -120, deltaY: 0, pointer: 'touch' },
    { type: 'expect', selector: '#selected', state: 'text', text: 'A' },
    { type: 'expect', selector: '#n0', state: 'centered', container: '#names', tolerance: 2 },
    { type: 'expect', selector: '#names', state: 'scrollLeft', min: 0, max: 1 },
  ];
  const result = await runLocalPreviewCapture(fixture(carousel, { actions }));
  assert.equal(result.interaction?.passed, true, JSON.stringify(result.interaction));
  assert.equal(satisfiesInteractionPlan('点击名字、循环滚动并支持滑动', actions), true);
  assert.equal(
    interactionStateEvidence('点击名字、循环滚动并支持滑动', actions, result.interaction?.steps),
    true,
  );
});
