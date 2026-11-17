import type { TimelineEntry } from './types';
import { formatToolDetail } from './timeline';

const roles: Record<string, string> = {
  rule_scan: '扫描规则',
  ui: '生成区块代码',
  design: '分析设计稿',
  review: '检查代码',
};
const tools: Record<string, string> = {
  prepare_slices: '切图',
  read_file: '读取规则与资料',
  figma: '查看设计稿',
  write_file: '保存代码',
  edit_file: '局部修改代码',
  check_rules: '校验代码',
  build_preview: '构建预览',
  inspect_preview: '检查页面效果',
  delegate_agent: '执行子任务',
  wait_subagents: '等待子任务结果',
};

const rolePhases: Record<string, string> = {
  design: '分析设计稿',
  rule_scan: '扫描规则',
  ui: '生成代码',
  review: '校验代码',
};
const toolPhases: Record<string, string> = {
  figma: '分析设计稿',
  prepare_slices: '准备切图',
  write_file: '生成代码',
  edit_file: '调整代码',
  delete_file: '生成代码',
  check_rules: '校验代码',
  build_preview: '构建预览',
  inspect_preview: '检查页面效果',
};

/** 仅采用公开结构化切图字段，不解析 detail/text，不从零值或工具数量估算进度。 */
function sliceCounts(data: TimelineEntry['data']): string | undefined {
  if (
    data.stage !== 'slices' ||
    !['starting', 'fetching', 'exporting', 'saving'].includes(data.phase ?? '') ||
    !Number.isSafeInteger(data.total) ||
    data.total! <= 0 ||
    !Number.isSafeInteger(data.completed) ||
    data.completed! < 0 ||
    !Number.isSafeInteger(data.failed) ||
    data.failed! < 0 ||
    data.completed! + data.failed! > data.total! ||
    (data.reused !== undefined &&
      (!Number.isSafeInteger(data.reused) || data.reused < 0 || data.reused > data.completed!))
  )
    return;
  return `成功 ${data.completed}/${data.total} · 失败 ${data.failed}${
    data.reused === undefined ? '' : ` · 复用 ${data.reused}`
  }`;
}

/** 最近业务阶段跨通用动作保留；活跃子角色优先，并列展示实际并行任务。 */
function businessActivity(ordered: TimelineEntry[]): { phase?: string; progress?: string } {
  const children = new Map<string, string>();
  const ended = new Set<string>();
  const calls = new Map<string, string>();
  let phase: string | undefined;
  let progress: string | undefined;
  let slicesClosed = false;
  /** 切换阶段立即清理切图数量，后续读取或模型事件不能重新带出旧数量。 */
  function remember(next: string) {
    phase = next;
    if (next !== toolPhases.prepare_slices && ![...calls.values()].includes('prepare_slices')) {
      progress = undefined;
      slicesClosed = true;
    }
  }
  for (const { kind, data } of ordered) {
    if (kind === 'stage' && data.stage === 'subagent' && data.agentId) {
      const next = Object.hasOwn(rolePhases, data.role ?? '')
        ? rolePhases[data.role!]
        : children.get(data.agentId);
      if (['completed', 'failed'].includes(data.status ?? '')) {
        if (!ended.has(data.agentId) && next) remember(next);
        children.delete(data.agentId);
        ended.add(data.agentId);
      } else {
        if (data.status === 'started') ended.delete(data.agentId);
        if (!ended.has(data.agentId) && next) {
          children.set(data.agentId, next);
          remember(next);
        }
      }
    }
    if ((kind === 'tool_call' || kind === 'tool_result') && data.callId) {
      const name = data.name ?? calls.get(data.callId);
      if (kind === 'tool_call' && name) calls.set(data.callId, name);
      if (name && Object.hasOwn(toolPhases, name)) {
        remember(toolPhases[name]);
        if (name === 'prepare_slices') {
          slicesClosed = kind === 'tool_result';
          progress = undefined;
        }
      }
      if (kind === 'tool_result') calls.delete(data.callId);
    }
    if (
      kind === 'stage' &&
      data.stage === 'slices' &&
      ['starting', 'fetching', 'exporting', 'saving'].includes(data.phase ?? '') &&
      !slicesClosed
    ) {
      remember(toolPhases.prepare_slices);
      progress = sliceCounts(data);
    }
  }
  const activePhases = [
    ...new Set([
      ...children.values(),
      ...[...calls.values()]
        .filter((name) => Object.hasOwn(toolPhases, name))
        .map((name) => toolPhases[name]),
    ]),
  ];
  if (activePhases.length)
    return {
      phase: activePhases.join('、'),
      ...(activePhases.includes(toolPhases.prepare_slices) && progress ? { progress } : {}),
    };
  return phase
    ? { phase, ...(phase === toolPhases.prepare_slices && progress ? { progress } : {}) }
    : {};
}

/** 只展示已公开的动作摘要和助手说明，不解析思考内容或猜测设计版块。 */
function activityContext(ordered: TimelineEntry[]) {
  const pending = new Map<string, string>();
  const calls = new Map<string, TimelineEntry>();
  const models = new Map<string, string>();
  let target: string | undefined;
  let note: string | undefined;
  let saved: { path: string; at: string } | undefined;
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240);
  for (const entry of ordered) {
    const { kind, data } = entry;
    if (kind === 'message' && data.role === 'assistant' && data.text?.trim())
      note = clean(data.text.replace(/[`#*]/g, ''));
    if (kind === 'tool_call' && data.callId) {
      calls.set(data.callId, entry);
      const detail = formatToolDetail(data.detail).trim() || data.path;
      if (detail) {
        target = clean(detail);
        pending.set(data.callId, target);
      }
    }
    if (kind === 'tool_result' && data.callId) {
      const call = calls.get(data.callId);
      pending.delete(data.callId);
      const name = data.name ?? call?.data.name;
      if (
        ['write_file', 'edit_file'].includes(name ?? '') &&
        !data.failure &&
        !data.feedback &&
        !data.interrupted
      ) {
        const detail = data.detail || call?.data.detail;
        const path =
          data.path ||
          call?.data.path ||
          detail?.match(/(?:写入文件|保存文件|局部修改文件)[：:]\s*(.+)/)?.[1];
        if (path) saved = { path: clean(path), at: entry.at };
      }
    }
    if (kind === 'stage' && data.stage === 'subagent' && data.agentId) {
      const key = `agent:${data.agentId}`;
      if (['completed', 'failed'].includes(data.status ?? '')) pending.delete(key);
      else if (data.detail?.trim()) {
        target = clean(formatToolDetail(data.detail));
        pending.set(key, target);
      }
    }
    if (kind === 'model_status' && data.operationId) {
      if (data.status === 'started') models.set(data.operationId, entry.at);
      else if (['completed', 'failed'].includes(data.status ?? '')) models.delete(data.operationId);
    }
  }
  const activeTargets = [...new Set(pending.values())];
  return {
    target: activeTargets.length ? activeTargets.slice(0, 2).join('；') : undefined,
    recentAction: target,
    note,
    saved,
    modelStartedAt: [...models.values()].sort()[0],
  };
}

/** 从当前轮次真实事件投影进行中的工作；不生成助手消息，也不推断完成结果。 */
export function currentActivity(entries: TimelineEntry[]) {
  const first = entries[0];
  const ordered = entries
    .filter((entry) => entry.sessionId === first?.sessionId && entry.runId === first?.runId)
    .sort((a, b) => a.seq - b.seq);
  const children = new Map<string, { agentId: string; label: string }>();
  const ended = new Set<string>();
  const pendingTools = new Map<string, string>();
  const pendingModels = new Map<string, string>();
  const waitingRetry = new Set<string>();
  for (const entry of ordered) {
    const data = entry.data;
    if (entry.kind === 'stage' && data.stage === 'subagent' && data.agentId) {
      if (['completed', 'failed'].includes(data.status ?? '')) {
        children.delete(data.agentId);
        ended.add(data.agentId);
      } else {
        if (data.status === 'started') ended.delete(data.agentId);
        if (!ended.has(data.agentId))
          children.set(data.agentId, {
            agentId: data.agentId,
            label: roles[data.role ?? ''] ?? '执行子任务',
          });
      }
    }
    if (entry.kind === 'tool_call' && data.callId)
      pendingTools.set(data.callId, tools[data.name ?? ''] ?? '执行工具');
    if (entry.kind === 'tool_result' && data.callId) pendingTools.delete(data.callId);
    if (entry.kind === 'model_status' && data.operationId) {
      if (data.status === 'started') {
        waitingRetry.delete(data.scope ?? 'generation');
        pendingModels.set(data.operationId, data.scope ?? 'generation');
      } else if (['completed', 'failed'].includes(data.status ?? ''))
        pendingModels.delete(data.operationId);
      if (data.status === 'failed' && typeof data.retryAfterMs === 'number')
        waitingRetry.add(data.scope ?? 'generation');
    }
  }
  const agents = [...children.values()];
  const work = [
    ...new Set([
      ...agents.map((agent) => agent.label),
      ...[...pendingTools.values()].filter((name) => name !== '执行子任务' || !agents.length),
    ]),
  ];
  let label = work.length ? `正在${work.join('、')}` : '正在处理';
  if (pendingModels.size) {
    const scopes = [...pendingModels.values()];
    if (!work.length) label = scopes.includes('summary') ? '正在整理上下文' : '正在等待模型回复';
    else label += ' · 等待模型回复';
  }
  if (waitingRetry.size && !pendingModels.size) label += ' · 等待自动重试';
  return {
    label,
    agents,
    at: ordered.at(-1)?.at,
    ...businessActivity(ordered),
    ...activityContext(ordered),
  };
}

export type CurrentActivity = ReturnType<typeof currentActivity>;
