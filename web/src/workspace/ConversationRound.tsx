import { formatTime } from './time';
import React, { type ReactNode } from 'react';
import TimelineActivity from './TimelineActivity';
import { formatRoundDuration, projectConversationRound } from './roundProjection';
import type { TimelineEntry } from './types';
import { currentActivity } from './currentActivity';

/** 渲染整轮的可见结果；调用方提供正文 renderer，避免依赖 SessionPanel。 */
export default function ConversationRound({
  entries,
  active,
  onLayoutChange,
  revision,
  renderMessage,
}: {
  entries: TimelineEntry[];
  active: boolean;
  onLayoutChange: () => void;
  revision?: number;
  renderMessage: (entry: TimelineEntry) => ReactNode;
}) {
  const round = projectConversationRound(entries, active);
  if (!entries.length || (!round.answer && !round.foreground.length && !round.process.length))
    return null;
  const duration = formatRoundDuration(round.durationMs);
  const statuses: Record<string, string> = {
    succeeded: '已完成',
    failed: '执行失败',
    interrupted: '已暂停',
    cancelled: '已结束',
    waiting_input: '等待回答',
    queued: '等待执行',
  };
  const label = round.active
    ? '正在处理'
    : `${statuses[round.status ?? ''] ?? '执行过程'} · ${duration}`;
  const timing =
    round.startedAt && round.endedAt
      ? `${round.durationOrigin === 'queued' ? '入队' : '开始执行'} ${round.startedAt} → 结束 ${round.endedAt}；包含期间的等待时间`
      : '缺少完整的轮次起止时间，无法计算耗时';

  /** 复用既有消息样式，renderer 只返回正文；每个事件仍是外层 ol 的直接 li。 */
  function message(entry: TimelineEntry) {
    const isMessage = entry.kind === 'message' || entry.kind === 'text_delta';
    const key =
      isMessage && entry.data.streamId && entry.data.role !== 'user'
        ? JSON.stringify([entry.sessionId, entry.runId, entry.data.streamId, 'assistant'])
        : entry.entryId;
    const at = Date.parse(entry.at);
    return (
      <li
        key={key}
        data-entry-seq={entry.seq}
        className={
          isMessage
            ? `event-message ${entry.data.role === 'user' ? 'from-user' : 'from-agent'}`
            : 'event-activity'
        }
      >
        <div className="event-meta">
          <span>
            {isMessage
              ? entry.data.role === 'user'
                ? entry.data.authorUserId || '你'
                : 'PixelPrint'
              : `#${entry.seq}`}
          </span>
          <time dateTime={Number.isFinite(at) ? entry.at : undefined}>{formatTime(entry.at)}</time>
        </div>
        {renderMessage(entry)}
      </li>
    );
  }

  const process = (
    <li
      key="process"
      className="event-process conversation-round-process"
      data-page-first={entries[0].seq}
      data-page-last={entries.at(-1)!.seq}
    >
      <TimelineActivity
        key={JSON.stringify([entries[0].sessionId, entries[0].runId ?? entries[0].seq])}
        entries={round.process}
        active={round.active}
        revision={revision}
        onLayoutChange={onLayoutChange}
        summary={label}
        summaryTitle={round.active ? '点击查看本轮执行过程' : timing}
        current={round.active ? currentActivity(entries) : undefined}
      />
    </li>
  );
  const hasRun = Boolean(entries[0].runId);
  const isReply = (entry: TimelineEntry) =>
    entry.kind === 'text_delta' || (entry.kind === 'message' && entry.data.role === 'assistant');
  const replies = round.foreground.filter(isReply);
  const folded = new Set(replies.slice(0, -2).map((entry) => entry.entryId));
  const messages: ReactNode[] = [];
  let older: TimelineEntry[] = [];
  /** 连续的较早正文共用一个折叠入口，用户消息与错误仍保持原来的时间顺序。 */
  function flushOlder() {
    if (!older.length) return;
    const group = older;
    older = [];
    messages.push(
      <li className="event-reply-history" key={`history:${group[0].entryId}`}>
        <details onToggle={onLayoutChange}>
          <summary>较早回复 · {group.length} 条</summary>
          <ol>{group.map(message)}</ol>
        </details>
      </li>,
    );
  }
  let processAdded = false;
  for (const entry of round.foreground) {
    if (hasRun && !processAdded && isReply(entry)) {
      messages.push(process);
      processAdded = true;
    }
    if (folded.has(entry.entryId)) older.push(entry);
    else {
      flushOlder();
      messages.push(message(entry));
    }
  }
  flushOlder();
  if (hasRun && !processAdded) messages.push(process);
  return <>{messages}</>;
}
