import { measureRunDuration } from '../../../shared/runDuration';
import { findOrderedRows } from '../utils/orderedRead';
import { buildAgentDiagnostics } from './subagentDiagnostics';
import { createHash } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { Op } from 'sequelize';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { D2cAgentCheckpoint } from '@/models/D2cAgentCheckpoint';
import { ownedSession, requireIdentifier, SessionError } from '../session/access';
import { toolFeedbackSchema } from './toolFeedback';
import { runFailureSchema } from './errors';
import { modelActivitySchema } from './agent/modelActivity';
import type { ModelPreparation } from './agent/modelPreparation';
import type { ExecutionDiagnostics, ExecutionScope } from '../../../../shared/executionDiagnostics';

const tools = new Set([
  'prepare_slices',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'figma',
  'check_rules',
  'delegate_agent',
  'wait_subagents',
  'ask_user',
  'report_progress',
  'build_preview',
  'inspect_preview',
]);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
type Step = {
  id: string;
  type: 'model' | 'tool' | 'summary' | 'subagent';
  name: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  preparation?: ModelPreparation;
  startedSaveMs?: number;
  feedbackCode?: string;
  /** 客户端观测分段；缺值保持未知，不能推断网关内部排队。 */
  gatewayRequestId?: string | null;
  firstChunkMs?: number | null;
  afterFirstChunkMs?: number | null;
  /** 请求参数元数据，不代表网关实际采用的思考强度。 */
  requestedReasoningEffort?: 'low' | 'high';
  reasoningEscalated?: boolean;
};

/** 非法或缺失时间保持未知，不能把历史空值展示为1970年或0ms。 */
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 私有工具调用ID只用于内部配对，公开步骤用摘要标识而不回传原文。 */
function stepId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** 工具耗时含调用登记至返回之间的排队等待；窗口缺一端时明确保持未知。 */
function executionSteps(rows: D2cTimeline[], status: string): Step[] {
  const steps: Step[] = [];
  const models = new Map<string, Step>();
  const calls = new Map<string, Step>();
  for (const row of rows) {
    const at = timestamp(row.createdAt);
    const data = row.displayPayload ?? {};
    if (row.kind === 'model_status') {
      const parsed = modelActivitySchema.safeParse(data);
      if (!parsed.success) continue;
      const event = parsed.data;
      let step = models.get(event.operationId);
      if (!step || event.status === 'started') {
        step = {
          id: stepId(`model:${event.operationId}:${row.seq}`),
          type:
            event.scope === 'summary'
              ? 'summary'
              : event.scope === 'generation'
                ? 'model'
                : 'subagent',
          name:
            event.scope === 'summary'
              ? '上下文摘要'
              : event.scope === 'design'
                ? '设计分析模型'
                : event.scope === 'review'
                  ? '代码审查模型'
                  : event.scope === 'rule_scan'
                    ? '规则扫描模型'
                    : event.scope === 'ui'
                      ? 'UI 实现模型'
                      : '模型请求',
          status: 'running',
          startedAt: event.status === 'started' ? at : null,
          endedAt: null,
          durationMs: null,
          gatewayRequestId: null,
          firstChunkMs: null,
          afterFirstChunkMs: null,
        };
        models.set(event.operationId, step);
        steps.push(step);
      }
      if (event.requestedReasoningEffort !== undefined)
        step.requestedReasoningEffort = event.requestedReasoningEffort;
      if (event.preparation !== undefined) step.preparation = event.preparation;
      if (event.startedSaveMs !== undefined) step.startedSaveMs = event.startedSaveMs;
      if (event.reasoningEscalated !== undefined)
        step.reasoningEscalated = event.reasoningEscalated;
      if (event.gatewayRequestId !== undefined) step.gatewayRequestId = event.gatewayRequestId;
      if (event.firstChunkMs !== undefined) step.firstChunkMs = event.firstChunkMs;
      if (event.afterFirstChunkMs !== undefined) step.afterFirstChunkMs = event.afterFirstChunkMs;
      if (event.status !== 'started') {
        step.status =
          event.status === 'failed' && event.interrupted === true ? 'interrupted' : event.status;
        step.endedAt = at;
        step.durationMs = event.durationMs ?? null;
      }
      continue;
    }
    if (row.kind !== 'tool_call' && row.kind !== 'tool_result') continue;
    const callId =
      typeof row.toolCallId === 'string'
        ? row.toolCallId
        : typeof data.callId === 'string'
          ? data.callId
          : null;
    const name = typeof data.name === 'string' && tools.has(data.name) ? data.name : '未知工具';
    let step = callId ? calls.get(callId) : undefined;
    if (row.kind === 'tool_call' || !step || (name !== '未知工具' && step.name !== name)) {
      step = {
        id: stepId(`tool:${row.seq}:${callId ?? ''}`),
        type: 'tool',
        name,
        status: row.kind === 'tool_call' ? 'running' : 'unknown',
        startedAt: row.kind === 'tool_call' ? at : null,
        endedAt: null,
        durationMs: null,
      };
      if (callId) calls.set(callId, step);
      steps.push(step);
    }
    if (row.kind === 'tool_result') {
      const feedback = toolFeedbackSchema.safeParse(data.feedback);
      if (feedback.success) step.feedbackCode = feedback.data.code;
      step.status =
        data.recovered === true
          ? 'unknown'
          : feedback.success
            ? 'failed'
            : data.status === 'failed'
              ? 'failed'
              : data.status === 'interrupted'
                ? 'interrupted'
                : data.status === 'completed'
                  ? 'completed'
                  : 'unknown';
      step.endedAt = at;
      if (data.recovered !== true && step.startedAt && at)
        step.durationMs = Math.max(0, Date.parse(at) - Date.parse(step.startedAt));
    }
  }
  for (const step of steps) {
    if (step.status === 'running' && terminal.has(status)) step.status = 'interrupted';
  }
  return steps;
}

/** 主轮事件排除子任务；聊天与诊断共用等待回答暂停的区间算法。 */
function runTiming(run: D2cRun, events: D2cTimeline[], observedAt: string) {
  const timing = measureRunDuration(
    timestamp(run.createdAt) ? Date.parse(timestamp(run.createdAt)!) : null,
    run.status,
    [...events]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .filter(
        (event) =>
          event.kind === 'run_status' ||
          (event.kind === 'stage' &&
            event.displayPayload?.stage === 'queued' &&
            event.displayPayload?.status === 'queued' &&
            event.displayPayload?.agentId == null),
      )
      .map((event) => ({
        status: String(event.displayPayload?.status),
        at: timestamp(event.createdAt) ? Date.parse(timestamp(event.createdAt)!) : null,
      })),
    Date.parse(observedAt),
  );
  return {
    ...timing,
    finishedAt: timing.finishedAt === null ? null : new Date(timing.finishedAt).toISOString(),
  };
}

/** 有界状态事件按 runId 分组；任一轮计时缺失时合计保持未知。 */
function sessionTiming(runs: D2cRun[], events: D2cTimeline[], observedAt: string) {
  const byRun = new Map<string, D2cTimeline[]>();
  for (const event of events) {
    if (!event.runId) continue;
    const list = byRun.get(event.runId) ?? [];
    list.push(event);
    byRun.set(event.runId, list);
  }
  let elapsedMs = 0;
  let runningCount = 0;
  for (const run of runs) {
    const timing = runTiming(run, byRun.get(run.runId!) ?? [], observedAt);
    if (timing.elapsedMs === null) return { elapsedMs: null, runningCount: 0 };
    elapsedMs += timing.elapsedMs;
    runningCount += timing.runningCount;
  }
  return { elapsedMs, runningCount };
}

/** 跨轮只累加平台逐轮采集的计数；历史旧累计值可能跨轮重复，保持未知。 */
function scopeSummary(
  runs: D2cRun[],
  events: D2cTimeline[],
  observedAt: string,
  complete = true,
): ExecutionScope {
  const timing = sessionTiming(runs, events, observedAt);
  const sum = (key: string, tokens = false): number | null => {
    let total = 0;
    for (const run of runs) {
      const usage = run.usage;
      if (usage?.trackingVersion !== 1) return null;
      const value = usage[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      if (
        tokens &&
        !(typeof usage.reportedRequests === 'number' && usage.reportedRequests > 0) &&
        !(usage.requests === 0 && usage.usageComplete === true)
      )
        return null;
      total += value;
      if (!Number.isSafeInteger(total)) return null;
    }
    return complete ? total : null;
  };
  return {
    runCount: runs.length,
    elapsedMs: complete ? timing.elapsedMs : null,
    runningCount: complete ? timing.runningCount : 0,
    complete,
    usage: {
      requests: sum('requests'),
      reportedRequests: sum('reportedRequests'),
      totalTokens: sum('totalTokens', true),
      usageComplete:
        !complete || runs.some((run) => run.usage?.trackingVersion !== 1)
          ? null
          : runs.every((run) => run.usage?.usageComplete === true),
    },
  };
}

/** 仅沿显式关联找恢复链；缺父节点、循环及历史关联缺失均不补造。 */
function recoveryChain(runs: D2cRun[], selected: D2cRun | null) {
  if (!selected?.runId) return { runs: [] as D2cRun[], complete: true };
  const byId = new Map(runs.map((run) => [run.runId, run]));
  byId.set(selected.runId, selected);
  let root = selected;
  const visited = new Set<string>();
  let complete = true;
  while (root.resumeFromRunId) {
    if (visited.has(root.runId!)) {
      complete = false;
      break;
    }
    visited.add(root.runId!);
    const parent = byId.get(root.resumeFromRunId);
    if (!parent) {
      complete = false;
      break;
    }
    root = parent;
  }
  if (root.resumeFromRunId === undefined) complete = false;
  const ids = new Set([root.runId]);
  const children = new Map<string, D2cRun[]>();
  for (const run of byId.values()) {
    if (!run.resumeFromRunId) continue;
    const list = children.get(run.resumeFromRunId) ?? [];
    list.push(run);
    children.set(run.resumeFromRunId, list);
  }
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index].runId!) ?? []) {
      if (ids.has(child.runId)) continue;
      ids.add(child.runId);
      queue.push(child);
    }
  }
  return { runs: queue, complete };
}

/**
 * 读取本人会话的有限诊断窗口，只选择元数据列，不创建图或反序列化检查点。
 * 轮次与事件在执行期间可能继续推进，observedAt/timelineSeq标记本次读取范围。
 */
export async function readRunDiagnostics(
  mysql: Sequelize,
  userId: string,
  sessionId: string,
  selectedRunId?: string,
) {
  const { session } = await ownedSession(mysql, userId, sessionId);
  if (selectedRunId) requireIdentifier(selectedRunId);
  const runs = mysql.models.D2cRun as typeof D2cRun;
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  const checkpoints = mysql.models.D2cAgentCheckpoint as typeof D2cAgentCheckpoint | undefined;
  if (!runs || !timeline)
    throw new SessionError(503, 'DIAGNOSTICS_UNAVAILABLE', '执行诊断暂不可用');
  /** 会话总时间包含全部轮次，仅读取时间/状态元数据，不受最近10轮菜单限制。 */
  const sessionRows = await findOrderedRows(runs, 'runId', {
    where: { sessionId },
    attributes: ['runId', 'status', 'createdAt', 'updatedAt', 'resumeFromRunId', 'usage'],
    limit: 2001,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const sessionRuns = sessionRows.slice(0, 2000);
  let runsComplete = sessionRows.length <= 2000;
  let recent = sessionRuns.slice(0, 10);
  const runId = selectedRunId ?? session.activeRunId ?? recent[0]?.runId;
  const run = runId
    ? await runs.findOne({
        where: { runId, sessionId },
        attributes: [
          'runId',
          'sessionId',
          'status',
          'modelSnapshot',
          'usage',
          'error',
          'createdAt',
          'updatedAt',
          'leaseExpiresAt',
          'resumeFromRunId',
        ],
      })
    : null;
  if (runId && (!run || run.runId !== runId || run.sessionId !== sessionId))
    throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
  // 后读所选轮次可能已新增请求；三个范围必须采用同一版所选元数据。
  if (run) {
    const index = sessionRuns.findIndex((item) => item.runId === run.runId);
    if (index >= 0) sessionRuns[index] = run;
    else if (runsComplete && sessionRuns.length < 2000) sessionRuns.push(run);
    else runsComplete = false;
    recent = sessionRuns.slice(0, 10);
  }
  const rows = run
    ? await findOrderedRows(timeline, 'seq', {
        where: {
          sessionId,
          runId,
          kind: { [Op.in]: ['model_status', 'tool_call', 'tool_result'] },
        },
        attributes: ['seq', 'kind', 'toolCallId', 'createdAt', 'displayPayload'],
        order: [['seq', 'DESC']],
        limit: 201,
      })
    : [];
  /** 分离模型元数据和子任务元数据窗口，避免工具噪声截断模型统计；不读取SDK正文。 */
  const [modelRows, agentRows] = run
    ? await Promise.all([
        findOrderedRows(timeline, 'seq', {
          where: { sessionId, runId, kind: 'model_status' },
          attributes: ['seq', 'createdAt', 'displayPayload'],
          order: [['seq', 'DESC']],
          limit: 4001,
        }),
        findOrderedRows(timeline, 'seq', {
          where: {
            sessionId,
            runId,
            kind: 'stage',
            'displayPayload.stage': 'subagent',
            [Op.or]: [
              {
                'displayPayload.status': {
                  [Op.in]: [
                    'queued',
                    'started',
                    'completed',
                    'failed',
                    'tool_started',
                    'tool_completed',
                    'tool_feedback',
                    'tool_failed',
                  ],
                },
              },
              { 'displayPayload.status': 'message', 'displayPayload.message.role': 'user' },
            ],
          },
          attributes: ['seq', 'createdAt', 'displayPayload'],
          order: [['seq', 'DESC']],
          limit: 8001,
        }),
      ])
    : [[], []];
  const hasMore = rows.length > 200;
  const steps = executionSteps(rows.slice(0, 200).reverse(), run?.status ?? 'unknown');
  const checkpoint = checkpoints
    ? await checkpoints.findOne({
        where: { sessionId, threadId: `d2c:${sessionId}`, checkpointNs: '' },
        attributes: ['createdAt', 'updatedAt'],
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
      })
    : null;
  const timeRows = await findOrderedRows(timeline, 'seq', {
    where: {
      sessionId,
      [Op.or]: [
        { kind: 'run_status' },
        { kind: 'stage', 'displayPayload.stage': 'queued', 'displayPayload.status': 'queued' },
      ],
    },
    attributes: ['runId', 'seq', 'kind', 'createdAt', 'displayPayload'],
    order: [['seq', 'ASC']],
    limit: 20001,
  });
  const timeEvents = timeRows.slice(0, 20000);
  const timesComplete = timeRows.length <= 20000;
  const observedAt = new Date().toISOString();
  const sessionTime = sessionTiming(sessionRuns, timeEvents, observedAt);
  const selectedTime = run
    ? runTiming(
        run,
        timeEvents.filter((event) => event.runId === run.runId),
        observedAt,
      )
    : null;
  const chain = recoveryChain(sessionRuns, run);
  const createdAt = timestamp(run?.createdAt);
  const finishedAt = timesComplete ? (selectedTime?.finishedAt ?? null) : null;
  const expiresAt = timestamp(run?.leaseExpiresAt);
  const live = run && (run.status === 'running' || run.status === 'stopping');
  const active = live ? steps.find((step) => step.status === 'running') : null;
  const savedAt = timestamp(checkpoint?.updatedAt) ?? timestamp(checkpoint?.createdAt);
  /** 只计已保存供应商用量，未报告时Token保持null，不把未知用量当作零成本。 */
  const count = (name: string) => {
    const value = run?.usage?.[name];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const reportedRequests = count('reportedRequests');
  const failure = run?.error && runFailureSchema.safeParse(run.error.failure);
  const failureCode = failure && failure.success ? failure.data.code : null;
  const reason = run?.error?.reason;
  const execution: ExecutionDiagnostics = {
    selected: {
      ...scopeSummary(run ? [run] : [], timeEvents, observedAt, timesComplete),
      usage: {
        requests: run ? count('requests') : 0,
        reportedRequests: run ? reportedRequests : 0,
        totalTokens: run ? (reportedRequests ? count('totalTokens') : null) : 0,
        usageComplete: run
          ? typeof run.usage?.usageComplete === 'boolean'
            ? run.usage.usageComplete
            : null
          : true,
      },
    },
    recoveryChain: scopeSummary(
      chain.runs,
      timeEvents,
      observedAt,
      chain.complete && runsComplete && timesComplete,
    ),
    session: scopeSummary(sessionRuns, timeEvents, observedAt, runsComplete && timesComplete),
    resumeFromRunId: run?.resumeFromRunId ?? null,
    interruption: !run
      ? null
      : run.status === 'cancelled'
        ? 'cancelled'
        : failureCode && failureCode !== 'WORKER_INTERRUPTED'
          ? 'failure'
          : reason === 'WORKER_INTERRUPTED' || failureCode === 'WORKER_INTERRUPTED'
            ? 'worker'
            : reason === 'LEASE_EXPIRED'
              ? 'lease'
              : run.status === 'failed'
                ? 'failure'
                : run.status === 'interrupted' || run.status === 'paused'
                  ? 'unknown'
                  : null,
  };
  const model = run?.modelSnapshot?.MODEL_NAME;
  return {
    sessionId,
    runId: run?.runId ?? null,
    status: run?.status ?? null,
    timelineSeq: Math.max(session.timelineSeq, ...rows.map((row) => row.seq ?? 0)),
    observedAt,
    execution,
    sessionElapsedMs: runsComplete && timesComplete ? sessionTime.elapsedMs : null,
    sessionRunningCount: runsComplete && timesComplete ? sessionTime.runningCount : 0,
    modelName: typeof model === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(model) ? model : null,
    createdAt,
    finishedAt,
    elapsedMs: timesComplete ? (selectedTime?.elapsedMs ?? null) : null,
    lease: {
      expiresAt,
      expired: Boolean(live && expiresAt && Date.parse(expiresAt) <= Date.parse(observedAt)),
    },
    runs: recent
      .filter((row) => typeof row.runId === 'string')
      .map((row) => ({
        runId: row.runId!,
        status: row.status,
        createdAt: timestamp(row.createdAt),
      })),
    current: active ? { type: active.type, name: active.name, startedAt: active.startedAt } : null,
    steps,
    agentDiagnostics: buildAgentDiagnostics({
      models: modelRows.slice(0, 4000).reverse(),
      stages: agentRows.slice(0, 8000).reverse(),
      status: run?.status ?? 'unknown',
      finishedAt,
      observedAt,
      modelName:
        typeof model === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(model) ? model : null,
      complete: modelRows.length <= 4000 && agentRows.length <= 8000,
    }),
    hasMore,
    checkpoint: {
      available: !!savedAt,
      savedAt,
      scope: 'session' as const,
      continuation:
        run?.runId === session.activeRunId && run.status === 'waiting_input'
          ? ('answer' as const)
          : run?.runId === session.activeRunId && run.status === 'interrupted'
            ? ('resume' as const)
            : ('none' as const),
    },
    usage: {
      requests: count('requests'),
      reportedRequests,
      completedRequests: count('completedRequests'),
      failedRequests: count('failedRequests'),
      interruptedRequests: count('interruptedRequests'),
      pendingRequests: count('pendingRequests'),
      unreportedRequests: count('unreportedRequests'),
      usageComplete:
        typeof run?.usage?.usageComplete === 'boolean' ? run.usage.usageComplete : null,
      inputTokens: reportedRequests ? count('inputTokens') : null,
      outputTokens: reportedRequests ? count('outputTokens') : null,
      totalTokens: reportedRequests ? count('totalTokens') : null,
    },
    failure: failure && failure.success ? failure.data : null,
  };
}
