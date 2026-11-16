import FileTypeIcon from '../components/FileTypeIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Input, Tree, Segmented } from 'antd';
import SessionPreviewPanel from './SessionPreviewPanel';
import { data, errorMessage, id } from './api';
import FilePreview from './FilePreview';
import VersionsPanel from './VersionsPanel';
import ValidationNotice from './ValidationNotice';
import type { FileList } from './types';
import Icon from '../components/Icon';
import { buildFileTree, directoryKeys } from './fileTree';
import EditWorkspace from './EditWorkspace';
import DesignReferencePanel from './DesignReferencePanel';
import type { InspectorSourceRequest } from './PreviewInspector';

/** 文件列表均可选择查看；文本内容只读，元数据修订驱动预览刷新。 */
export default function FilesPanel({
  sessionId,
  refresh,
  versionRefresh = 0,
  previewRevision = 0,
  busy = false,
  validationState,
}: {
  sessionId: string;
  refresh: number;
  versionRefresh?: number;
  previewRevision?: number;
  busy?: boolean;
  validationState?: Record<string, unknown> | null;
}) {
  const [view, setView] = useState<string | number>('preview');
  const [sourceSearch, setSourceSearch] = useState<
    (InspectorSourceRequest & { requestId: string }) | undefined
  >();
  const [list, setList] = useState<FileList | null>(null);
  const [listSessionId, setListSessionId] = useState('');
  const [selected, setSelected] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const initialized = useRef(false);
  const tree = useMemo(() => buildFileTree(list?.files ?? [], search), [list, search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    data<FileList>(`/sessions/${id(sessionId)}/files`, { signal: controller.signal }).then(
      (value) => {
        if (!controller.signal.aborted) {
          setList(value);
          setListSessionId(sessionId);
          if (!initialized.current) {
            initialized.current = true;
            setExpanded(
              buildFileTree(value.files)
                .filter((node) => !node.isLeaf)
                .map((node) => node.key),
            );
          }
          setSelected((prior) => (value.files.some((file) => file.fileId === prior) ? prior : ''));
          setError('');
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
  }, [sessionId, refresh, reload]);
  return (
    <section className="files-panel">
      {error && <Alert type="error" showIcon title={error} className="feedback-alert" />}
      <div className="session-files-tabs">
        <Segmented
          size="small"
          aria-label="会话产物视图"
          value={view}
          onChange={setView}
          options={[
            { label: '运行预览', value: 'preview' },
            { label: '源码与资源', value: 'source' },
            { label: '设计稿截图', value: 'design' },
          ]}
        />
        <EditWorkspace
          key={sessionId}
          sessionId={sessionId}
          disabled={
            loading ||
            listSessionId !== sessionId ||
            !list?.files.some((file) => file.kind === 'source')
          }
          sourceSearch={sourceSearch}
          onApplied={() => setReload((value) => value + 1)}
        />
      </div>
      <SessionPreviewPanel
        key={sessionId}
        sessionId={sessionId}
        files={listSessionId === sessionId ? list?.files : undefined}
        previewRevision={previewRevision}
        active={view === 'preview'}
        onLocateSource={
          listSessionId === sessionId &&
          !loading &&
          list?.files.some((file) => file.kind === 'source')
            ? (request) => setSourceSearch({ ...request, requestId: crypto.randomUUID() })
            : undefined
        }
      />
      {view === 'design' && (
        <DesignReferencePanel
          key={`design:${sessionId}`}
          files={listSessionId === sessionId ? list?.files : undefined}
          loading={loading}
          onRefresh={() => setReload((value) => value + 1)}
        />
      )}
      <div className="files-layout" hidden={view !== 'source'}>
        <nav className="file-list" aria-label="会话文件">
          <div className="file-tree-heading">
            <h3>
              文件 <span className="count">{list?.files.length ?? 0}</span>
              {validationState && <ValidationNotice state={validationState} />}
            </h3>
            <button
              type="button"
              className="quiet icon-button"
              aria-label="刷新文件列表"
              title="刷新文件列表"
              disabled={loading}
              aria-busy={loading}
              onClick={() => setReload((value) => value + 1)}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="file-tree-toolbar">
            <Input.Search
              size="small"
              placeholder="搜索文件"
              aria-label="搜索文件"
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              className="quiet"
              type="button"
              disabled={!!search.trim()}
              onClick={() => setExpanded(expanded.length ? [] : directoryKeys(tree))}
            >
              {expanded.length ? '收起目录' : '展开目录'}
            </button>
          </div>
          <div className="file-tree-scroll">
            {loading && !list && <p className="muted">正在加载文件…</p>}
            {list && !list.files.length && <p className="empty">暂无文件</p>}
            {!!list?.files.length && !tree.length && <p className="empty">没有匹配的文件。</p>}
            <Tree.DirectoryTree
              showIcon
              icon={(node) => (
                <FileTypeIcon
                  path={(node as { data?: { file?: { path: string } } }).data?.file?.path ?? ''}
                  directory={!node.isLeaf}
                  expanded={node.expanded}
                />
              )}
              blockNode
              treeData={tree}
              expandedKeys={search.trim() ? directoryKeys(tree) : expanded}
              onExpand={(keys) => setExpanded(keys.map(String))}
              selectedKeys={selected ? [selected] : []}
              onSelect={(keys, info) => {
                if (info.node.isLeaf && keys[0]) setSelected(String(keys[0]));
              }}
              titleRender={(node) => (
                <span className="file-tree-name" title={node.file?.path ?? node.title}>
                  {node.title}
                </span>
              )}
            />
          </div>
        </nav>
        {selected && list ? (
          <FilePreview
            key={selected}
            sessionId={sessionId}
            fileId={selected}
            current={list.files.find((file) => file.fileId === selected)}
          />
        ) : (
          <div className="editor-empty">选择文件查看</div>
        )}
      </div>
      <VersionsPanel key={`versions:${sessionId}`} sessionId={sessionId} refresh={versionRefresh} />
    </section>
  );
}
