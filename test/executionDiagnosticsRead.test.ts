import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Op } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { messageFixture } from './helpers/messages';
import { readRunDiagnostics } from '../src/functions/d2c/run/diagnostics';
async function fixture() {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '生成页面',
  });
  Object.assign(f.tables.D2cRun[0], {
    status: 'running',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    leaseExpiresAt: new Date('2026-01-01T00:01:00Z'),
    error: null,
    modelSnapshot: { MODEL_NAME: 'safe-model', MODEL_API_KEY: 'PRIVATE_MODEL_KEY' },
  });
  // 本组自行构造完整计时事件，去掉enqueue时采用真实当前时间的初始stage。
  f.tables.D2cTimeline.length = 0;
  /** 诊断只读取白名单display字段，原始SDK条目和非法额外字段不得进入响应。 */
  function event(
    seq: number,
    kind: string,
    displayPayload: Record<string, unknown>,
    seconds: number,
    callId?: string,
  ) {
    f.tables.D2cTimeline.push({
      sessionId: f.id,
      runId: queued.runId,
      seq,
      kind,
      displayPayload: { ...displayPayload, private: 'PRIVATE_PAYLOAD' },
      toolCallId: callId,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000),
      sdkItem: { content: 'PRIVATE_SDK_ITEM' },
    });
  }
  return { ...f, queued, event };
}

/** 明确的逐轮采集总计，跨轮不会沿用旧累计预算。 */
function trackedUsage(requests: number, totalTokens: number) {
  return {
    trackingVersion: 1,
    requests,
    reportedRequests: requests,
    totalTokens,
    usageComplete: true,
  };
}

test('所选轮次、显式恢复链和会话用量分别累计，首终态与同轮重新queued排除空闲', async () => {
  const f = await fixture();
  const root = f.tables.D2cRun[0];
  Object.assign(root, {
    status: 'interrupted',
    resumeFromRunId: null,
    usage: trackedUsage(2, 20),
    updatedAt: new Date('2026-01-01T01:00:00Z'),
    error: { reason: 'WORKER_INTERRUPTED' },
  });
  f.event(1, 'run_status', { status: 'interrupted' }, 10);
  f.event(2, 'run_status', { status: 'cancelled' }, 25);
  f.tables.D2cRun.push({
    runId: 'child',
    sessionId: f.id,
    resumeFromRunId: root.runId,
    status: 'succeeded',
    createdAt: new Date('2026-01-01T00:01:00Z'),
    updatedAt: new Date('2026-01-01T01:00:00Z'),
    usage: trackedUsage(3, 30),
  });
  f.tables.D2cTimeline.push({
    sessionId: f.id,
    runId: 'child',
    seq: 3,
    kind: 'run_status',
    createdAt: new Date('2026-01-01T00:01:20Z'),
    displayPayload: { status: 'succeeded' },
  });
  f.tables.D2cRun.push({
    runId: 'unrelated',
    sessionId: f.id,
    resumeFromRunId: null,
    status: 'succeeded',
    createdAt: new Date('2026-01-01T00:02:00Z'),
    usage: trackedUsage(4, 40),
  });
  f.tables.D2cTimeline.push({
    sessionId: f.id,
    runId: 'unrelated',
    seq: 4,
    kind: 'run_status',
    createdAt: new Date('2026-01-01T00:02:30Z'),
    displayPayload: { status: 'succeeded' },
  });
  const selected = await readRunDiagnostics(f.mysql, 'employee-a', f.id, root.runId);
  assert.equal(selected.elapsedMs, 10000);
  assert.equal(selected.finishedAt, '2026-01-01T00:00:10.000Z');
  assert.equal(selected.execution.selected.usage.requests, 2);
  assert.equal(selected.execution.recoveryChain.usage.requests, 5);
  assert.equal(selected.execution.recoveryChain.usage.totalTokens, 50);
  assert.equal(selected.execution.recoveryChain.runCount, 2);
  assert.equal(selected.execution.recoveryChain.elapsedMs, 30000);
  assert.equal(selected.execution.session.usage.requests, 9);
  assert.equal(selected.execution.session.elapsedMs, 60000);
  assert.equal(selected.execution.interruption, 'worker');
  const child = await readRunDiagnostics(f.mysql, 'employee-a', f.id, 'child');
  assert.deepEqual(child.execution.recoveryChain, selected.execution.recoveryChain);
  assert.equal(child.execution.resumeFromRunId, root.runId);
  assert.equal(child.elapsedMs, 20000);
  // 同run有明确queued才开启新区间，后续cleanup不延长两段实际跨度。
  f.event(5, 'stage', { stage: 'queued', status: 'queued' }, 40);
  f.event(6, 'run_status', { status: 'succeeded' }, 45);
  Object.assign(root, { status: 'succeeded', error: null });
  const resumed = await readRunDiagnostics(f.mysql, 'employee-a', f.id, root.runId);
  assert.equal(resumed.elapsedMs, 15000);
  assert.equal(resumed.finishedAt, '2026-01-01T00:00:45.000Z');
  assert.equal(resumed.execution.recoveryChain.elapsedMs, 35000);
});

test('缺终态、缺父轮次、循环和旧累计用量均保持未知；未知工具不回显任意名称', async () => {
  const f = await fixture();
  const run = f.tables.D2cRun[0];
  Object.assign(run, {
    status: 'succeeded',
    resumeFromRunId: 'missing',
    usage: { requests: 99, totalTokens: 999 },
  });
  let result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.finishedAt, null);
  assert.equal(result.execution.recoveryChain.complete, false);
  assert.equal(result.execution.recoveryChain.usage.requests, null);
  assert.equal(result.execution.session.usage.requests, null);
  // 单轮旧统计保留，不把其累计预算当作跨轮实际用量。
  assert.equal(result.usage.requests, 99);
  run.resumeFromRunId = run.runId;
  result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.execution.recoveryChain.complete, false);
  for (const [index, name] of ['build_preview', 'inspect_preview', 'PRIVATE_TOOL'].entries()) {
    f.event(10 + index * 2, 'tool_call', { name, status: 'started' }, 1, `call-${index}`);
    f.event(11 + index * 2, 'tool_result', { name, status: 'completed' }, 2, `call-${index}`);
  }
  result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['build_preview', 'inspect_preview', '未知工具'],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOOL/);
  Object.assign(run, { status: 'interrupted', error: { reason: 'LEASE_EXPIRED' } });
  assert.equal(
    (await readRunDiagnostics(f.mysql, 'employee-a', f.id)).execution.interruption,
    'lease',
  );
  run.error = {
    reason: 'WORKER_INTERRUPTED',
    failure: {
      code: 'STORAGE_FAILED',
      stage: 'storage',
      errorId: '11111111-1111-4111-8111-111111111111',
      message: 'safe',
      suggestion: 'safe',
    },
  };
  assert.equal(
    (await readRunDiagnostics(f.mysql, 'employee-a', f.id)).execution.interruption,
    'failure',
  );
});

test('有界诊断先小键排序、再无order读取usage和displayPayload；超限不声称全量', async () => {
  const f = await fixture();
  f.event(1, 'run_status', { status: 'running' }, 1);
  const calls: Array<{ table: string; options: any }> = [];
  for (const table of ['D2cRun', 'D2cTimeline']) {
    const model = f.mysql.models[table] as any;
    const read = model.findAll.bind(model);
    model.findAll = async (options: any) => {
      calls.push({ table, options });
      return read(options);
    };
  }
  await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  const runCalls = calls.filter((call) => call.table === 'D2cRun');
  assert.deepEqual(runCalls[0].options.attributes, ['runId']);
  assert.equal(runCalls[0].options.limit, 2001);
  assert.ok(runCalls[0].options.order);
  assert.equal(runCalls[1].options.order, undefined);
  assert.ok(runCalls[1].options.attributes.includes('usage'));
  assert.ok(!runCalls[1].options.attributes.includes('checkpoint'));
  const timeCalls = calls.filter(
    (call) => call.table === 'D2cTimeline' && isTimingQuery(call.options),
  );
  assert.deepEqual(timeCalls[0].options.attributes, ['seq']);
  assert.equal(timeCalls[0].options.limit, 20001);
  assert.equal(timeCalls[1].options.order, undefined);
  assert.ok(timeCalls[1].options.attributes.includes('displayPayload'));
  const model = f.mysql.models.D2cRun as any;
  model.findAll = async (options: any) =>
    options.raw
      ? Array.from({ length: 2001 }, (_, i) => ({ runId: `cap-${i}` }))
      : Array.from({ length: 2001 }, (_, i) => ({
          runId: `cap-${i}`,
          status: 'running',
          resumeFromRunId: null,
          createdAt: new Date(),
          usage: trackedUsage(1, 1),
        }));
  const capped = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(capped.execution.session.runCount, 2000);
  assert.equal(capped.execution.session.complete, false);
  assert.equal(capped.execution.session.usage.requests, null);
  assert.equal(capped.sessionElapsedMs, null);
});

test('状态事件超过20,000条时返回不完整并保持耗时未知，不扩大读取窗口', async () => {
  const f = await fixture();
  const model = f.mysql.models.D2cTimeline as any;
  const read = model.findAll.bind(model);
  let first: any, second: any;
  model.findAll = async (options: any) => {
    if (!isTimingQuery(options)) return read(options);
    if (options.raw) {
      first = options;
      return Array.from({ length: 20001 }, (_, index) => ({ seq: index + 1 }));
    }
    second = options;
    return Array.from({ length: 20001 }, (_, index) => ({
      runId: f.queued.runId,
      seq: index + 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      displayPayload: { status: 'running' },
    }));
  };
  const result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(first.limit, 20001);
  assert.deepEqual(first.attributes, ['seq']);
  assert.equal(second.order, undefined);
  assert.equal(result.execution.session.complete, false);
  assert.equal(result.execution.recoveryChain.complete, false);
  assert.equal(result.elapsedMs, null);
  assert.equal(result.sessionElapsedMs, null);
});

test('进程中断不抹掉已记录模型失败，未返回的工具不冒充已确认故障', async () => {
  const f = await fixture();
  Object.assign(f.tables.D2cRun[0], {
    status: 'interrupted',
    error: { reason: 'WORKER_INTERRUPTED' },
  });
  f.event(
    1,
    'model_status',
    {
      operationId: randomUUID(),
      scope: 'generation',
      status: 'failed',
      interrupted: false,
      durationMs: 1000,
    },
    1,
  );
  f.event(2, 'tool_call', { name: 'build_preview', status: 'started' }, 2, 'unfinished');
  let result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.steps[0].status, 'failed');
  assert.equal(result.steps[1].status, 'interrupted');
  Object.assign(f.tables.D2cRun[0], { status: 'failed' });
  result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.steps[1].status, 'interrupted');
  assert.equal(result.steps[1].durationMs, null);
});

/** 与生产查询同样匹配主轮状态及明确queued，排除子任务阶段。 */
function isTimingQuery(options: any) {
  return options.where[Op.or]?.some((clause: any) => clause.kind === 'run_status') === true;
}

test('回答的真实stage queued开启同run新区间，子Agent queued不延长终态', async () => {
  const f = await fixture();
  const run = f.tables.D2cRun[0];
  Object.assign(run, { status: 'succeeded', resumeFromRunId: null, usage: trackedUsage(1, 10) });
  f.event(1, 'run_status', { status: 'interrupted' }, 10);
  f.event(2, 'stage', { stage: 'subagent', status: 'queued', agentId: randomUUID() }, 30);
  let result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.elapsedMs, 10000);
  assert.equal(result.finishedAt, '2026-01-01T00:00:10.000Z');
  f.event(3, 'stage', { stage: 'queued', status: 'queued' }, 40);
  f.event(4, 'run_status', { status: 'succeeded' }, 45);
  result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.elapsedMs, 15000);
  assert.equal(result.execution.session.elapsedMs, 15000);
  assert.equal(result.finishedAt, '2026-01-01T00:00:45.000Z');
});

test('两次查询间新增请求，后读所选轮次回填会话与链，避免selected大于session', async () => {
  const f = await fixture();
  const run = f.tables.D2cRun[0];
  Object.assign(run, { resumeFromRunId: null, usage: trackedUsage(1, 10) });
  const model = f.mysql.models.D2cRun as any;
  const read = model.findOne.bind(model);
  model.findOne = async (options: any) => {
    run.usage = trackedUsage(2, 20);
    return read(options);
  };
  const result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.execution.selected.usage.requests, 2);
  assert.equal(result.execution.recoveryChain.usage.requests, 2);
  assert.equal(result.execution.session.usage.requests, 2);
  assert.equal(result.execution.session.usage.totalTokens, 20);
  assert.equal(result.execution.session.complete, true);
});
