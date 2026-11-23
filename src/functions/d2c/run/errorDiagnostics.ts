import { createHash } from 'node:crypto';
import { Op, type Sequelize } from 'sequelize';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type {
  DiagnosticError,
  DiagnosticErrorCategory,
  ErrorDiagnostics,
  ErrorDiagnosticsQuery,
} from '../../../../shared/errorDiagnostics';
import { readFailureDetails } from '../../../shared/failureDetails';
import { ownedSession, requireIdentifier, SessionError } from '../session/access';
import { findOrderedRows } from '../utils/orderedRead';
import { gatewayRequestIdSchema } from './agent/modelActivity';
import { runFailureSchema, type RunFailure } from './errors';
import { toolFeedbackSchema } from './toolFeedback';

const limit = 20000;
const runLimit = 2000;
const snapshotLimit = 128;
const cachedItemLimit = 100000;
const roles = new Set(['design', 'review', 'rule_scan', 'ui']);
const categories = new Set<DiagnosticErrorCategory>([
  'model',
  'tool',
  'subagent',
  'storage',
  'preview',
  'database',
  'execution',
  'rule',
]);
const tools = new Set([
  'prepare_slices',
  'list_files',
  'report_progress',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'figma',
  'ask_user',
  'delegate_agent',
  'wait_subagents',
  'check_rules',
  'build_preview',
  'inspect_preview',
]);
const commands = new Set([
  'verify-token',
  'cache-check',
  'fetch-node',
  'inspect-node',
  'export-image',
  'screenshot',
]);
const stages = new Set(['prepare', 'model', 'tool', 'validation', 'storage', 'worker', 'subagent']);
const ruleMessages: Record<string, string> = {
  RULES_FAILED: '规则检查未通过',
  VALIDATION_FAILED: '生成产物未通过规则检查',
  RULE_REPAIR_STALLED: '规则修复未取得进展，已交回主任务',
};
type Bucket = 'executionErrors' | 'toolCorrections' | 'ruleFailures';
type Candidate = { item: DiagnosticError; keys: string[]; bucket: Bucket; modelOwner?: string };
type Snapshot = {
  snapshotToken: string;
  items: DiagnosticError[];
  counts: Pick<ErrorDiagnostics, Bucket>;
  coverage: ErrorDiagnostics['coverage'];
  expires: number;
};
/** 只缓存安全投影；快照数量与明细总量双重有界，鉴权不进入缓存。 */
const snapshots = new WeakMap<Sequelize, Map<string, Snapshot>>();

/** 非对象与数组均不能作为元数据读取，不解析字符串或私有SDK正文。 */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 所有编号复用请求编号的格式与凭据前缀拒绝规则。 */
function identifier(value: unknown): string | null {
  const parsed = gatewayRequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** 缺失时间保持未知，禁止产生1970年或无效日期。 */
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 历史失败也只由固定code映射重建说明，不接受message、detail或cause。 */
function description(value: unknown, fallback: string) {
  const code = typeof value === 'string' ? value : '';
  if (Object.hasOwn(ruleMessages, code)) return { code, message: ruleMessages[code] };
  const feedback = toolFeedbackSchema.safeParse({ type: 'tool_feedback', ok: false, code });
  if (feedback.success) return { code, message: feedback.data.message };
  const failure = runFailureSchema.safeParse({
    errorId: '00000000-0000-4000-8000-000000000000',
    stage: 'worker',
    code,
  });
  if (failure.success) return { code, message: failure.data.message };
  return {
    code: fallback,
    message:
      fallback === 'MODEL_REQUEST_FAILED'
        ? '模型请求失败'
        : '执行失败，历史记录未保存可识别的失败分类',
  };
}

/** 业务错误类别由可信阶段、工具或已知code确定，不检索异常正文。 */
function category(
  code: string,
  stage: string | null,
  tool: string | null,
  base: DiagnosticErrorCategory,
): DiagnosticErrorCategory {
  if (Object.hasOwn(ruleMessages, code)) return 'rule';
  if (code === 'STORAGE_FAILED' || stage === 'storage') return 'storage';
  if (tool === 'build_preview' || tool === 'inspect_preview') return 'preview';
  if (code.startsWith('MODEL_') || code === 'CONTEXT_LIMIT' || stage === 'model') return 'model';
  if (code === 'SUBAGENT_FAILED') return 'subagent';
  if (stage === 'tool' || code === 'TOOL_FAILED') return 'tool';
  return base;
}

/** 仅使用已有公开动作摘要定位操作对象；不读取SDK、正文或原始参数。
 * 摘要中的字段可能在200字符处截断，无法证明完整对象时保持未知。
 */
function toolTarget(tool: string, detail: unknown): string | null {
  if (typeof detail !== 'string' || detail.length > 512 || /[\u0000-\u001f\u007f]/.test(detail))
    return null;
  let fields: string[] | undefined;
  if (tool === 'read_file') {
    const match =
      /^读取(固定资源|会话文件)：(.+?)( · 字符偏移 \d+，(?:自动页长|请求 \d+ 字符))?$/.exec(detail);
    if (match) fields = [match[1], match[2], match[3] ?? ''];
  } else if (['write_file', 'edit_file', 'delete_file'].includes(tool)) {
    const prefix = {
      write_file: '写入文件：',
      edit_file: '局部修改文件：',
      delete_file: '删除文件：',
    }[tool]!;
    if (detail.startsWith(prefix)) fields = [detail.slice(prefix.length)];
  } else if (tool === 'check_rules') {
    const match = /^检查规则：(.+) · (block|merge)$/.exec(detail);
    if (match) fields = [match[1], match[2]];
  } else if (tool === 'prepare_slices') {
    const match = /^准备切图：([a-z0-9][a-z0-9-]{0,63})$/.exec(detail);
    if (match) fields = [match[1]];
  } else if (tool === 'figma') {
    const match =
      /^Figma：(fetch-node|inspect-node|export-image|screenshot) · 节点 (\d+:\d+)( · 子树分页 \d+)?$/.exec(
        detail,
      );
    if (match) fields = [match[1], match[2], match[3] ?? ''];
  }
  if (!fields || fields.some((field) => field.length >= 200) || !fields[0]) return null;
  return JSON.stringify([tool, ...fields]);
}

type ToolEvidence = { key: string; started: number; finished: number; success: boolean };

/** 同run同Agent的唯一callId配对；缺起点、重复编号或未知结果不能推断成功。 */
function toolEvidence(rows: D2cTimeline[]) {
  const calls = new Map<string, { row: D2cTimeline; start: boolean }[]>();
  for (const row of rows) {
    const data = object(row.displayPayload);
    const child = row.kind === 'stage' && data.stage === 'subagent';
    const start = row.kind === 'tool_call' || (child && data.status === 'tool_started');
    if (!start && row.kind !== 'tool_result' && !(child && String(data.status).startsWith('tool_')))
      continue;
    const runId = identifier(row.runId);
    const callId = identifier(row.toolCallId ?? data.callId);
    if (row.toolCallId != null && data.callId != null && row.toolCallId !== data.callId) continue;
    const agentId = identifier(data.agentId);
    // 主工具事件的既有契约没有agentId；显式非法身份不能回退成主Agent。
    const owner =
      (agentId ? `agent:${agentId}` : null) ??
      (!child &&
      data.agentId == null &&
      (data.scope == null || ['main', 'generation'].includes(String(data.scope)))
        ? 'main'
        : null);
    if (!runId || !callId || !owner || !Number.isSafeInteger(row.seq)) continue;
    const key = JSON.stringify([runId, owner, callId]);
    const group = calls.get(key) ?? [];
    group.push({ row, start });
    calls.set(key, group);
  }
  const bySeq = new Map<number, ToolEvidence>();
  for (const group of calls.values()) {
    if (group.length !== 2) continue;
    const begin = group.find((entry) => entry.start)?.row;
    const end = group.find((entry) => !entry.start)?.row;
    if (!begin || !end || begin.seq! >= end.seq!) continue;
    const a = object(begin.displayPayload),
      b = object(end.displayPayload);
    const tool = a.name ?? a.tool;
    if (typeof tool !== 'string' || !tools.has(tool) || (b.name ?? b.tool ?? tool) !== tool)
      continue;
    if (!['started', 'tool_started'].includes(String(a.status))) continue;
    const target = toolTarget(tool, a.detail);
    if (!target || (b.detail != null && b.detail !== a.detail)) continue;
    const command = tool === 'figma' ? JSON.parse(target)[1] : null;
    if (
      (a.command != null && a.command !== command) ||
      (b.command != null && b.command !== command)
    )
      continue;
    const evidence: ToolEvidence = {
      key: JSON.stringify([
        begin.runId,
        a.agentId == null ? 'main' : `agent:${identifier(a.agentId)}`,
        target,
      ]),
      started: begin.seq!,
      finished: end.seq!,
      success:
        ['completed', 'tool_completed'].includes(String(b.status)) &&
        b.feedback == null &&
        b.failure == null &&
        b.diagnosticFailure == null &&
        b.recovered !== true &&
        b.interrupted !== true &&
        b.cancelled !== true &&
        b.ok !== false &&
        b.result == null &&
        b.resultStatus == null &&
        object(b.ruleCheck).passed !== false &&
        object(b.delivery).success !== false,
    };
    bySeq.set(end.seq!, evidence);
  }
  return bySeq;
}

/** 参数拒绝非法游标，before始终是去重、筛选后的记录偏移数。 */
function validate(query: ErrorDiagnosticsQuery) {
  if (query.runId !== undefined) {
    requireIdentifier(query.runId);
    if (!identifier(query.runId)) throw new SessionError(422, 'INVALID_IDENTIFIER', '轮次标识无效');
  }
  if (
    (query.category !== undefined && !categories.has(query.category)) ||
    (query.scope !== undefined && !['main', 'subagent', 'unknown'].includes(query.scope)) ||
    [query.before, query.snapshotSeq, query.pageSize].some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    query.pageSize === 0 ||
    (query.snapshotToken !== undefined && !/^[a-f0-9]{64}$/.test(query.snapshotToken)) ||
    ((query.before ?? 0) > 0 &&
      (query.snapshotSeq === undefined || query.snapshotToken === undefined))
  )
    throw new SessionError(422, 'INVALID_DIAGNOSTICS_QUERY', '错误统计查询参数无效');
}

/** 读取已有公开事件并构造安全候选；没有可靠关联的不同历史记录分别保留。 */
function collect(rows: D2cTimeline[], runs: D2cRun[], cutoff: string | null) {
  const candidates: Candidate[] = [];
  const evidence = toolEvidence(rows);
  const toolSuccesses = new Map<string, number>();
  for (const entry of evidence.values())
    if (entry.success)
      toolSuccesses.set(entry.key, Math.max(toolSuccesses.get(entry.key) ?? 0, entry.started));
  const terminalEvents = new Set<string>();
  const stopped = new Set(['failed', 'interrupted', 'succeeded', 'cancelled', 'paused']);
  const stoppedRuns = new Set(
    runs
      .filter((run) => {
        const ended = timestamp(run.updatedAt);
        return stopped.has(run.status) && ended && cutoff && ended <= cutoff;
      })
      .map((run) => run.runId),
  );
  /** 旧终态事件可能遗漏failure；仅用冻结边界内同轮已结束记录补齐明确关联。 */
  const savedFailures = new Map<string, RunFailure>();
  for (const run of runs) {
    const ended = timestamp(run.updatedAt);
    if (!['failed', 'interrupted'].includes(run.status) || !ended || !cutoff || ended > cutoff)
      continue;
    const parsed = runFailureSchema.safeParse(object(run.error).failure);
    if (parsed.success && run.runId) savedFailures.set(run.runId, parsed.data);
  }
  const successes = new Map<string, number>();
  let complete = true;
  for (const row of rows) {
    const runId = identifier(row.runId);
    if (!runId) {
      complete = false;
      continue;
    }
    const data = object(row.displayPayload);
    const seq = Number.isSafeInteger(row.seq) ? row.seq! : null;
    const subagent = row.kind === 'stage' && data.stage === 'subagent';
    const model = row.kind === 'model_status';
    const agentId = identifier(data.agentId);
    const owner = agentId ?? (data.agentId === null || data.scope === 'generation' ? 'main' : null);
    const modelOwner = owner
      ? `${runId}:${owner}:${identifier(data.scope) ?? 'unknown'}`
      : undefined;
    if (model && data.status === 'completed' && modelOwner && seq !== null)
      successes.set(modelOwner, Math.max(successes.get(modelOwner) ?? 0, seq));
    const runTerminal = row.kind === 'run_status';
    if (runTerminal && stopped.has(String(data.status))) stoppedRuns.add(runId);
    const parsed = runFailureSchema.safeParse(data.diagnosticFailure ?? data.failure);
    const failure = parsed.success
      ? parsed.data
      : runTerminal && ['failed', 'interrupted'].includes(String(data.status))
        ? savedFailures.get(runId)
        : undefined;
    if (failure?.code === 'WORKER_INTERRUPTED') continue;
    const terminalFailure =
      runTerminal && failure && ['failed', 'interrupted'].includes(String(data.status));
    if (runTerminal && (data.status === 'failed' || terminalFailure)) terminalEvents.add(runId);
    if (
      (model && data.interrupted === true) ||
      ['cancelled', 'paused'].includes(String(data.status)) ||
      (data.status === 'interrupted' && !terminalFailure)
    )
      continue;
    const feedback = object(data.feedback);
    const hasFeedback = feedback.type === 'tool_feedback' && feedback.ok === false;
    // 正常命名补全保留在时间线，不进入错误面板的计数或明细。
    if (hasFeedback && feedback.code === 'SLICE_NAMES_REQUIRED') continue;
    const failed = data.status === 'failed' || data.status === 'tool_failed' || terminalFailure;
    if (!(failed || hasFeedback || (subagent && data.status === 'tool_feedback'))) continue;
    if (subagent && !['failed', 'tool_failed', 'tool_feedback'].includes(String(data.status)))
      continue;
    if (!model && !runTerminal && !subagent && row.kind !== 'tool_result') continue;
    // 补齐取消/中断工具配对仅表示结果未知，不能当成一次实际工具失败。
    if (data.recovered === true && !hasFeedback && !object(data.failure).code) continue;
    const isTool =
      row.kind === 'tool_result' || (subagent && String(data.status).startsWith('tool_'));
    const stage =
      failure?.stage ?? (model ? 'model' : isTool ? 'tool' : subagent ? 'subagent' : null);
    const toolValue = failure?.tool ?? data.tool ?? data.name;
    const tool = typeof toolValue === 'string' && tools.has(toolValue) ? toolValue : null;
    const commandValue = failure?.command ?? data.command;
    const command =
      typeof commandValue === 'string' && commands.has(commandValue) ? commandValue : null;
    const reason = object(data.delivery).reason;
    const described = description(
      hasFeedback ? feedback.code : (failure?.code ?? data.code ?? reason),
      model ? 'MODEL_REQUEST_FAILED' : 'EXECUTION_FAILED',
    );
    const base = model ? 'model' : isTool ? 'tool' : subagent ? 'subagent' : 'execution';
    const kind = category(described.code, stage, tool, base);
    const errorId = identifier(failure?.errorId ?? data.errorId);
    const operationId = identifier(data.operationId);
    const callId = identifier(row.toolCallId ?? data.callId);
    const keys = [
      ...(errorId ? [`error:${runId}:${errorId}`] : []),
      ...(operationId
        ? [
            `operation:${runId}:${agentId ? `agent:${agentId}` : subagent ? 'unknown' : 'main'}:${operationId}`,
          ]
        : []),
      ...(callId
        ? [
            `call:${runId}:${agentId ? `agent:${agentId}` : subagent ? 'unknown' : 'main'}:${callId}`,
          ]
        : []),
    ];
    const attempt = typeof data.retryIndex === 'number' ? data.retryIndex + 1 : data.attempt;
    const details = readFailureDetails({ ...failure, ...object(data.failureDetails) });
    candidates.push({
      keys,
      modelOwner: model ? modelOwner : undefined,
      bucket:
        kind === 'rule'
          ? 'ruleFailures'
          : hasFeedback || data.status === 'tool_feedback'
            ? 'toolCorrections'
            : 'executionErrors',
      item: {
        id: '',
        ...(details ? { failureDetails: details } : {}),
        seq,
        at: timestamp(row.createdAt),
        runId,
        category: kind,
        scope:
          agentId || subagent
            ? 'subagent'
            : model
              ? owner === 'main'
                ? 'main'
                : 'unknown'
              : row.kind === 'tool_result'
                ? 'main'
                : 'unknown',
        ...described,
        stage: stage && stages.has(stage) ? stage : null,
        tool,
        command,
        agentId,
        agentRole:
          typeof data.role === 'string' && roles.has(data.role)
            ? data.role
            : typeof data.scope === 'string' && roles.has(data.scope)
              ? data.scope
              : null,
        errorId,
        requestId: identifier(data.gatewayRequestId ?? data.requestId),
        attempt:
          typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0
            ? attempt
            : null,
        recovery:
          typeof data.retryAttempt === 'number' && data.retryAttempt > 0 ? 'retrying' : 'unknown',
      },
    });
  }
  for (const run of runs) {
    const runId = identifier(run.runId);
    if (!runId || terminalEvents.has(runId) || !['failed', 'interrupted'].includes(run.status))
      continue;
    if (run.status === 'interrupted' && !object(run.error).failure) continue;
    // run.error没有序号；仅补充冻结边界前已结束的历史轮次，避免未来终态挤入旧页。
    const endedAt = timestamp(run.updatedAt);
    if (!cutoff || !endedAt || endedAt > cutoff) {
      complete = false;
      continue;
    }
    const parsed = runFailureSchema.safeParse(object(run.error).failure);
    const failure = parsed.success ? parsed.data : undefined;
    if (failure?.code === 'WORKER_INTERRUPTED') continue;
    const described = failure
      ? { code: failure.code, message: failure.message }
      : description(undefined, 'EXECUTION_FAILED');
    const kind = category(
      described.code,
      failure?.stage ?? null,
      failure?.tool ?? null,
      'execution',
    );
    candidates.push({
      keys: failure ? [`error:${runId}:${failure.errorId}`] : [],
      bucket: kind === 'rule' ? 'ruleFailures' : 'executionErrors',
      item: {
        id: '',
        seq: null,
        at: endedAt,
        runId,
        category: kind,
        scope: 'unknown',
        ...described,
        stage: failure?.stage ?? null,
        tool: failure?.tool ?? null,
        command: failure?.command ?? null,
        agentId: null,
        agentRole: null,
        errorId: failure?.errorId ?? null,
        failureDetails: readFailureDetails(failure),
        requestId: null,
        attempt: null,
        recovery: 'unknown',
      },
    });
  }
  for (const candidate of candidates) {
    const tool = candidate.item.seq === null ? undefined : evidence.get(candidate.item.seq);
    if (tool && (toolSuccesses.get(tool.key) ?? 0) > tool.finished)
      candidate.item.recovery = 'subsequent_success';
    else if (
      candidate.modelOwner &&
      candidate.item.seq !== null &&
      (successes.get(candidate.modelOwner) ?? 0) > candidate.item.seq
    )
      candidate.item.recovery = 'subsequent_success';
    else if (candidate.item.recovery === 'retrying' && stoppedRuns.has(candidate.item.runId))
      candidate.item.recovery = 'unresolved';
  }
  return { candidates, complete };
}

/** 并查集合并跨层编号桥接，不按文案、角色或相邻时间猜测同一失败。 */
function deduplicate(candidates: Candidate[], sessionId: string) {
  const parent = candidates.map((_, index) => index);
  const keys = new Map<string, number>();
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  candidates.forEach((candidate, index) => {
    for (const key of candidate.keys) {
      const previous = keys.get(key);
      if (previous !== undefined) parent[root(index)] = root(previous);
      keys.set(key, index);
    }
  });
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, index) => {
    const group = root(index);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(candidate);
  });
  return [...groups.values()].map((group) => {
    // 工具反馈和规则保留其原始语义，终态封装不会把它们重复算成执行错误。
    const selected = [...group].sort((a, b) => {
      const rank = (value: Candidate) =>
        value.bucket === 'ruleFailures'
          ? 0
          : value.bucket === 'toolCorrections'
            ? 1
            : value.modelOwner
              ? 2
              : 3;
      return rank(a) - rank(b) || (a.item.seq ?? Infinity) - (b.item.seq ?? Infinity);
    })[0];
    const item = { ...selected.item };
    for (const other of group) {
      for (const field of [
        'errorId',
        'requestId',
        'agentId',
        'agentRole',
        'tool',
        'command',
        'stage',
        'attempt',
      ] as const)
        if (item[field] === null) Object.assign(item, { [field]: other.item[field] });
      if (!item.failureDetails && other.item.failureDetails)
        item.failureDetails = other.item.failureDetails;
      if (other.item.scope === 'subagent') item.scope = 'subagent';
      if (other.item.recovery === 'subsequent_success') item.recovery = 'subsequent_success';
      else if (item.recovery === 'unknown' && other.item.recovery === 'retrying')
        item.recovery = 'retrying';
    }
    const first = group
      .filter((value) => value.item.seq !== null)
      .sort((a, b) => a.item.seq! - b.item.seq!)[0];
    if (first) {
      item.seq = first.item.seq;
      item.at = first.item.at;
    }
    const key = `row:${first?.item.runId ?? item.runId}:${item.seq ?? 'terminal'}`;
    item.id = createHash('sha256').update(`${sessionId}:${key}`).digest('hex').slice(0, 24);
    return { item, bucket: selected.bucket };
  });
}

/**
 * 本人会话全部轮次的只读错误统计。先冻结seq，元数据选序后读取公开事件；
 * historical始终仅指已保存事件，不代表历史采集完整，不读取SDK、检查点或回写历史。
 */
export async function readSessionErrors(
  mysql: Sequelize,
  userId: string,
  sessionId: string,
  query: ErrorDiagnosticsQuery,
): Promise<ErrorDiagnostics> {
  await ownedSession(mysql, userId, sessionId, undefined, 'read');
  validate(query);
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  const runs = mysql.models.D2cRun as typeof D2cRun;
  if (!timeline || !runs)
    throw new SessionError(503, 'DIAGNOSTICS_UNAVAILABLE', '错误统计暂不可用');
  const observedAt = new Date().toISOString();
  const heads = await timeline.findAll({
    where: { sessionId },
    attributes: ['seq', 'createdAt'],
    order: [['seq', 'DESC']],
    limit: 1,
  });
  const latest = heads[0]?.seq ?? 0;
  if (query.snapshotSeq !== undefined && query.snapshotSeq > latest)
    throw new SessionError(422, 'INVALID_DIAGNOSTICS_QUERY', '错误统计快照无效');
  const snapshotSeq = query.snapshotSeq ?? latest;
  const cache = snapshots.get(mysql) ?? new Map<string, Snapshot>();
  snapshots.set(mysql, cache);
  for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
  const cacheKey = `${sessionId}:${snapshotSeq}`;
  let snapshot = cache.get(cacheKey);
  if (!snapshot) {
    const [events, sessionRuns, anchor] = await Promise.all([
      findOrderedRows(timeline, 'seq', {
        where: {
          sessionId,
          seq: { [Op.lte]: snapshotSeq },
          [Op.or]: [
            { kind: { [Op.in]: ['tool_call', 'tool_result', 'model_status', 'run_status'] } },
            {
              kind: 'stage',
              'displayPayload.stage': 'subagent',
              'displayPayload.status': {
                [Op.in]: [
                  'failed',
                  'tool_failed',
                  'tool_feedback',
                  'tool_started',
                  'tool_completed',
                ],
              },
            },
          ],
        },
        attributes: ['seq', 'runId', 'kind', 'createdAt', 'toolCallId', 'displayPayload'],
        order: [['seq', 'DESC']],
        limit: limit + 1,
      }),
      findOrderedRows(runs, 'runId', {
        where: { sessionId },
        attributes: ['runId', 'status', 'error', 'updatedAt'],
        order: [
          ['createdAt', 'DESC'],
          ['runId', 'DESC'],
        ],
        limit: runLimit + 1,
      }),
      snapshotSeq === latest
        ? Promise.resolve(heads)
        : timeline.findAll({
            where: { sessionId, seq: { [Op.lte]: snapshotSeq } },
            attributes: ['seq', 'createdAt'],
            order: [['seq', 'DESC']],
            limit: 1,
          }),
    ]);
    const rows = events.slice(0, limit).reverse();
    const collected = collect(
      rows,
      sessionRuns.slice(0, runLimit),
      timestamp(anchor[0]?.createdAt),
    );
    const result = deduplicate(collected.candidates, sessionId);
    snapshot = {
      snapshotToken: '',
      counts: {
        executionErrors: result.filter((value) => value.bucket === 'executionErrors').length,
        toolCorrections: result.filter((value) => value.bucket === 'toolCorrections').length,
        ruleFailures: result.filter((value) => value.bucket === 'ruleFailures').length,
      },
      items: result
        .sort(
          (a, b) =>
            (b.item.seq ?? -1) - (a.item.seq ?? -1) ||
            (b.item.at ?? '').localeCompare(a.item.at ?? '') ||
            a.item.id.localeCompare(b.item.id),
        )
        .map((value) => value.item),
      coverage: {
        complete:
          events.length <= limit &&
          sessionRuns.length <= runLimit &&
          collected.complete &&
          (rows.length > 0 || collected.candidates.length > 0),
        scannedEvents: rows.length,
        limit,
        historical: 'saved_events_only',
      },
      expires: Date.now() + 30000,
    };
    // 只散列确定性安全投影，不含读取时间、缓存TTL、SDK内容或原始错误。
    snapshot.snapshotToken = createHash('sha256')
      .update(
        JSON.stringify({
          sessionId,
          snapshotSeq,
          items: snapshot.items,
          counts: snapshot.counts,
          coverage: snapshot.coverage,
        }),
      )
      .digest('hex');
    cache.set(cacheKey, snapshot);
    let cachedItems = [...cache.values()].reduce((sum, value) => sum + value.items.length, 0);
    while (cache.size > snapshotLimit || cachedItems > cachedItemLimit) {
      const oldest = cache.keys().next().value!;
      cachedItems -= cache.get(oldest)!.items.length;
      cache.delete(oldest);
    }
  }
  if (query.snapshotToken !== undefined && query.snapshotToken !== snapshot.snapshotToken)
    throw new SessionError(409, 'SNAPSHOT_EXPIRED', '错误统计快照内容已变化，请刷新后重试');
  const { ruleFailures, toolCorrections, executionErrors } = snapshot.counts;
  const filtered = snapshot.items.filter(
    (item) =>
      (!query.runId || item.runId === query.runId) &&
      (!query.category || item.category === query.category) &&
      (!query.scope || item.scope === query.scope),
  );
  const before = query.before ?? 0;
  const pageSize = Math.min(query.pageSize ?? 50, 100);
  const items = filtered.slice(before, before + pageSize);
  const hasMore = before + items.length < filtered.length;
  return {
    sessionId,
    observedAt,
    snapshotSeq,
    snapshotToken: snapshot.snapshotToken,
    total: executionErrors + toolCorrections,
    executionErrors,
    toolCorrections,
    ruleFailures,
    filteredTotal: filtered.length,
    items: items.map((item) => ({ ...item })),
    hasMore,
    nextBefore: hasMore ? before + items.length : null,
    coverage: { ...snapshot.coverage },
  };
}
