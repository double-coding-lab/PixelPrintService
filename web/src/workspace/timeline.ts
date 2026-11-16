import type { FailureCode, PendingQuestion, Session, TimelineEntry } from './types';

/** 普通过程仅展示读取对象；分页参数留在原始事件和展开后的工具详情。 */
export function formatToolDetail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return /^读取(?:固定资源|会话文件)：/.test(value)
    ? value.replace(/ · 字符偏移 \d+，(?:自动页长|请求 \d+ 字符)$/, '')
    : value;
}

const failureStages = {
  prepare: '执行准备',
  model: '模型调用',
  tool: '工具执行',
  validation: '产物校验',
  storage: '数据存储',
  worker: '后台任务',
} as const;

/** 与公开错误码契约对应；不采用历史记录中的任意异常文案。 */
const failureReasons = {
  EXECUTION_FAILED: ['任务执行失败', '请提供排查编号，由服务端日志定位失败阶段。'],
  PREPARATION_FAILED: ['执行上下文准备失败', '请检查会话配置、资源副本与历史记录。'],
  HISTORY_INVALID: ['对话工具历史不完整，无法继续执行', '请核对上轮中断记录，暂勿反复发送继续。'],
  RESOURCE_RESTORE_FAILED: ['固定资源或会话文件恢复失败', '请检查对象存储、资源摘要及执行目录。'],
  MODEL_UNAVAILABLE: ['本轮固定模型当前不可用', '请核对 项目配置 中的模型名称及接口地址。'],
  MODEL_REQUEST_FAILED: ['模型请求失败', '请检查模型网关和服务端模型配置。'],
  MODEL_RESPONSE_INVALID: [
    '模型返回的工具调用格式无效',
    '模型多次未能给出有效工具参数，已保存产物保留，请核对工具契约后继续。',
  ],
  SUBAGENT_FAILED: [
    '子任务执行或结果交接失败',
    '已保存文件和扫描报告保留，请结合排查编号检查子任务执行与结果交接。',
  ],
  MODEL_EMPTY_RESPONSE: [
    '模型连续返回空回复，任务未完成',
    '已保存文件和工具结果保留，可继续当前任务；请核对模型网关的可见输出及输出长度限制。',
  ],
  MODEL_OUTPUT_LIMIT: [
    '模型输出被长度上限截断',
    '本次回复或摘要未完整生成；请检查模型输出上限与摘要长度，截断内容不会当作有效结果。',
  ],
  MODEL_REQUEST_LIMIT: [
    '本轮模型请求次数已达到上限，执行已中断',
    '已保存文件和对话仍会保留，可继续当前任务；复杂任务可提高 项目配置 d2c.execution.maxTurns，主任务、子任务及摘要共享此限额。',
  ],
  MODEL_AUTH_FAILED: ['模型网关鉴权失败', '请检查 项目配置 中的模型调用凭据。'],
  MODEL_RATE_LIMITED: ['模型网关请求受限', '请核对模型配额，稍后再试。'],
  NETWORK_TIMEOUT: ['目标服务连接或响应超时', '请检查目标服务、代理连接和执行超时配置。'],
  NETWORK_UNAVAILABLE: ['无法连接目标服务', '请检查域名解析、目标服务和外网代理连接。'],
  TLS_CERTIFICATE_FAILED: [
    'HTTPS 证书校验失败',
    '请核对部署可信 CA 与 Node 系统证书配置，不要关闭 TLS 校验。',
  ],
  CONTEXT_LIMIT: [
    '当前模型请求超过上下文预算或摘要未能收敛',
    '已接入自动摘要；请检查单条输入、固定提示及摘要结果是否超过本轮预算。',
  ],
  TOOL_FAILED: ['受控工具执行失败', '请结合工具名称和排查编号检查服务端日志。'],
  SCRIPT_OUTPUT_INVALID: [
    '固定脚本输出不完整或格式无效',
    '请检查脚本输出是否完整且符合 JSON 契约；无需重复确认切图。',
  ],
  SCRIPT_FAILED: ['固定脚本执行失败', '请核对脚本依赖、外网代理及设计稿访问权限。'],
  SCRIPT_TIMEOUT: ['固定脚本执行超时', '请检查代理和外网连接，再核对任务执行限额。'],
  FIGMA_REQUEST_FAILED: ['Figma 请求或响应校验失败', '请检查设计稿权限、Figma 凭据与代理连接。'],
  FIGMA_ADDRESS_MISSING: ['会话尚未绑定有效 Figma 地址', '请在会话中配置有效设计稿地址。'],
  CREDENTIAL_UNAVAILABLE: ['Figma 凭据不可用', '请检查本人凭据配置及服务端加密材料。'],
  VALIDATION_FAILED: ['生成产物未通过规则检查', '请检查源码、前置切图证据和规则报告。'],
  CONFIRMATION_REQUIRED: ['生成流程需要人工确认', '请核对切图或业务问题；完整确认恢复仍待接入。'],
  STORAGE_FAILED: ['执行数据保存或读取失败', '请检查数据库、对象存储及文件修订状态。'],
  LEASE_LOST: ['本轮执行资格已失效', '请检查租约、服务重启或并发状态。'],
  RUN_TIMEOUT: ['任务超过执行时间限制', '请检查模型及工具耗时，再核对任务超时配置。'],
  WORKER_INTERRUPTED: ['后台任务已中断', '请核对服务退出或停止操作，已保存文件仍会保留。'],
} as const satisfies Record<FailureCode, readonly [string, string]>;

/** 只读取普通对象，拒绝数组、空值等坏历史结构。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 展示字段必须是字符串，防止对象成为 React 子节点或隐式泄露数据。 */
function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 属性名必须显式命中枚举，不能命中 Object 原型上的属性。 */
function knownKey<T extends object>(values: T, key: unknown): key is keyof T {
  return typeof key === 'string' && Object.hasOwn(values, key);
}

/** 失败/中断轮次才展示诊断；文案重建，其他可选字段逐个校验并投影。 */
export function getEventFailure(entry: TimelineEntry) {
  const data = record(entry?.data);
  if (entry?.kind !== 'run_status' || !['failed', 'interrupted'].includes(text(data.status)))
    return null;
  const failure = record(data.failure);
  if (!knownKey(failureReasons, failure.code)) return null;
  const [message, suggestion] = failureReasons[failure.code];
  const tool = text(failure.tool);
  const command = text(failure.command);
  const errorId = text(failure.errorId);
  const runId = text(entry.runId);
  return {
    requiresUser: failure.requiresUser === true,
    stage: knownKey(failureStages, failure.stage) ? failureStages[failure.stage] : '未知阶段',
    message,
    suggestion,
    errorId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(errorId)
      ? errorId
      : undefined,
    tool: [
      'prepare_slices',
      'list_files',
      'read_file',
      'write_file',
      'delete_file',
      'figma',
      'check_rules',
      'delegate_agent',
      'wait_subagents',
    ].includes(tool)
      ? tool
      : undefined,
    command: ['verify-token', 'cache-check', 'fetch-node', 'export-image', 'screenshot'].includes(
      command,
    )
      ? command
      : undefined,
    statusCode:
      typeof failure.statusCode === 'number' &&
      Number.isInteger(failure.statusCode) &&
      failure.statusCode >= 100 &&
      failure.statusCode <= 599
        ? failure.statusCode
        : undefined,
    runId: /^[\w-]{1,128}$/.test(runId) ? runId : undefined,
  };
}

/** SSE 仅订阅公开时间线事件，摘要与模型内部参数不在此列。 */
export const timelineEventKinds = [
  'session_changed',
  'file_changed',
  'version_changed',
  'preview_changed',
  'message',
  'text_delta',
  'reasoning_delta',
  'user_question',
  'model_status',
  'stage',
  'run_status',
  'tool_call',
  'tool_result',
] as const;

/** 流标识必须来自公开正文协议；不依赖顶层 messageId。 */
function streamKey(entry: TimelineEntry): string | null {
  const streamId = entry.data?.streamId;
  return typeof streamId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(streamId) &&
    typeof entry.runId === 'string' &&
    entry.runId.length > 0
    ? JSON.stringify([
        entry.sessionId,
        entry.runId,
        streamId,
        entry.kind === 'reasoning_delta' ? 'reasoning' : 'answer',
      ])
    : null;
}

/** 仅接受助手正文累计快照；无效或带其他角色的事件不进入展示。 */
export function isTextSnapshot(entry: TimelineEntry): boolean {
  return (
    entry.kind === 'text_delta' &&
    streamKey(entry) !== null &&
    typeof entry.data.text === 'string' &&
    (entry.data.role === undefined || entry.data.role === 'assistant') &&
    ['streaming', 'interrupted', 'discarded'].includes(entry.data.status ?? '')
  );
}

/** 思考仅进入执行过程，与相同请求的正式正文分别合并。 */
export function isReasoningSnapshot(entry: TimelineEntry): boolean {
  return (
    entry.kind === 'reasoning_delta' &&
    streamKey(entry) !== null &&
    typeof entry.data.text === 'string' &&
    ['streaming', 'completed', 'interrupted'].includes(entry.data.status ?? '')
  );
}

/** 按真实 seq 去重；先压缩累计快照再限窗，终态覆盖保留以抵御断线重放。 */
export function mergeTimeline(
  current: TimelineEntry[],
  incoming: TimelineEntry[],
  sessionId: string,
  maxEntries = 500,
) {
  const entries = new Map<number, TimelineEntry>();
  for (const entry of [...current, ...incoming]) {
    if (
      entry?.sessionId === sessionId &&
      Number.isSafeInteger(entry.seq) &&
      entry.seq > 0 &&
      entry.kind !== 'preview_changed' &&
      (entry.kind !== 'text_delta' || isTextSnapshot(entry)) &&
      (entry.kind !== 'reasoning_delta' || isReasoningSnapshot(entry))
    ) {
      entries.set(entry.seq, entry);
    }
  }
  const ordered = [...entries.values()].sort((a, b) => a.seq - b.seq);
  const streams = new Map<string, TimelineEntry>();
  for (const entry of ordered) {
    const key = streamKey(entry);
    if (!key) continue;
    const prior = streams.get(key);
    if (entry.kind === 'message' && entry.data.role === 'assistant') {
      streams.set(key, entry);
    } else if (
      ['text_delta', 'reasoning_delta'].includes(entry.kind) &&
      prior?.kind !== 'message' &&
      (entry.data.status !== 'streaming' || !prior || prior.data.status === 'streaming')
    ) {
      streams.set(key, entry);
    }
  }
  return ordered
    .filter(
      (entry) =>
        !['text_delta', 'reasoning_delta'].includes(entry.kind) ||
        streams.get(streamKey(entry)!) === entry,
    )
    .slice(-maxEntries);
}

export type TimelineGroup =
  | { kind: 'event'; entry: TimelineEntry }
  | { kind: 'activity'; entries: TimelineEntry[]; active: boolean };

/** 消息和失败单独展示，其余连续同轮次过程合并；只有最后的活跃过程自动展开。 */
export function groupTimeline(
  entries: TimelineEntry[],
  activeRunId: string | null,
): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const calls = new Map<string, TimelineEntry | null>();
  /** 调用标识只在同会话、同轮次内匹配，不能用工具名或相邻顺序猜测。 */
  const callKey = (entry: TimelineEntry) =>
    JSON.stringify([entry.sessionId, entry.runId, entry.data.callId]);
  for (const entry of entries) {
    if (entry.kind !== 'tool_call' || !entry.data.callId) continue;
    const key = callKey(entry);
    calls.set(key, calls.has(key) ? null : entry);
  }
  const finished = new Set(
    entries
      .filter(
        (entry) =>
          (entry.kind === 'run_status' ||
            (entry.kind === 'stage' && entry.data.stage !== 'subagent')) &&
          ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(entry.data.status ?? ''),
      )
      .map((entry) => entry.runId),
  );
  for (const original of entries) {
    if (original.kind === 'preview_changed') continue;
    if (
      original.kind === 'text_delta' &&
      (!isTextSnapshot(original) || original.data.status === 'discarded')
    )
      continue;
    const snapshot =
      ['text_delta', 'reasoning_delta'].includes(original.kind) &&
      original.data.status === 'streaming' &&
      (original.runId !== activeRunId || finished.has(original.runId))
        ? { ...original, data: { ...original.data, status: 'interrupted' } }
        : original;
    const call = original.kind === 'tool_result' ? calls.get(callKey(original)) : null;
    const entry =
      call && call.seq < original.seq
        ? {
            ...original,
            data: { ...original.data, name: call.data.name, detail: call.data.detail },
          }
        : snapshot;
    const failure =
      ['run_status', 'tool_result', 'stage'].includes(entry.kind) &&
      ['failed', 'interrupted'].includes(entry.data.status ?? '');
    if (
      entry.kind === 'user_question' ||
      entry.kind === 'message' ||
      entry.kind === 'text_delta' ||
      failure ||
      entry.data.feedback?.action === 'user'
    ) {
      groups.push({ kind: 'event', entry });
      continue;
    }
    const prior = groups.at(-1);
    if (prior?.kind === 'activity' && prior.entries[0].runId === entry.runId)
      prior.entries.push(entry);
    else groups.push({ kind: 'activity', entries: [entry], active: false });
  }
  const last = groups.at(-1);
  if (
    last?.kind === 'activity' &&
    activeRunId &&
    !finished.has(activeRunId) &&
    last.entries[0].runId === activeRunId
  )
    last.active = true;
  return groups;
}

/** 子 Agent 仅展示固定阶段、状态和受控工具；私有字段及不合法标识不回显。 */
function describeSubagent(data: Record<string, unknown>): string {
  const roles = { design: '设计分析', review: '代码审查', rule_scan: '规则扫描', ui: 'UI 实现' };
  const statuses = {
    started: '已开始',
    tool_started: '工具执行中',
    tool_completed: '工具已完成',
    tool_feedback: '工具需调整',
    tool_failed: '工具未完成',
    completed: '已完成',
    failed: '失败',
  };
  const role = knownKey(roles, data.role) ? roles[data.role] : '子 Agent';
  const status = knownKey(statuses, data.status) ? statuses[data.status] : '状态已更新';
  const agentId = text(data.agentId);
  const shortId =
    agentId.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
      ? ` · ${agentId.slice(0, 8)}`
      : '';
  const tool =
    ['tool_started', 'tool_completed', 'tool_feedback', 'tool_failed'].includes(
      text(data.status),
    ) &&
    (data.role === 'ui'
      ? ['list_files', 'read_file', 'write_file', 'figma', 'check_rules']
      : data.role === 'rule_scan'
        ? ['list_files', 'read_file', 'write_file', 'figma']
        : ['list_files', 'read_file']
    ).includes(text(data.tool))
      ? ` · ${data.tool}`
      : '';
  const detail =
    tool && typeof data.detail === 'string'
      ? ` · ${formatToolDetail(data.detail)
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, 512)}`
      : '';
  const codes = {
    INVALID_ARGUMENT: '参数不符合工具约定',
    FILE_WRITE_NOT_ALLOWED: '路径不允许写入',
    BLOCK_DIRECTORY_INVALID: '区块目录需要英文别名',
    RULES_FAILED: '本区块规则检查未通过，修复后重新检查',
    FILE_NOT_FOUND: '文件不存在',
    ADJUSTMENT_EXHAUSTED: '子任务纠错次数已用完，交回主 Agent',
    RETRY_EXHAUSTED: '子任务重试次数已用完，交回主 Agent',
  };
  const feedback = record(data.feedback);
  const reason = knownKey(codes, feedback.code) ? ` · ${codes[feedback.code]}` : '';
  return `${role}${shortId}${tool}：${status}${detail}${reason}`;
}

/** 页面展示已开放的文件、用户消息和排队状态，不渲染 HTML 或私有 SDK 数据。 */
export function describeEvent(entry: TimelineEntry) {
  const data = record(entry?.data);
  const kind = entry?.kind;
  if (kind === 'run_status') {
    const failure = getEventFailure(entry);
    if (failure)
      return failure.requiresUser
        ? `需要用户处理：${failure.message}`
        : `${failure.stage}${data.status === 'interrupted' ? '中断' : '失败'}：${failure.message}`;
    const statuses = {
      waiting_input: '等待回答业务问题',
      running: '后台执行已领取',
      stopping: '正在停止执行，已保存文件会保留',
      succeeded: '执行已完成',
      failed: '执行失败',
      cancelled: '本轮已结束',
      interrupted: '执行已中断，需要核对后恢复',
    };
    return knownKey(statuses, data.status) ? statuses[data.status] : '执行状态已更新';
  }
  if (kind === 'model_status') {
    const scopes = {
      generation: '模型调用',
      summary: '上下文摘要',
      design: '设计专家模型调用',
      review: '审查专家模型调用',
      rule_scan: '规则扫描模型调用',
      ui: 'UI 实现模型调用',
    };
    if (data.status === 'failed' && typeof data.retryAfterMs === 'number')
      return `${knownKey(scopes, data.scope) ? scopes[data.scope] : '模型调用'}：${data.rateLimited ? '请求受限' : '临时失败'}，${Math.ceil(data.retryAfterMs / 1000)}秒后重试（第${data.retryAttempt}次）`;
    const statuses = { started: '调用中', completed: '完成', failed: '失败' };
    const duration =
      data.status !== 'started' &&
      typeof data.durationMs === 'number' &&
      Number.isFinite(data.durationMs) &&
      data.durationMs >= 0
        ? ` · ${Number((data.durationMs / 1000).toFixed(1))} 秒`
        : '';
    const status =
      data.status === 'failed' && data.interrupted === true
        ? '已中断'
        : knownKey(statuses, data.status)
          ? statuses[data.status]
          : '状态更新';
    return `${knownKey(scopes, data.scope) ? scopes[data.scope] : '模型调用'}：${status}${duration}`;
  }
  if (kind === 'user_question')
    return `Agent 提问：${getPendingQuestion(data)?.question ?? '问题已失效'}`;
  if (kind === 'message' && data.role === 'user') return `${text(data.text)}`;
  if (kind === 'message' && data.role === 'assistant') return `Agent：${text(data.text)}`;
  if (kind === 'tool_call')
    return text(data.detail)
      ? `${text(data.name, '受控工具')} · ${formatToolDetail(data.detail)}`
      : `开始工具：${text(data.name, '受控工具')}`;
  if (kind === 'tool_result') {
    const target = text(data.name) || (text(data.callId) ? `调用 ${text(data.callId)}` : '');
    const suffix = target
      ? `：${target}${text(data.detail) ? ` · ${formatToolDetail(data.detail)}` : ''}`
      : '';
    const feedback = record(data.feedback);
    if (['adjust', 'retry', 'user'].includes(text(feedback.action))) {
      const label =
        feedback.action === 'adjust'
          ? '工具待纠正'
          : feedback.action === 'retry'
            ? '工具可重试'
            : '需要用户处理';
      return `${label}${suffix} · ${text(feedback.message, '请核对工具结果')}`;
    }
    if (data.status === 'failed')
      return `工具执行失败${suffix}，结果可能不完整；继续前请检查已保存产物`;
    if (data.status === 'interrupted')
      return `工具执行中断${suffix}，结果未知；继续前请检查已保存产物`;
    return `工具执行完成${suffix}`;
  }
  if (kind === 'stage') {
    if (data.stage === 'slices') {
      const phases: Record<string, string> = {
        starting: '开始切图',
        fetching: '获取设计节点',
        exporting: '导出并下载切图',
        saving: '保存切图产物',
      };
      return `prepare_slices · ${phases[String(data.phase)] ?? '切图中'} · 完成 ${data.completed ?? 0}/${data.total ?? 0}，失败 ${data.failed ?? 0}${Number(data.reused) > 0 ? `，复用 ${data.reused}` : ''}`;
    }
    if (data.stage === 'subagent') return describeSubagent(data);
    if (data.status === 'queued')
      return data.action === 'resume'
        ? data.automatic === true
          ? '系统已自动恢复任务，等待后台执行'
          : '已继续，等待后台执行'
        : '消息已入队，等待后台执行';
    if (data.status === 'cancelled') return '排队轮次已取消';
  }
  if (kind === 'version_changed')
    return `版本${data.status === 'ready' ? '暂存完成' : data.status === 'failed' ? '暂存失败' : '后台暂存中'}：${text(data.name, '未命名版本')}`;
  const actions = { created: '新增文件', updated: '修改文件', deleted: '删除文件' };
  const action = knownKey(actions, data.action) ? actions[data.action] : '文件变化';
  return kind === 'file_changed' ? `${action}：${text(data.path, '未知路径')}` : '收到会话事件';
}

/** 只接受公开问题结构，坏历史不能生成可提交的表单。 */
export function getPendingQuestion(value: unknown): PendingQuestion | null {
  const data = record(value);
  return typeof data.questionId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.questionId) &&
    typeof data.question === 'string' &&
    data.question.trim().length > 0 &&
    Array.isArray(data.options) &&
    data.options.every((option) => typeof option === 'string') &&
    (data.recommendedAnswer === undefined ||
      (typeof data.recommendedAnswer === 'string' &&
        data.recommendedAnswer.trim().length > 0 &&
        data.recommendedAnswer.length <= 2000))
    ? {
        questionId: data.questionId,
        question: data.question,
        options: data.options,
        ...(typeof data.recommendedAnswer === 'string'
          ? { recommendedAnswer: data.recommendedAnswer }
          : {}),
      }
    : null;
}

/** 按会话 seq 投影当前问题；历史提问只读，后续状态及终态使回答失效。 */
export function applySessionEvent(current: Session | null, entry: TimelineEntry): Session | null {
  if (!current || current.sessionId !== entry.sessionId || current.timelineSeq >= entry.seq)
    return current;
  const updated = {
    ...current,
    timelineSeq: entry.seq,
    ...(entry.kind === 'session_changed' && typeof entry.data.name === 'string'
      ? { name: entry.data.name }
      : {}),
    ...(entry.kind === 'file_changed' ? { validationState: { status: 'stale' } } : {}),
    ...(entry.kind === 'run_status' && entry.data.validation
      ? { validationState: entry.data.validation }
      : {}),
  };
  if (entry.kind === 'user_question' && entry.runId) {
    const question = getPendingQuestion(entry.data);
    if (question && (!current.activeRunId || current.activeRunId === entry.runId))
      return {
        ...updated,
        activeRunId: entry.runId,
        activeRunStatus: 'waiting_input',
        pendingQuestion: question,
      };
  }
  if (
    (entry.kind === 'run_status' || (entry.kind === 'stage' && entry.data.stage !== 'subagent')) &&
    entry.runId
  ) {
    if (
      ['queued', 'running', 'stopping', 'interrupted', 'waiting_input'].includes(
        entry.data.status ?? '',
      )
    )
      return {
        ...updated,
        activeRunId: entry.runId,
        activeRunStatus: entry.data.status,
        pendingQuestion:
          entry.data.status === 'waiting_input' && current.activeRunId === entry.runId
            ? current.pendingQuestion
            : null,
      };
    if (
      ['cancelled', 'succeeded', 'failed'].includes(entry.data.status ?? '') &&
      current.activeRunId === entry.runId
    )
      return { ...updated, activeRunId: null, activeRunStatus: null, pendingQuestion: null };
  }
  return updated;
}

/** 可信摘要也受 seq 约束，防止回答请求后的旧响应覆盖先到的 SSE 终态。 */
export function mergeSessionSnapshot(
  current: Session | null,
  incoming: Session,
  sessionId: string,
): Session | null {
  if (incoming.sessionId !== sessionId) return current;
  return !current || current.sessionId !== sessionId || incoming.timelineSeq >= current.timelineSeq
    ? incoming
    : current;
}

/** 诊断仅随执行过程变化刷新；正文、产物和重复补读不推进 revision。 */
export function diagnosticsRevision(entries: TimelineEntry[], previous = 0): number {
  return entries.reduce(
    (seq, entry) =>
      ['model_status', 'stage', 'run_status', 'tool_call', 'tool_result', 'user_question'].includes(
        entry.kind,
      )
        ? Math.max(seq, entry.seq)
        : seq,
    previous,
  );
}
