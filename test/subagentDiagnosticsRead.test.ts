import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
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

test('子任务诊断按平台ID归属，展示交付与真实规则变化，排除私有正文', async () => {
  const f = await fixture();
  const agentId = randomUUID();
  f.event(
    10,
    'stage',
    {
      stage: 'subagent',
      diagnosticVersion: 1,
      agentId,
      role: 'ui',
      status: 'queued',
      task: '实现首屏',
      writePaths: ['pages/page/blocks/hero/index.jsx'],
    },
    1,
  );
  f.event(
    11,
    'stage',
    { stage: 'subagent', diagnosticVersion: 1, agentId, role: 'ui', status: 'started' },
    2,
  );
  const operationId = randomUUID();
  f.event(
    12,
    'model_status',
    { operationId, agentId, scope: 'ui', status: 'started', retryIndex: 0 },
    3,
  );
  f.event(
    13,
    'model_status',
    {
      operationId,
      agentId,
      scope: 'ui',
      status: 'completed',
      retryIndex: 0,
      durationMs: 1000,
      tokenUsage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
    4,
  );
  f.event(
    14,
    'stage',
    {
      stage: 'subagent',
      agentId,
      role: 'ui',
      status: 'tool_feedback',
      tool: 'check_rules',
      callId: 'PRIVATE_CHILD_CALL',
      ruleCheck: {
        path: 'pages/page/blocks/hero',
        passed: false,
        count: 1,
        signature: 'a'.repeat(64),
        violations: [{ rule: 'R02', nodeId: '1:2' }],
        omittedViolations: 0,
      },
    },
    5,
  );
  f.event(
    15,
    'stage',
    {
      stage: 'subagent',
      agentId,
      role: 'ui',
      status: 'failed',
      delivery: {
        success: false,
        reason: 'RULE_REPAIR_STALLED',
        files: ['pages/page/blocks/hero/index.jsx'],
        missingFiles: [],
      },
    },
    6,
  );
  const original = JSON.stringify(f.tables);
  const result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  const agent = result.agentDiagnostics.agents[0];
  assert.equal(agent.agentId, agentId);
  assert.equal(agent.task, '实现首屏');
  assert.equal(agent.usage.requests, 1);
  assert.equal(agent.usage.totalTokens, 12);
  assert.equal(agent.status, 'handed_off');
  assert.deepEqual(agent.checks[0].violations, [{ rule: 'R02', nodeId: '1:2' }]);
  assert.equal(result.agentDiagnostics.complete, true);
  assert.equal(JSON.stringify(f.tables), original);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|sdkItem|MODEL_API_KEY|checkpointPayload/);
});

test('主步骤窗口超过200条时仍统计本轮完整请求元数据，不把窗口当作总用量', async () => {
  const f = await fixture();
  for (let i = 0; i < 220; i++) {
    const operationId = randomUUID();
    f.event(
      10 + i * 2,
      'model_status',
      { operationId, agentId: null, scope: 'generation', status: 'started', retryIndex: 0 },
      i * 2 + 1,
    );
    f.event(
      11 + i * 2,
      'model_status',
      {
        operationId,
        agentId: null,
        scope: 'generation',
        status: 'completed',
        retryIndex: 0,
        durationMs: 1000,
        tokenUsage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
      i * 2 + 2,
    );
  }
  const result = await readRunDiagnostics(f.mysql, 'employee-a', f.id);
  assert.equal(result.hasMore, true);
  assert.equal(result.agentDiagnostics.main.requests, 220);
  assert.equal(result.agentDiagnostics.main.totalTokens, 440);
  assert.equal(result.agentDiagnostics.main.usageComplete, true);
});
