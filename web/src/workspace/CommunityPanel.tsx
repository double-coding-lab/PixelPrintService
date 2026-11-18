import './community.css';
import './editWorkspace.css';
import { useEffect, useState } from 'react';
import { Alert, Button, Drawer, Empty, Pagination, Skeleton } from 'antd';
import { data, errorMessage, id } from './api';
import {
  detachedEditOptions,
  publicTimelineEntry,
  readCollection,
  SessionReadRoot,
  type CollectionPage,
  type SharedSession,
  type PersonalWork,
} from './sharing';
import type { SessionDiagnostics, TimelineEntry, TimelinePage } from './types';
import { mergeTimeline, describeEvent } from './timeline';
import { groupConversationRounds } from './roundProjection';
import ConversationRound from './ConversationRound';
import MarkdownMessage from '../components/MarkdownMessage';
import MessageImages from './MessageImages';
import EditWorkspace, { EditWorkspaceSurface } from './EditWorkspace';
import { diagnosticNumber, diagnosticTokens, totalDuration } from './DiagnosticsPanel';

type Kind = 'plaza' | 'my-works';

/** 广场默认展示独立编辑副本；对话及用量按需读取，不占据编辑区域。 */
export function PublicSession({
  shareId,
  onBack,
  onDirty,
  onBusy,
}: {
  shareId: string;
  onBack: () => void;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}) {
  const root = `/plaza/sessions/${id(shareId)}`;
  const [detail, setDetail] = useState<SharedSession | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [panel, setPanel] = useState<'chat' | 'usage' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    data<SharedSession>(root, { signal: controller.signal }).then(
      (session) => {
        if (!controller.signal.aborted) {
          setDetail(session);
          setError('');
        }
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setDetail(null);
          setError(errorMessage(reason));
        }
      },
    );
    return () => controller.abort();
  }, [root, reload]);
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        title={error}
        action={<Button onClick={() => setReload((n) => n + 1)}>重试</Button>}
      />
    );
  if (!detail) return <Skeleton active />;
  return (
    <SessionReadRoot.Provider value={root}>
      <div className="community-detail-heading">
        <div className="community-detail-identity">
          <h2>{detail.name}</h2>
          <span>
            {detail.creatorName || detail.createdEid} · {detail.target.toUpperCase()}
          </span>
        </div>
        <div className="community-actions">
          <Button onClick={onBack}>返回广场</Button>
          <Button onClick={() => setPanel('usage')}>用量</Button>
          <Button onClick={() => setPanel('chat')}>查看对话</Button>
        </div>
      </div>
      <EditWorkspaceSurface
        sessionId={shareId}
        options={detachedEditOptions('plaza', shareId)}
        embedded
        onDirty={onDirty}
        onBusy={onBusy}
        onClose={onBack}
        onApplied={() => {}}
      />
      <Drawer
        title={panel === 'usage' ? '会话用量' : '会话对话'}
        open={panel !== null}
        onClose={() => setPanel(null)}
        size={760}
        className="community-detail-drawer"
      >
        {panel === 'chat' && <PublicConversation root={root} detail={detail} shareId={shareId} />}
        {panel === 'usage' && <PublicUsage root={root} />}
      </Drawer>
    </SessionReadRoot.Provider>
  );
}

/** 对话仅在抽屉打开时读取；补读失败保留已加载记录，卸载取消请求。 */
function PublicConversation({
  root,
  detail,
  shareId,
}: {
  root: string;
  detail: SharedSession;
  shareId: string;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [previousSeq, setPreviousSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [failedCursor, setFailedCursor] = useState(0);
  const [reload, setReload] = useState(0);
  const [request] = useState(() => ({ current: null as AbortController | null }));
  async function load(beforeSeq = 0) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    try {
      const page = await data<TimelinePage>(`${root}/timeline?beforeSeq=${beforeSeq}&limit=500`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const before = page.previousSeq ?? page.entries[0]?.seq ?? 0;
      if (page.hasMore && (!before || (beforeSeq > 0 && before >= beforeSeq)))
        throw new Error('历史记录游标无效');
      setEntries((current) => mergeTimeline(page.entries, current, detail.sessionId, Infinity));
      setPreviousSeq(before);
      setHasMore(page.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setFailedCursor(beforeSeq);
        setError(errorMessage(reason));
      }
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (request.current === controller) request.current = null;
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [root, reload]);
  return (
    <div className="community-conversation">
      <div className="community-conversation-actions">
        {hasMore && (
          <Button loading={pending} onClick={() => void load(previousSeq)}>
            加载更早记录
          </Button>
        )}
        <Button disabled={pending} onClick={() => setReload((n) => n + 1)}>
          刷新对话
        </Button>
      </div>
      {error && (
        <Alert
          type="error"
          title={error}
          action={<Button onClick={() => void load(failedCursor)}>重试</Button>}
        />
      )}
      {pending && !entries.length && <Skeleton active />}
      <ol className="timeline">
        {groupConversationRounds(entries, null).map((round) => (
          <ConversationRound
            key={round.key}
            entries={round.entries}
            active={false}
            revision={detail.timelineSeq}
            onLayoutChange={() => {}}
            renderMessage={(entry) => <PublicMessage entry={publicTimelineEntry(entry, shareId)} />}
          />
        ))}
      </ol>
      {!pending && !error && !entries.length && <Empty description="暂无对话" />}
    </div>
  );
}

/** 只请求广场授权的会话聚合，不从当前分页记录推算用量。 */
function PublicUsage({ root }: { root: string }) {
  const [snapshot, setSnapshot] = useState<{
    usage: SessionDiagnostics['usage'];
    sessionElapsedMs: number | null;
    observedAt: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    data<NonNullable<typeof snapshot>>(`${root}/usage`, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setSnapshot(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [root, reload]);
  if (error)
    return (
      <Alert
        type="error"
        title={error}
        action={<Button onClick={() => setReload((n) => n + 1)}>重试</Button>}
      />
    );
  if (!snapshot) return <Skeleton active />;
  return (
    <>
      <dl className="community-usage-grid">
        {[
          ['总 Token', diagnosticTokens(snapshot.usage.totalTokens)],
          ['输入 Token', diagnosticTokens(snapshot.usage.inputTokens)],
          ['输出 Token', diagnosticTokens(snapshot.usage.outputTokens)],
          ['模型请求', diagnosticNumber(snapshot.usage.requests)],
          ['累计耗时', totalDuration(snapshot.sessionElapsedMs)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {snapshot.usage.usageComplete !== true && (
        <p className="muted">用量尚未完整报告，以上为已记录部分。</p>
      )}
      <Button onClick={() => setReload((n) => n + 1)}>刷新用量</Button>
    </>
  );
}

/** 原始事件只作展示，图片定位已由广场附件接口重新投影。 */
function PublicMessage({ entry }: { entry: TimelineEntry }) {
  return (
    <>
      <MessageImages attachments={entry.data.attachments} />
      {entry.kind === 'message' || entry.kind === 'text_delta' ? (
        entry.data.role === 'user' ? (
          <span className="event-content">{entry.data.text}</span>
        ) : (
          <MarkdownMessage text={entry.data.text ?? ''} />
        )
      ) : (
        <span className="event-content">{describeEvent(entry)}</span>
      )}
    </>
  );
}

/** 本人作品元数据先鉴权，再创建独立副本；保存由同一 workId 的 edit/save 更新。 */
function PersonalWorkDetail({ workId }: { workId: string }) {
  const [work, setWork] = useState<PersonalWork | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    data<PersonalWork>(`/my-works/${id(workId)}`, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setWork(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [workId]);
  if (error) return <Alert type="error" title={error} />;
  if (!work) return <Skeleton active />;
  return (
    <div className="community-detail-heading">
      <div>
        <h2>{work.name}</h2>
        <span>{work.target.toUpperCase()}</span>
      </div>
      <div className="community-actions">
        {work.canManage !== false && (
          <EditWorkspace
            sessionId={workId}
            options={detachedEditOptions('my-works', workId)}
            onApplied={() => {}}
            label="再次编辑"
          />
        )}
        <Button href={`/api/d2c/my-works/${id(workId)}/archive`}>下载 ZIP</Button>
      </div>
    </div>
  );
}

/** 广场和本人副本集合使用服务端分页，不合并或改变现有冻结版本。 */
export default function CommunityPanel({
  kind,
  resourceId,
  onSelect,
  onVersions,
  onDirty,
  onBusy,
}: {
  kind: Kind;
  resourceId: string;
  onSelect: (value: string) => void;
  onVersions: () => void;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<CollectionPage<SharedSession | PersonalWork> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (resourceId) return;
    const controller = new AbortController();
    setList(null);
    setError('');
    setLoading(true);
    readCollection<SharedSession | PersonalWork>(
      `${kind === 'plaza' ? '/plaza/sessions' : '/my-works'}?page=${page}&pageSize=12`,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          setList(value);
          setLoading(false);
        }
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [kind, resourceId, page, reload]);
  const title = kind === 'plaza' ? '广场' : '我的作品';
  return (
    <section
      className={`works-panel community-panel${kind === 'plaza' && resourceId ? ' community-panel-detail' : ''}`}
    >
      <div className="works-heading">
        <h1>{title}</h1>
        <div className="community-actions">
          {resourceId && kind !== 'plaza' && (
            <Button onClick={() => onSelect('')}>返回{title}</Button>
          )}
          {kind === 'my-works' && <Button onClick={onVersions}>暂存版本</Button>}
          {!resourceId && (
            <Button loading={loading} onClick={() => setReload((n) => n + 1)}>
              刷新
            </Button>
          )}
        </div>
      </div>
      {resourceId ? (
        kind === 'plaza' ? (
          <PublicSession
            key={resourceId}
            shareId={resourceId}
            onBack={() => onSelect('')}
            onDirty={onDirty}
            onBusy={onBusy}
          />
        ) : (
          <PersonalWorkDetail key={resourceId} workId={resourceId} />
        )
      ) : (
        <>
          {error && <Alert type="error" title={error} />}
          {loading && <Skeleton active />}
          <div className="works-grid">
            {list?.items.map((item) => {
              const resource = 'shareId' in item ? item.shareId : item.workId;
              return (
                <article className="work-card" key={resource}>
                  <h2>
                    <Button type="link" onClick={() => onSelect(resource)}>
                      {item.name}
                    </Button>
                  </h2>
                  <span>{item.target.toUpperCase()}</span>
                  {'creatorName' in item && <span>{item.creatorName || item.createdEid}</span>}
                  <div className="work-card-actions">
                    <Button onClick={() => onSelect(resource)}>
                      {kind === 'plaza' ? '打开作品' : '查看作品'}
                    </Button>
                    {'workId' in item && (
                      <Button href={`/api/d2c/my-works/${id(item.workId)}/archive`}>
                        下载 ZIP
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {list && !list.total && (
            <Empty description={kind === 'plaza' ? '暂无公开会话' : '暂无作品'} />
          )}
          {list && list.total > 12 && (
            <Pagination
              current={page}
              pageSize={12}
              total={list.total}
              showSizeChanger={false}
              onChange={setPage}
            />
          )}
        </>
      )}
    </section>
  );
}
