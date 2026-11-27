import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewInspection } from '../src/functions/d2c/preview/inspection';
import type { PreviewService } from '../src/functions/d2c/preview/service';
import { PreviewCaptureError } from '../src/functions/d2c/preview/capture';

/** 固定已就绪修订；构建器替身不能写数据库、上传文件或伪造真实浏览器验收。 */
function service(status = 'ready') {
  const row = {
    previewId: 'preview-one',
    target: 'h5',
    entryPath: 'pages/page/index.tsx',
    fileRevision: 3,
    status,
    error: status === 'failed' ? { code: 'SYNTAX_ERROR', message: '语法错误' } : null,
  };
  return {
    createSession: async () => ({
      current: row,
      lastReady: null,
      entries: [row.entryPath],
      fileRevision: 3,
    }),
    get: async () => row,
    captureInputs: async () => ({
      files: [{ path: 'index.html', content: Buffer.from('page'), mimeType: 'text/html' }],
      target: 'h5',
      entryPath: row.entryPath,
      fileRevision: 3,
    }),
  } as unknown as PreviewService;
}

test('自动编译失败只读、按修订去重反馈；未改源码时不查库，不创建额外构建', async () => {
  const api = service();
  let reads = 0;
  let creates = 0;
  let revision = 3;
  let failed = true;
  api.createSession = async () => {
    creates++;
    return { current: null } as never;
  };
  api.existingSession = async () => {
    reads++;
    return {
      current: {
        previewId: 'preview-one',
        validatedFileRevision: revision,
        entryPath: 'pages/page/index.tsx',
        status: failed ? 'failed' : 'building',
        error: {
          code: 'BUILD_FAILED',
          file: 'pages/page/blocks/hero/index.scss',
          message: '预览构建失败',
        },
      },
    } as never;
  };
  const inspection = createPreviewInspection({
    service: api,
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
  });
  assert.equal(await inspection.tools.feedback(), undefined);
  assert.equal(reads, 0);
  inspection.changed();
  const first = JSON.parse((await inspection.tools.feedback())!);
  assert.equal(first.type, 'preview_feedback');
  assert.equal(first.fileRevision, 3);
  assert.equal(first.diagnostic.file, 'pages/page/blocks/hero/index.scss');
  assert.equal(await inspection.tools.feedback(), undefined);
  revision = 4;
  assert.equal(JSON.parse((await inspection.tools.feedback())!).fileRevision, 4);
  failed = false;
  assert.equal(await inspection.tools.feedback(), undefined);
  assert.equal(creates, 0);
  await inspection.close();
});

test('主模型下一次请求收到已有编译失败，不额外调用编译器或增加模型请求', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  let calls = 0;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    calls++;
    assert.match(JSON.stringify(messages), /preview_feedback.*hero\/index.scss/);
    const message = new AIMessage('已收到真实编译错误');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [new HumanMessage('继续')],
    instructions: 'PARENT',
    maxTurns: 3,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async () => '',
      write: async () => '',
      remove: async () => '',
      figma: async () => '',
      rules: async () => '',
      slices: async () => '',
      preview: {
        feedback: async () => '{"type":"preview_feedback","file":"hero/index.scss"}',
        needsInspection: async () => false,
        build: async () => assert.fail('反馈不创建构建'),
        inspect: async () => assert.fail('反馈不创建截图'),
      },
    },
  });
  assert.equal(calls, 1);
});

test('检查绑定固定修订，普通聊天不重复截图，缓存仅在当前Run可读取', async () => {
  let captures = 0;
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    capture: async () => {
      captures++;
      return {
        image: Buffer.from('image'),
        mimeType: 'image/png',
        width: 375,
        height: 900,
        errors: [],
        missingAssets: [],
        truncated: false,
      };
    },
  });
  assert.equal(await inspection.tools.needsInspection(), false);
  inspection.changed();
  assert.equal(await inspection.tools.needsInspection(), true);
  const result = JSON.parse(await inspection.tools.inspect());
  assert.equal(result.fileRevision, 3);
  assert.equal((await inspection.resolveImage(result.imageRef))?.data.toString(), 'image');
  assert.equal(await inspection.tools.needsInspection(), false);
  await inspection.tools.inspect();
  assert.equal(captures, 1);
  assert.equal(await inspection.resolveImage('preview://outside-run'), null);
  await inspection.close();
  assert.equal(await inspection.resolveImage(result.imageRef), null);
});

test('源码构建诊断供模型调整，基础设施缺失如实降级且不循环截图', async () => {
  const failed = createPreviewInspection({
    service: service('failed'),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
  });
  failed.changed();
  assert.equal(JSON.parse(await failed.tools.inspect()).diagnostic.code, 'SYNTAX_ERROR');
  assert.equal(await failed.tools.needsInspection(), false);
  await failed.close();
  let calls = 0;
  const missing = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    capture: async () => {
      calls++;
      throw new PreviewCaptureError('PREVIEW_CAPTURE_DOCKER_UNAVAILABLE');
    },
  });
  assert.equal(JSON.parse(await missing.tools.inspect()).status, 'capture_unavailable');
  await missing.tools.inspect();
  assert.equal(calls, 1);
  await missing.close();
});

test('实际截图保存后返回持久引用，保存失败不缓存成功结果', async () => {
  let saves = 0;
  const image = { mimeType: 'image/png' as const, data: Buffer.from('image') };
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    capture: async () => ({
      image: image.data,
      mimeType: image.mimeType,
      width: 375,
      height: 900,
      errors: [],
      missingAssets: [],
      truncated: false,
    }),
    saveCapture: async (value) => {
      saves++;
      assert.equal(value.fileRevision, 3);
      assert.equal(value.entryPath, 'pages/page/index.tsx');
      if (saves === 1) throw new Error('storage unavailable');
      return { imageRef: `attachment://${'a'.repeat(64)}`, image };
    },
  });
  await assert.rejects(inspection.tools.inspect(), /storage unavailable/);
  const saved = JSON.parse(await inspection.tools.inspect());
  assert.match(saved.imageRef, /^attachment:/);
  assert.equal(await inspection.tools.inspect(), JSON.stringify(saved));
  assert.equal(saves, 2);
  assert.deepEqual(await inspection.resolveImage(saved.imageRef), image);
  await inspection.close();
});

test('同一源码修订的不同交互与聚焦计划使用独立截图缓存，重复计划复用', async () => {
  let captures = 0;
  const saved: string[] = [];
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    capture: async (input) => {
      captures++;
      assert.ok(input.inspection);
      return {
        image: Buffer.from(`image-${captures}`),
        mimeType: 'image/png',
        width: 375,
        height: 900,
        truncated: false,
        errors: [],
        missingAssets: [],
        interaction: {
          passed: true,
          steps:
            input.inspection.actions?.map((action, index) => ({
              step: index + 1,
              type: action.type,
              passed: true,
              reason: 'completed' as const,
            })) ?? [],
        },
      };
    },
    saveCapture: async (value) => {
      saved.push(value.inspectionKey!);
      return {
        imageRef: `attachment://${value.inspectionKey}`,
        image: { mimeType: 'image/png', data: value.capture.image },
      };
    },
  });
  const plan = { actions: [{ type: 'click' as const, selector: '#next' }] };
  const first = JSON.parse(await inspection.tools.inspect(undefined, plan));
  const repeat = JSON.parse(await inspection.tools.inspect(undefined, plan));
  const focused = JSON.parse(
    await inspection.tools.inspect(undefined, { ...plan, focusSelector: '#bottom' }),
  );
  assert.equal(captures, 2);
  assert.equal(first.imageRef, repeat.imageRef);
  assert.notEqual(first.imageRef, focused.imageRef);
  assert.equal(new Set(saved).size, 2);
  assert.equal((await inspection.resolveImage(first.imageRef))?.data.toString(), 'image-1');
  await assert.rejects(
    inspection.tools.inspect(undefined, {
      actions: [{ type: 'evaluate', script: 'private' }],
    } as never),
  );
  assert.equal(captures, 2);
  await inspection.close();
});

test('layout audit shares capture/cache, preserves explicit overrides, and only current mismatches enter delivery', async () => {
  let captures = 0;
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    requireWholePage: true,
    layoutChecks: async () => [{ selector: '#box', width: 80, tolerance: 3 }],
    capture: async (input) => {
      captures++;
      assert.deepEqual(input.inspection?.layoutChecks, [
        { selector: '#box', width: 100, tolerance: 3 },
      ]);
      return {
        image: Buffer.from('image'),
        mimeType: 'image/png',
        width: 375,
        height: 900,
        errors: [],
        missingAssets: [],
        truncated: false,
        layout: {
          checked: 1,
          durationMs: 1,
          truncated: false,
          issues: [{ code: 'width_mismatch', selector: '#box', expected: 100, actual: 40 }],
        },
      };
    },
  });
  inspection.changed();
  const options = { layoutChecks: [{ selector: '#box', width: 100 }] };
  const result = JSON.parse(await inspection.tools.inspect(undefined, options));
  assert.equal(result.layout.issues[0].actual, 40);
  assert.equal(inspection.problems().length, 1);
  inspection.changed();
  assert.deepEqual(inspection.problems(), [], 'stale source evidence is invalidated');
  await inspection.tools.inspect(undefined, options);
  assert.equal(captures, 1, 'unchanged immutable preview reuses capture');
  assert.equal(inspection.problems().length, 1, 'cached failures cannot become passes');
  assert.equal(await inspection.tools.needsInspection(), false);
  await inspection.close();
});

test('focused capture does not discharge initial-generation whole-page inspection', async () => {
  let captures = 0;
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    requireWholePage: true,
    capture: async () => {
      captures++;
      return {
        image: Buffer.from('image'),
        mimeType: 'image/png',
        width: 375,
        height: 900,
        errors: [],
        missingAssets: [],
        truncated: false,
      };
    },
  });
  inspection.changed();
  await inspection.tools.inspect(undefined, { focusSelector: '#button' });
  assert.equal(await inspection.tools.needsInspection(), true);
  await inspection.tools.inspect();
  assert.equal(await inspection.tools.needsInspection(), false);
  assert.equal(captures, 2);
  await inspection.close();
});

test('partial/action-only capture cannot erase unresolved width evidence', async () => {
  const inspection = createPreviewInspection({
    service: service(),
    userId: 'employee',
    sessionId: 'session',
    signal: new AbortController().signal,
    assertLease: async () => {},
    capture: async (input) => ({
      image: Buffer.from('image'),
      mimeType: 'image/png',
      width: 375,
      height: 900,
      errors: [],
      missingAssets: [],
      truncated: false,
      layout: {
        checked: input.inspection?.layoutChecks?.length ?? 0,
        durationMs: 1,
        truncated: false,
        issues: input.inspection?.layoutChecks?.length
          ? [{ code: 'width_mismatch', selector: '#box', expected: 100, actual: 40 }]
          : [],
      },
    }),
  });
  await inspection.tools.inspect(undefined, { layoutChecks: [{ selector: '#box', width: 100 }] });
  assert.equal(inspection.problems().length, 1);
  await inspection.tools.inspect(undefined, { focusSelector: '#other' });
  assert.equal(inspection.problems().length, 1);
  await inspection.tools.inspect(undefined, { focusSelector: '#other' });
  assert.equal(inspection.problems().length, 1, 'cache hits also retain unrelated failures');
  await inspection.close();
});
