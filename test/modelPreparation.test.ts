import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import {
  createModelPreparation,
  modelPreparationSchema,
} from '../src/functions/d2c/run/agent/modelPreparation';
import { createRunImageCache } from '../src/functions/d2c/run/agent/imageCache';
import {
  modelActivitySchema,
  observeModelRequest,
  type ModelActivity,
} from '../src/functions/d2c/run/agent/modelActivity';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosticsContent } from '../web/src/workspace/DiagnosticsPanel';
import { messageFixture } from './helpers/messages';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { readRunDiagnostics } from '../src/functions/d2c/run/diagnostics';

/** 正式存储到前端链路：固定白名单且不把旧缺值变成零。 */
test('preparation survives persistence/diagnostics/UI while old metadata remains unknown', async () => {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: 'timing',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = (await leases.claim(queued.runId, 'prep-worker'))!;
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    notify: () => {},
    redact: (value) => value,
  });
  await persistence.load();
  const operationId = randomUUID();
  await persistence.recordModelActivity({
    operationId,
    scope: 'generation',
    status: 'started',
    preparation: { totalMs: 1500, imagesMs: 1200, tokenCountMs: 200 },
  });
  await persistence.recordModelActivity({
    operationId,
    scope: 'generation',
    status: 'completed',
    durationMs: 100,
    startedSaveMs: 250,
    preparation: { totalMs: 1500, imagesMs: 1200, tokenCountMs: 200 },
  });
  await persistence.recordModelActivity({
    operationId: randomUUID(),
    scope: 'generation',
    status: 'started',
  });
  const snapshot = await readRunDiagnostics(f.mysql, 'employee-a', f.id, queued.runId);
  assert.equal(snapshot.steps[0].preparation?.imagesMs, 1200);
  assert.equal(snapshot.steps[0].startedSaveMs, 250);
  assert.equal(snapshot.steps[0].durationMs, 100);
  assert.equal(snapshot.steps[1].preparation, undefined);
  assert.equal(snapshot.steps[1].startedSaveMs, undefined);
  const html = renderToStaticMarkup(
    React.createElement(DiagnosticsContent, {
      snapshot: { ...snapshot, failure: null },
      now: Date.now(),
    }),
  );
  assert.match(html, /图片读取与物化/);
  assert.match(html, /1\.2 秒/);
  assert.match(html, /不含图检查点/);
  assert.match(html, /不代表完整工具结束/);
  assert.match(html, /图检查点及范围外持久化尚未归因/);
  assert.match(html, /耗时未知/);
  assert.equal(f.tables.D2cTimeline.filter((row) => row.kind === 'model_status').length, 3);
});

/** 注入时钟核对墙钟边界，模拟区间内部两个并行工作而不累加它们。 */
test('preparation uses bounded monotonic wall time and missing phases stay unknown', () => {
  let now = 100;
  const timing = createModelPreparation(() => now);
  now = 110;
  timing.mark('promptMs');
  now = 130;
  timing.mark('imagesMs');
  assert.deepEqual(timing.snapshot(), { promptMs: 10, imagesMs: 20, totalMs: 30 });
  assert.equal(timing.snapshot().contextMs, undefined);
  now = 1e12;
  assert.equal(timing.snapshot().totalMs, 86_400_000);
  assert.equal(modelPreparationSchema.safeParse({ totalMs: -1 }).success, false);
  assert.equal(modelPreparationSchema.safeParse({ totalMs: Infinity }).success, false);
  const old = modelActivitySchema.parse({
    operationId: randomUUID(),
    scope: 'generation',
    status: 'started',
  });
  assert.equal(old.preparation, undefined);
});

/** 计时只附带现有两个模型事件；持久化延迟不能计入模型请求时长。 */
test('model event saving is measured separately and storage failure still blocks dispatch', async () => {
  const events: ModelActivity[] = [];
  await observeModelRequest(
    'generation',
    () => new AIMessage('ok'),
    async (event) => {
      events.push(event);
      if (event.status === 'started') await delay(25);
    },
    undefined,
    undefined,
    { preparation: { totalMs: 123, imagesMs: 100 } },
  );
  assert.equal(events.length, 2);
  assert.ok(events[1].startedSaveMs! >= 20);
  assert.equal(events[1].preparation?.imagesMs, 100);
  assert.equal(modelActivitySchema.safeParse(events[1]).success, true);
  let dispatched = false;
  const error = new Error('private storage failure');
  await assert.rejects(
    observeModelRequest(
      'generation',
      () => {
        dispatched = true;
      },
      async () => {
        throw error;
      },
    ),
    (value) => value === error,
  );
  assert.equal(dispatched, false);
});

/** LRU 同时限制字节和条数，版本变化不复用，返回副本且不同 Run 无共享。 */
test('image cache is bounded, versioned, isolated and cannot be mutated by a consumer', () => {
  const cache = createRunImageCache(6, 2);
  const first = Buffer.from('abc');
  cache.set('sha-a/version-1', first);
  first[0] = 0;
  const read = cache.get('sha-a/version-1')!;
  assert.equal(read.toString(), 'abc');
  read[0] = 0;
  assert.equal(cache.get('sha-a/version-1')!.toString(), 'abc');
  assert.equal(cache.get('sha-b/version-2'), undefined);
  cache.set('b', Buffer.from('def'));
  cache.get('sha-a/version-1');
  cache.set('c', Buffer.from('ghi'));
  assert.equal(cache.get('b'), undefined);
  cache.set('large', Buffer.alloc(7));
  assert.equal(cache.get('large'), undefined);
  const byteBound = createRunImageCache(4, 4);
  byteBound.set('a', Buffer.from('abc'));
  byteBound.set('b', Buffer.from('de'));
  assert.equal(byteBound.get('a'), undefined);
  assert.equal(createRunImageCache().get('sha-a/version-1'), undefined);
});

/** 真正运行 Agent 工具循环：每次请求仍携带图片证据，准备耗时进入既有事件。 */
test('agent loop reports image preparation for each request and retains visual evidence', async (t) => {
  const model = new FakeToolCallingModel();
  t.mock.method(model, 'bindTools', () => model);
  let calls = 0;
  t.mock.method(model, '_generate', async (messages: BaseMessage[]) => {
    assert.ok(JSON.stringify(messages).includes('data:image/png;base64'));
    const message =
      ++calls === 1
        ? new AIMessage({
            content: '',
            tool_calls: [
              { id: 'read', name: 'read_file', args: { path: 'page.tsx', resource: false } },
            ],
          })
        : new AIMessage('done');
    return { generations: [{ text: message.text, message }] };
  });
  const events: ModelActivity[] = [];
  let images = 0;
  await runAgent({
    model,
    instructions: 'read page',
    messages: [
      new HumanMessage({
        content: [
          { type: 'text', text: 'look at screenshot' },
          { type: 'image_url', image_url: { url: 'attachment://fixture' } },
        ],
      }),
    ],
    tools: {
      list: async () => [],
      read: async () => 'page',
      write: async () => '',
      remove: async () => '',
      figma: async () => '',
      rules: async () => '',
      slices: async () => '',
    },
    maxTurns: 4,
    contextBudgetTokens: 100000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    resolveImage: async () => {
      images++;
      await delay(25);
      return { mimeType: 'image/png', data: Buffer.from('fixture') };
    },
    onModelActivity: async (event) => {
      events.push(event);
    },
  });
  assert.equal(calls, 2);
  assert.equal(images, 2);
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.ok(event.preparation!.imagesMs! >= 20);
    assert.ok(event.preparation!.totalMs >= event.preparation!.imagesMs!);
  }
});
