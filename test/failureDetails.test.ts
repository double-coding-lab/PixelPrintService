import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFailureDetails } from '../src/shared/failureDetails';
import { subagentEventSchema } from '../src/functions/d2c/run/subagent';
import { diagnoseRunFailure, SubagentExecutionError } from '../src/functions/d2c/run/errors';

test('失败详情只保留固定字段，不泄露私有错误消息、堆栈和文件内容', () => {
  const details = readFailureDetails({
    errorType: 'TypeError',
    causeCode: 'ENOTFOUND',
    statusCode: 503,
    subagentPhase: 'execute',
    frameworkCode: 'DEEP_SUBAGENT_MAX_TURNS',
    message: 'PRIVATE_MESSAGE',
    stack: 'PRIVATE_STACK',
    token: 'PRIVATE_TOKEN',
  });
  assert.deepEqual(details, {
    errorType: 'TypeError',
    causeCode: 'ENOTFOUND',
    statusCode: 503,
    subagentPhase: 'execute',
    frameworkCode: 'DEEP_SUBAGENT_MAX_TURNS',
  });
  assert.equal(
    readFailureDetails({ errorType: 'PRIVATE_TYPE', causeCode: 'PRIVATE_CAUSE', statusCode: 999 }),
    undefined,
  );
  assert.deepEqual(readFailureDetails({ errorType: 'TypeError', causeCode: 'PRIVATE' }), {
    errorType: 'TypeError',
  });
  assert.equal(readFailureDetails(null), undefined);
});

test('子任务异常已有真实类型和阶段可持久化，未知原因保持未知', () => {
  const id = 'b925f99b-46ba-4416-b13e-685ccb23b7b8';
  const error = new SubagentExecutionError(
    { agentId: id, role: 'rule_scan', phase: 'execute' },
    new TypeError('PRIVATE_ORIGINAL'),
  );
  const report = diagnoseRunFailure(error, 'SUBAGENT_FAILED', {
    stage: 'tool',
    tool: 'delegate_agent',
  });
  const event = subagentEventSchema.parse({
    stage: 'subagent',
    agentId: id,
    role: 'rule_scan',
    status: 'failed',
    diagnosticFailure: report.failure,
    failureDetails: readFailureDetails(report.diagnostics),
  });
  assert.equal(event.failureDetails?.errorType, 'TypeError');
  assert.equal(event.failureDetails?.subagentPhase, 'execute');
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_ORIGINAL|stack/);
  assert.equal(
    subagentEventSchema.parse({
      stage: 'subagent',
      agentId: id,
      role: 'rule_scan',
      status: 'failed',
    }).failureDetails,
    undefined,
  );
});
