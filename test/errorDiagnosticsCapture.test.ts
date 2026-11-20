import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  beginFailureOccurrence,
  diagnoseRunFailure,
  RunExecutionError,
} from '../src/functions/d2c/run/errors';
import {
  observeModelRequest,
  type ModelActivity,
} from '../src/functions/d2c/run/agent/modelActivity';
import { subagentEventSchema } from '../src/functions/d2c/run/subagent';

test('同一失败在模型、子任务和轮次边界复用排查编号，独立重试重新计数', async () => {
  const original = Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { status: 429 });
  const events: ModelActivity[] = [];
  const publish = async (event: ModelActivity) => {
    events.push(event);
  };
  const action = async () => {
    throw original;
  };
  await assert.rejects(observeModelRequest('rule_scan', action, publish));
  const first = events.at(-1)!.diagnosticFailure!;
  assert.equal(first.code, 'MODEL_RATE_LIMITED');
  const wrapped = new RunExecutionError(
    'SUBAGENT_FAILED',
    { stage: 'tool', tool: 'delegate_agent' },
    original,
  );
  assert.equal(diagnoseRunFailure(wrapped).failure.errorId, first.errorId);
  await assert.rejects(observeModelRequest('rule_scan', action, publish));
  const second = events.at(-1)!.diagnosticFailure!;
  assert.notEqual(second.errorId, first.errorId);
  assert.equal(diagnoseRunFailure(original).failure.errorId, second.errorId);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_PROVIDER_BODY/);
});

test('人工取消只有中断元数据，不写入错误明细的失败投影', async () => {
  const controller = new AbortController();
  const events: ModelActivity[] = [];
  await assert.rejects(
    observeModelRequest(
      'generation',
      async () => {
        controller.abort();
        throw new Error('PRIVATE_CANCEL');
      },
      async (event) => {
        events.push(event);
      },
      controller.signal,
    ),
  );
  assert.equal(events.at(-1)!.interrupted, true);
  assert.equal(events.at(-1)!.diagnosticFailure, undefined);
});

test('安全子任务失败投影重建固定说明，丢弃原始上下文和上游正文', () => {
  const failure = diagnoseRunFailure(new Error('PRIVATE_SECRET')).failure;
  const projected = subagentEventSchema.parse({
    stage: 'subagent',
    agentId: randomUUID(),
    role: 'ui',
    status: 'failed',
    diagnosticFailure: {
      ...failure,
      message: 'PRIVATE_OVERRIDE',
      stack: 'PRIVATE_STACK',
      token: 'PRIVATE_TOKEN',
    },
    upstreamBody: 'PRIVATE_BODY',
  });
  assert.equal(projected.diagnosticFailure!.errorId, failure.errorId);
  assert.equal(projected.diagnosticFailure!.message, failure.message);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
});

test('cause循环在失败关联时有界，不改变原始错误', () => {
  const error = new Error('cycle', { cause: null });
  error.cause = error;
  beginFailureOccurrence(error);
  const first = diagnoseRunFailure(error).failure.errorId;
  assert.equal(diagnoseRunFailure(error).failure.errorId, first);
  assert.equal(error.cause, error);
});
