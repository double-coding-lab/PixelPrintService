import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  createD2cConfigReader,
  modelConfigsSchema,
  parseD2cRuntimeConfig,
} from '../src/config/d2c';
import {
  createDeepModel,
  createDeepReasoningModels,
  type DeepModelConfig,
} from '../src/functions/d2c/run/agent/model';
import type { executeGenerationRun } from '../src/functions/d2c/run/execute';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';
import { messageFixture } from './helpers/messages';

const configuredModel = {
  MODEL_BASE_URL: 'http://offline-model.invalid/v1/chat/completions',
  MODEL_NAME: 'deepseek-flash',
  MODEL_API_KEY: 'offline-timeout-key',
  contextBudgetTokens: 16000,
};
const modelConfig: DeepModelConfig = {
  baseURL: configuredModel.MODEL_BASE_URL,
  name: configuredModel.MODEL_NAME,
  apiKey: configuredModel.MODEL_API_KEY,
  contextBudgetTokens: configuredModel.contextBudgetTokens,
};
const invalidTimeouts: unknown[] = [
  0,
  -1,
  999,
  1000.5,
  600001,
  Number.NaN,
  Infinity,
  -Infinity,
  null,
  '60000',
  false,
];

test('旧模型配置默认180000，每模型保留独立超时与显式60000，边界为1000..600000', () => {
  const parsed = modelConfigsSchema.parse([
    configuredModel,
    ...[1000, 60000, 180000, 600000].map((requestTimeoutMs) => ({
      ...configuredModel,
      requestTimeoutMs,
    })),
  ]);
  assert.deepEqual(
    parsed.map((model) => model.requestTimeoutMs),
    [180000, 1000, 60000, 180000, 600000],
  );
  assert.equal(
    modelConfigsSchema.parse([{ ...configuredModel, requestTimeoutMs: undefined }])[0]
      .requestTimeoutMs,
    180000,
  );
  for (const requestTimeoutMs of invalidTimeouts) {
    const result = modelConfigsSchema.safeParse([
      configuredModel,
      { ...configuredModel, requestTimeoutMs },
    ]);
    assert.equal(result.success, false);
    if (!result.success) assert.deepEqual(result.error.issues[0].path, [1, 'requestTimeoutMs']);
  }
});

test('平台配置保留旧配置默认值，无效超时只报告字段并保留最后有效配置', async () => {
  const f = await messageFixture();
  const original = structuredClone(f.runtime);
  assert.equal(parseD2cRuntimeConfig(original).modelConfigs[0].requestTimeoutMs, 180000);
  let source: unknown = {
    ...original,
    modelConfigs: [{ ...configuredModel, requestTimeoutMs: 60000 }],
  };
  const errors: Error[] = [];
  const read = createD2cConfigReader(
    () => source,
    (error) => errors.push(error),
  );
  const previous = read();
  assert.equal(previous.modelConfigs[0].requestTimeoutMs, 60000);
  assert.equal(Object.isFrozen(previous.modelConfigs[0]), true);
  source = {
    ...original,
    modelConfigs: [{ ...configuredModel, requestTimeoutMs: 'PRIVATE_INVALID_TIMEOUT' }],
  };
  assert.equal(read(), previous);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /modelConfigs\.0\.requestTimeoutMs/);
  assert.doesNotMatch(errors[0].message, /PRIVATE|offline-timeout-key|offline-model/);
  assert.deepEqual(f.runtime, original);
});

test('模型构造校验与默认独立于schema，高低思考及供应商默认保持相同超时', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('construction must not fetch');
  });
  for (const requestTimeoutMs of [undefined, 1000, 60000, 180000, 600000]) {
    const config = { ...modelConfig, requestTimeoutMs };
    const timeout = requestTimeoutMs ?? 180000;
    for (const effort of [undefined, 'low', 'high'] as const)
      assert.equal(createDeepModel(config, effort).timeout, timeout);
    const variants = createDeepReasoningModels(config);
    assert.ok(variants);
    for (const model of [variants.low, variants.high]) {
      assert.ok('timeout' in model);
      assert.equal(model.timeout, timeout);
    }
    assert.equal(
      createDeepModel({ ...config, reasoningPolicy: 'provider-default' }).timeout,
      timeout,
    );
    assert.equal(createDeepModel({ ...config, name: 'other-model' }).timeout, timeout);
  }
  for (const requestTimeoutMs of invalidTimeouts) {
    const config = { ...modelConfig, requestTimeoutMs: requestTimeoutMs as number };
    assert.throws(() => createDeepModel(config), /requestTimeoutMs/);
    assert.throws(() => createDeepReasoningModels(config), /requestTimeoutMs/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('实际SDK fetch收到超时参数和AbortSignal，高低思考及摘要共用入口不改请求体', async (t) => {
  const scheduled: Array<number | undefined> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    scheduled.push(args[1]);
    return nativeSetTimeout(...args);
  });
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      assert.equal(String(url), 'http://offline-model.invalid/v1/chat/completions');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(init.signal.aborted, false);
      const body = JSON.parse(String(init.body));
      assert.equal(body.stream, true);
      assert.equal(body.model, modelConfig.name);
      assert.equal('timeout' in body, false);
      assert.equal('requestTimeoutMs' in body, false);
      return new Response(
        'data: {"id":"offline","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"id":"offline","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  for (const requestTimeoutMs of [undefined, 1000, 60000, 600000]) {
    const config = { ...modelConfig, requestTimeoutMs };
    const variants = createDeepReasoningModels(config);
    assert.ok(variants);
    const models = [
      createDeepModel(config),
      variants.low,
      variants.high,
      createDeepModel(config, 'low'),
    ];
    for (const model of models) {
      scheduled.length = 0;
      assert.equal((await model.invoke('offline probe')).text, 'ok');
      assert.ok(scheduled.includes(requestTimeoutMs ?? 180000), 'SDK必须按配置安排超时取消');
    }
  }
  assert.equal(fetch.mock.callCount(), 16);
});

test('1000ms超时实际中止挂起fetch，不依赖构造字段断言且不自动重试', async (t) => {
  let requestSignal: AbortSignal | undefined;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        requestSignal = signal;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('offline request aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  const started = performance.now();
  await assert.rejects(
    createDeepModel({ ...modelConfig, requestTimeoutMs: 1000 }).invoke('offline probe'),
    /timed out|timeout/i,
  );
  assert.ok(performance.now() - started >= 900);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('显式请求超时保留调用方取消信号', async (t) => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        requestSignal = signal;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('offline caller cancelled', 'AbortError')),
          { once: true },
        );
        controller.abort();
      }),
  );
  await assert.rejects(
    createDeepModel({ ...modelConfig, requestTimeoutMs: 600000 }).invoke('offline probe', {
      signal: controller.signal,
    }),
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('持久化读取旧Run默认180000，新快照保留超时并拒绝非法值，原快照保持原样', async () => {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '解释已有代码',
  });
  const run = f.tables.D2cRun[0];
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = await leases.claim(queued.runId, 'timeout-worker');
  assert.ok(lease);
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    notify() {},
    redact: (value) => value,
  });
  delete run.modelSnapshot.requestTimeoutMs;
  const legacy = structuredClone(run.modelSnapshot);
  assert.equal((await persistence.load()).model.requestTimeoutMs, 180000);
  assert.deepEqual(run.modelSnapshot, legacy);
  for (const requestTimeoutMs of [1000, 60000, 600000]) {
    run.modelSnapshot.requestTimeoutMs = requestTimeoutMs;
    assert.equal((await persistence.load()).model.requestTimeoutMs, requestTimeoutMs);
  }
  for (const requestTimeoutMs of invalidTimeouts) {
    run.modelSnapshot.requestTimeoutMs = requestTimeoutMs;
    await assert.rejects(persistence.load(), /requestTimeoutMs/);
  }
});

/** 只替换模型执行边界，使用正式执行器、快照校验与资源恢复。 */
async function capturedExecutor() {
  const compiled = await build({
    stdin: {
      contents:
        "export {executeGenerationRun} from './src/functions/d2c/run/execute'; export {captureGeneration} from 'timeout-test-generation';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: [
      {
        name: 'capture-timeout-generation',
        setup(builder) {
          builder.onResolve({ filter: /^(?:\.\/agent\/run|timeout-test-generation)$/ }, () => ({
            path: 'generation',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              'let capture; export function captureGeneration(next){capture=next} export async function runDeepGeneration(input){capture(input);throw new Error("OFFLINE_TIMEOUT_CAPTURED")}',
            loader: 'js',
          }));
          builder.onResolve({ filter: /^[^./]/ }, ({ path: entry }) => {
            if (entry.startsWith('@/') || entry.startsWith('node:')) return undefined;
            return { path: import.meta.resolve(entry), external: true };
          });
        },
      },
    ],
  });
  return (await import(
    'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
  )) as {
    executeGenerationRun: typeof executeGenerationRun;
    captureGeneration: (capture: (input: { model: DeepModelConfig }) => void) => void;
  };
}

test('execute传冻结超时，旧快照回退180000，当前配置仅更新密钥', async (t) => {
  const executor = await capturedExecutor();
  const platformSkills = await realpath(
    await mkdtemp(path.join(tmpdir(), 'timeout-platform-skills-')),
  );
  t.after(() => rm(platformSkills, { recursive: true, force: true }));
  const bundle = await readTemplateResources(path.resolve('pixelprint'), platformSkills);
  for (const requestTimeoutMs of [undefined, 1000, 60000, 600000]) {
    const f = await messageFixture();
    const root = await mkdtemp(path.join(tmpdir(), 'model-timeout-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    f.runtime.d2c.execution.workRoot = root;
    Object.assign(f.runtime.modelConfigs[0], configuredModel);
    f.tables.D2cWorkspaceRevision[0].bundleHash = bundle.hash;
    if (requestTimeoutMs !== undefined)
      f.runtime.modelConfigs[0].requestTimeoutMs = requestTimeoutMs;
    const queued = await f.messages.enqueue('employee-a', f.id, {
      clientRequestId: randomUUID(),
      content: '解释已有代码',
    });
    // 直接构造已持久化的新旧Run，独立验证执行器读取边界。
    if (requestTimeoutMs === undefined) delete f.tables.D2cRun[0].modelSnapshot.requestTimeoutMs;
    else assert.equal(f.tables.D2cRun[0].modelSnapshot.requestTimeoutMs, requestTimeoutMs);
    Object.assign(f.runtime.modelConfigs[0], {
      requestTimeoutMs: 25000,
      MODEL_API_KEY: 'rotated-offline-timeout-key',
    });
    const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
    const lease = await leases.claim(queued.runId, 'timeout-executor');
    assert.ok(lease);
    let captured: DeepModelConfig | undefined;
    executor.captureGeneration((input) => {
      captured = input.model;
    });
    await assert.rejects(
      executor.executeGenerationRun({
        mysql: f.mysql,
        config: parseD2cRuntimeConfig(f.runtime),
        leases,
        lease,
        store: { load: async () => bundle },
        binary: {
          uploadFile: async () => assert.fail('unexpected upload'),
          downloadFile: async () => assert.fail('unexpected download'),
        },
        proxyUrl: 'http://127.0.0.1:1',
        signal: new AbortController().signal,
        notify() {},
      }),
    );
    assert.ok(captured, '必须到达模型执行边界');
    assert.equal(captured.requestTimeoutMs, requestTimeoutMs ?? 180000);
    assert.equal(captured.apiKey, 'rotated-offline-timeout-key');
    assert.equal(createDeepModel(captured).timeout, requestTimeoutMs ?? 180000);
  }
});
