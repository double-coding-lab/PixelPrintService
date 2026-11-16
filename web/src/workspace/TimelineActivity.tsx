import { formatTime } from './time';
import { revealPagedContent } from './pagedContent';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeEvent } from './timeline';
import type { TimelineEntry } from './types';
import SubagentPanel from './SubagentPanel';
import ReasoningDetails from './ReasoningDetails';
import type { CurrentActivity } from './currentActivity';

/** 子会话每轮只保留一个入口；工具与模型按调用编号合并，不改变原始事件。 */
export function compactActivityEntries(entries: TimelineEntry[]) {
  const rows: TimelineEntry[] = [];
  const agents = new Map<string, number>();
  const tools = new Map<string, number>();
  const models = new Map<string, number>();
  const duplicates = new Set<string>();
  const childScopes = new Set(
    entries.filter((entry) => entry.data.stage === 'subagent').map((entry) => entry.data.role),
  );
  for (const entry of entries) {
    if (entry.kind === 'model_status' && entry.data.scope && childScopes.has(entry.data.scope))
      continue;
    if (
      entry.kind === 'model_status' &&
      entry.runId &&
      entry.data.operationId &&
      ['started', 'completed', 'failed'].includes(entry.data.status ?? '')
    ) {
      const key = JSON.stringify([
        entry.sessionId,
        entry.runId,
        entry.data.scope,
        entry.data.operationId,
      ]);
      const index = models.get(key);
      if (index === undefined) {
        models.set(key, rows.length);
        rows.push(entry);
      } else if (entry.data.status !== 'started') {
        rows[index] = { ...rows[index], data: { ...rows[index].data, ...entry.data } };
      }
      continue;
    }
    if (entry.kind === 'stage' && entry.data.stage === 'subagent' && entry.data.agentId) {
      const key = JSON.stringify([entry.sessionId, entry.runId, entry.data.agentId]);
      const index = agents.get(key);
      const lifecycle = ['started', 'completed', 'failed'].includes(entry.data.status ?? '');
      if (index === undefined) {
        agents.set(key, rows.length);
        rows.push({
          ...entry,
          data: {
            stage: 'subagent',
            agentId: entry.data.agentId,
            role: entry.data.role,
            ...(lifecycle ? { status: entry.data.status } : {}),
          },
        });
      } else if (lifecycle) {
        rows[index] = { ...rows[index], data: { ...rows[index].data, status: entry.data.status } };
      }
      continue;
    }
    const callId = entry.data.callId;
    const key = callId ? JSON.stringify([entry.sessionId, entry.runId, callId]) : '';
    if (key && entry.kind === 'tool_call') {
      if (tools.has(key)) {
        duplicates.add(key);
        tools.delete(key);
      } else if (!duplicates.has(key)) tools.set(key, rows.length);
    }
    if (key && entry.kind === 'tool_result' && tools.has(key)) {
      const index = tools.get(key)!;
      rows[index] = {
        ...rows[index],
        kind: 'tool_result',
        data: { ...rows[index].data, ...entry.data },
      };
      tools.delete(key);
    } else rows.push(entry);
  }
  return rows;
}

/** 过程默认收起，展开状态由用户控制；实时更新及执行完成均保持当前选择。 */
export default function TimelineActivity({
  entries,
  active,
  onLayoutChange,
  revision,
  summary,
  summaryTitle,
  current,
}: {
  entries: TimelineEntry[];
  active: boolean;
  onLayoutChange: () => void;
  /** 可由调用方传入全会话 seq，让跨活动组的同一 Agent 也能刷新。 */
  revision?: number;
  /** 整轮模式将真实耗时作为唯一过程入口，不重复堆叠活动标题。 */
  summary?: string;
  summaryTitle?: string;
  current?: CurrentActivity;
}) {
  const visibleEntries = compactActivityEntries(entries);
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [selected, setSelected] = useState<{ sessionId: string; agentId: string } | null>(null);
  const sessionId = entries[0]?.sessionId ?? '';
  const refreshRevision = revision ?? entries.reduce((seq, entry) => Math.max(seq, entry.seq), 0);
  useEffect(() => setSelected(null), [sessionId]);
  /** 每次展开先显示最新过程；展开后向上阅读时保留用户位置。 */
  useLayoutEffect(() => {
    if (!expanded || !list.current) return;
    const revealSeq = root.current?.dataset.pageRevealSeq;
    if (root.current) delete root.current.dataset.pageRevealSeq;
    const target = revealSeq
      ? list.current.querySelector<HTMLElement>(`[data-entry-seq="${revealSeq}"]`)
      : null;
    if (target) revealPagedContent(list.current, target);
    else list.current.scrollTop = list.current.scrollHeight;
  }, [expanded]);
  useEffect(() => {
    const element = root.current;
    const viewport = element?.closest('ol');
    if (!element || !viewport) return;
    /** 以实际对话滚动窗口为上限，兼容分栏、缩放和全屏后的尺寸变化。 */
    function resize() {
      const header = element!.querySelector('summary')?.getBoundingClientRect().height ?? 32;
      element!.style.setProperty(
        '--conversation-process-max-height',
        `${Math.max(0, viewport!.clientHeight - header - 16)}px`,
      );
    }
    resize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    const header = element.querySelector('summary');
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <details
        ref={root}
        className={`timeline-activity conversation-process${active ? ' is-active' : ''}`}
        open={expanded}
        onToggle={(event) => {
          setExpanded(event.currentTarget.open);
          onLayoutChange();
        }}
      >
        <summary title={summaryTitle}>
          <span className="activity-marker" aria-hidden="true" />
          <span>{summary ?? (active ? '正在处理' : '执行过程')}</span>
        </summary>
        <ul ref={list} className="activity-entries" aria-label="执行过程详情" tabIndex={0}>
          {visibleEntries.map((entry) => (
            <li
              data-entry-seq={entry.seq}
              key={
                entry.kind === 'reasoning_delta'
                  ? JSON.stringify([entry.sessionId, entry.runId, 'reasoning', entry.data.streamId])
                  : entry.seq
              }
            >
              <time>{formatTime(entry.at)}</time>
              {entry.kind === 'reasoning_delta' ? (
                <ReasoningDetails text={entry.data.text ?? ''} status={entry.data.status} />
              ) : (
                <span className="subagent-activity-description">{describeEvent(entry)}</span>
              )}
              {entry.kind === 'stage' &&
                entry.data.stage === 'subagent' &&
                typeof entry.data.agentId === 'string' &&
                entry.data.agentId && (
                  <button
                    type="button"
                    className="subagent-view"
                    aria-label={`查看子 Agent ${entry.data.agentId} 会话`}
                    onClick={() =>
                      setSelected({ sessionId: entry.sessionId, agentId: entry.data.agentId! })
                    }
                  >
                    查看会话
                  </button>
                )}
            </li>
          ))}
          {!entries.length && <li>没有保存执行过程记录</li>}
        </ul>
      </details>
      {active && current && (
        <div className="conversation-current-activity" role="status" aria-live="polite">
          <span>{current.label}</span>
          {current.at && Number.isFinite(Date.parse(current.at)) && (
            <time dateTime={current.at}>更新于 {formatTime(current.at)}</time>
          )}
          {current.agents.map((agent, index) => (
            <button
              type="button"
              className="subagent-view"
              key={agent.agentId}
              onClick={() => setSelected({ sessionId, agentId: agent.agentId })}
            >
              查看{agent.label}
              {current.agents.filter((other) => other.label === agent.label).length > 1
                ? ` ${index + 1}`
                : ''}
            </button>
          ))}
        </div>
      )}
      <SubagentPanel
        sessionId={sessionId}
        agentId={selected?.agentId ?? ''}
        open={selected?.sessionId === sessionId}
        revision={refreshRevision}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
