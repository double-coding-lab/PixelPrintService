import React, { useEffect, useState } from 'react';
import { formatTime } from './time';
import { currentActivity } from './currentActivity';
import type { TimelineEntry } from './types';

/** 输入区常驻进度只使用当前轮次的真实事件，恢复时不借用上一轮的阶段。 */
export default function ExecutionProgress({
  entries,
  runId,
  status,
}: {
  entries: TimelineEntry[];
  runId?: string | null;
  status?: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!runId || status !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runId, status]);
  if (!runId || ['succeeded', 'failed', 'cancelled'].includes(status ?? '')) return null;
  const current = currentActivity(entries.filter((entry) => entry.runId === runId));
  const states: Record<string, string> = {
    queued: '等待执行',
    stopping: '正在暂停',
    interrupted: '已暂停',
    waiting_input: '等待你的回答',
  };
  const settled = states[status ?? ''];
  const phase = settled || current.phase || '执行中';
  const detail = settled
    ? ''
    : [current.label === `正在${phase}` ? '' : current.label, current.progress]
        .filter(Boolean)
        .join(' · ');
  const waitingAt = current.modelStartedAt ? Date.parse(current.modelStartedAt) : NaN;
  const seconds = Number.isFinite(waitingAt)
    ? Math.max(0, Math.floor((now - waitingAt) / 1000))
    : 0;
  const wait = seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
  return (
    <div className="execution-progress" role="status" aria-live="polite" aria-label="当前执行阶段">
      <span className="execution-progress-dot" aria-hidden="true" />
      <div className="execution-progress-content">
        <div className="execution-progress-heading">
          <strong>{settled || current.target || phase}</strong>
          {detail && <span>{detail}</span>}
          {!settled && Number.isFinite(waitingAt) && <span>模型处理中 · 已等待 {wait}</span>}
        </div>
        {!settled && current.note && (
          <div className="execution-progress-note" title={current.note}>
            Agent 工作说明：{current.note}
          </div>
        )}
        {!settled && !current.target && !current.note && current.recentAction && (
          <div className="execution-progress-note">最近操作：{current.recentAction}</div>
        )}
        {!settled && current.saved && (
          <div className="execution-progress-file" title={current.saved.path}>
            最近已保存：{current.saved.path} · {formatTime(current.saved.at)}
          </div>
        )}
      </div>
    </div>
  );
}
