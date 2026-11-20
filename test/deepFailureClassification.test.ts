import './helpers/projectFixture';
import { APIConnectionTimeoutError, APIConnectionError } from 'openai';
import assert from 'node:assert/strict';
import { DatabaseError } from 'sequelize';
import test from 'node:test';
import { deepGenerationFailure } from '../src/functions/d2c/run/agent/run';
import {
  diagnoseRunFailure,
  RunExecutionError,
  SubagentExecutionError,
} from '../src/functions/d2c/run/errors';

const signal = new AbortController().signal;
const context = { agentId: '9d2f2193-ceaa-4661-96c9-f67a22159043', role: 'rule_scan' as const };

test('数据库错误保留当前预览工具归属及脱敏数据库错误码', () => {
  const driver = Object.assign(new Error('private SQL'), {
    code: 'ER_OUT_OF_SORTMEMORY',
    errno: 1038,
    sql: 'private SELECT source',
    parameters: {},
  });
  const failure = deepGenerationFailure(
    new RunExecutionError(
      'TOOL_FAILED',
      { stage: 'tool', tool: 'build_preview' },
      new DatabaseError(driver),
    ),
    signal,
  );
  assert.equal(failure.code, 'STORAGE_FAILED');
  assert.equal(failure.context.tool, 'build_preview');
  const report = diagnoseRunFailure(failure);
  assert.equal(report.diagnostics.databaseCode, 'ER_OUT_OF_SORTMEMORY');
  assert.doesNotMatch(JSON.stringify(report), /private|SELECT source/);
});

test('未知内部异常不冒充模型请求失败，子任务各边界保留原因和安全诊断', () => {
  assert.equal(deepGenerationFailure(new Error('private detail'), signal).code, 'EXECUTION_FAILED');
  for (const phase of ['start', 'execute', 'settle', 'observe'] as const) {
    const cause = new TypeError('private detail');
    const boundary = new SubagentExecutionError({ ...context, phase }, cause);
    const classified = deepGenerationFailure(boundary, signal);
    assert.equal(classified.code, phase === 'execute' ? 'SUBAGENT_FAILED' : 'STORAGE_FAILED');
    assert.equal(classified.cause, boundary);
    assert.equal(boundary.cause, cause);
    const report = diagnoseRunFailure(classified);
    assert.equal(report.diagnostics.subagentId, context.agentId);
    assert.equal(report.diagnostics.subagentPhase, phase);
    assert.ok(!JSON.stringify(report).includes('private detail'));
  }
});

test('子任务边界不掩盖真实失租、存储、模型限流和共享预算分类', () => {
  for (const code of [
    'LEASE_LOST',
    'STORAGE_FAILED',
    'MODEL_RATE_LIMITED',
    'MODEL_REQUEST_LIMIT',
  ] as const) {
    const original = new RunExecutionError(code, { stage: 'worker' });
    const boundary = new SubagentExecutionError({ ...context, phase: 'execute' }, original);
    assert.equal(deepGenerationFailure(boundary, signal), original);
  }
});

test('框架交接和工具参数错误采用固定分类，真实模型请求保留模型分类', () => {
  for (const [message, expected] of [
    ['DEEP_SUBAGENT_BACKGROUND_CORRUPT', 'STORAGE_FAILED'],
    ['DEEP_BACKGROUND_SUBAGENT_UNJOINED', 'SUBAGENT_FAILED'],
    ['DEEP_MODEL_TOOL_ARGUMENTS_INVALID', 'MODEL_RESPONSE_INVALID'],
  ])
    assert.equal(deepGenerationFailure(new Error(message), signal).code, expected);
  const original = new RunExecutionError(
    'MODEL_REQUEST_FAILED',
    { stage: 'model' },
    new Error('provider failed'),
  );
  assert.equal(deepGenerationFailure(original, signal), original);
});

test('子模型故障不被子任务边界覆盖，SDK超时保留安全类型诊断', () => {
  for (const [raw, code] of [
    [new APIConnectionTimeoutError(), 'NETWORK_TIMEOUT'],
    [new APIConnectionError({}), 'NETWORK_UNAVAILABLE'],
  ] as const) {
    const boundary = new SubagentExecutionError(
      { ...context, phase: 'execute' },
      new RunExecutionError('MODEL_REQUEST_FAILED', { stage: 'model' }, raw),
    );
    const result = deepGenerationFailure(boundary, signal);
    assert.equal(result.code, code);
    const report = diagnoseRunFailure(result);
    assert.equal(report.diagnostics.subagentId, context.agentId);
    assert.equal(report.diagnostics.errorType, raw.constructor.name);
  }
  const failure = new RunExecutionError('MODEL_REQUEST_FAILED', { stage: 'model' });
  assert.equal(
    deepGenerationFailure(
      new SubagentExecutionError({ ...context, phase: 'execute' }, failure),
      signal,
    ),
    failure,
  );
  assert.equal(
    deepGenerationFailure(
      new SubagentExecutionError({ ...context, phase: 'settle' }, new APIConnectionTimeoutError()),
      signal,
    ).code,
    'STORAGE_FAILED',
  );
});
