import { useContext } from 'react';
import { SessionReadRoot } from './sharing';
import { formatTime } from './time';
import { revealPagedContent } from './pagedContent';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Spin } from 'antd';
import MarkdownMessage from '../components/MarkdownMessage';
import { data, id } from './api';
import type { TimelineEntry } from './types';
import { formatToolDetail } from './timeline';

export type SubagentEntry = TimelineEntry & {
  data: TimelineEntry['data'] & Record<string, unknown>;
};
export type SubagentPage = {
  agentId: string;
  entries: SubagentEntry[];
  nextSeq: number;
  hasMore: boolean;
};
type Snapshot = SubagentPage & { loading: boolean; error: string };

/** 只接受当前会话、当前子 Agent 的公开阶段记录，按 seq 去重排序。 */
export function mergeSubagentEntries(
  current: SubagentEntry[],
  incoming: SubagentEntry[],
  sessionId: string,
  agentId: string,
) {
  const entries = new Map<number, SubagentEntry>();
  for (const entry of [...current, ...incoming]) {
    if (
      entry?.sessionId === sessionId &&
      entry.kind === 'stage' &&
      entry.data?.stage === 'subagent' &&
      entry.data.agentId === agentId &&
      Number.isSafeInteger(entry.seq) &&
      entry.seq > 0
    )
      entries.set(entry.seq, entry);
  }
  const ordered = [...entries.values()].sort((a, b) => a.seq - b.seq);
  const streams = new Map<string, SubagentEntry>();
  for (const entry of ordered) {
    const reasoning = entry.data.reasoning;
    if (entry.data.status !== 'reasoning' || !reasoning) continue;
    const key = JSON.stringify([entry.runId, reasoning.streamId]);
    const prior = streams.get(key)?.data.reasoning;
    if (reasoning.status !== 'streaming' || !prior || prior.status === 'streaming')
      streams.set(key, entry);
  }
  return ordered.filter(
    (entry) =>
      entry.data.status !== 'reasoning' ||
      streams.get(JSON.stringify([entry.runId, entry.data.reasoning?.streamId])) === entry,
  );
}

/** 沿用同源请求封装，路径分别编码，游标始终使用后端 nextSeq。 */
export async function readSubagentPage(
  sessionId: string,
  agentId: string,
  afterSeq: number,
  signal: AbortSignal,
  root = `/sessions/${id(sessionId)}`,
): Promise<SubagentPage> {
  const page = await data<SubagentPage>(
    `${root}/subagents/${id(agentId)}/events?afterSeq=${afterSeq}&limit=500`,
    { signal },
  );
  if (
    page?.agentId !== agentId ||
    !Array.isArray(page.entries) ||
    !Number.isSafeInteger(page.nextSeq) ||
    page.nextSeq < afterSeq ||
    typeof page.hasMore !== 'boolean' ||
    (page.hasMore && page.nextSeq === afterSeq)
  )
    throw new Error('子 Agent 会话响应无效');
  return page;
}

/** 每次打开独立读取；忙碌期间合并一次事件刷新，关闭后连忽略 abort 的响应也丢弃。 */
export function createSubagentReader(
  sessionId: string,
  agentId: string,
  notify: (snapshot: Snapshot) => void,
  read = readSubagentPage,
) {
  let snapshot: Snapshot = {
    agentId,
    entries: [],
    nextSeq: 0,
    hasMore: false,
    loading: false,
    error: '',
  };
  let disposed = false;
  let pending = false;
  const controller = new AbortController();
  /** 顺序追加一页，分页和刷新共用游标，避免并发请求相互覆盖。 */
  async function load() {
    if (disposed) return;
    if (snapshot.loading) {
      pending = true;
      return;
    }
    snapshot = { ...snapshot, loading: true, error: '' };
    notify(snapshot);
    try {
      const page = await read(sessionId, agentId, snapshot.nextSeq, controller.signal);
      if (disposed) return;
      snapshot = {
        ...page,
        entries: mergeSubagentEntries(snapshot.entries, page.entries, sessionId, agentId),
        loading: false,
        error: '',
      };
    } catch {
      if (disposed) return;
      snapshot = { ...snapshot, loading: false, error: '子 Agent 会话读取失败，请重试。' };
    }
    notify(snapshot);
    if (pending) {
      pending = false;
      void load();
    }
  }
  return {
    load,
    dispose() {
      disposed = true;
      pending = false;
      controller.abort();
    },
  };
}

const roles: Record<string, string> = {
  rule_scan: '规则扫描',
  ui: '区块实现',
  design: '设计分析',
  review: '代码审查',
};

/** 将同一 callId 的开始和结果配对，保留首次出现顺序以及缺失结果的真实状态。 */
export function compactSubagentTools(entries: SubagentEntry[]) {
  const tools = new Map<string, SubagentEntry>();
  for (const entry of entries) {
    if (!String(entry.data.status).startsWith('tool_')) continue;
    const key = typeof entry.data.callId === 'string' ? entry.data.callId : `seq:${entry.seq}`;
    const prior = tools.get(key);
    tools.set(
      key,
      prior ? { ...entry, seq: prior.seq, data: { ...prior.data, ...entry.data } } : entry,
    );
  }
  return [...tools.values()];
}

/** 只格式化已保存的时间，不用当前时间填补历史缺口。 */
function eventTime(at: string) {
  return formatTime(at);
}

/** 工具名称和状态直接展示，参数及错误详情按需展开。 */
function SubagentTool({ entry, hasMore }: { entry: SubagentEntry; hasMore: boolean }) {
  const status = entry.data.status;
  const label =
    status === 'tool_completed'
      ? '已完成'
      : status === 'tool_failed'
        ? '未完成'
        : status === 'tool_feedback'
          ? '需调整'
          : hasMore
            ? '结果待加载'
            : '未记录结果';
  return (
    <details className="subagent-tool" data-status={status} data-entry-seq={entry.seq}>
      <summary>
        <code>{String(entry.data.tool ?? '工具')}</code>
        <span className="subagent-tool-detail" title={formatToolDetail(entry.data.detail)}>
          {formatToolDetail(entry.data.detail)}
        </span>
        <span className="subagent-tool-state">{label}</span>
      </summary>
      <div className="subagent-tool-meta">
        <time dateTime={entry.at}>{eventTime(entry.at)}</time>
        {typeof entry.data.detail === 'string' && <p>{entry.data.detail}</p>}
        {typeof entry.data.callId === 'string' && <code>调用 {entry.data.callId}</code>}
        {typeof entry.data.feedback?.message === 'string' && (
          <p className="subagent-feedback">{entry.data.feedback.message}</p>
        )}
      </div>
    </details>
  );
}

/** 思考与工具合为一个处理过程，回复独立展示；手动补读定位新增记录。 */
export function SubagentTranscript({
  entries,
  hasMore = false,
  revealAfterSeq,
}: {
  entries: SubagentEntry[];
  hasMore?: boolean;
  revealAfterSeq?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [processExpanded, setProcessExpanded] = useState(false);
  /** 主动展开显示最新记录，分页展开则保留新增记录的定位。 */
  useLayoutEffect(() => {
    if (!processExpanded) return;
    const details = root.current?.querySelector<HTMLDetailsElement>('.subagent-processing');
    const list = details?.querySelector<HTMLElement>('.subagent-processing-list');
    if (!details || !list) return;
    const seq = details.dataset.pageRevealSeq;
    delete details.dataset.pageRevealSeq;
    const target = seq ? list.querySelector<HTMLElement>(`[data-entry-seq="${seq}"]`) : null;
    if (target) revealPagedContent(list, target);
    else list.scrollTop = list.scrollHeight;
  }, [processExpanded]);
  const revealed = useRef<number | undefined>(undefined);
  /** 手动补读打开新增工具所在分组，并定位内层列表；实时追加不抢历史阅读位置。 */
  useLayoutEffect(() => {
    if (revealAfterSeq === undefined || revealed.current === revealAfterSeq) return;
    const added = entries.find((entry) => entry.seq > revealAfterSeq);
    const viewport = root.current?.closest<HTMLElement>('.ant-drawer-body');
    if (!added || !viewport || !root.current) return;
    const tool = compactSubagentTools(entries).find((entry) =>
      added.data.callId ? entry.data.callId === added.data.callId : entry.seq === added.seq,
    );
    const target =
      root.current.querySelector<HTMLElement>(`[data-entry-seq="${tool?.seq ?? added.seq}"]`) ??
      root.current.querySelector<HTMLElement>('.subagent-overview');
    if (target) {
      follow.current = false;
      revealPagedContent(viewport, target);
    }
    revealed.current = revealAfterSeq;
  }, [entries, revealAfterSeq]);
  useEffect(() => {
    const viewport = root.current?.closest('.ant-drawer-body');
    if (!viewport) return;
    const scroll = () => {
      follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    };
    viewport.addEventListener('scroll', scroll, { passive: true });
    return () => viewport.removeEventListener('scroll', scroll);
  }, []);
  useEffect(() => {
    const viewport = root.current?.closest('.ant-drawer-body');
    if (viewport && follow.current) viewport.scrollTop = viewport.scrollHeight;
  }, [entries]);
  const started = entries.find((entry) => entry.data.status === 'started');
  const terminal = [...entries]
    .reverse()
    .find((entry) => ['completed', 'failed'].includes(String(entry.data.status)));
  const role = roles[String(started?.data.role ?? entries[0]?.data.role)] ?? '子 Agent';
  const status =
    terminal?.data.status === 'completed'
      ? '已完成'
      : terminal
        ? '执行失败'
        : hasMore
          ? '记录待加载'
          : started
            ? '已开始'
            : '历史记录';
  const paths = Array.isArray(started?.data.writePaths)
    ? started.data.writePaths.filter((path): path is string => typeof path === 'string')
    : [];
  const allTools = compactSubagentTools(entries);
  const toolsBySeq = new Map(allTools.map((entry) => [entry.seq, entry]));
  const rows: Array<
    | { kind: 'message'; entry: SubagentEntry; message: { role: string; text: string } }
    | { kind: 'tools'; entries: SubagentEntry[] }
    | { kind: 'reasoning'; entry: SubagentEntry }
  > = [];
  for (const entry of entries) {
    const message = entry.data.message as { role?: unknown; text?: unknown } | undefined;
    if (entry.data.status === 'reasoning' && entry.data.reasoning) {
      rows.push({ kind: 'reasoning', entry });
    } else if (
      message &&
      ['user', 'assistant'].includes(String(message.role)) &&
      typeof message.text === 'string'
    ) {
      rows.push({
        kind: 'message',
        entry,
        message: { role: String(message.role), text: message.text },
      });
    } else if (toolsBySeq.has(entry.seq)) {
      const tool = toolsBySeq.get(entry.seq)!;
      const last = rows.at(-1);
      if (last?.kind === 'tools') last.entries.push(tool);
      else rows.push({ kind: 'tools', entries: [tool] });
    }
  }
  const hasMessages = rows.some((row) => row.kind === 'message');
  const firstProcess = rows.findIndex((row) => row.kind !== 'message');
  const processRows = rows.filter((row) => row.kind !== 'message');
  return (
    <div className="subagent-transcript" ref={root}>
      <div className="subagent-overview">
        <strong>{role}</strong>
        <span data-status={terminal?.data.status}>{status}</span>
        {started && <time dateTime={started.at}>{eventTime(started.at)}</time>}
      </div>
      {terminal?.data.status === 'failed' &&
        typeof terminal.data.feedback?.message === 'string' && (
          <Alert type="error" showIcon title={terminal.data.feedback.message} />
        )}
      {(paths.length > 0 || typeof started?.data.nodeId === 'string') && (
        <details className="subagent-scope" open>
          <summary>
            写入范围 <span>{paths.length} 个文件</span>
          </summary>
          {typeof started?.data.nodeId === 'string' && <p>节点：{started.data.nodeId}</p>}
          <ul>
            {paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!hasMessages && (
        <p className="subagent-empty">
          {entries.length
            ? '这些记录没有保存可见对话，以下展示已有执行过程。'
            : '暂无会话记录；部分历史任务可能只保存了工具过程。'}
        </p>
      )}
      <ol aria-label="子 Agent 会话与工具过程">
        {rows.map((row, index) =>
          row.kind !== 'message' ? (
            index === firstProcess ? (
              <li key="process" className="subagent-process">
                <details
                  className="subagent-processing"
                  open={processExpanded}
                  onToggle={(event) => setProcessExpanded(event.currentTarget.open)}
                >
                  <summary>处理过程</summary>
                  <div className="subagent-processing-list">
                    {processRows.map((item) =>
                      item.kind === 'tools' ? (
                        item.entries.map((entry) => (
                          <SubagentTool key={`tool:${entry.seq}`} entry={entry} hasMore={hasMore} />
                        ))
                      ) : (
                        <section
                          className="subagent-reasoning"
                          key={`reasoning:${item.entry.data.reasoning!.streamId ?? item.entry.seq}`}
                          data-entry-seq={item.entry.seq}
                        >
                          <div className="subagent-entry-heading">
                            <span>
                              {item.entry.data.reasoning!.status === 'streaming'
                                ? '思考中'
                                : '思考'}
                            </span>
                            <time dateTime={item.entry.at}>{eventTime(item.entry.at)}</time>
                          </div>
                          <MarkdownMessage text={item.entry.data.reasoning!.text} />
                        </section>
                      ),
                    )}
                  </div>
                </details>
              </li>
            ) : null
          ) : (
            <li key={row.entry.seq} className="subagent-message" data-entry-seq={row.entry.seq}>
              {row.message.role === 'user' ? (
                <details className="subagent-task" open>
                  <summary>
                    委派任务 <time dateTime={row.entry.at}>{eventTime(row.entry.at)}</time>
                  </summary>
                  <MarkdownMessage text={row.message.text} />
                </details>
              ) : (
                <>
                  <div className="subagent-entry-heading">
                    <span>助手回复</span>
                    <time dateTime={row.entry.at}>{eventTime(row.entry.at)}</time>
                  </div>
                  <MarkdownMessage text={row.message.text} />
                </>
              )}
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

/** Hooks 始终调用；身份变化立即隐藏旧快照，并销毁旧读取器。 */
export default function SubagentPanel({
  sessionId,
  agentId,
  open,
  revision,
  onClose,
}: {
  sessionId: string;
  agentId: string;
  open: boolean;
  revision: number;
  onClose: () => void;
}) {
  const root = useContext(SessionReadRoot);
  const [state, setState] = useState<{ key: string; snapshot: Snapshot } | null>(null);
  const reader = useRef<ReturnType<typeof createSubagentReader> | null>(null);
  const [revealAfter, setRevealAfter] = useState<number | undefined>(undefined);
  const lastRevision = useRef(revision);
  const key = JSON.stringify([sessionId, agentId, root]);
  useEffect(() => {
    setState(null);
    setRevealAfter(undefined);
    lastRevision.current = revision;
    if (!open || !sessionId || !agentId) return;
    const current = createSubagentReader(
      sessionId,
      agentId,
      (snapshot) => setState({ key, snapshot }),
      (session, agent, after, signal) => readSubagentPage(session, agent, after, signal, root),
    );
    reader.current = current;
    void current.load();
    return () => {
      current.dispose();
      reader.current = null;
    };
  }, [sessionId, agentId, open, key]);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    if (open) void reader.current?.load();
  }, [revision, open]);
  const snapshot = open && state?.key === key ? state.snapshot : null;
  return (
    <Drawer
      title={
        <span className="subagent-drawer-title">
          子 Agent <code>{agentId.slice(0, 8)}</code>
        </span>
      }
      rootClassName="subagent-drawer"
      open={open}
      onClose={onClose}
      size={640}
      styles={{ wrapper: { maxWidth: '100vw' } }}
    >
      {snapshot?.error && <Alert type="error" showIcon title={snapshot.error} />}
      {snapshot && (!snapshot.loading || snapshot.entries.length > 0) && (
        <SubagentTranscript
          key={key}
          entries={snapshot.entries}
          hasMore={snapshot.hasMore}
          revealAfterSeq={revealAfter}
        />
      )}
      {snapshot?.loading && (
        <div className="subagent-loading" role="status">
          <Spin size="small" /> 正在读取会话
        </div>
      )}
      {revealAfter !== undefined && snapshot && !snapshot.loading && !snapshot.error && (
        <p className="subagent-load-status" role="status">
          {snapshot.entries.some((entry) => entry.seq > revealAfter)
            ? `已加载 ${snapshot.entries.filter((entry) => entry.seq > revealAfter).length} 条记录`
            : '暂无新记录'}
        </p>
      )}
      {(snapshot?.hasMore || snapshot?.error) && (
        <Button
          size="small"
          loading={snapshot.loading}
          onClick={() => {
            setRevealAfter(snapshot.entries.at(-1)?.seq ?? 0);
            void reader.current?.load();
          }}
        >
          {snapshot.error ? '重试' : '加载后续记录'}
        </Button>
      )}
    </Drawer>
  );
}
