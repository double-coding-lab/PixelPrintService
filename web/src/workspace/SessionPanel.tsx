import SessionSharing from './SessionSharing';
import { findPagedEntry, revealPagedContent } from './pagedContent';
import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, Input, Skeleton } from 'antd';
import { data, errorMessage, id } from './api';
import {
  applySessionEvent,
  diagnosticsRevision,
  getPendingQuestion,
  describeEvent,
  getEventFailure,
  isTextSnapshot,
  mergeTimeline,
  mergeSessionSnapshot,
  timelineEventKinds,
} from './timeline';
import FilesPanel from './FilesPanel';
import MessageImages from './MessageImages';
import { createImageDraft, imageTypes, messageInput, type DraftImage } from './attachments';
import type { Session, TimelineEntry, TimelinePage } from './types';
import Icon from '../components/Icon';
import ConversationView, { ConversationDivider } from './ConversationView';
import { useConfirm } from '../components/useConfirm';
import MarkdownMessage from '../components/MarkdownMessage';
import ConversationRound from './ConversationRound';
import { groupConversationRounds } from './roundProjection';
import MessageQueue from './MessageQueue';
import { useMessageQueue } from './useMessageQueue';
import QuestionPanel from './QuestionPanel';
import DiagnosticsPanel from './DiagnosticsPanel';
import ExecutionProgress from './ExecutionProgress';

/** 只展示投影后的诊断文本，旧事件保持原有时间线文案。 */
export function TimelineEvent({
  entry,
  onLayoutChange,
}: {
  entry: TimelineEntry;
  onLayoutChange?: () => void;
}) {
  if (entry.kind === 'text_delta' && (!isTextSnapshot(entry) || entry.data.status === 'discarded'))
    return null;
  if (
    (entry.kind === 'text_delta' ||
      (entry.kind === 'message' && entry.data?.role === 'assistant')) &&
    typeof entry.data.text === 'string'
  )
    return (
      <>
        <MessageImages attachments={entry.data.attachments} onLoad={onLayoutChange} />
        <MarkdownMessage text={entry.data.text} onLayoutChange={onLayoutChange} />
        {entry.kind === 'text_delta' && (
          <span className="connection" role="status">
            {entry.data.status === 'streaming' ? '正在生成…' : '回复已中断 · 未完成'}
          </span>
        )}
      </>
    );
  if (entry.kind === 'message' && entry.data?.role === 'user')
    return (
      <>
        <MessageImages attachments={entry.data.attachments} onLoad={onLayoutChange} />
        {typeof entry.data.text === 'string' && entry.data.text && (
          <span className="event-content">{entry.data.text}</span>
        )}
      </>
    );
  const failure = getEventFailure(entry);
  if (entry.kind === 'run_status' && entry.data.status === 'interrupted')
    return (
      <div className="interruption-notice">
        <span className="interruption-summary">
          <Icon name="pause" />
          {failure ? '执行已暂停，文件和对话已保留' : describeEvent(entry)}
        </span>
        {typeof entry.runId === 'string' && /^[\w-]{1,128}$/.test(entry.runId) && (
          <div className="failure-details">
            runId：<code>{entry.runId}</code>
          </div>
        )}
        {failure && (
          <details>
            <summary>查看详情</summary>
            <div className="failure-details">
              <div>{failure.suggestion}</div>
              <div>排查编号：{failure.errorId ?? '未提供'}</div>
            </div>
          </details>
        )}
      </div>
    );
  if (!failure) return <span className="event-content">{describeEvent(entry)}</span>;
  return (
    <Alert
      type={failure.requiresUser ? 'warning' : 'error'}
      showIcon
      title={describeEvent(entry)}
      description={
        <div className="failure-details">
          {failure.tool && <div>工具：{failure.tool}</div>}
          {failure.command && <div>命令：{failure.command}</div>}
          {failure.statusCode !== undefined && <div>状态码：{failure.statusCode}</div>}
          <div>建议：{failure.suggestion}</div>
          <div>排查编号：{failure.errorId ?? '未提供'}</div>
          {failure.runId && <div>runId：{failure.runId}</div>}
        </div>
      }
    />
  );
}

/** 先取得会话归属，再补齐历史并订阅；切换只关闭订阅，不操作后台执行。 */
export default function SessionPanel({
  sessionId,
  workspaceId,
  onDirty,
  onBusy,
  onNameChange,
}: {
  sessionId: string;
  workspaceId: string;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onNameChange?: (sessionId: string, name: string) => void;
}) {
  const confirm = useConfirm();
  const [session, setSession] = useState<Session | null>(null);
  const [loadedSessionId, setLoadedSessionId] = useState('');
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyNotice, setHistoryNotice] = useState('');
  const earlierCursor = useRef(0);
  const earlierRequest = useRef<AbortController | null>(null);
  const historyAnchor = useRef<{ height: number; top: number; revealSeq?: number } | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsSeq, setDiagnosticsSeq] = useState(0);
  const [connection, setConnection] = useState('正在读取会话');
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const nameSaving = useRef(false);

  /** 标题写入独立于任务执行，成功后立即更新当前页和左侧菜单。 */
  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (nameSaving.current) return;
    if (!nameDraft.trim()) {
      setNameError('请输入会话名称');
      return;
    }
    nameSaving.current = true;
    setSavingName(true);
    setNameError('');
    try {
      const result = await data<Session>(`/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      setSession((current) => (current ? { ...current, name: result.name } : current));
      onNameChange?.(sessionId, result.name);
      setEditingName(false);
    } catch (reason) {
      setNameError(errorMessage(reason));
    } finally {
      nameSaving.current = false;
      setSavingName(false);
    }
  }
  const [retry, setRetry] = useState(0);
  const [fileRefresh, setFileRefresh] = useState(0);
  const [versionRefresh, setVersionRefresh] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [queueRevision, setQueueRevision] = useState(0);
  const queue = useMessageQueue(sessionId, queueRevision);
  const [images, setImages] = useState<DraftImage[]>([]);
  const [imageError, setImageError] = useState('');
  const imageDraft = useRef<ReturnType<typeof createImageDraft> | null>(null);
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const sendingLock = useRef(false);
  const imagesBlocked = images.some((image) => image.status !== 'ready');
  const [prompt, setPrompt] = useState('');
  const hasMessage = !!prompt.trim() || images.length > 0;
  const [answerDirty, setAnswerDirty] = useState(false);
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const [sending, setSending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [controlling, setControlling] = useState(false);
  const resumeRequest = useRef<{ runId: string; clientRequestId: string } | null>(null);
  const [sendError, setSendError] = useState('');
  const [focused, setFocused] = useState(false);
  const [conversationWidth, setConversationWidth] = useState(55);
  const pending = useRef<{
    content: string;
    attachmentIds?: string[];
    clientRequestId: string;
  } | null>(null);
  const pendingDelivery = useRef<{
    clientRequestId: string;
    mode: 'queue' | 'guidance';
    queued: boolean;
  } | null>(null);
  const mounted = useRef(true);
  const timeline = useRef<HTMLOListElement>(null);
  const followLatest = useRef(true);
  const path = `/sessions/${id(sessionId)}`;
  const waiting = session?.sessionId === sessionId && session.activeRunStatus === 'waiting_input';
  const question = waiting ? getPendingQuestion(session?.pendingQuestion) : null;
  const canStop = Boolean(
    session?.activeRunId && !waiting && session.activeRunStatus !== 'interrupted',
  );
  const canResume = Boolean(session?.activeRunId && session.activeRunStatus === 'interrupted');
  const stopping = session?.activeRunStatus === 'stopping';
  const canQueueMessage = hasMessage && !waiting;
  const actionLabel = canQueueMessage
    ? session?.activeRunId || queue.items.length
      ? '加入消息队列'
      : '发送给 Agent'
    : canStop
      ? stopping
        ? '正在暂停执行'
        : session?.activeRunStatus === 'queued'
          ? '取消排队'
          : '暂停执行'
      : canResume
        ? '继续任务'
        : '发送给 Agent';
  /** 停止写入服务端状态；继续复用同一请求标识，断网重试不会重复创建轮次。 */
  async function controlRun(action: 'stop' | 'resume') {
    if (controlling || ending || sending || !session?.activeRunId) return;
    const runId = session.activeRunId;
    if (action === 'resume' && resumeRequest.current?.runId !== runId)
      resumeRequest.current = { runId, clientRequestId: crypto.randomUUID() };
    setControlling(true);
    setSendError('');
    onBusy(true);
    try {
      await data(`${path}/${action}`, {
        method: 'POST',
        body: JSON.stringify(action === 'resume' ? resumeRequest.current : { runId }),
      });
      const latest = await data<Session>(path);
      if (mounted.current && latest.workspaceId === workspaceId)
        setSession((current) => mergeSessionSnapshot(current, latest, sessionId));
      if (action === 'resume') resumeRequest.current = null;
    } catch (reason) {
      if (mounted.current) setSendError(errorMessage(reason));
    } finally {
      onBusy(false);
      if (mounted.current) setControlling(false);
    }
  }
  /** 明确放弃中断轮次的继续执行，保留草稿、文件和历史，再刷新可信会话摘要。 */
  async function endInterrupted() {
    if (
      ending ||
      sending ||
      controlling ||
      session?.activeRunStatus !== 'interrupted' ||
      !session.activeRunId
    )
      return;
    const runId = session.activeRunId;
    setEnding(true);
    setSendError('');
    onBusy(true);
    try {
      if (
        !(await confirm({
          title: '结束中断轮次？',
          content:
            '已有文件和对话历史会保留。结束后可以继续发送消息或删除会话；不会自动重跑中断的工具，请先核对产物。',
          okText: '结束中断轮次',
        }))
      )
        return;
      if (!mounted.current) return;
      await data(`${path}/end-interrupted`, { method: 'POST', body: JSON.stringify({ runId }) });
      const latest = await data<Session>(path);
      if (mounted.current && latest.workspaceId === workspaceId)
        setSession((current) => mergeSessionSnapshot(current, latest, sessionId));
    } catch (reason) {
      if (mounted.current) setSendError(errorMessage(reason));
    } finally {
      onBusy(false);
      if (mounted.current) setEnding(false);
    }
  }
  /** 回答后读回可信摘要；晚到响应不能覆盖已收到的新 seq 或另一会话。 */
  async function refreshQuestion() {
    const latest = await data<Session>(path);
    if (
      !mounted.current ||
      currentSessionId.current !== sessionId ||
      latest.workspaceId !== workspaceId
    )
      return;
    setSession((current) => mergeSessionSnapshot(current, latest, sessionId));
  }
  /** 直接切换会话时清空普通消息和回答草稿，避免旧请求污染新会话。 */
  useEffect(() => {
    setPrompt('');
    setImages([]);
    setImageError('');
    sendingLock.current = false;
    setSending(false);
    setDiagnosticsOpen(false);
    setDiagnosticsSeq(0);
    setAnswerDirty(false);
    pending.current = null;
    pendingDelivery.current = null;
  }, [sessionId]);
  useEffect(() => {
    const draft = createImageDraft({ sessionId, onChange: setImages, onError: setImageError });
    imageDraft.current = draft;
    return () => draft.dispose();
  }, [sessionId]);
  /** 缩放、全屏与列宽变化后仍尊重用户是否正在阅读历史。 */
  function followLayout() {
    requestAnimationFrame(() => {
      if (timeline.current && followLatest.current)
        timeline.current.scrollTop = timeline.current.scrollHeight;
    });
  }
  /** 首次展示历史时定位最新消息；实时更新仅在用户仍靠近底部时跟随。 */
  useLayoutEffect(() => {
    const list = timeline.current;
    if (list && historyAnchor.current) {
      const anchor = historyAnchor.current;
      list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
      historyAnchor.current = null;
      if (anchor.revealSeq !== undefined) {
        const target = findPagedEntry(list, anchor.revealSeq);
        if (target) revealPagedContent(list, target);
      }
    } else if (list && followLatest.current) list.scrollTop = list.scrollHeight;
  }, [entries, loadedSessionId]);
  useEffect(() => {
    onDirty(!!prompt || answerDirty || images.length > 0);
  }, [prompt, answerDirty, images.length, onDirty]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** 网络失败重试相同内容沿用请求 ID，避免重复排队；收到结果后才清空输入。 */
  async function send(mode?: 'queue' | 'guidance') {
    if (sendingLock.current || sending || ending || controlling || queue.pending || !session)
      return;
    const input = messageInput(prompt, images, pending.current);
    if (!input) return;
    const delivery =
      pendingDelivery.current?.clientRequestId === input.clientRequestId
        ? pendingDelivery.current
        : {
            clientRequestId: input.clientRequestId,
            mode: mode ?? 'queue',
            queued: !!session.activeRunId || queue.items.length > 0 || mode === 'guidance',
          };
    if (mode && mode !== delivery.mode) {
      setSendError('上一条发送尚未确认，请先按原方式重试');
      return;
    }
    pending.current = input;
    pendingDelivery.current = delivery;
    sendingLock.current = true;
    setSending(true);
    setSendError('');
    onBusy(true);
    try {
      if (delivery.queued) {
        await queue.submit(input, delivery.mode);
      } else {
        await data<{ runId: string; status: string }>(`${path}/messages`, {
          method: 'POST',
          body: JSON.stringify(input),
        });
      }
      if (!mounted.current || currentSessionId.current !== sessionId) return;
      pending.current = null;
      pendingDelivery.current = null;
      setPrompt('');
      imageDraft.current?.clear();
      const latest = await data<Session>(path);
      if (
        mounted.current &&
        currentSessionId.current === sessionId &&
        latest.workspaceId === workspaceId
      )
        setSession((current) => mergeSessionSnapshot(current, latest, sessionId));
    } catch (reason) {
      if (mounted.current && currentSessionId.current === sessionId)
        setSendError(errorMessage(reason));
    } finally {
      if (currentSessionId.current === sessionId) {
        sendingLock.current = false;
        onBusy(false);
        if (mounted.current) setSending(false);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | undefined;
    let checkingLogin = false;
    setError('');
    setConnection('正在补读事件');
    setLoadingEarlier(false);
    setHistoryNotice('');
    /** 首屏只取最新页，完整历史由向前分页读取，实时事件继续按 cursor 补读。 */
    async function connect() {
      const [snapshot, page] = await Promise.all([
        data<Session>(path, { signal: controller.signal }),
        data<TimelinePage>(`${path}/timeline?beforeSeq=0&limit=200`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (snapshot.workspaceId !== workspaceId) throw new Error('会话不属于当前工作区');
      setSession((current) => mergeSessionSnapshot(current, snapshot, sessionId));
      const history = mergeTimeline([], page.entries, sessionId, Infinity);
      let cursor = page.nextSeq;
      earlierCursor.current = page.previousSeq ?? page.entries[0]?.seq ?? 0;
      setHasEarlier(page.hasMore);
      setHistoryError('');
      /** 补读期间可能已领取或结束轮次，重新取得摘要，避免头部状态落后于历史。 */
      const latest = await data<Session>(path, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (latest.workspaceId !== workspaceId) throw new Error('会话不属于当前工作区');
      setSession((current) => mergeSessionSnapshot(current, latest, sessionId));
      setEntries(history);
      setDiagnosticsSeq(diagnosticsRevision(history));
      setFileRefresh((value) => value + 1);
      setVersionRefresh((value) => value + 1);
      setConnection('连接中');
      setLoadedSessionId(sessionId);
      source = new EventSource(`/api/d2c${path}/events?afterSeq=${cursor}`);
      source.onopen = () => {
        if (!controller.signal.aborted) setConnection('实时连接正常');
      };
      source.onerror = async () => {
        if (!controller.signal.aborted)
          setConnection(
            source?.readyState === EventSource.CLOSED
              ? '连接已关闭，请重连'
              : '连接断开，正在自动重连',
          );
        /** EventSource 隐藏 HTTP 状态；断线时核对一次登录，401 沿用统一浏览器跳转。 */
        if (controller.signal.aborted || checkingLogin) return;
        checkingLogin = true;
        try {
          await data<Session>(path, { signal: controller.signal });
        } catch (reason) {
          if (!controller.signal.aborted && (reason as { status?: number }).status === 401) {
            source?.close();
            setConnection('登录已失效，正在跳转登录');
          }
        } finally {
          checkingLogin = false;
        }
      };
      /** 用户消息与状态沿用同一 cursor；文件变化才刷新文件列表。 */
      const receive = (event: MessageEvent<string>) => {
        if (controller.signal.aborted) return;
        try {
          const entry = JSON.parse(event.data) as TimelineEntry;
          if (
            entry.sessionId !== sessionId ||
            !Number.isSafeInteger(entry.seq) ||
            entry.seq <= 0 ||
            !timelineEventKinds.some((kind) => kind === entry.kind) ||
            !entry.data ||
            typeof entry.data !== 'object'
          )
            return;
          cursor = Math.max(cursor, entry.seq);
          if (entry.kind === 'session_changed') {
            setSession((current) => applySessionEvent(current, entry));
            if (typeof entry.data.name === 'string') onNameChange?.(sessionId, entry.data.name);
            return;
          }
          if (entry.kind === 'stage' && entry.data.action === 'message_queue')
            setQueueRevision((value) => value + 1);
          /** 预览完成通知只纯查状态，不进入聊天、流程或触发 ensure。 */
          if (entry.kind === 'preview_changed') {
            if (entry.data.status === 'changed') setPreviewRevision((value) => value + 1);
            setSession((current) => applySessionEvent(current, entry));
            return;
          }
          setDiagnosticsSeq((seq) => diagnosticsRevision([entry], seq));
          setEntries((current) => mergeTimeline(current, [entry], sessionId, Infinity));
          if (
            entry.kind === 'file_changed' ||
            (entry.kind === 'run_status' && entry.data.validation)
          )
            setFileRefresh((value) => value + 1);
          if (entry.kind === 'version_changed') setVersionRefresh((value) => value + 1);
          setSession((current) => applySessionEvent(current, entry));
        } catch {
          source?.close();
          setConnection('事件格式异常，请重连');
        }
      };
      for (const kind of timelineEventKinds) source.addEventListener(kind, receive);
      source.addEventListener('stream_error', () => {
        source?.close();
        setConnection('事件读取失败，请重连');
      });
    }
    connect().catch((reason) => {
      if (!controller.signal.aborted) {
        setError(errorMessage(reason));
        setConnection('连接失败');
      }
    });
    return () => {
      controller.abort();
      earlierRequest.current?.abort();
      earlierRequest.current = null;
      source?.close();
    };
  }, [path, sessionId, workspaceId, retry]);
  /** 自动补读保留阅读位置，点击加载则展开并定位新增记录；切换会话取消请求。 */
  async function loadEarlier(reveal = false) {
    if (!hasEarlier || earlierRequest.current || !earlierCursor.current) return;
    const controller = new AbortController();
    earlierRequest.current = controller;
    setLoadingEarlier(true);
    setHistoryError('');
    if (reveal) setHistoryNotice('');
    try {
      const page = await data<TimelinePage>(
        `${path}/timeline?beforeSeq=${earlierCursor.current}&limit=500`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || currentSessionId.current !== sessionId) return;
      const next = page.previousSeq ?? page.entries[0]?.seq ?? 0;
      if (page.hasMore && (!next || next >= earlierCursor.current))
        throw new Error('历史分页游标无效');
      const added = page.entries.filter(
        (entry) => !entries.some((current) => current.seq === entry.seq),
      );
      if (reveal)
        setHistoryNotice(added.length ? `已加载 ${added.length} 条更早记录` : '暂无更早记录');
      const list = timeline.current;
      if (list) {
        followLatest.current = false;
        historyAnchor.current = {
          height: list.scrollHeight,
          top: list.scrollTop,
          ...(reveal && added.length ? { revealSeq: added[0].seq } : {}),
        };
      }
      earlierCursor.current = next;
      setHasEarlier(page.hasMore);
      setEntries((current) => mergeTimeline(page.entries, current, sessionId, Infinity));
    } catch (reason) {
      if (!controller.signal.aborted) setHistoryError(errorMessage(reason));
    } finally {
      if (earlierRequest.current === controller) {
        earlierRequest.current = null;
        setLoadingEarlier(false);
      }
    }
  }
  /** 初次历史和最新摘要一起就绪后再展示，避免空态、旧内容及滚动定位闪现。 */
  if (loadedSessionId !== sessionId) {
    return (
      <section className="session-main" aria-busy={!error}>
        <div className="session-loading" role={error ? undefined : 'status'}>
          {error ? (
            <>
              <Alert type="error" showIcon title="聊天记录加载失败" description={error} />
              <Button onClick={() => setRetry((value) => value + 1)}>重新加载</Button>
            </>
          ) : (
            <div className="chat-skeleton" aria-label="正在加载聊天记录">
              <div className="chat-skeleton-heading" aria-hidden="true">
                <Skeleton.Input active size="small" />
                <Skeleton.Button active size="small" />
              </div>
              <div className="chat-skeleton-messages" aria-hidden="true">
                <div className="chat-skeleton-user">
                  <Skeleton active title={false} paragraph={{ rows: 2, width: ['90%', '65%'] }} />
                </div>
                <div className="chat-skeleton-assistant">
                  <Skeleton
                    active
                    title={{ width: '24%' }}
                    paragraph={{ rows: 4, width: ['96%', '88%', '94%', '58%'] }}
                  />
                </div>
                <div className="chat-skeleton-user">
                  <Skeleton active title={false} paragraph={{ rows: 1, width: '80%' }} />
                </div>
                <div className="chat-skeleton-assistant">
                  <Skeleton
                    active
                    title={{ width: '20%' }}
                    paragraph={{ rows: 3, width: ['92%', '98%', '68%'] }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="session-main">
      <DiagnosticsPanel
        key={sessionId}
        sessionId={sessionId}
        open={diagnosticsOpen}
        revision={diagnosticsSeq}
        onClose={() => setDiagnosticsOpen(false)}
      />
      <div className="session-heading">
        <div>
          {editingName ? (
            <form className="session-name-edit" onSubmit={saveName}>
              <Input
                autoFocus
                aria-label="会话名称"
                maxLength={200}
                value={nameDraft}
                disabled={savingName}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !savingName) {
                    event.stopPropagation();
                    setEditingName(false);
                  }
                }}
              />
              <Button size="small" type="primary" htmlType="submit" loading={savingName}>
                保存
              </Button>
              <Button size="small" disabled={savingName} onClick={() => setEditingName(false)}>
                取消
              </Button>
              {nameError && (
                <span className="session-name-error" role="alert">
                  {nameError}
                </span>
              )}
            </form>
          ) : (
            <h2>
              <button
                type="button"
                className="session-name-button"
                aria-label="修改会话名称"
                disabled={!session}
                title="点击修改会话名称"
                onClick={() => {
                  setNameDraft(session?.name ?? '');
                  setNameError('');
                  setEditingName(true);
                }}
              >
                {session?.name ?? '会话'}
              </button>
            </h2>
          )}
          <span className="pill">{session?.target.toUpperCase() ?? '—'}</span>
          <span className={`session-state${session?.activeRunId ? ' is-running' : ''}`}>
            {waiting
              ? '等待你的回答'
              : session?.activeRunStatus === 'interrupted'
                ? '执行已中断，待处理'
                : session?.activeRunId
                  ? 'Agent 执行中'
                  : '空闲'}
          </span>
        </div>
        <div className="session-heading-actions">
          <SessionSharing key={sessionId} sessionId={sessionId} />
          <Button
            type="text"
            size="small"
            className="diagnostics-trigger"
            icon={<Icon name="activity" />}
            onClick={() => setDiagnosticsOpen(true)}
            title="查看执行状态、耗时与模型用量"
          >
            执行诊断
          </Button>
          <Button
            type="text"
            size="small"
            className="session-reconnect"
            icon={<Icon name="refresh" />}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新连接
          </Button>
        </div>
      </div>
      {session?.figmaUrl && (
        <a
          className="session-design-link"
          href={session.figmaUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={session.figmaUrl}
        >
          <Icon name="external" /> Figma 设计稿 <span>{session.figmaUrl}</span>
        </a>
      )}
      {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      <div
        className={`session-content${session ? ' resizable-content' : ''}${focused ? ' conversation-focused' : ''}`}
        style={
          {
            '--conversation-left': `${conversationWidth}fr`,
            '--conversation-right': `${100 - conversationWidth}fr`,
          } as CSSProperties
        }
      >
        <ConversationView
          focused={focused}
          onFocusChange={setFocused}
          onLayoutChange={followLayout}
        >
          <section className="timeline">
            {connection !== '实时连接正常' && (
              <p role="status" className="connection">
                {connection}
              </p>
            )}
            {!entries.length && !hasEarlier ? (
              <div className="conversation-empty">
                <h3>发送设计稿，开始生成</h3>
              </div>
            ) : (
              <ol
                ref={timeline}
                aria-label="对话记录"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  followLatest.current =
                    list.scrollHeight - list.clientHeight - list.scrollTop <= 64;
                  if (list.scrollTop <= 48 && !historyError) void loadEarlier();
                }}
              >
                {(hasEarlier || historyNotice) && (
                  <li className="timeline-history-control">
                    {hasEarlier && (
                      <Button
                        type="text"
                        size="small"
                        loading={loadingEarlier}
                        onClick={() => void loadEarlier(true)}
                      >
                        {loadingEarlier
                          ? '正在加载历史…'
                          : historyError
                            ? '加载失败，点击重试'
                            : '加载更早记录'}
                      </Button>
                    )}
                    {historyNotice && <span role="status">{historyNotice}</span>}
                  </li>
                )}
                {groupConversationRounds(
                  entries,
                  waiting || session?.activeRunStatus === 'interrupted'
                    ? null
                    : (session?.activeRunId ?? null),
                ).map((round) => (
                  <ConversationRound
                    key={round.key}
                    entries={round.entries}
                    revision={entries.at(-1)?.seq ?? 0}
                    active={round.active}
                    onLayoutChange={followLayout}
                    renderMessage={(entry) => (
                      <TimelineEvent entry={entry} onLayoutChange={followLayout} />
                    )}
                  />
                ))}
              </ol>
            )}
          </section>
          <MessageQueue
            items={queue.items}
            pending={queue.pending}
            error={queue.error}
            onRemove={(queueId) => void queue.remove(queueId).catch(() => undefined)}
            onSendNow={(queueId) => void queue.sendNow(queueId).catch(() => undefined)}
            onRetry={queue.refresh}
          />
          <ExecutionProgress
            entries={entries}
            runId={session?.activeRunId}
            status={session?.activeRunStatus}
          />
          {waiting ? (
            question && session?.activeRunId ? (
              <QuestionPanel
                key={`${sessionId}:${session.activeRunId}:${question.questionId}`}
                sessionId={sessionId}
                runId={session.activeRunId}
                question={question}
                onDirty={setAnswerDirty}
                onBusy={onBusy}
                onRefresh={refreshQuestion}
              />
            ) : (
              <Alert type="info" showIcon title="等待业务问题同步，请刷新会话" />
            )
          ) : (
            <section className="composer" aria-label="Agent 对话">
              <Input.TextArea
                aria-label="给 Agent 的消息"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.items)
                    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                    .map((item) => item.getAsFile())
                    .filter((file): file is File => !!file);
                  if (!files.length) return;
                  event.preventDefault();
                  if (!sending) imageDraft.current?.add(files);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing ||
                    event.nativeEvent.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  if (
                    !event.repeat &&
                    session &&
                    !queue.pending &&
                    !sending &&
                    !ending &&
                    !controlling &&
                    hasMessage &&
                    !imagesBlocked
                  )
                    void send();
                }}
                disabled={sending}
                autoSize={{ minRows: 2, maxRows: 8 }}
                maxLength={65536}
                placeholder="描述页面或调整需求…"
              />
              <input
                ref={imagePicker}
                type="file"
                accept={imageTypes.join(',')}
                multiple
                hidden
                aria-label="选择反馈截图"
                disabled={sending}
                onChange={(event) => {
                  imageDraft.current?.add(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
              {!!images.length && (
                <div className="draft-images" aria-label="待发送截图">
                  {images.map((image) => (
                    <div className="draft-image" key={image.key}>
                      <img src={image.url} alt={image.file.name} />
                      <button
                        type="button"
                        aria-label={`移除 ${image.file.name}`}
                        disabled={sending}
                        onClick={() => imageDraft.current?.remove(image.key)}
                      >
                        ×
                      </button>
                      <small role="status">
                        {image.status === 'uploading'
                          ? '上传中…'
                          : image.status === 'ready'
                            ? '已上传'
                            : '上传失败'}
                      </small>
                      {image.status === 'failed' && (
                        <Button
                          size="small"
                          onClick={() => void imageDraft.current?.retry(image.key)}
                        >
                          重试
                        </Button>
                      )}
                      {image.error && <span className="draft-image-error">{image.error}</span>}
                    </div>
                  ))}
                </div>
              )}
              {imageError && (
                <div className="image-upload-error" role="alert">
                  {imageError}
                </div>
              )}
              {sendError && (
                <Alert type="error" showIcon title={sendError} className="feedback-alert" />
              )}
              <div className="composer-toolbar">
                <span className="muted">
                  {canResume
                    ? '已暂停 · 文件和对话已保留'
                    : session?.activeRunId
                      ? 'Enter 加入队列 · Shift+Enter 换行'
                      : 'Enter 发送 · Shift+Enter 换行'}
                </span>
                <div className="composer-actions">
                  <Button
                    type="text"
                    size="small"
                    disabled={sending || images.length >= 4}
                    onClick={() => imagePicker.current?.click()}
                  >
                    添加截图
                  </Button>
                  {canStop && hasMessage && (
                    <>
                      <Button
                        type="text"
                        size="small"
                        disabled={sending || queue.pending || imagesBlocked || stopping}
                        onClick={() => void send('guidance')}
                      >
                        立即引导
                      </Button>
                      <Button
                        type="text"
                        size="small"
                        aria-label="暂停执行"
                        disabled={sending || controlling || stopping}
                        icon={<Icon name="pause" />}
                        onClick={() => void controlRun('stop')}
                      />
                    </>
                  )}
                  {canResume && (
                    <Button
                      type="text"
                      size="small"
                      disabled={sending || controlling || ending}
                      loading={ending}
                      onClick={() => void endInterrupted()}
                    >
                      结束本轮
                    </Button>
                  )}
                  <Button
                    className="composer-action"
                    aria-label={actionLabel}
                    title={actionLabel}
                    aria-busy={sending || controlling || stopping || queue.pending}
                    type="primary"
                    shape="circle"
                    loading={sending || controlling || stopping || queue.pending}
                    disabled={
                      !session ||
                      ending ||
                      sending ||
                      controlling ||
                      stopping ||
                      queue.pending ||
                      (canQueueMessage && imagesBlocked) ||
                      (!canQueueMessage &&
                        !canStop &&
                        !canResume &&
                        (!!session.activeRunId || !hasMessage || imagesBlocked))
                    }
                    icon={
                      <Icon
                        name={
                          canQueueMessage
                            ? 'arrow'
                            : canStop
                              ? 'pause'
                              : canResume
                                ? 'play'
                                : 'arrow'
                        }
                        style={
                          !canQueueMessage && (canStop || canResume)
                            ? undefined
                            : { transform: 'rotate(-90deg)' }
                        }
                      />
                    }
                    onClick={() =>
                      canQueueMessage
                        ? void send()
                        : canStop
                          ? void controlRun('stop')
                          : canResume
                            ? void controlRun('resume')
                            : void send()
                    }
                  />
                </div>
              </div>
            </section>
          )}
        </ConversationView>
        {session && (
          <ConversationDivider
            value={conversationWidth}
            onChange={(value) => {
              setConversationWidth(value);
              followLayout();
            }}
          />
        )}
        {session && (
          <FilesPanel
            key={sessionId}
            sessionId={sessionId}
            refresh={fileRefresh}
            versionRefresh={versionRefresh}
            previewRevision={previewRevision}
            validationState={!session.activeRunId ? session.validationState : null}
            busy={!!session.activeRunId && session.activeRunStatus !== 'interrupted'}
          />
        )}
      </div>
    </section>
  );
}
