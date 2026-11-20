import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { messageFixture } from './helpers/messages';
import { readSessionErrors } from '../src/functions/d2c/run/errorDiagnostics';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { runFailureSchema } from '../src/functions/d2c/run/errors';
import { toolFeedback } from '../src/functions/d2c/run/toolFeedback';
import { observeModelRequest } from '../src/functions/d2c/run/agent/modelActivity';

/** 正式保存器与租约配合离线事务替身，验证真实投影，不访问数据库或模型。 */
async function fixture() {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '错误统计',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = (await leases.claim(queued.runId, 'errors-worker'))!;
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    redact: (text) => text,
    notify: () => {},
  });
  await persistence.load();
  /** 历史展示记录替身；SDK与不受信任附加字段必须被隔离。 */
  function event(
    kind: string,
    data: Record<string, unknown>,
    runId = queued.runId,
    at = new Date(),
  ) {
    const seq = Math.max(0, ...f.tables.D2cTimeline.map((row) => Number(row.seq))) + 1;
    f.tables.D2cTimeline.push({
      sessionId: f.id,
      runId,
      seq,
      kind,
      createdAt: at,
      displayPayload: { ...data, private: 'PRIVATE_PAYLOAD' },
      sdkItem: { text: 'PRIVATE_SDK' },
      toolCallId: data.callId,
    });
    f.tables.D2cSession[0].timelineSeq = seq;
    return seq;
  }
  return {
    ...f,
    queued,
    leases,
    lease,
    persistence,
    event,
    read: (query: Parameters<typeof readSessionErrors>[3] = {}) =>
      readSessionErrors(f.mysql, 'employee-a', f.id, query),
  };
}

/** 只构造平台固定失败，敏感附加数据不属于共享诊断合同。 */
function failure(code = 'MODEL_REQUEST_FAILED', extra: Record<string, unknown> = {}) {
  return runFailureSchema.parse({ errorId: randomUUID(), stage: 'model', code, ...extra });
}

test('真实保存器跨轮次保留模型失败、工具反馈及主子失败，规则单列且不修改历史', async () => {
  const f = await fixture();
  const p = f.persistence;
  const agentId = randomUUID();
  const sharedModelError = new Error('PRIVATE_MODEL');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      observeModelRequest(
        'generation',
        async () => {
          throw sharedModelError;
        },
        (event) => p.recordModelActivity(event),
      ),
    );
  }
  await p.record({
    kind: 'tool_call',
    name: 'read_file',
    callId: 'missing',
    sdkItem: {
      type: 'function_call',
      callId: 'missing',
      name: 'read_file',
      arguments: '{}',
    },
  });
  await p.record({
    kind: 'tool_result',
    name: 'read_file',
    callId: 'missing',
    sdkItem: {
      type: 'function_call_result',
      callId: 'missing',
      output: JSON.stringify(
        toolFeedback('FILE_NOT_FOUND', { detail: 'PRIVATE_DETAIL', path: 'PRIVATE_PATH' }),
      ),
    },
  });
  await p.recordSubagent({
    stage: 'subagent',
    agentId,
    role: 'ui',
    status: 'tool_feedback',
    tool: 'check_rules',
    callId: 'rules',
    feedback: toolFeedback('RULES_FAILED'),
  });
  await p.recordSubagent({ stage: 'subagent', agentId, role: 'ui', status: 'failed' });
  await f.leases.settle(f.lease, 'succeeded');
  const next = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '下一轮',
  });
  const lease = (await f.leases.claim(next.runId, 'errors-worker-2'))!;
  const p2 = createRunPersistence(f.mysql, f.leases, lease, {
    limits: f.runtime.d2c.limits,
    redact: (text) => text,
    notify: () => {},
  });
  await p2.load();
  const terminal = failure('STORAGE_FAILED', { stage: 'storage' });
  await f.leases.settle(lease, 'failed', terminal);
  const before = JSON.stringify(f.tables);
  const result = await f.read();
  assert.equal(result.executionErrors, 4);
  assert.equal(result.toolCorrections, 1);
  assert.equal(result.ruleFailures, 1);
  assert.equal(result.total, 5);
  assert.equal(result.items.length, 6);
  assert.equal(result.items.filter((item) => item.category === 'model').length, 2);
  assert.equal(
    new Set(result.items.filter((item) => item.category === 'model').map((item) => item.errorId))
      .size,
    2,
  );
  assert.equal(result.items.find((item) => item.category === 'subagent')?.scope, 'subagent');
  assert.equal(result.items.find((item) => item.category === 'storage')?.errorId, terminal.errorId);
  assert.equal(result.coverage.historical, 'saved_events_only');
  assert.equal(JSON.stringify(f.tables), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|cause|sdkItem|stack/);
});

test('errorId、operationId与callId桥接跨层去重，同文案独立operation不合并', async () => {
  const f = await fixture();
  const child = randomUUID(),
    operationId = randomUUID(),
    diagnosticFailure = failure();
  const first = f.event('model_status', {
    operationId,
    agentId: child,
    scope: 'ui',
    status: 'failed',
    diagnosticFailure,
  });
  f.event('stage', {
    stage: 'subagent',
    agentId: child,
    role: 'ui',
    status: 'failed',
    diagnosticFailure,
  });
  f.event('run_status', { status: 'failed', failure: diagnosticFailure });
  f.event('model_status', {
    operationId,
    agentId: child,
    scope: 'ui',
    status: 'failed',
    diagnosticFailure,
  });
  for (let i = 0; i < 2; i++)
    f.event('model_status', {
      operationId: randomUUID(),
      scope: 'generation',
      status: 'failed',
      message: 'same message',
    });
  const toolFailure = failure('TOOL_FAILED', { stage: 'tool', tool: 'read_file' });
  f.event('tool_result', {
    callId: 'call-a',
    name: 'read_file',
    status: 'completed',
    feedback: toolFeedback('FILE_NOT_FOUND'),
  });
  f.event('tool_result', {
    callId: 'call-a',
    name: 'read_file',
    status: 'failed',
    diagnosticFailure: toolFailure,
  });
  f.event('run_status', { status: 'failed', failure: toolFailure });
  const result = await f.read();
  assert.equal(result.executionErrors, 3);
  assert.equal(result.toolCorrections, 1);
  assert.equal(result.total, 4);
  assert.equal(result.items.find((item) => item.errorId === diagnosticFailure.errorId)?.seq, first);
});

test('去重后的稳定逆序分页与筛选不改变会话总数，新增事件不能挤入冻结快照', async () => {
  const f = await fixture();
  const child = randomUUID();
  for (let i = 0; i < 7; i++) {
    const operationId = randomUUID();
    f.event('model_status', { operationId, scope: 'ui', agentId: child, status: 'failed' });
    f.event('model_status', { operationId, scope: 'ui', agentId: child, status: 'failed' });
  }
  f.event('tool_result', {
    name: 'read_file',
    status: 'completed',
    feedback: toolFeedback('FILE_NOT_FOUND'),
  });
  f.event('tool_result', {
    name: 'check_rules',
    status: 'completed',
    feedback: toolFeedback('RULES_FAILED'),
  });
  const one = await f.read({ category: 'model', scope: 'subagent', pageSize: 3 });
  assert.equal(one.total, 8);
  assert.equal(one.filteredTotal, 7);
  assert.equal(one.nextBefore, 3);
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'ui',
    agentId: child,
    status: 'failed',
  });
  const two = await f.read({
    snapshotSeq: one.snapshotSeq,
    snapshotToken: one.snapshotToken,
    category: 'model',
    scope: 'subagent',
    before: one.nextBefore!,
    pageSize: 3,
  });
  const three = await f.read({
    snapshotSeq: one.snapshotSeq,
    snapshotToken: one.snapshotToken,
    category: 'model',
    scope: 'subagent',
    before: two.nextBefore!,
    pageSize: 3,
  });
  assert.equal(two.total, one.total);
  assert.equal(three.nextBefore, null);
  assert.equal(
    new Set([...one.items, ...two.items, ...three.items].map((item) => item.id)).size,
    7,
  );
  assert.ok(one.items[0].seq! > two.items[0].seq!);
  assert.equal((await f.read()).total, 9);
  assert.equal((await f.read({ runId: 'other-run' })).filteredTotal, 0);
});

test('有序号的源记录ID不因后续补充errorId、跨层包装和缓存过期而改变', async (t) => {
  const f = await fixture();
  const operationId = randomUUID();
  f.event('model_status', { operationId, scope: 'generation', status: 'failed' });
  const initial = await f.read();
  const diagnosticFailure = failure();
  f.event('model_status', {
    operationId,
    scope: 'generation',
    status: 'failed',
    diagnosticFailure,
  });
  f.event('run_status', { status: 'failed', failure: diagnosticFailure });
  const later = await f.read();
  assert.equal(later.total, 1);
  assert.equal(later.items[0].id, initial.items[0].id);
  t.mock.method(Date, 'now', () => Date.parse('2099-01-01'));
  assert.equal((await f.read()).items[0].id, initial.items[0].id);
});

test('恢复只认明确重试与同归属后续模型成功，已恢复错误保留；工具与整轮成功不推断恢复', async () => {
  const f = await fixture();
  const child = randomUUID();
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'generation',
    status: 'failed',
    retryIndex: 0,
    retryAttempt: 1,
  });
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'ui',
    agentId: child,
    status: 'failed',
    retryIndex: 1,
    retryAttempt: 2,
  });
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'ui',
    agentId: randomUUID(),
    status: 'completed',
  });
  f.event('model_status', { operationId: randomUUID(), scope: 'summary', status: 'failed' });
  f.event('model_status', { operationId: randomUUID(), scope: 'generation', status: 'completed' });
  f.event('tool_result', {
    callId: 'bad',
    name: 'read_file',
    status: 'completed',
    feedback: toolFeedback('FILE_NOT_FOUND'),
  });
  f.event('tool_result', { callId: 'new', name: 'read_file', status: 'completed' });
  f.event('run_status', { status: 'succeeded' });
  const result = await f.read();
  assert.equal(result.total, 4);
  const generation = result.items.find((item) => item.attempt === 1)!;
  assert.equal(generation.recovery, 'subsequent_success');
  assert.equal(result.items.find((item) => item.attempt === 2)?.recovery, 'unresolved');
  assert.equal(result.items.find((item) => item.tool === 'read_file')?.recovery, 'unknown');
  assert.equal(result.items.find((item) => item.scope === 'unknown')?.recovery, 'unknown');
});

test('失败/中断终态清除重试中，正常停止、暂停、补齐未知配对与interrupted模型不计错误', async () => {
  const f = await fixture();
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'generation',
    status: 'failed',
    interrupted: true,
  });
  f.event('tool_result', { name: 'read_file', status: 'failed', recovered: true });
  f.event('run_status', { status: 'interrupted' });
  f.event('run_status', {
    status: 'interrupted',
    failure: failure('WORKER_INTERRUPTED', { stage: 'worker' }),
  });
  f.event('run_status', { status: 'cancelled' });
  f.event('run_status', { status: 'paused' });
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'generation',
    status: 'failed',
    retryAttempt: 1,
  });
  f.event('run_status', {
    status: 'interrupted',
    failure: failure('RUN_TIMEOUT', { stage: 'worker' }),
  });
  const result = await f.read();
  assert.equal(result.total, 2);
  assert.equal(result.items.find((item) => item.category === 'model')?.recovery, 'unresolved');
  assert.equal(result.items.find((item) => item.code === 'RUN_TIMEOUT')?.stage, 'worker');
});

test('未知历史保守分列、缺少编号为null；固定说明及标识拒绝凭据，不读取任意诊断正文', async () => {
  const f = await fixture();
  f.event('tool_result', {
    name: 'PRIVATE_TOOL',
    status: 'failed',
    code: 'PRIVATE_UNKNOWN',
    errorId: 'sk-private',
    requestId: 'BearerPrivate',
    callId: 'token-secret',
    command: 'PRIVATE_CMD',
    message: 'PRIVATE_MESSAGE',
    stack: 'PRIVATE_STACK',
    input: 'PRIVATE_INPUT',
    output: 'PRIVATE_OUTPUT',
  });
  f.event('tool_result', {
    name: 'read_file',
    status: 'completed',
    feedback: {
      ...toolFeedback('INVALID_ARGUMENT'),
      detail: 'PRIVATE_DETAIL',
      message: 'PRIVATE_MESSAGE',
      path: 'PRIVATE_PATH',
    },
  });
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'generation',
    status: 'failed',
    gatewayRequestId: 'figd_secret',
  });
  f.event('model_status', {
    operationId: randomUUID(),
    scope: 'generation',
    status: 'failed',
    gatewayRequestId: 'req-safe:1',
  });
  f.event('stage', {
    stage: 'subagent',
    role: 'PRIVATE_ROLE',
    agentId: 'api_key_secret',
    status: 'failed',
  });
  f.event('run_status', {
    status: 'failed',
    failure: { ...failure(), message: 'PRIVATE_MESSAGE', cause: { secret: 'PRIVATE_CAUSE' } },
  });
  f.event('preview_changed', { status: 'changed', diagnosticFailure: 'PRIVATE_UNSTRUCTURED' });
  const result = await f.read();
  assert.equal(result.total, 6);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|sk-private|BearerPrivate|figd_secret|api_key_secret|token-secret/,
  );
  const unknown = result.items.find((item) => item.category === 'tool' && item.tool === null)!;
  assert.equal(unknown.errorId, null);
  assert.equal(unknown.requestId, null);
  assert.equal(unknown.attempt, null);
  assert.equal(result.items.find((item) => item.requestId)?.requestId, 'req-safe:1');
  assert.equal(result.items.find((item) => item.category === 'subagent')?.agentId, null);
});

test('preview工具已有失败分类为preview，不把changed通知或规则结果推算成预览失败', async () => {
  const f = await fixture();
  for (const name of ['build_preview', 'inspect_preview'])
    f.event('tool_result', { name, status: 'failed' });
  f.event('preview_changed', { status: 'changed' });
  f.event('tool_result', {
    name: 'check_rules',
    status: 'completed',
    feedback: toolFeedback('RULES_FAILED'),
  });
  const result = await f.read();
  assert.equal(result.items.filter((item) => item.category === 'preview').length, 2);
  assert.equal(result.executionErrors, 2);
  assert.equal(result.ruleFailures, 1);
  assert.equal(result.total, 2);
});

test('冻结快照只回补边界前的Run.error，分页不吸入新终态；缓存过期拒绝重算偏移', async (t) => {
  const f = await fixture();
  const old = failure('STORAGE_FAILED', { stage: 'storage' });
  const boundary = new Date('2026-10-02');
  f.tables.D2cRun.push({
    runId: 'old-run',
    sessionId: f.id,
    status: 'failed',
    updatedAt: new Date('2026-10-01'),
    error: { failure: { ...old, cause: 'PRIVATE_CAUSE' }, stack: 'PRIVATE_STACK' },
  });
  f.event(
    'model_status',
    { operationId: randomUUID(), scope: 'generation', status: 'failed' },
    f.queued.runId,
    boundary,
  );
  const first = await f.read({ pageSize: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.nextBefore, 1);
  Object.assign(f.tables.D2cRun[0], {
    status: 'failed',
    updatedAt: new Date('2026-10-03'),
    error: { failure: failure() },
  });
  Object.assign(f.tables.D2cRun.find((run) => run.runId === 'old-run')!, {
    status: 'interrupted',
    updatedAt: new Date('2026-10-03'),
    error: { failure: failure() },
  });
  f.event(
    'model_status',
    { operationId: randomUUID(), scope: 'generation', status: 'failed' },
    f.queued.runId,
    new Date('2026-10-04'),
  );
  const next = await f.read({
    snapshotSeq: first.snapshotSeq,
    snapshotToken: first.snapshotToken,
    before: 1,
    pageSize: 1,
  });
  assert.equal(next.total, 2);
  assert.equal(next.items[0].seq, null);
  assert.equal(next.items[0].errorId, old.errorId);
  assert.doesNotMatch(JSON.stringify(next), /PRIVATE/);
  t.mock.method(Date, 'now', () => Date.parse('2099-01-01'));
  await assert.rejects(
    f.read({
      snapshotSeq: first.snapshotSeq,
      snapshotToken: first.snapshotToken,
      before: 1,
      pageSize: 1,
    }),
    {
      statusCode: 409,
      reason: 'SNAPSHOT_EXPIRED',
    },
  );
  const cold = await f.read({ snapshotSeq: first.snapshotSeq, before: 0, pageSize: 2 });
  assert.equal(cold.total, 1);
  assert.equal(cold.coverage.complete, false);
});

test('快照有界驱逐后安全投影未变可重算继续，不依赖sticky session', async () => {
  const f = await fixture();
  f.event('tool_result', { name: 'read_file', status: 'failed' });
  f.event('tool_result', { name: 'read_file', status: 'failed' });
  const first = await f.read({ pageSize: 1 });
  for (let i = 0; i < 127; i++) {
    f.event('model_status', {
      operationId: randomUUID(),
      scope: 'generation',
      status: 'completed',
    });
    await f.read();
  }
  assert.equal(
    (
      await f.read({
        snapshotSeq: first.snapshotSeq,
        snapshotToken: first.snapshotToken,
        before: 1,
      })
    ).total,
    2,
  );
  f.event('model_status', { operationId: randomUUID(), scope: 'generation', status: 'completed' });
  await f.read();
  const evicted = await f.read({
    snapshotSeq: first.snapshotSeq,
    snapshotToken: first.snapshotToken,
    before: 1,
  });
  assert.equal(evicted.snapshotToken, first.snapshotToken);
  assert.equal(evicted.items.length, 1);
  const otherMysql = { models: f.mysql.models } as typeof f.mysql;
  const otherInstance = await readSessionErrors(otherMysql, 'employee-a', f.id, {
    snapshotSeq: first.snapshotSeq,
    snapshotToken: first.snapshotToken,
    before: 1,
  });
  assert.equal(otherInstance.snapshotToken, first.snapshotToken);
  assert.deepEqual(otherInstance.items, evicted.items);
});

test('冷缓存TTL过期但安全投影未变化仍能翻页，token不含观测时间且不受筛选影响', async (t) => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    f.event('tool_result', { callId: `fixed-${i}`, name: 'read_file', status: 'failed' });
  const first = await f.read({ pageSize: 1 });
  assert.match(first.snapshotToken, /^[a-f0-9]{64}$/);
  assert.equal((await f.read({ category: 'model' })).snapshotToken, first.snapshotToken);
  t.mock.method(Date, 'now', () => Date.parse('2099-01-01'));
  const later = await f.read({
    snapshotSeq: first.snapshotSeq,
    snapshotToken: first.snapshotToken,
    before: 1,
    pageSize: 1,
  });
  assert.equal(later.snapshotToken, first.snapshotToken);
  assert.equal(later.total, first.total);
  assert.notEqual(later.items[0].id, first.items[0].id);
  await assert.rejects(
    f.read({ snapshotSeq: first.snapshotSeq, snapshotToken: '0'.repeat(64), before: 1 }),
    { statusCode: 409, reason: 'SNAPSHOT_EXPIRED' },
  );
});

test('相关事件上限截断与轮次上限均明确不完整；无关大正文不参与扫描', async () => {
  const f = await fixture();
  // 直接批量构造历史替身，避免辅助函数的O(n²)计序。
  const first = f.tables.D2cSession[0].timelineSeq + 1;
  for (let i = 0; i < 20001; i++)
    f.tables.D2cTimeline.push({
      sessionId: f.id,
      runId: f.queued.runId,
      seq: first + i,
      kind: 'tool_result',
      createdAt: new Date(),
      displayPayload: { name: 'read_file', status: 'failed', callId: `call-${i}` },
    });
  for (let i = 0; i < 2001; i++)
    f.tables.D2cRun.push({
      runId: `old-${i}`,
      sessionId: f.id,
      status: 'succeeded',
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-01-01'),
    });
  f.event('stage', { stage: 'subagent', status: 'message', message: { text: 'PRIVATE_LARGE' } });
  f.event('message', { text: 'PRIVATE_LARGE' });
  const result = await f.read({ pageSize: 999 });
  assert.equal(result.total, 20000);
  assert.equal(result.items.length, 100);
  assert.equal(result.coverage.scannedEvents, 20000);
  assert.equal(result.coverage.limit, 20000);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.historical, 'saved_events_only');
});

test('轮次回补独立设上限，事件未截断时也不宣称历史完整', async (t) => {
  const f = await fixture();
  f.event('model_status', { operationId: randomUUID(), scope: 'generation', status: 'failed' });
  for (let i = 0; i < 2001; i++)
    f.tables.D2cRun.push({
      runId: `older-${i}`,
      sessionId: f.id,
      status: 'succeeded',
      createdAt: new Date('2020-01-01'),
      updatedAt: new Date('2020-01-01'),
    });
  const model = f.mysql.models.D2cRun;
  const original = model.findAll.bind(model);
  t.mock.method(model, 'findAll', async (...args: Parameters<typeof model.findAll>) => {
    if (args[0]?.order) assert.equal(args[0].limit, 2001);
    return original(...args);
  });
  const result = await f.read();
  assert.equal(result.total, 1);
  assert.ok(result.coverage.scannedEvents < 20000);
  assert.equal(result.coverage.complete, false);
});

test('鉴权每次先执行，缓存不绕过撤权，连接/会话隔离；空历史不宣称完整零', async () => {
  const f = await fixture();
  f.event('tool_result', { name: 'read_file', status: 'failed' });
  await f.read();
  await assert.rejects(readSessionErrors(f.mysql, 'employee-b', f.id, {}), { statusCode: 404 });
  f.tables.D2cWorkspace[0].createdUserId = 'employee-b';
  await assert.rejects(f.read(), { statusCode: 404 });
  const other = await fixture();
  assert.equal((await other.read()).total, 0);
  assert.equal((await other.read()).coverage.complete, true); // 仅queued/running的已保存事件可扫描完整。
  other.tables.D2cTimeline.length = 0;
  const empty = await other.read();
  assert.equal(empty.coverage.complete, false);
  assert.equal(empty.coverage.historical, 'saved_events_only');
  assert.equal(empty.total, 0);
});

test('源码读取仅投影元数据，JSON正文不参与排序，无SDK/检查点/快照查询与业务写入', async (t) => {
  const f = await fixture();
  f.event('tool_result', { name: 'read_file', status: 'failed' });
  for (const name of ['D2cTimeline', 'D2cRun']) {
    const model = f.mysql.models[name];
    const original = model.findAll.bind(model);
    t.mock.method(model, 'findAll', async (...args: Parameters<typeof model.findAll>) => {
      const options = args[0]!;
      assert.ok(Array.isArray(options.attributes));
      const fields = options.attributes as string[];
      assert.ok(
        !fields.some((value) =>
          ['sdkItem', 'checkpoint', 'configSnapshot', 'modelSnapshot', 'usage'].includes(value),
        ),
      );
      if (options.order)
        assert.ok(!fields.some((value) => ['displayPayload', 'error'].includes(value)));
      return original(...args);
    });
  }
  const before = JSON.stringify(f.tables);
  const index = f.queries.length;
  await f.read();
  assert.equal(JSON.stringify(f.tables), before);
  assert.ok(!f.queries.slice(index).some((query) => /Checkpoint|AgentWrite/.test(query.table)));
});

test('函数拒绝非法筛选与偏移，pageSize默认50最大100，偏移越界为空页', async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++)
    f.event('tool_result', { callId: `id-${i}`, name: 'read_file', status: 'failed' });
  assert.equal((await f.read()).items.length, 50);
  assert.equal((await f.read({ pageSize: 1000 })).items.length, 100);
  const first = await f.read();
  assert.deepEqual(
    (
      await f.read({
        snapshotSeq: first.snapshotSeq,
        snapshotToken: first.snapshotToken,
        before: 999,
      })
    ).items,
    [],
  );
  for (const query of [
    { before: -1 },
    { before: 1 },
    { before: 1, snapshotSeq: first.snapshotSeq },
    { before: 1, snapshotToken: first.snapshotToken },
    { snapshotToken: 'bad' },
    { snapshotSeq: 1.2 },
    { snapshotSeq: 999999 },
    { pageSize: 0 },
    { runId: '../bad' },
    { runId: 'token-secret' },
  ])
    await assert.rejects(f.read(query), { statusCode: 422 });
});

test('历史终态未带failure时关联同轮安全错误，避免重复计算同一次模型失败', async () => {
  const f = await fixture();
  const saved = failure('NETWORK_TIMEOUT');
  const boundary = new Date('2026-11-20T01:00:00Z');
  Object.assign(f.tables.D2cRun[0], {
    status: 'failed',
    updatedAt: boundary,
    error: { failure: { ...saved, message: 'PRIVATE_RAW_BODY' }, stack: 'PRIVATE_STACK' },
  });
  f.event(
    'model_status',
    {
      operationId: randomUUID(),
      scope: 'generation',
      status: 'failed',
      diagnosticFailure: saved,
    },
    f.queued.runId,
    boundary,
  );
  f.event('run_status', { status: 'failed' }, f.queued.runId, boundary);
  const snapshot = await f.read();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.items[0].errorId, saved.errorId);
  assert.equal(snapshot.items[0].code, 'NETWORK_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});
