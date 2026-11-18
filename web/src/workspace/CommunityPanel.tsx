import './community.css';
import './editWorkspace.css';
import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Pagination, Select, Skeleton, Tabs } from 'antd';
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
import type { FileInfo, TimelineEntry, TimelinePage } from './types';
import { mergeTimeline, describeEvent } from './timeline';
import { groupConversationRounds } from './roundProjection';
import ConversationRound from './ConversationRound';
import MarkdownMessage from '../components/MarkdownMessage';
import MessageImages from './MessageImages';
import FilePreview from './FilePreview';
import EditWorkspace from './EditWorkspace';

type Kind = 'plaza' | 'my-works';

/** 独立详情不挂载输入框、队列、暂停、应用或私有会话组件。 */
export function PublicSession({ shareId }: { shareId: string }) {
  const root = `/plaza/sessions/${id(shareId)}`;
  const [detail, setDetail] = useState<SharedSession | null>(null);
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [fileId, setFileId] = useState('');
  const [previousSeq, setPreviousSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError('');
    setHistoryError('');
    Promise.all([
      data<SharedSession>(root, { signal: controller.signal }),
      data<FileInfo[]>(`${root}/files`, { signal: controller.signal }),
      data<TimelinePage>(`${root}/timeline?beforeSeq=0&limit=500`, { signal: controller.signal }),
    ]).then(
      ([session, list, timeline]) => {
        if (controller.signal.aborted) return;
        setDetail(session);
        setFiles(list);
        setFileId((current) =>
          list.some((file) => file.fileId === current) ? current : (list[0]?.fileId ?? ''),
        );
        setEntries(mergeTimeline([], timeline.entries, session.sessionId, Infinity));
        setPreviousSeq(timeline.previousSeq ?? timeline.entries[0]?.seq ?? 0);
        setHasMore(timeline.hasMore);
        setPending(false);
      },
      (reason) => {
        if (!controller.signal.aborted) {
          /** 下架或权限变化时立即移除已展示的数据。 */
          setDetail(null);
          setEntries([]);
          setFiles([]);
          setError(errorMessage(reason));
          setPending(false);
        }
      },
    );
    return () => controller.abort();
  }, [root, reload]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  /** 历史读取随详情刷新或卸载取消。 */
  const [historyRequest] = useState(() => ({ current: null as AbortController | null }));
  useEffect(() => () => historyRequest.current?.abort(), [root, reload, historyRequest]);
  async function loadEarlier() {
    if (!detail || loadingHistory || pending) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const page = await data<TimelinePage>(`${root}/timeline?beforeSeq=${previousSeq}&limit=500`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const before = page.previousSeq ?? page.entries[0]?.seq ?? 0;
      if (page.hasMore && (!before || before >= previousSeq)) throw new Error('历史记录游标无效');
      setEntries((current) => mergeTimeline(page.entries, current, detail.sessionId, Infinity));
      setPreviousSeq(before);
      setHasMore(page.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted) setHistoryError(errorMessage(reason));
    } finally {
      setLoadingHistory(false);
    }
  }
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
  const selected = files.find((file) => file.fileId === fileId);
  return (
    <SessionReadRoot.Provider value={root}>
      <div className="community-detail-heading">
        <div>
          <h2>{detail.name}</h2>
          <span>
            {detail.creatorName || detail.createdEid} · {detail.target.toUpperCase()}
          </span>
        </div>
        <div className="community-actions">
          <Button
            loading={pending}
            disabled={loadingHistory}
            onClick={() => setReload((n) => n + 1)}
          >
            刷新
          </Button>
          <EditWorkspace
            sessionId={shareId}
            options={detachedEditOptions('plaza', shareId)}
            onApplied={() => {}}
          />
        </div>
      </div>
      <Tabs
        defaultActiveKey="chat"
        items={[
          {
            key: 'chat',
            label: '对话',
            children: (
              <div className="community-conversation">
                {hasMore && (
                  <Button
                    loading={loadingHistory}
                    disabled={pending}
                    onClick={() => void loadEarlier()}
                  >
                    加载更早记录
                  </Button>
                )}
                {historyError && <Alert type="error" title={historyError} />}
                <ol className="timeline">
                  {groupConversationRounds(entries, null).map((round) => (
                    <ConversationRound
                      key={round.key}
                      entries={round.entries}
                      active={false}
                      revision={detail.timelineSeq}
                      onLayoutChange={() => {}}
                      renderMessage={(entry) => (
                        <PublicMessage entry={publicTimelineEntry(entry, shareId)} />
                      )}
                    />
                  ))}
                </ol>
                {!entries.length && <Empty description="暂无对话" />}
              </div>
            ),
          },
          {
            key: 'files',
            label: `产物 (${files.length})`,
            children: (
              <>
                <Select
                  aria-label="选择产物"
                  className="community-file-select"
                  value={fileId || undefined}
                  onChange={setFileId}
                  showSearch
                  optionFilterProp="label"
                  options={files.map((file) => ({ value: file.fileId, label: file.path }))}
                />
                {selected && (
                  <FilePreview
                    key={`${shareId}:${fileId}`}
                    sessionId={detail.sessionId}
                    apiRoot={root}
                    fileId={fileId}
                    current={selected}
                  />
                )}
                {!files.length && <Empty description="暂无产物" />}
              </>
            ),
          },
        ]}
      />
    </SessionReadRoot.Provider>
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
}: {
  kind: Kind;
  resourceId: string;
  onSelect: (value: string) => void;
  onVersions: () => void;
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
    <section className="works-panel community-panel">
      <div className="works-heading">
        <h1>{title}</h1>
        <div className="community-actions">
          {resourceId && <Button onClick={() => onSelect('')}>返回{title}</Button>}
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
          <PublicSession key={resourceId} shareId={resourceId} />
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
                      {kind === 'plaza' ? '查看会话' : '查看作品'}
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
