import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildAgentDiagnostics } from '../src/functions/d2c/run/subagentDiagnostics';

const agentA = 'f6a571b6-28d9-4d4d-9ac9-a012667aacb0';
const agentB = '650db6d0-f8b9-4b22-aa0d-8f1c3c81f559';
const time = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, seconds)).toISOString();
let seq = 0;
/** 构造已保存元数据，额外私有字段不能进入聚合结果。 */
function stage(
  agentId: string,
  status: string,
  seconds: number,
  extra: Record<string, unknown> = {},
) {
  return {
    seq: ++seq,
    createdAt: time(seconds),
    displayPayload: {
      stage: 'subagent',
      agentId,
      role: 'ui',
      status,
      diagnosticVersion: 1,
      writePaths: [`pages/page/blocks/${agentId === agentA ? 'hero' : 'footer'}/index.jsx`],
      ...extra,
      private: 'PRIVATE_STAGE',
    },
  };
}
/** 每次实际请求分别绑定平台Agent身份，重试使用新的operationId。 */
function request(
  agentId: string | null | undefined,
  tokens = 10,
  options: { scope?: string; failed?: boolean; retryIndex?: number; pending?: boolean } = {},
) {
  const operationId = randomUUID();
  const base = {
    operationId,
    scope: options.scope ?? 'ui',
    ...(agentId !== undefined ? { agentId } : {}),
    ...(options.retryIndex !== undefined ? { retryIndex: options.retryIndex } : {}),
  };
  return [
    { seq: ++seq, createdAt: time(5), displayPayload: { ...base, status: 'started' } },
    ...(!options.pending
      ? [
          {
            seq: ++seq,
            createdAt: time(6),
            displayPayload: {
              ...base,
              status: options.failed ? 'failed' : 'completed',
              durationMs: 1000,
              firstChunkMs: 200,
              ...(options.failed
                ? {}
                : {
                    tokenUsage: {
                      input_tokens: tokens,
                      output_tokens: 2,
                      total_tokens: tokens + 2,
                    },
                  }),
              private: 'PRIVATE_MODEL',
            },
          },
        ]
      : []),
  ];
}
function build(
  stages: ReturnType<typeof stage>[],
  models: ReturnType<typeof request>,
  overrides = {},
) {
  return buildAgentDiagnostics({
    stages,
    models,
    status: 'succeeded',
    observedAt: time(30),
    finishedAt: time(25),
    modelName: 'fixture-model',
    complete: true,
    ...overrides,
  });
}

test('同角色并行按agentId独立计量，主任务和子摘要互不串用量', () => {
  const stages = [
    stage(agentA, 'queued', 0, { task: '实现首屏' }),
    stage(agentB, 'started', 1),
    stage(agentA, 'started', 5),
    stage(agentB, 'completed', 15),
    stage(agentA, 'completed', 20),
  ];
  const models = [
    ...request(agentB, 200, { retryIndex: 0 }),
    ...request(null, 30, { scope: 'generation', retryIndex: 0 }),
    ...request(agentA, 100, { retryIndex: 0 }),
    ...request(agentA, 20, { scope: 'summary', retryIndex: 1 }),
  ];
  const result = build(stages, models);
  assert.equal(result.main.totalTokens, 32);
  const a = result.agents.find((entry) => entry.agentId === agentA)!;
  const b = result.agents.find((entry) => entry.agentId === agentB)!;
  assert.equal(a.task, '实现首屏');
  assert.equal(a.usage.requests, 2);
  assert.equal(a.usage.summaryRequests, 1);
  assert.equal(a.usage.retryRequests, 1);
  assert.equal(a.usage.totalTokens, 124);
  assert.equal(b.usage.totalTokens, 202);
  assert.equal(a.elapsedMs, 20000);
  assert.equal(a.queueDurationMs, 5000);
  assert.equal(a.usage.modelDurationMs, 2000);
  assert.equal(a.usage.firstChunkMs, 400);
  assert.equal(b.elapsedMs, 14000);
  assert.equal(b.queueDurationMs, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('旧子任务的缺失归属显示未知，旧UI与摘要请求列为未归属，不按时间猜测', () => {
  const old = stage(agentA, 'started', 1, { message: { role: 'user', text: '历史任务' } });
  delete (old.displayPayload as Record<string, unknown>).diagnosticVersion;
  const result = build(
    [old],
    [
      ...request(undefined, 40),
      ...request(undefined, 20, { scope: 'summary' }),
      ...request(undefined, 10, { scope: 'generation' }),
    ],
  );
  assert.equal(result.historicalAttribution, true);
  assert.equal(result.agents[0].usage.requests, null);
  assert.equal(result.agents[0].usage.totalTokens, null);
  assert.equal(result.unassigned.requests, 2);
  assert.equal(result.unassigned.totalTokens, 64);
  assert.equal(result.main.requests, 1);
  assert.equal(result.agents[0].task, '历史任务');
});

test('未报告Token不计零，重复起止事件不重复计量，进行中请求保留状态', () => {
  const failed = request(agentA, 5, { failed: true, retryIndex: 0 });
  const pending = request(agentA, 6, { pending: true, retryIndex: 1 });
  const result = build([stage(agentA, 'started', 1)], [...failed, ...failed, ...pending], {
    status: 'running',
    finishedAt: null,
  });
  const a = result.agents[0];
  assert.equal(a.usage.requests, 2);
  assert.equal(a.usage.failedRequests, 1);
  assert.equal(a.usage.pendingRequests, 1);
  assert.equal(a.usage.totalTokens, null);
  assert.equal(a.usage.usageComplete, false);
  assert.equal(a.status, 'waiting_model');
  assert.equal(a.runningSince, time(30));
});

test('规则变化使用完整签名而非数量判定重复，交接保留文件、缺口和真实失败', () => {
  const check = (seconds: number, count: number, signature: string | undefined) =>
    stage(agentA, 'tool_feedback', seconds, {
      tool: 'check_rules',
      callId: `rule-${seconds}`,
      ruleCheck: {
        path: 'pages/page/blocks/hero',
        passed: count === 0,
        count,
        ...(signature ? { signature } : {}),
        violations: count ? [{ rule: 'R02', nodeId: '1:2' }] : [],
        omittedViolations: 0,
      },
    });
  const stages = [
    stage(agentA, 'started', 0),
    check(2, 6, 'a'.repeat(64)),
    check(4, 6, 'a'.repeat(64)),
    check(6, 6, 'b'.repeat(64)),
    check(8, 0, undefined),
    stage(agentA, 'failed', 10, {
      delivery: {
        success: false,
        reason: 'RULE_REPAIR_STALLED',
        files: ['pages/page/blocks/hero/index.jsx'],
        missingFiles: ['pages/page/blocks/hero/index.scss'],
      },
    }),
  ];
  const a = build(stages, []).agents[0];
  assert.deepEqual(
    a.checks.map((entry) => entry.count),
    [6, 6, 6, 0],
  );
  assert.deepEqual(
    a.checks.map((entry) => entry.unchanged),
    [null, true, false, false],
  );
  assert.equal(a.status, 'handed_off');
  assert.equal(a.delivery.success, false);
  assert.equal(a.delivery.reason, 'RULE_REPAIR_STALLED');
  assert.deepEqual(a.files, ['pages/page/blocks/hero/index.jsx']);
  assert.deepEqual(a.missingFiles, ['pages/page/blocks/hero/index.scss']);
  assert.equal(a.toolDurationMs, null);
});

test('同一子任务恢复累计实际执行区间，排除两次尝试之间的空闲；工具只累计有效配对', () => {
  const stages = [
    stage(agentA, 'queued', 0),
    stage(agentA, 'started', 2),
    stage(agentA, 'tool_started', 3, { callId: 'PRIVATE_CALL', tool: 'read_file' }),
    stage(agentA, 'tool_completed', 4, { callId: 'PRIVATE_CALL', tool: 'read_file' }),
    stage(agentA, 'failed', 10),
    stage(agentA, 'queued', 100),
    stage(agentA, 'started', 102),
    stage(agentA, 'completed', 110),
  ];
  const a = build(stages, [], { finishedAt: time(120), observedAt: time(120) }).agents[0];
  assert.equal(a.elapsedMs, 20000);
  assert.equal(a.queueDurationMs, 4000);
  assert.equal(a.toolDurationMs, 1000);
  assert.equal(a.toolCalls, 1);
  assert.equal(a.tools?.[0].name, 'read_file');
  assert.doesNotMatch(JSON.stringify(a), /PRIVATE_CALL/);
});

test('诊断截断与缺少生命周期不冒充完整统计，历史过多检查显式截断', () => {
  const stages = [stage(agentA, 'started', 1)];
  for (let i = 0; i < 85; i++)
    stages.push(
      stage(agentA, 'tool_feedback', i + 2, {
        tool: 'check_rules',
        callId: `check-${i}`,
        ruleCheck: {
          path: 'pages/page/blocks/hero',
          passed: false,
          count: 1,
          signature: 'a'.repeat(64),
          violations: [{ rule: 'R02', nodeId: '1:2' }],
          omittedViolations: 0,
        },
      }),
    );
  const result = build(stages, [], { complete: false });
  assert.equal(result.complete, false);
  assert.equal(result.agents[0].usage.requests, null);
  assert.equal(result.agents[0].checks.length, 80);
  assert.equal(result.agents[0].checksTruncated, true);
  const orphan = build([], request(agentB));
  assert.equal(orphan.agents.length, 0);
  assert.equal(orphan.unassigned.requests, 1);
});

test('完整新采集明确没有模型请求时为零用量，历史和截断仍保持未知', () => {
  const stages = [stage(agentA, 'started', 1), stage(agentA, 'completed', 2)];
  const fresh = build(stages, []).agents[0].usage;
  assert.equal(fresh.requests, 0);
  assert.equal(fresh.totalTokens, 0);
  assert.equal(fresh.usageComplete, true);
  const truncated = build(stages, [], { complete: false }).agents[0].usage;
  assert.equal(truncated.totalTokens, null);
  assert.equal(truncated.usageComplete, null);
  const mixed = build(stages, request(undefined)).agents[0].usage;
  assert.equal(mixed.requests, null);
  assert.equal(mixed.totalTokens, null);
  assert.equal(mixed.usageComplete, null);
});
