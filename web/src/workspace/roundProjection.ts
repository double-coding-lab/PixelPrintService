import { groupTimeline, mergeTimeline } from './timeline';
import type { TimelineEntry } from './types';

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export type ConversationRoundGroup = {
  key: string;
  entries: TimelineEntry[];
  active: boolean;
};

/** 仅顶层生命周期可决定整轮状态，子 Agent、切图和工具状态均不算结束。 */
function isLifecycle(entry: TimelineEntry): boolean {
  return (
    entry.kind === 'run_status' ||
    (entry.kind === 'stage' &&
      (entry.data.stage === undefined || ['queued', 'cancelled'].includes(entry.data.stage)))
  );
}

/** 使用持久化时间；缺失或非法时间不以当前时间、模型耗时等字段补造。 */
function timestamp(entry: TimelineEntry | undefined): number | null {
  if (!entry || typeof entry.at !== 'string' || !entry.at.trim()) return null;
  const value = Date.parse(entry.at);
  return Number.isFinite(value) ? value : null;
}

/** 面板通知只刷新对应视图；只有绑定轮次的文件事件进入执行过程。 */
function isConversationEvent(entry: TimelineEntry): boolean {
  return (
    entry.kind !== 'preview_changed' &&
    entry.kind !== 'version_changed' &&
    !(entry.kind === 'file_changed' && !entry.runId) &&
    !(entry.kind === 'stage' && entry.data.action === 'message_queue')
  );
}

/** 同会话同 runId 只产生一轮；无 runId 的旧记录各自隔离，不猜测归属。 */
export function groupConversationRounds(
  entries: TimelineEntry[],
  activeRunId: string | null,
): ConversationRoundGroup[] {
  const sessions = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    if (!isConversationEvent(entry)) continue;
    const list = sessions.get(entry.sessionId) ?? [];
    list.push(entry);
    sessions.set(entry.sessionId, list);
  }
  const groups = new Map<string, ConversationRoundGroup>();
  for (const [sessionId, list] of sessions) {
    for (const entry of mergeTimeline([], list, sessionId, Infinity)) {
      const key = JSON.stringify([sessionId, entry.runId || null, entry.runId ? null : entry.seq]);
      const group = groups.get(key) ?? { key, entries: [], active: false };
      group.entries.push(entry);
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    group.active =
      Boolean(activeRunId && group.entries[0].runId === activeRunId) &&
      group.entries.filter(isLifecycle).at(-1)?.data.status !== 'waiting_input' &&
      !group.entries.some(
        (entry) => isLifecycle(entry) && terminalStatuses.has(entry.data.status ?? ''),
      );
  }
  return [...groups.values()];
}

/** 投影一整轮：回复按时间保留，思考与工具日志归入过程；同流快照仍合并。 */
export function projectConversationRound(entries: TimelineEntry[], active: boolean) {
  const sessionId = entries[0]?.sessionId ?? '';
  const runId = entries[0]?.runId;
  const ordered = mergeTimeline(
    [],
    entries.filter(
      (entry) =>
        entry.sessionId === sessionId && entry.runId === runId && isConversationEvent(entry),
    ),
    sessionId,
    Infinity,
  );
  const terminal = ordered.find(
    (entry) => isLifecycle(entry) && terminalStatuses.has(entry.data.status ?? ''),
  );
  const latestStatus = ordered.filter(isLifecycle).at(-1)?.data.status;
  const running = active && !terminal && latestStatus !== 'waiting_input';
  const originals = new Map(ordered.map((entry) => [entry.seq, entry]));
  /** 复用流中断与工具配对投影，不沿用被模型回复打断的活动分组。 */
  const projected = groupTimeline(ordered, running ? (runId ?? null) : null)
    .flatMap((group) => (group.kind === 'event' ? [group.entry] : group.entries))
    /** 普通暂停和主动结束由轮次状态表达，聊天中省去重复的系统提示。 */
    .filter(
      (entry) =>
        !(
          entry.kind === 'run_status' &&
          ((entry.data.status === 'cancelled' && !entry.data.failure && !entry.data.feedback) ||
            (entry.data.status === 'interrupted' &&
              entry.data.failure?.code === 'WORKER_INTERRUPTED' &&
              entry.data.failure.requiresUser !== true))
        ),
    )
    .map((entry) => {
      /** 非生命周期阶段失败不能中断仍在执行的主回复。 */
      const original = originals.get(entry.seq);
      return running && entry.kind === 'text_delta' && original?.data.status === 'streaming'
        ? { ...entry, data: { ...entry.data, status: 'streaming' } }
        : entry;
    });
  const answer = [...projected]
    .reverse()
    .find(
      (entry) =>
        entry.kind === 'text_delta' ||
        (entry.kind === 'message' && entry.data.role === 'assistant'),
    );
  const foreground = projected.filter(
    (entry) =>
      entry.kind === 'text_delta' ||
      (entry.kind === 'message' && ['user', 'assistant'].includes(entry.data.role ?? '')) ||
      entry.kind === 'user_question' ||
      entry.data.feedback?.action === 'user' ||
      (isLifecycle(entry) &&
        ['failed', 'interrupted', 'cancelled'].includes(entry.data.status ?? '')),
  );
  const visible = new Set([...foreground, ...(answer ? [answer] : [])]);
  const process = projected.filter((entry) => !visible.has(entry));
  const queued = ordered.find((entry) => isLifecycle(entry) && entry.data.status === 'queued');
  const started =
    queued ??
    ordered.find((entry) => entry.kind === 'run_status' && entry.data.status === 'running');
  const startedAt = timestamp(started);
  const endedAt = timestamp(terminal);
  const durationMs =
    startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
  return {
    foreground,
    answer,
    process,
    active: running,
    status: terminal?.data.status ?? latestStatus,
    startedAt: startedAt === null ? null : started!.at,
    endedAt: endedAt === null ? null : terminal!.at,
    durationMs,
    durationOrigin: queued ? ('queued' as const) : started ? ('running' as const) : null,
  };
}

/** 小于一秒保留毫秒，整秒向下取整；未知耗时显式显示，不伪造零秒。 */
export function formatRoundDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '耗时未知';
  if (durationMs < 1000) return `${Math.floor(durationMs)} 毫秒`;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`;
}
