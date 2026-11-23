import { appPath } from './appRoutes';
import DeleteSavedItem from './DeleteSavedItem';
import WorkCover from './WorkCover';
import FileTypeIcon from '../components/FileTypeIcon';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Image,
  Input,
  Pagination,
  Segmented,
  Select,
  Tag,
  Tree,
  Tabs,
  Skeleton,
} from 'antd';
import { data, errorMessage, id } from './api';
import type { FileInfo, TextFile, VersionMetadata } from './types';
import { buildFileTree, isPreviewImage } from './fileTree';
import { versionValidationLabel } from './VersionsPanel';
import PreviewPanel from './PreviewPanel';
import Icon from '../components/Icon';
import DesignReferencePanel from './DesignReferencePanel';
import { useTeams } from './TeamSettings';

const CodePreview = lazy(() => import('./CodePreview'));
type Work = VersionMetadata & {
  createdUserId: string | null;
  creatorName: string | null;
  coverUrl?: string | null;
  canDelete?: boolean;
};
type WorkPage = { rows: Work[]; total: number; page: number; pageSize: number };
type WorkDetail = Work & {
  files: FileInfo[];
  sourceSession?: { workspaceId: string; sessionId: string } | null;
};

/** 作品筛选沿用版本接口；详情、源码与下载仍使用原有版本定位协议。 */
export function worksListPath(scope: 'mine' | 'all' | 'team', teamId: string, page: number) {
  const query = new URLSearchParams({
    scope,
    page: String(page),
    pageSize: '12',
  });
  if (scope === 'team') query.set('teamId', teamId);
  return `/versions?${query}`;
}

/** 检查状态独立于版本保存状态，保留未知结果的原始说明。 */
function ValidationTag({ summary }: { summary: VersionMetadata['validationSummary'] }) {
  const color =
    summary?.status === 'passed' ? 'success' : summary?.status === 'failed' ? 'warning' : 'default';
  return <Tag color={color}>{versionValidationLabel(summary)}</Tag>;
}

/** 统一展示本地日期，完整时间保留在原生提示中。 */
function createdTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 读取冻结版本文件；文本只高亮展示，图片通过已保存的产物直链显示。 */
function WorkFile({ versionId, file }: { versionId: string; file: FileInfo }) {
  const [text, setText] = useState<TextFile | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError('');
    if (file.kind === 'source')
      data<TextFile>(`/versions/${id(versionId)}/files/${id(file.fileId)}`, {
        signal: controller.signal,
      }).then(
        (value) => {
          if (!controller.signal.aborted) setText(value);
        },
        (reason) => {
          if (!controller.signal.aborted) setError(errorMessage(reason));
        },
      );
    return () => controller.abort();
  }, [versionId, file.fileId, file.kind]);
  return (
    <section className="work-file">
      <div className="work-file-heading">
        <Icon name="file" />
        <strong>{file.path}</strong>
        <span>只读</span>
      </div>
      {error && <Alert type="error" title={error} showIcon />}
      {file.kind === 'source' ? (
        text ? (
          <Suspense fallback={<p>加载代码预览…</p>}>
            <CodePreview content={text.content} path={file.path} />
          </Suspense>
        ) : (
          !error && <p>正在读取源码…</p>
        )
      ) : isPreviewImage(file) && file.url ? (
        <Image src={file.url} alt={file.path} />
      ) : (
        <p>该附件请下载 ZIP 查看。</p>
      )}
    </section>
  );
}

/** 全用户只读作品列表和可直接访问的版本页，与源会话导航解耦。 */
export default function WorksPanel({
  versionId,
  onSelect,
  onOpenSession,
}: {
  versionId: string;
  onSelect: (value: string) => void;
  onOpenSession?: (workspaceId: string, sessionId: string) => void;
}) {
  const [scope, setScope] = useState<'mine' | 'all' | 'team'>('mine');
  const [teamId, setTeamId] = useState('');
  const directory = useTeams();
  const validTeam = directory.teams.some((team) => team.teamId === teamId);
  const effectiveScope = scope === 'team' && !validTeam ? 'mine' : scope;
  useEffect(() => {
    if (!directory.loading && !directory.error && teamId && !validTeam) {
      setTeamId('');
      if (scope === 'team') {
        setScope('mine');
        setPage(1);
      }
    }
  }, [directory.loading, directory.error, teamId, validTeam, scope]);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<WorkPage | null>(null);
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [fileId, setFileId] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDetail(null);
    setList(null);
    setFileId('');
    setCopyMessage('');
    setSearch('');
    const path = versionId
      ? `/versions/${id(versionId)}`
      : worksListPath(effectiveScope, teamId, page);
    data<WorkDetail | WorkPage>(path, { signal: controller.signal }).then(
      (value) => {
        if (controller.signal.aborted) return;
        if (versionId) {
          setDetail(value as WorkDetail);
          setFileId((value as WorkDetail).files[0]?.fileId ?? '');
        } else {
          const result = value as WorkPage;
          const lastPage = Math.max(1, Math.ceil(result.total / 12));
          if (page > lastPage) setPage(lastPage);
          else setList(result);
        }
        setLoading(false);
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(reason));
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [effectiveScope, teamId, page, versionId, reload, directory.revision]);
  const selected = detail?.files.find((file) => file.fileId === fileId);
  function deleted() {
    if (versionId) onSelect('');
    else if (list?.rows.length === 1 && page > 1) setPage((value) => value - 1);
    else setReload((value) => value + 1);
  }
  return (
    <section className="works-panel">
      <div className="works-heading">
        <div className="works-heading-leading">
          {versionId && (
            <Button
              type="text"
              icon={<Icon name="arrow" style={{ transform: 'rotate(180deg)' }} />}
              onClick={() => onSelect('')}
            >
              返回会话版本
            </Button>
          )}
          <h1>{versionId ? (detail?.name ?? '版本详情') : '会话版本'}</h1>
        </div>
        <div className="works-heading-actions">
          <Button
            icon={<Icon name="refresh" />}
            loading={loading}
            onClick={() => {
              setReload((value) => value + 1);
              directory.reload();
            }}
          >
            刷新
          </Button>
        </div>
      </div>
      {!versionId && (
        <div className="works-toolbar">
          <Segmented
            options={[
              { label: '我的版本', value: 'mine' },
              { label: '全部版本', value: 'all' },
              {
                label: '团队版本',
                value: 'team',
                disabled: directory.loading || !directory.teams.length,
              },
            ]}
            value={effectiveScope}
            onChange={(value) => {
              setScope(value as 'mine' | 'all' | 'team');
              if (value === 'team' && !validTeam) setTeamId(directory.teams[0]?.teamId ?? '');
              setPage(1);
            }}
          />
          {effectiveScope === 'team' && (
            <Select
              className="works-team-select"
              aria-label="作品团队"
              value={teamId}
              disabled={directory.loading}
              options={directory.teams.map((team) => ({
                value: team.teamId,
                label: team.name,
              }))}
              onChange={(value) => {
                setTeamId(value);
                setPage(1);
              }}
            />
          )}
          <span className="works-total">
            {loading ? '正在读取版本' : `共 ${list?.total ?? 0} 个版本`}
          </span>
        </div>
      )}
      {(error || (!versionId && directory.error)) && (
        <Alert type="error" title={error || directory.error} showIcon />
      )}
      {loading ? (
        <div className="works-loading" role="status" aria-label="正在加载作品">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : (
        !error &&
        (versionId ? (
          detail && (
            <>
              <div className="work-summary">
                <div className="work-summary-info">
                  <div className="work-summary-tags">
                    <Tag className={`work-target ${detail.target}`}>
                      {detail.target.toUpperCase()}
                    </Tag>
                    <ValidationTag summary={detail.validationSummary} />
                  </div>
                  <div className="work-meta">
                    <span>{detail.creatorName || detail.createdUserId || '未知创建人'}</span>
                    <time dateTime={detail.createdAt} title={detail.createdAt}>
                      {createdTime(detail.createdAt)}
                    </time>
                    <span>{detail.files.length} 个文件</span>
                    <span>文件修订 r{detail.sourceFileRevision}</span>
                  </div>
                </div>
                <div className="work-summary-actions">
                  {detail.sourceSession ? (
                    <Button
                      icon={<Icon name="chat" />}
                      href={appPath({ view: 'workbench', ...detail.sourceSession })}
                      onClick={(event) => {
                        if (
                          onOpenSession &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey &&
                          event.button === 0
                        ) {
                          event.preventDefault();
                          onOpenSession(
                            detail.sourceSession!.workspaceId,
                            detail.sourceSession!.sessionId,
                          );
                        }
                      }}
                    >
                      查看来源会话
                    </Button>
                  ) : (
                    <span className="muted">来源会话已删除或无权访问</span>
                  )}
                  {detail.canDelete && (
                    <DeleteSavedItem
                      kind="version"
                      itemId={detail.versionId}
                      name={detail.name}
                      onDeleted={deleted}
                      onRefresh={() => setReload((value) => value + 1)}
                    />
                  )}

                  <Button
                    type="primary"
                    icon={<Icon name="file" />}
                    href={`/api/d2c/versions/${id(versionId)}/archive`}
                  >
                    下载 ZIP
                  </Button>
                  <Button
                    icon={<Icon name="external" />}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(window.location.href);
                        setCopyMessage('版本链接已复制');
                      } catch {
                        setCopyMessage('复制失败，请复制地址栏链接');
                      }
                    }}
                  >
                    复制链接
                  </Button>
                </div>
              </div>
              {copyMessage && <p role="status">{copyMessage}</p>}
              <Tabs
                className="work-detail-tabs"
                defaultActiveKey="preview"
                items={[
                  {
                    key: 'preview',
                    label: (
                      <span className="work-tab-label">
                        <Icon name="play" />
                        运行预览
                      </span>
                    ),
                    children: (
                      <PreviewPanel
                        key={versionId}
                        versionId={versionId}
                        files={detail.files}
                        target={detail.target}
                      />
                    ),
                  },
                  {
                    key: 'design',
                    label: '设计稿截图',
                    children: <DesignReferencePanel key={versionId} files={detail.files} />,
                  },
                  {
                    key: 'files',
                    label: (
                      <span className="work-tab-label">
                        <Icon name="code" />
                        源码与资源 <span className="work-tab-count">{detail.files.length}</span>
                      </span>
                    ),
                    children: (
                      <div className="work-browser">
                        <nav aria-label="版本文件目录">
                          <div className="work-directory-heading">
                            <strong>文件</strong>
                          </div>
                          <Input.Search
                            aria-label="搜索版本文件"
                            placeholder="搜索文件"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                          />
                          <Tree
                            showIcon
                            icon={(node) => (
                              <FileTypeIcon
                                path={
                                  (
                                    node as {
                                      data?: { file?: { path: string } };
                                    }
                                  ).data?.file?.path ?? ''
                                }
                                directory={!node.isLeaf}
                                expanded={node.expanded}
                              />
                            )}
                            key={`${versionId}:${search}`}
                            treeData={buildFileTree(detail.files, search)}
                            defaultExpandAll
                            selectedKeys={[fileId]}
                            onSelect={(keys) => {
                              const key = String(keys[0] ?? '');
                              if (detail.files.some((file) => file.fileId === key)) setFileId(key);
                            }}
                          />
                        </nav>
                        {selected ? (
                          <WorkFile
                            key={`${versionId}:${selected.fileId}`}
                            versionId={versionId}
                            file={selected}
                          />
                        ) : (
                          <p>选择文件查看</p>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </>
          )
        ) : (
          <>
            <div className="works-grid library-works-grid">
              {list?.rows.map((work) => (
                <article key={work.versionId} className="work-card library-work-card">
                  <div className="work-card-body">
                    <div className="work-card-top">
                      <Tag className={`work-target ${work.target}`}>
                        {work.target.toUpperCase()}
                      </Tag>
                    </div>
                    <h2 title={work.name}>
                      <a
                        href={`/works/versions/${id(work.versionId)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          onSelect(work.versionId);
                        }}
                      >
                        {work.name}
                      </a>
                    </h2>
                    <div className="work-card-author">
                      <span>{work.creatorName || work.createdUserId || '未知创建人'}</span>
                    </div>
                    <time dateTime={work.createdAt} title={work.createdAt}>
                      {createdTime(work.createdAt)}
                    </time>
                    <div className="work-card-validation">
                      <ValidationTag summary={work.validationSummary} />
                    </div>
                    <div className="work-card-actions">
                      <Button
                        className="work-action-view"
                        type="primary"
                        ghost
                        icon={<Icon name="play" />}
                        onClick={() => onSelect(work.versionId)}
                      >
                        查看版本
                      </Button>
                      <Button
                        className="work-action-download"
                        icon={<Icon name="download" />}
                        href={`/api/d2c/versions/${id(work.versionId)}/archive`}
                      >
                        下载 ZIP
                      </Button>
                      {work.canDelete && (
                        <DeleteSavedItem
                          kind="version"
                          itemId={work.versionId}
                          name={work.name}
                          onDeleted={deleted}
                          onRefresh={() => setReload((value) => value + 1)}
                        />
                      )}
                    </div>
                  </div>
                  <WorkCover
                    url={work.coverUrl}
                    name={work.name}
                    kind="work"
                    onOpen={() => onSelect(work.versionId)}
                  />
                </article>
              ))}
            </div>
            {list && !list.total && (
              <p className="works-empty" role="status">
                {scope === 'mine'
                  ? '暂无会话版本。前往工作台打开会话，点击“暂存版本”后即可在这里查看。'
                  : '暂无会话版本'}
              </p>
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
        ))
      )}
    </section>
  );
}
