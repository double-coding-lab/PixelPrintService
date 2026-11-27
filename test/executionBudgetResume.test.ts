import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { messageFixture } from './helpers/messages';

for (const budget of [
  { maxTurns: 600, runTimeoutMs: 10800000 },
  { maxTurns: 20, runTimeoutMs: 300000 },
])
  test(`手动继续采用当前执行预算，保留原轮次和幂等新轮次：${budget.maxTurns}`, async () => {
    const f = await messageFixture();
    const queued = await f.messages.enqueue('employee-a', f.id, {
      clientRequestId: 'original-budget',
      content: '生成页面',
    });
    const previous = f.tables.D2cRun[0];
    const original = structuredClone(previous.modelSnapshot);
    Object.assign(previous, {
      status: 'interrupted',
      usage: { requests: original.maxTurns },
      error: { reason: 'WORKER_INTERRUPTED', failure: { code: 'MODEL_REQUEST_LIMIT' } },
    });
    Object.assign(f.runtime.d2c.execution, budget);
    const continued = await f.messages.resume('employee-a', f.id, queued.runId, 'manual-resume');
    const run = f.tables.D2cRun.find((row) => row.runId === continued.runId)!;
    assert.equal(run.modelSnapshot.maxTurns, budget.maxTurns);
    assert.equal(run.modelSnapshot.runTimeoutMs, budget.runTimeoutMs);
    assert.deepEqual(previous.modelSnapshot, original);
    assert.equal(run.resumeFromRunId, queued.runId);
    f.runtime.d2c.execution.maxTurns = 999;
    const retried = await f.messages.resume('employee-a', f.id, queued.runId, 'manual-resume');
    assert.equal(retried.runId, continued.runId);
    assert.equal(run.modelSnapshot.maxTurns, budget.maxTurns);
    assert.equal(f.tables.D2cRun.length, 2);
  });

test('自动恢复沿原快照扣减预算，提升运行配置也不能重置限额', async () => {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'automatic-budget',
    content: '生成页面',
  });
  const previous = f.tables.D2cRun[0];
  const original = structuredClone(previous.modelSnapshot);
  const endedAt = Date.now() - 10000;
  Object.assign(previous, {
    status: 'interrupted',
    error: { reason: 'LEASE_EXPIRED' },
    usage: { requests: 7 },
    createdAt: new Date(endedAt - 20000),
    updatedAt: new Date(endedAt),
    checkpoint: { executionStartedAt: new Date(endedAt - 20000).toISOString() },
  });
  Object.assign(f.runtime.d2c.execution, { maxTurns: 600, runTimeoutMs: 10800000 });
  const continued = await f.messages.automaticallyResume('employee-a', f.id, queued.runId);
  const run = f.tables.D2cRun.find((row) => row.runId === continued.runId)!;
  assert.equal(run.modelSnapshot.maxTurns, original.maxTurns - 7);
  assert.equal(run.modelSnapshot.runTimeoutMs, original.runTimeoutMs - 20000);
  assert.deepEqual(previous.modelSnapshot, original);
});
