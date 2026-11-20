import { createHash } from 'node:crypto';
import type {
  AgentDiagnostics,
  AgentUsage,
  SubagentDiagnostic,
} from '../../../../shared/agentDiagnostics';
import { modelActivitySchema, type ModelActivity } from './agent/modelActivity';
import { subagentEventSchema } from './subagent';

type Row = {
  seq: number | null;
  createdAt: unknown;
  displayPayload?: Record<string, unknown> | null;
};
type Request = { first: ModelActivity; last: ModelActivity };

/** 无效时间保持未知；不从记录顺序伪造耗时。 */
function at(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 请求按operationId去重，只有网关明确报告的Token和测量值才累计。 */
function usage(requests: Map<string, Request>, known: boolean, complete: boolean): AgentUsage {
  const items = [...requests.values()];
  const counted = known || items.length > 0;
  const noRequests = known && complete && items.length === 0;
  const ended = items.filter(({ last }) => last.status !== 'started');
  const reported = ended.filter(({ last }) => last.tokenUsage);
  const durations = ended.filter(({ last }) => last.durationMs !== undefined);
  const firstChunks = ended.filter(({ last }) => last.firstChunkMs !== undefined);
  const measured = (key: 'durationMs' | 'firstChunkMs', entries: Request[]) =>
    entries.length ? entries.reduce((sum, { last }) => sum + last[key]!, 0) : null;
  return {
    requests: counted ? items.length : null,
    reportedRequests: counted ? reported.length : null,
    completedRequests: counted
      ? ended.filter(({ last }) => last.status === 'completed').length
      : null,
    failedRequests: counted
      ? ended.filter(({ last }) => last.status === 'failed' && !last.interrupted).length
      : null,
    interruptedRequests: counted
      ? ended.filter(({ last }) => last.interrupted === true).length
      : null,
    pendingRequests: counted ? items.length - ended.length : null,
    retryRequests:
      counted && items.every(({ first }) => first.retryIndex !== undefined)
        ? items.filter(({ first }) => first.retryIndex! > 0).length
        : null,
    inputTokens: reported.length
      ? reported.reduce((sum, { last }) => sum + last.tokenUsage!.input_tokens, 0)
      : noRequests
        ? 0
        : null,
    outputTokens: reported.length
      ? reported.reduce((sum, { last }) => sum + last.tokenUsage!.output_tokens, 0)
      : noRequests
        ? 0
        : null,
    totalTokens: reported.length
      ? reported.reduce((sum, { last }) => sum + last.tokenUsage!.total_tokens, 0)
      : noRequests
        ? 0
        : null,
    usageComplete: counted ? complete && reported.length === items.length : null,
    modelDurationMs: measured('durationMs', durations),
    durationRequests: durations.length,
    firstChunkMs: measured('firstChunkMs', firstChunks),
    firstChunkRequests: firstChunks.length,
    summaryRequests: counted ? items.filter(({ first }) => first.scope === 'summary').length : null,
  };
}

/** 只读公开元数据投影；同角色并行严格按平台agentId归属，历史缺失不按时间猜测。 */
export function buildAgentDiagnostics(input: {
  models: Row[];
  stages: Row[];
  status: string;
  finishedAt: string | null;
  observedAt: string;
  modelName: string | null;
  complete: boolean;
}): AgentDiagnostics {
  const groups = new Map<string, Map<string, Request>>();
  const legacyScopes = new Set<ModelActivity['scope']>();
  const group = (key: string) => {
    let entries = groups.get(key);
    if (!entries) groups.set(key, (entries = new Map()));
    return entries;
  };
  for (const row of input.models) {
    const parsed = modelActivitySchema.safeParse(row.displayPayload);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.agentId === undefined && event.scope !== 'generation') legacyScopes.add(event.scope);
    const owner =
      typeof event.agentId === 'string'
        ? event.agentId
        : event.agentId === null || event.scope === 'generation'
          ? 'main'
          : 'unassigned';
    const requests = group(owner);
    const previous = requests.get(event.operationId);
    if (!previous) requests.set(event.operationId, { first: event, last: event });
    else {
      // 完整结束结果不被迟到的重复started覆盖。
      if (event.status === 'started') previous.first = event;
      if (event.status !== 'started') previous.last = event;
    }
  }
  type Acc = {
    item: SubagentDiagnostic;
    versioned: boolean;
    cycleStart: string | null;
    queueStart: string | null;
    elapsed: number;
    measured: boolean;
    queueMeasured: boolean;
    queueMs: number;
    calls: Map<
      string,
      { name: string; detail?: string; start: string | null; end: string | null; failed: boolean }
    >;
    checks: Map<string, string>;
  };
  const agents = new Map<string, Acc>();
  const liveRun = ['running', 'stopping'].includes(input.status);
  for (const row of input.stages) {
    const parsed = subagentEventSchema.safeParse(row.displayPayload);
    if (!parsed.success) continue;
    const event = parsed.data;
    const time = at(row.createdAt);
    let acc = agents.get(event.agentId);
    if (!acc) {
      acc = {
        item: {
          agentId: event.agentId,
          role: event.role,
          nodeId: event.nodeId ?? null,
          task: event.task ?? null,
          writePaths: event.writePaths ?? [],
          files: [],
          missingFiles: [],
          status: 'unknown',
          queuedAt: null,
          startedAt: null,
          endedAt: null,
          elapsedMs: null,
          runningSince: null,
          queueDurationMs: null,
          toolDurationMs: null,
          toolCalls: 0,
          toolFailures: 0,
          modelName: input.modelName,
          usage: usage(new Map(), false, input.complete),
          delivery: { success: null, reason: null },
          checks: [],
          checksTruncated: false,
        },
        versioned: false,
        cycleStart: null,
        queueStart: null,
        elapsed: 0,
        measured: false,
        queueMeasured: false,
        queueMs: 0,
        calls: new Map(),
        checks: new Map(),
      };
      agents.set(event.agentId, acc);
    }
    const { item } = acc;
    acc.versioned ||= event.diagnosticVersion === 1;
    if (event.task) item.task = event.task;
    if (!item.task && event.message?.role === 'user') item.task = event.message.text.slice(0, 600);
    if (event.status === 'queued') {
      acc.queueStart = time;
      acc.cycleStart ??= time;
      item.queuedAt ??= time;
      item.status = 'queued';
      item.endedAt = null;
      item.delivery = { success: null, reason: null };
    } else if (event.status === 'started') {
      if (acc.queueStart && time) {
        acc.queueMs += Math.max(0, Date.parse(time) - Date.parse(acc.queueStart));
        acc.queueMeasured = true;
      }
      acc.queueStart = null;
      acc.cycleStart ??= time;
      item.startedAt ??= time;
      item.endedAt = null;
      item.status = 'running';
      item.delivery = { success: null, reason: null };
    } else if (event.status === 'completed' || event.status === 'failed') {
      if (acc.cycleStart && time) {
        acc.elapsed += Math.max(0, Date.parse(time) - Date.parse(acc.cycleStart));
        acc.measured = true;
      }
      acc.cycleStart = null;
      item.endedAt = time;
      item.status =
        event.status === 'completed'
          ? 'completed'
          : event.delivery?.success === false
            ? 'handed_off'
            : 'failed';
    }
    if (event.delivery) {
      item.delivery = { success: event.delivery.success, reason: event.delivery.reason ?? null };
      item.files = event.delivery.files;
      item.missingFiles = event.delivery.missingFiles;
    }
    if (event.callId && event.tool && event.status.startsWith('tool_')) {
      const call = acc.calls.get(event.callId) ?? {
        name: event.tool,
        detail: event.detail,
        start: null,
        end: null,
        failed: false,
      };
      if (event.status === 'tool_started') call.start ??= time;
      else {
        call.end = time;
        call.failed ||= event.status === 'tool_failed' || event.status === 'tool_feedback';
      }
      if (event.detail) call.detail = event.detail;
      acc.calls.set(event.callId, call);
    }
    if (event.ruleCheck && event.status !== 'tool_started' && typeof row.seq === 'number') {
      const check = event.ruleCheck;
      const prior = acc.checks.get(check.path);
      const unchanged = check.signature ? prior === check.signature : check.passed ? false : null;
      if (check.passed) acc.checks.delete(check.path);
      else if (check.signature) acc.checks.set(check.path, check.signature);
      if (!item.checks.some((value) => value.seq === row.seq))
        item.checks.push({
          seq: row.seq,
          at: time,
          path: check.path,
          passed: check.passed,
          count: check.count,
          unchanged: prior ? unchanged : null,
          violations: check.violations,
          omittedViolations: check.omittedViolations,
        });
      if (item.checks.length > 80) {
        item.checks.shift();
        item.checksTruncated = true;
      }
    }
  }
  for (const [agentId, requests] of groups) {
    if (agentId !== 'main' && agentId !== 'unassigned' && !agents.has(agentId)) {
      // 生命周期不在窗口内也不把请求算到主Agent；作为未归属详情提示保留统计。
      for (const [id, request] of requests) group('unassigned').set(id, request);
    }
  }
  for (const acc of agents.values()) {
    const { item } = acc;
    const requests = group(item.agentId);
    const attributionComplete =
      input.complete && !legacyScopes.has(item.role) && !legacyScopes.has('summary');
    item.usage = usage(requests, attributionComplete && acc.versioned, attributionComplete);
    item.toolCalls = acc.calls.size;
    item.tools = [...acc.calls.entries()].slice(-60).map(([id, call]) => ({
      id: createHash('sha256').update(`${item.agentId}:${id}`).digest('hex').slice(0, 24),
      name: call.name,
      detail: call.detail ?? null,
      status: call.failed
        ? 'failed'
        : call.end
          ? 'completed'
          : call.start
            ? liveRun
              ? 'running'
              : 'interrupted'
            : 'unknown',
      startedAt: call.start,
      endedAt: call.end,
      durationMs:
        call.start && call.end ? Math.max(0, Date.parse(call.end) - Date.parse(call.start)) : null,
    }));
    item.toolsTruncated = acc.calls.size > 60 || !input.complete;
    const paired = [...acc.calls.values()].filter((call) => call.start && call.end);
    item.toolFailures = [...acc.calls.values()].filter((call) => call.failed).length;
    item.toolDurationMs = paired.length
      ? paired.reduce(
          (sum, call) => sum + Math.max(0, Date.parse(call.end!) - Date.parse(call.start!)),
          0,
        )
      : null;
    item.queueDurationMs = acc.queueMeasured ? acc.queueMs : null;
    if (acc.cycleStart) {
      const end = liveRun ? input.observedAt : input.finishedAt;
      if (end) {
        acc.elapsed += Math.max(0, Date.parse(end) - Date.parse(acc.cycleStart));
        acc.measured = true;
      }
      item.runningSince = liveRun ? input.observedAt : null;
      if (!liveRun) {
        item.status = 'interrupted';
        item.endedAt = input.finishedAt;
      } else if (item.status !== 'queued' && (item.usage.pendingRequests ?? 0) > 0)
        item.status = 'waiting_model';
    }
    if (acc.queueStart && liveRun)
      item.queueDurationMs =
        acc.queueMs + Math.max(0, Date.parse(input.observedAt) - Date.parse(acc.queueStart));
    item.elapsedMs = acc.measured ? acc.elapsed : null;
    item.checksTruncated ||= !input.complete;
  }
  const main = group('main');
  const unassigned = group('unassigned');
  return {
    complete: input.complete,
    historicalAttribution:
      unassigned.size > 0 || [...agents.values()].some((acc) => !acc.versioned),
    main: usage(
      main,
      input.complete && main.size > 0,
      input.complete && !legacyScopes.has('summary'),
    ),
    unassigned: usage(unassigned, unassigned.size > 0, input.complete),
    agents: [...agents.values()].map(({ item }) => item),
  };
}
