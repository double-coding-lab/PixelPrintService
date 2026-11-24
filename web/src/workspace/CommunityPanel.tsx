import DeleteSavedItem from './DeleteSavedItem';
import WorkCover from './WorkCover';
import PublishedSessionActions from './PublishedSessionActions';
import ForkSession from './ForkSession';
import './community.css';
import './editWorkspace.css';
import './conversationRound.css';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { SessionDiagnostics, TimelineEntry } from './types';
import { mergeTimeline, describeEvent } from './timeline';
import { groupConversationRounds } from './roundProjection';
import ConversationRound from './ConversationRound';
import MarkdownMessage from '../components/MarkdownMessage';
import { readPublicHistory } from './communityHistory';
import MessageImages from './MessageImages';
import { EditWorkspaceSurface } from './EditWorkspace';
import { diagnosticNumber, diagnosticTokens, totalDuration } from './DiagnosticsPanel';
import Icon from '../components/Icon';
import { formatTime } from './time';

type Kind = 'plaza' | 'my-works';

/** 广场默认展示独立编辑副本；对话及用量按需读取，不占据编辑区域。 */
export function PublicSession({
  shareId,
  onBack,
  onDirty,
  onBusy,
  onOpenSession,
  navigationDisabled = false,
}: {
  shareId: string;
  onBack: () => void;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
  onOpenSession?: (workspaceId: string, sessionId: string) => void;
  navigationDisabled?: boolean;
}) {
  const root = `/plaza/sessions/${id(shareId)}`;
  const [detail, setDetail] = useState<SharedSession | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [panel, setPanel] = useState<'chat' | 'usage' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const busySources = useRef({ editor: false, fork: false });
  const dirtyChanged = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty?.(value);
    },
    [onDirty],
  );
  const editorBusyChanged = useCallback(
    (value: boolean) => {
      busySources.current.editor = value;
      setEditorBusy(value);
      onBusy?.(value || busySources.current.fork);
    },
    [onBusy],
  );
  const forkBusyChanged = useCallback(
    (value: boolean) => {
      busySources.current.fork = value;
      onBusy?.(value || busySources.current.editor);
    },
    [onBusy],
  );
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
        <div className="community-detail-leading">
          <Button onClick={onBack}>← 返回广场</Button>
          <div className="community-detail-identity">
            <h2>{detail.name}</h2>
            <span>
              {detail.creatorName || detail.createdEid || '未知创建人'} ·{' '}
              {detail.target.toUpperCase()}
            </span>
            <time dateTime={detail.createdAt} title={detail.createdAt}>
              创建于 {formatTime(detail.createdAt)}
            </time>
          </div>
        </div>
        <div className="community-actions">
          <PublishedSessionActions session={detail} onOpenSession={onOpenSession} />
          {onOpenSession && (
            <span title={dirty ? '请先保存或放弃当前未保存的编辑，再创建分支' : undefined}>
              <ForkSession
                shareId={shareId}
                sourceName={detail.name}
                requireModelCredential
                disabled={navigationDisabled || dirty || editorBusy}
                onBusy={forkBusyChanged}
                onOpenSession={onOpenSession}
              />
            </span>
          )}
          <Button onClick={() => setPanel('usage')}>用量</Button>
          <Button onClick={() => setPanel('chat')}>查看对话</Button>
        </div>
      </div>
      <EditWorkspaceSurface
        sessionId={shareId}
        sourceName={detail.name}
        options={detachedEditOptions('plaza', shareId)}
        embedded
        onDirty={dirtyChanged}
        onBusy={editorBusyChanged}
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
        {panel === 'chat' && (
          <PublicConversation key={root} root={root} detail={detail} shareId={shareId} />
        )}
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
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [pages, setPages] = useState(0);
  const [reload, setReload] = useState(0);
  const cursor = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError('');
    void readPublicHistory(root, cursor.current, controller.signal, (page, before) => {
      setEntries((current) => mergeTimeline(page.entries, current, detail.sessionId, Infinity));
      cursor.current = before;
      setPages((current) => current + 1);
    }).then(
      () => {
        if (!controller.signal.aborted) setPending(false);
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setPending(false);
        }
      },
    );
    return () => controller.abort();
  }, [root, detail.sessionId, reload]);
  return (
    <div className="community-conversation">
      <div className="community-conversation-actions">
        <span role="status" aria-live="polite">
          {pending ? '正在自动读取对话' : error ? '读取已暂停' : '已读取全部对话'}
          {` · ${pages} 页 · ${entries.length} 条记录`}
        </span>
        <Button
          disabled={pending}
          onClick={() => {
            cursor.current = 0;
            setPages(0);
            setReload((n) => n + 1);
          }}
        >
          刷新对话
        </Button>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          description="已读取的记录已保留，重试将从失败的分页继续。"
          action={
            <Button disabled={pending} onClick={() => setReload((n) => n + 1)}>
              重试
            </Button>
          }
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
        <MarkdownMessage text={entry.data.text ?? ''} />
      ) : (
        <span className="event-content">{describeEvent(entry)}</span>
      )}
    </>
  );
}

/** 本人作品元数据先鉴权，再创建独立副本；保存由同一 workId 的 edit/save 更新。 */
function PersonalWorkDetail({
  workId,
  onDeleted,
  onBack,
  onDirty,
  onBusy,
}: {
  workId: string;
  onDeleted: () => void;
  onBack: () => void;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
}) {
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyChanged = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty?.(value);
    },
    [onDirty],
  );
  const busyChanged = useCallback(
    (value: boolean) => {
      setSaving(value);
      onBusy?.(value);
    },
    [onBusy],
  );
  const [work, setWork] = useState<PersonalWork | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    data<PersonalWork>(`/my-works/${id(workId)}`, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) setWork(value);
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [workId, reload]);
  if (!work)
    return error ? (
      <Alert
        type="error"
        showIcon
        title={error}
        action={<Button onClick={() => setReload((value) => value + 1)}>重试</Button>}
      />
    ) : (
      <Skeleton active />
    );
  return (
    <>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={() => setReload((value) => value + 1)}>重试</Button>}
        />
      )}
      <div className="community-detail-heading">
        <div className="community-detail-leading">
          <Button onClick={onBack}>← 返回已保存作品</Button>
          <div className="community-detail-identity">
            <h2>{work.name}</h2>
            <span>{work.target.toUpperCase()}</span>
            <time dateTime={work.createdAt} title={work.createdAt}>
              创建于 {formatTime(work.createdAt)}
            </time>
          </div>
        </div>
        <div className="community-actions">
          <Button
            className="work-action-download"
            icon={<Icon name="download" />}
            href={`/api/d2c/my-works/${id(workId)}/archive`}
          >
            下载 ZIP
          </Button>
          <DeleteSavedItem
            kind="work"
            itemId={workId}
            name={work.name}
            revision={work.revision}
            onDeleted={onDeleted}
            onRefresh={() => setReload((value) => value + 1)}
            disabled={saving}
            hasUnsavedChanges={dirty}
          />
        </div>
      </div>
      {work.canManage === false ? (
        <Alert
          type="info"
          showIcon
          title="当前作品仅支持下载"
          description="该作品暂不可编辑，请下载源码或刷新页面后重试。"
        />
      ) : (
        <EditWorkspaceSurface
          sessionId={workId}
          sourceName={work.name}
          options={detachedEditOptions('my-works', workId)}
          embedded
          onClose={onBack}
          onApplied={() => {}}
          onSaved={() => setReload((value) => value + 1)}
          onDirty={dirtyChanged}
          onBusy={busyChanged}
        />
      )}
    </>
  );
}

/** 广场和本人副本集合使用服务端分页，不合并或改变现有冻结版本。 */
export default function CommunityPanel({
  kind,
  resourceId,
  onSelect,
  onDirty,
  onBusy,
  onDeleted: onRecordDeleted,
  onOpenSession,
  plazaScope,
  onScopeChange,
  onKindChange,
  navigationDisabled = false,
}: {
  kind: Kind;
  resourceId: string;
  onSelect: (value: string) => void;
  onVersions?: () => void;
  onDirty?: (value: boolean) => void;
  onBusy?: (value: boolean) => void;
  onDeleted?: () => void;
  onOpenSession?: (workspaceId: string, sessionId: string) => void;
  plazaScope?: 'all' | 'mine';
  onScopeChange?: (scope: 'all' | 'mine') => void;
  onKindChange?: (kind: Kind) => void;
  navigationDisabled?: boolean;
}) {
  const [localScope, setLocalScope] = useState<'all' | 'mine'>('all');
  const scope = plazaScope ?? localScope;
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
      `${kind === 'plaza' ? '/plaza/sessions' : '/my-works'}?page=${page}&pageSize=12${kind === 'plaza' && scope === 'mine' ? '&scope=mine' : ''}`,
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) {
          const lastPage = Math.max(1, Math.ceil(value.total / 12));
          if (page > lastPage) setPage(lastPage);
          else setList(value);
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
  }, [kind, resourceId, page, reload, scope]);
  function deleted() {
    if (list?.items.length === 1 && page > 1) setPage((value) => value - 1);
    else setReload((value) => value + 1);
  }
  const title = kind === 'plaza' ? '广场' : '已保存作品';
  /** 分类与筛选共用一层导航；跨分类由主入口保留原离开保护。 */
  function selectCollection(value: 'all' | 'mine' | 'saved') {
    setPage(1);
    if (value === 'saved') {
      if (kind !== 'my-works') onKindChange?.('my-works');
    } else {
      setLocalScope(value);
      onScopeChange?.(value);
      if (kind !== 'plaza') onKindChange?.('plaza');
    }
  }
  return (
    <section
      className={`works-panel community-panel${resourceId ? ' community-panel-detail' : ''}`}
      aria-label={title}
    >
      {!resourceId && (
        <div className="community-collection-toolbar">
          <nav className="community-category-nav" aria-label="广场分类">
            {(
              [
                ['all', '全部作品'],
                ['mine', '我发布的作品'],
                ['saved', '已保存作品'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={
                  navigationDisabled ||
                  (!onKindChange && (value === 'saved' ? kind !== 'my-works' : kind !== 'plaza'))
                }
                aria-current={
                  (value === 'saved' ? kind === 'my-works' : kind === 'plaza' && scope === value)
                    ? 'page'
                    : undefined
                }
                onClick={() => selectCollection(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="community-collection-meta">
            {list && <span className="works-total">共 {list.total} 个作品</span>}
            <Button
              type="text"
              icon={<Icon name="refresh" />}
              title="刷新作品"
              aria-label="刷新作品"
              loading={loading}
              onClick={() => setReload((n) => n + 1)}
            />
          </div>
        </div>
      )}
      {resourceId ? (
        kind === 'plaza' ? (
          <PublicSession
            key={resourceId}
            shareId={resourceId}
            onBack={() => onSelect('')}
            onDirty={onDirty}
            onBusy={onBusy}
            onOpenSession={onOpenSession}
            navigationDisabled={navigationDisabled}
          />
        ) : (
          <PersonalWorkDetail
            key={resourceId}
            workId={resourceId}
            onDeleted={() => (onRecordDeleted ? onRecordDeleted() : onSelect(''))}
            onBack={() => onSelect('')}
            onDirty={onDirty}
            onBusy={onBusy}
          />
        )
      ) : (
        <>
          {error && <Alert type="error" title={error} />}
          {loading && <Skeleton active />}
          <div className="works-grid library-works-grid">
            {list?.items.map((item) => {
              const resource = 'shareId' in item ? item.shareId : item.workId;
              return (
                <article className="work-card library-work-card" key={resource}>
                  <WorkCover
                    url={item.coverUrl}
                    name={item.name}
                    kind="runtime"
                    className="community-cover"
                    onOpen={() => onSelect(resource)}
                  />
                  <div className="work-card-body">
                    <h2>
                      <Button type="link" onClick={() => onSelect(resource)}>
                        {item.name}
                      </Button>
                    </h2>
                    <span>{item.target.toUpperCase()}</span>
                    {'creatorName' in item && (
                      <span>{item.creatorName || item.createdEid || '未知创建人'}</span>
                    )}
                    <time dateTime={item.createdAt} title={item.createdAt}>
                      创建于 {formatTime(item.createdAt)}
                    </time>
                    <div className="work-card-actions">
                      <Button
                        className="work-action-view"
                        type="primary"
                        ghost
                        icon={<Icon name="play" />}
                        onClick={() => onSelect(resource)}
                      >
                        {kind === 'plaza' ? '打开作品' : '查看作品'}
                      </Button>
                      {'shareId' in item && (
                        <PublishedSessionActions
                          session={item}
                          onOpenSession={onOpenSession}
                          onUnpublished={deleted}
                          compact
                        />
                      )}
                      {'workId' in item && (
                        <Button
                          className="work-action-download"
                          aria-label="下载 ZIP"
                          title="下载 ZIP"
                          icon={<Icon name="download" />}
                          href={`/api/d2c/my-works/${id(item.workId)}/archive`}
                        />
                      )}
                      {'workId' in item && (
                        <DeleteSavedItem
                          kind="work"
                          itemId={item.workId}
                          name={item.name}
                          revision={item.revision}
                          onDeleted={deleted}
                          onRefresh={() => setReload((value) => value + 1)}
                        />
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
          {list && !list.total && (
            <Empty
              description={
                kind === 'plaza' ? (
                  scope === 'mine' ? (
                    '暂无已发布的作品，可在工作台会话中发布到广场。'
                  ) : (
                    '暂无公开会话'
                  )
                ) : (
                  <span>
                    暂无已保存作品。前往<a href="/plaza">广场</a>打开作品并编辑，
                    点击“保存为作品”后即可在这里查看。
                  </span>
                )
              }
            />
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
