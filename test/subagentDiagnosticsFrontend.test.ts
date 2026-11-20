import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentDiagnostics,
  AgentRuleCheck,
  AgentUsage,
  SubagentDiagnostic,
} from '../shared/agentDiagnostics';
import { DiagnosticsContent } from '../web/src/workspace/DiagnosticsPanel';
import SubagentDiagnostics, { subagentElapsed } from '../web/src/workspace/SubagentDiagnostics';
import type { SessionDiagnostics } from '../web/src/workspace/types';

const observedAt = '2026-11-20T02:00:00Z';
const now = Date.parse(observedAt) + 5000;

/** 用量计数完全未知，不能用零值填补历史。 */
function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    requests: null,
    reportedRequests: null,
    completedRequests: null,
    failedRequests: null,
    interruptedRequests: null,
    pendingRequests: null,
    retryRequests: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    usageComplete: null,
    modelDurationMs: null,
    durationRequests: 0,
    firstChunkMs: null,
    firstChunkRequests: 0,
    summaryRequests: null,
    ...overrides,
  };
}

/** 同角色任务通过独立 agentId 区分。 */
function agent(overrides: Partial<SubagentDiagnostic> = {}): SubagentDiagnostic {
  return {
    agentId: 'agent-a',
    role: 'ui',
    nodeId: '10:20',
    task: '实现订单区块',
    writePaths: ['blocks/order/index.tsx'],
    files: ['blocks/order/index.tsx'],
    missingFiles: ['blocks/order/style.css'],
    status: 'completed',
    queuedAt: '2026-11-20T01:59:00Z',
    startedAt: '2026-11-20T01:59:02Z',
    endedAt: observedAt,
    elapsedMs: 60000,
    runningSince: null,
    queueDurationMs: 2000,
    toolDurationMs: 7000,
    toolCalls: 3,
    toolFailures: 1,
    modelName: 'test-model',
    usage: usage(),
    delivery: { success: false, reason: '缺少样式，交回主 Agent' },
    checks: [],
    checksTruncated: false,
    ...overrides,
  };
}

/** 检查数据按服务端原样报告，不按数量构造无改善结论。 */
function check(overrides: Partial<AgentRuleCheck> = {}): AgentRuleCheck {
  return {
    seq: 12,
    at: observedAt,
    path: 'blocks/order',
    passed: false,
    count: 2,
    unchanged: null,
    violations: [
      { rule: 'R01', nodeId: '10:20' },
      { rule: 'R02', nodeId: '10:21' },
    ],
    omittedViolations: 0,
    ...overrides,
  };
}

/** 生产容器与独立组件使用同一公开契约。 */
function diagnostics(overrides: Partial<AgentDiagnostics> = {}): AgentDiagnostics {
  return {
    complete: true,
    historicalAttribution: false,
    main: usage(),
    unassigned: usage(),
    agents: [agent()],
    ...overrides,
  };
}

/** 保留旧版总用量及步骤，验证新区域插入位置。 */
function snapshot(agentDiagnostics?: AgentDiagnostics): SessionDiagnostics {
  return {
    sessionId: 'session-a',
    timelineSeq: 1,
    observedAt,
    runId: 'run-a',
    status: 'running',
    modelName: 'main-model',
    createdAt: observedAt,
    finishedAt: null,
    elapsedMs: 120000,
    lease: { expiresAt: null, expired: false },
    runs: [],
    current: null,
    steps: [],
    hasMore: false,
    checkpoint: { available: false, savedAt: null, scope: 'session', continuation: 'none' },
    usage: usage(),
    failure: null,
    ...(agentDiagnostics ? { agentDiagnostics } : {}),
  };
}

/** 每个用例直接渲染真实组件，去除 React 的文本边界注释方便断言。 */
function render(value?: AgentDiagnostics, production = false): string {
  return renderToStaticMarkup(
    production
      ? React.createElement(DiagnosticsContent, { snapshot: snapshot(value), now })
      : React.createElement(SubagentDiagnostics, { diagnostics: value, observedAt, now }),
  ).replaceAll('<!-- -->', '');
}

test('旧接口缺省兼容：独立组件及生产 DiagnosticsContent 明确旧记录未采集', () => {
  for (const production of [false, true]) {
    const html = render(undefined, production);
    assert.match(html, /旧记录未采集 Agent 诊断/);
    assert.doesNotMatch(html, /subagent-card\"|NaN|Invalid Date/);
  }
});

test('生产容器在总用量之后、耗时步骤之前展示分组，主 Agent 与历史请求分别计量', () => {
  const value = diagnostics({
    main: usage({
      requests: 3,
      inputTokens: 111,
      outputTokens: 222,
      totalTokens: 333,
      reportedRequests: 3,
      usageComplete: true,
    }),
    unassigned: usage({ requests: 7, totalTokens: 777, usageComplete: false }),
  });
  const html = render(value, true);
  assert.ok(html.indexOf('aria-label="模型用量"') < html.indexOf('aria-label="Agent 诊断"'));
  assert.ok(html.indexOf('aria-label="Agent 诊断"') < html.indexOf('aria-label="耗时步骤"'));
  assert.match(
    html,
    /aria-label="主 Agent 用量"[\s\S]*?输入 Token<\/dt><dd>111[\s\S]*?输出 Token<\/dt><dd>222[\s\S]*?总 Token<\/dt><dd>333/,
  );
  assert.match(html, /aria-label="未归属历史请求用量"[\s\S]*?总 Token<\/dt><dd>777/);
  assert.match(html, /用量完整度：完整/);
  assert.match(html, /用量完整度：不完整/);
  assert.match(html, /并行任务的耗时存在重叠，不能相加作为本轮耗时/);
});

test('同角色双任务各有负责范围、任务摘要、状态及生命周期，不合并耗时', () => {
  const html = render(
    diagnostics({
      agents: [
        agent(),
        agent({
          agentId: 'agent-b',
          nodeId: '30:40',
          writePaths: [],
          task: '实现付款区块',
          status: 'handed_off',
          elapsedMs: 30000,
        }),
      ],
    }),
  );
  assert.equal((html.match(/<article /g) ?? []).length, 2);
  for (const text of [
    'agent-a',
    'agent-b',
    'blocks/order/index.tsx',
    '10:20',
    '30:40',
    '实现订单区块',
    '实现付款区块',
    '已完成',
    '已交接',
    '60.0 秒',
    '30.0 秒',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /90.0 秒/);
});

test('details 原生默认收起且有展开标记，展示用量采样、请求结果、文件与交接详情', () => {
  const value = agent({
    usage: usage({
      requests: 9,
      reportedRequests: 5,
      modelDurationMs: 12000,
      durationRequests: 7,
      firstChunkMs: 4000,
      firstChunkRequests: 6,
      completedRequests: 5,
      failedRequests: 1,
      interruptedRequests: 2,
      pendingRequests: 1,
      retryRequests: 3,
      summaryRequests: 4,
    }),
  });
  const html = render(diagnostics({ agents: [value] }));
  assert.match(
    html,
    /<details class="subagent-details"><summary><span class="subagent-chevron" aria-hidden="true">›<\/span>诊断详情/,
  );
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|>)/);
  for (const label of [
    'agentId',
    '模型名',
    'test-model',
    '入队时间',
    '开始时间',
    '结束时间',
    '排队耗时',
    '工具累计耗时（含等待）',
    '工具调用 / 失败数',
    '模型累计耗时',
    '首块累计等待',
    '实际已保存文件',
    '缺失文件',
    'blocks/order/style.css',
    '交接原因',
    '缺少样式，交回主 Agent',
  ])
    assert.ok(html.includes(label), label);
  assert.match(html, /模型累计耗时<\/dt><dd>12.0 秒<small>采样覆盖 7 \/ 9 请求/);
  assert.match(html, /首块累计等待<\/dt><dd>4.0 秒<small>采样覆盖 6 \/ 9 请求/);
  for (const [label, count] of [
    ['成功请求', 5],
    ['失败请求', 1],
    ['中断请求', 2],
    ['未结束请求', 1],
    ['重试请求', 3],
    ['摘要请求', 4],
  ])
    assert.ok(html.includes(`${label}</dt><dd>${count}</dd>`));
});

test('未上报用量/计时/任务保持未知，明确零值才显示零；采样覆盖不冒充用量覆盖', () => {
  const html = render(
    diagnostics({
      agents: [
        agent({
          task: null,
          nodeId: null,
          modelName: null,
          elapsedMs: null,
          queueDurationMs: null,
          toolDurationMs: null,
          queuedAt: null,
          startedAt: 'invalid',
          endedAt: null,
          files: [],
          missingFiles: [],
          delivery: { success: null, reason: null },
          usage: usage({ durationRequests: 2, firstChunkRequests: 1 }),
        }),
      ],
    }),
  );
  assert.match(html, /请求数<\/dt><dd>未报告/);
  assert.match(html, /输入 Token<\/dt><dd>未报告/);
  assert.match(html, /用量完整度：未知 \/ 未报告/);
  assert.match(html, /已报告请求 未报告 \/ 未报告/);
  assert.match(html, /任务耗时（含排队） <strong>耗时未知/);
  assert.match(html, /采样覆盖 2 \/ 未报告 请求/);
  assert.doesNotMatch(html, /Invalid Date|NaN|0.0 秒/);
  const zero = render(
    diagnostics({ main: usage({ requests: 0, totalTokens: 0, usageComplete: true }) }),
  );
  assert.match(zero, /请求数<\/dt><dd>0/);
  assert.match(zero, /总 Token<\/dt><dd>0/);
});

test('历史工具和采样计数为 null 的响应也不显示零', () => {
  const value: AgentDiagnostics = JSON.parse(JSON.stringify(diagnostics()));
  Object.assign(value.agents[0], { toolCalls: null, toolFailures: null });
  Object.assign(value.agents[0].usage, { durationRequests: null, firstChunkRequests: null });
  const html = render(value);
  assert.match(html, /工具调用 \/ 失败数<\/dt><dd>未报告 \/ 未报告/);
  assert.match(html, /采样覆盖 未报告 \/ 未报告 请求/);
});

test('生命周期仅对明确运行标记本地递增，结束与未知耗时保持固定', () => {
  const running = agent({
    status: 'waiting_model',
    endedAt: null,
    runningSince: observedAt,
    elapsedMs: 12000,
  });
  assert.equal(subagentElapsed(running, observedAt, now), 17000);
  assert.match(render(diagnostics({ agents: [running] })), /任务耗时（含排队） <strong>17.0 秒/);
  assert.equal(subagentElapsed({ ...running, status: 'completed' }, observedAt, now), 12000);
  assert.equal(subagentElapsed({ ...running, endedAt: observedAt }, observedAt, now), 12000);
  assert.equal(subagentElapsed({ ...running, runningSince: null }, observedAt, now), 12000);
  assert.equal(subagentElapsed({ ...running, elapsedMs: null }, observedAt, now), null);
  assert.equal(subagentElapsed(running, observedAt, now - 10000), 12000);
  assert.equal(subagentElapsed(running, 'invalid', now), 12000);
});

test('同数量不同违规不误标无改善，数量下降展示变化，重复规则/nodeId 明细原样保留', () => {
  const checks = [
    check(),
    check({
      seq: 15,
      unchanged: false,
      violations: [
        { rule: 'R03', nodeId: '20:30' },
        { rule: 'R03', nodeId: '20:31' },
      ],
    }),
    check({ seq: 18, count: 1, unchanged: false, violations: [{ rule: 'R03', nodeId: '20:30' }] }),
  ];
  const html = render(diagnostics({ agents: [agent({ checks })] }));
  assert.match(html, /违规数量：2 → 2/);
  assert.match(html, /违规数量：2 → 1/);
  assert.match(html, /违规有变化/);
  assert.doesNotMatch(html, /违规未改善/);
  assert.equal((html.match(/<code>R03<\/code>/g) ?? []).length, 3);
  assert.match(html, /<code>20:31<\/code>/);
});

test('重复违规只认服务端 unchanged，缺数量不推算；规则列表截断与省略数可见', () => {
  const html = render(
    diagnostics({
      agents: [
        agent({
          checks: [
            check(),
            check({ seq: 16, unchanged: true }),
            check({ seq: 19, count: null, unchanged: null, passed: null, omittedViolations: 8 }),
          ],
          checksTruncated: true,
        }),
      ],
    }),
  );
  assert.equal((html.match(/违规未改善/g) ?? []).length, 1);
  assert.match(html, /违规数量：2 → 未报告/);
  assert.match(html, /改善情况未知 \/ 未报告/);
  assert.match(html, /结果未知/);
  assert.match(html, /检查记录已截断/);
  assert.match(html, /另有 8 条违规明细未列出/);
});

test('元数据截断、历史无法归属分别提示，完整空任务不声称执行过子任务', () => {
  const html = render(
    diagnostics({ complete: false, historicalAttribution: true, agents: [] }),
    true,
  );
  assert.match(html, /诊断数据已截断/);
  assert.match(html, /部分历史请求无法归属/);
  assert.match(html, /当前范围无子任务诊断记录/);
  const complete = render(diagnostics({ agents: [] }));
  assert.doesNotMatch(complete, /诊断数据已截断|部分历史请求无法归属/);
});

test('工具明细兼容缺省/空清单，已完成与等待记录显示可信耗时与起止时间', () => {
  assert.match(render(diagnostics()), /旧记录未采集工具明细/);
  assert.match(render(diagnostics({ agents: [agent({ tools: [] })] })), /当前范围无工具记录/);
  const html = render(
    diagnostics({
      agents: [
        agent({
          toolsTruncated: true,
          tools: [
            {
              id: 'public-tool-1',
              name: 'write_file',
              status: 'completed',
              startedAt: '2026-11-20T01:59:00Z',
              endedAt: observedAt,
              durationMs: 1234,
            },
            {
              id: 'public-tool-2',
              name: 'check_rules',
              status: 'running',
              startedAt: observedAt,
              endedAt: null,
              durationMs: null,
            },
            {
              id: 'public-tool-3',
              name: 'read_file',
              status: 'unknown',
              startedAt: null,
              endedAt: observedAt,
              durationMs: 8888,
            },
          ],
        }),
      ],
    }),
  );
  for (const label of [
    '工具记录已截断',
    '最多 60 条',
    'write_file',
    'check_rules',
    'read_file',
    '等待/执行中',
    '1.2 秒',
    '耗时未知',
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /8.9 秒|callId|public-tool-/);
  assert.match(html, /<details class="subagent-tools"><summary>工具记录/);
});

test('任务、路径、规则、模型、交接原因和工具元数据中的恶意文本全部转义', () => {
  const malicious = '<img src=x onerror="alert(1)"><script>bad()</script>';
  const value = agent({
    agentId: malicious,
    task: malicious,
    nodeId: malicious,
    modelName: malicious,
    writePaths: [malicious],
    files: [malicious],
    missingFiles: [malicious],
    delivery: { success: false, reason: malicious },
    checks: [check({ path: malicious, violations: [{ rule: malicious, nodeId: malicious }] })],
    tools: [
      {
        id: malicious,
        name: malicious,
        status: 'unknown',
        startedAt: null,
        endedAt: null,
        durationMs: null,
      },
    ],
  });
  for (const production of [false, true]) {
    const html = render(diagnostics({ agents: [value] }), production);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<script|<img src=x|dangerouslySetInnerHTML/);
  }
});

test('子会话正文和思考分片不触发诊断重读，生命周期及模型事件仍驱动更新', async () => {
  const { diagnosticsRevision } = await import('../web/src/workspace/timeline');
  const base = {
    entryId: 'event',
    sessionId: 'session',
    runId: 'run',
    at: observedAt,
    kind: 'stage',
  };
  const events = [
    { ...base, seq: 10, data: { stage: 'subagent', status: 'tool_completed' } },
    { ...base, seq: 11, data: { stage: 'subagent', status: 'reasoning' } },
    {
      ...base,
      seq: 12,
      data: {
        stage: 'subagent',
        status: 'message',
        message: { role: 'assistant', text: '阶段说明' },
      },
    },
  ] as import('../web/src/workspace/types').TimelineEntry[];
  assert.equal(diagnosticsRevision(events), 10);
  assert.equal(
    diagnosticsRevision([
      ...events,
      { ...base, kind: 'model_status', seq: 13, data: { status: 'started' } },
    ]),
    13,
  );
});
