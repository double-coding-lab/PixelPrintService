import React, {
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useState,
  useSyncExternalStore,
  lazy,
  Suspense,
  type Ref,
} from 'react';
import { Alert, Button, Modal, Segmented, Select } from 'antd';
import PreviewInspector, {
  PreviewInspectorButton,
  usePreviewInspector,
  type InspectorSourceRequest,
} from './PreviewInspector';
import {
  EditWorkspaceController,
  editChanges,
  editDirty,
  editNeedsExitConfirmation,
  editPreviewUrl,
  type EditWorkspaceOptions,
} from './editWorkspaceState';
import EditableFileTree from './EditableFileTree';
import { filterEditableFiles } from './editableFiles';
import Icon from '../components/Icon';
import FileTypeIcon from '../components/FileTypeIcon';
import GlobalSearch from './EditorSearch';
import type { EditorReveal } from './globalSearch';

export type SourceSearchRequest = InspectorSourceRequest & { requestId: string };

const CodeEditor = lazy(() => import('./CodeEditor'));

/** 挂载一次对应一次全新副本，关闭后重新进入不会复用上次状态。 */
export default function EditWorkspace({
  sessionId,
  disabled = false,
  onApplied,
  sourceSearch,
  options,
  label = '在线编辑',
}: {
  label?: string;
  options?: EditWorkspaceOptions;
  sourceSearch?: SourceSearchRequest;
  sessionId: string;
  disabled?: boolean;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const handledSearch = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sourceSearch || handledSearch.current === sourceSearch.requestId) return;
    handledSearch.current = sourceSearch.requestId;
    setOpen(true);
  }, [sourceSearch?.requestId]);
  return (
    <>
      <Button size="small" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <EditWorkspaceDialog
          key={`${sessionId}:${options?.root ?? 'private'}`}
          options={options}
          sessionId={sessionId}
          sourceSearch={sourceSearch}
          onClose={() => setOpen(false)}
          onApplied={() => {
            onApplied();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

/** 宽度变化重建 iframe，让 RN 在新视口重新初始化 Dimensions。 */
export function EditWorkspaceFrame({
  revision,
  url,
  width,
  inspectorRef,
  active = true,
  onLoad,
}: {
  revision: number;
  url: string;
  width: string | number;
  inspectorRef: Ref<HTMLIFrameElement>;
  active?: boolean;
  onLoad?: () => void;
}) {
  return (
    <iframe
      key={`${revision}:${url}:${width}`}
      ref={inspectorRef}
      title="临时副本浏览器预览"
      className={active ? undefined : 'edit-workspace-next-frame'}
      aria-hidden={!active}
      onLoad={onLoad}
      src={url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ width: width === 'auto' ? '100%' : width }}
    />
  );
}

/** 新入口首帧加载完成才替换旧画面，过期 iframe 的回调不能恢复旧入口。 */
export function EditWorkspacePreviewFrames({
  url,
  revision,
  width,
  inspectorRef,
  onShown,
}: {
  url: string | null;
  revision: number;
  width: string | number;
  inspectorRef: Ref<HTMLIFrameElement>;
  onShown?: (url: string) => void;
}) {
  const [shown, setShown] = useState<{ url: string; revision: number } | null>(null);
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const frames = shown ? [shown] : [];
  if (url && url !== shown?.url) frames.push({ url, revision });
  return (
    <>
      {frames.map((frame) => (
        <EditWorkspaceFrame
          key={frame.url}
          revision={frame.revision}
          url={frame.url}
          width={width}
          active={frame.url === shown?.url}
          inspectorRef={frame.url === shown?.url ? inspectorRef : null}
          onLoad={() => {
            if (frame.url === currentUrl.current) {
              setShown(frame);
              onShown?.(frame.url);
            }
          }}
        />
      ))}
      {!shown && (
        <p className="edit-workspace-empty">{url ? '正在加载所选页面…' : '正在准备预览…'}</p>
      )}
    </>
  );
}

/** 编辑器与独立沙盒并排；仅保存副本，应用动作显式提交当前已保存修订。 */
function EditWorkspaceDialog({
  sessionId,
  sourceSearch,
  onClose,
  onApplied,
  options,
}: {
  options?: EditWorkspaceOptions;
  sessionId: string;
  onClose: () => void;
  onApplied: () => void;
  sourceSearch?: SourceSearchRequest;
}) {
  const [controller] = useState(() => new EditWorkspaceController(sessionId, undefined, options));
  const detached = !!options?.detached;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { copy, files, entryPath, pending, error } = state;
  const [selectedPath, setSelectedPath] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!sourceSearch);
  const [searchQuery, setSearchQuery] = useState(sourceSearch?.query ?? '');
  const [searchProperty, setSearchProperty] = useState(sourceSearch?.property);
  const [searchFocus, setSearchFocus] = useState(0);
  const [sourceSearchVersion, setSourceSearchVersion] = useState(0);
  const [reveal, setReveal] = useState<EditorReveal>();
  const revealSequence = useRef(0);
  /** 搜索请求只改变导航状态，保留当前 controller 及其未保存源码。 */
  const locateSource = useCallback((request: InspectorSourceRequest) => {
    setSearchQuery(request.query);
    setSearchProperty(request.property);
    setSourceSearchVersion((prior) => prior + 1);
    setSearchOpen(true);
    setSearchFocus((prior) => prior + 1);
  }, []);
  useEffect(() => {
    if (sourceSearch) locateSource(sourceSearch);
  }, [sourceSearch?.requestId, locateSource]);
  useEffect(() => {
    /** 捕获 Monaco 的快捷键前打开并聚焦当前副本搜索。 */
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        setSearchProperty(undefined);
        setSearchOpen(true);
        setSearchFocus((prior) => prior + 1);
      }
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);
  const [width, setWidth] = useState<string | number>(375);
  const editable = useMemo(() => filterEditableFiles(files), [files]);
  const selected = editable.find((file) => file.path === selectedPath) ?? editable[0];
  const dirtyPaths = editable
    .filter((file) => copy?.files.find((old) => old.path === file.path)?.content !== file.content)
    .map((file) => file.path);
  const dirty = editDirty(state);
  const changes = editChanges(state);
  const needsExitConfirmation =
    editNeedsExitConfirmation(state) ||
    !!state.resumePending ||
    (detached && !!copy && state.originalEntryPath !== entryPath);
  const readOnly = pending === 'applying' || pending === 'library' || !!state.resumePending;
  /** 关闭按钮、Esc 和退出共用未应用改动保护。 */
  const requestClose = () => {
    if (pending === 'applying' || pending === 'library') return;
    if (needsExitConfirmation) setConfirmClose(true);
    else onClose();
  };
  const url = copy ? editPreviewUrl(copy) : null;
  const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);
  const onPreviewShown = useCallback((value: string) => setDisplayedUrl(value), []);
  const inspector = usePreviewInspector(`${sessionId}:${copy?.editId}:${displayedUrl}:${width}`);
  const entryOptions = useMemo(
    () => copy?.entries.map((path) => ({ label: path, value: path })) ?? [],
    [copy?.entries],
  );

  useEffect(() => {
    void controller.open();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (!needsExitConfirmation) return;
    /** 刷新或关闭页面也提醒保存后尚未应用的改动。 */
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [needsExitConfirmation]);

  return (
    <Modal
      open
      title="在线编辑"
      className="edit-workspace-modal"
      width="calc(100vw - 40px)"
      style={{ top: 20 }}
      closable={pending !== 'applying' && pending !== 'library'}
      keyboard={pending !== 'applying' && pending !== 'library' && !confirmClose}
      mask={{ closable: false }}
      onCancel={requestClose}
      footer={
        <div className="edit-workspace-footer">
          <div className="edit-workspace-change-status">
            {changes.length > 0 && (
              <details className="edit-workspace-changes">
                <summary>{changes.length} 个文件有改动</summary>
                <div className="edit-workspace-change-list" aria-label="编辑改动汇总">
                  {changes.map((change) => (
                    <button
                      key={change.path}
                      type="button"
                      title={change.path}
                      onClick={() => setSelectedPath(change.path)}
                    >
                      <FileTypeIcon path={change.path} />
                      <span>{change.path}</span>
                      <small>
                        {change.restored
                          ? '已还原 · 待保存'
                          : change.saved
                            ? detached
                              ? '已保存副本'
                              : '已保存 · 未应用'
                            : '未保存'}
                      </small>
                    </button>
                  ))}
                </div>
              </details>
            )}
            <span className="muted" role="status">
              {state.applyPhase === 'pausing'
                ? '正在等待 Agent 暂停…'
                : state.applyPhase === 'writing'
                  ? '正在应用文件…'
                  : state.applyPhase === 'resuming'
                    ? '文件已应用，正在继续 Agent…'
                    : state.resumePending
                      ? '文件已应用 · Agent 尚未继续'
                      : dirty
                        ? '有未保存修改'
                        : changes.length
                          ? detached
                            ? '副本有改动'
                            : '已保存副本，尚未应用'
                          : copy
                            ? state.librarySaved
                              ? '已保存到我的作品'
                              : '暂无改动'
                            : '正在创建副本…'}
            </span>
          </div>
          <Button disabled={pending === 'applying' || pending === 'library'} onClick={requestClose}>
            退出
          </Button>
          <Button
            disabled={!copy || !!pending || state.resumePending}
            loading={pending === 'saving'}
            onClick={() => void controller.save()}
          >
            保存并预览
          </Button>
          {detached ? (
            <>
              <Button href={controller.downloadPath()} disabled={!controller.downloadPath()}>
                下载 ZIP
              </Button>
              <Button
                type="primary"
                disabled={!copy || !!pending}
                loading={pending === 'library'}
                onClick={() => void controller.saveToLibrary()}
              >
                保存到我的作品
              </Button>
            </>
          ) : (
            <Button
              type="primary"
              disabled={!copy || dirty || !!pending}
              loading={pending === 'applying'}
              onClick={async () => {
                if (await controller.apply()) onApplied();
              }}
            >
              {state.resumePending ? '重试继续 Agent' : '应用到当前工作区'}
            </Button>
          )}
        </div>
      }
    >
      {error && <Alert type="error" showIcon title={error} />}
      {detached && state.savedWork && (
        <p role="status">
          已保存到我的作品{' '}
          <a href={`?view=my-works&work=${encodeURIComponent(state.savedWork.workId)}`}>查看作品</a>
        </p>
      )}
      {!copy ? (
        <div className="edit-workspace-empty" role="status">
          {pending === 'opening' ? '正在从最新产物创建副本…' : '创建失败，请退出后重试'}
        </div>
      ) : (
        <div className="edit-workspace-layout">
          <aside className="edit-workspace-sidebar">
            {!searchOpen && (
              <div className="editor-search-launch">
                <Button
                  size="small"
                  type="text"
                  icon={<Icon name="search" />}
                  onClick={() => {
                    setSearchProperty(undefined);
                    setSearchOpen(true);
                    setSearchFocus((prior) => prior + 1);
                  }}
                >
                  全文搜索
                </Button>
                <small>Ctrl/⌘ ⇧ F</small>
              </div>
            )}
            <div
              className="editor-search-tree-host"
              hidden={searchOpen}
              style={{ display: searchOpen ? 'none' : 'flex' }}
            >
              <EditableFileTree
                files={editable}
                selectedPath={selected?.path ?? ''}
                onSelect={setSelectedPath}
                dirtyPaths={dirtyPaths}
                readOnly={readOnly}
              />
            </div>
            {searchOpen && (
              <GlobalSearch
                key={sourceSearchVersion}
                files={editable}
                query={searchQuery}
                property={searchProperty}
                focusRequest={searchFocus}
                onQueryChange={setSearchQuery}
                onClose={() => setSearchOpen(false)}
                onSelect={(match) => {
                  setSelectedPath(match.path);
                  setReveal({ ...match, requestId: ++revealSequence.current });
                }}
              />
            )}
          </aside>
          <section className="edit-workspace-editor" aria-label="副本源码编辑">
            {selected ? (
              <Suspense fallback={<p className="edit-workspace-empty">正在加载编辑器…</p>}>
                <CodeEditor
                  scope={`${sessionId}-${copy.editId}`}
                  files={editable}
                  path={selected.path}
                  reveal={reveal}
                  readOnly={readOnly}
                  onChange={(path, value) => controller.changeFile(path, value)}
                  onSave={() => void controller.save()}
                />
              </Suspense>
            ) : (
              <p className="edit-workspace-empty">没有可编辑的源文件</p>
            )}
          </section>
          <section className="edit-workspace-preview" aria-label="副本调试预览">
            <div className="edit-workspace-toolbar">
              <Select
                aria-label="预览入口"
                placeholder="选择入口"
                value={entryPath}
                disabled={!!pending || state.resumePending}
                loading={pending === 'saving'}
                showSearch
                optionFilterProp="label"
                onChange={(value) => void controller.selectEntry(value)}
                options={entryOptions}
              />
              <PreviewInspectorButton inspector={inspector} />
              <Segmented
                size="small"
                aria-label="副本预览宽度"
                value={width}
                onChange={setWidth}
                options={[
                  { label: '375', value: 375 },
                  { label: '750', value: 750 },
                  { label: '自适应', value: 'auto' },
                ]}
              />
            </div>
            <div className="edit-workspace-preview-status" role="status" aria-live="polite">
              {pending === 'saving'
                ? '正在保存副本并切换预览…'
                : copy.preview.status === 'building'
                  ? `正在构建 ${copy.entryPath ?? '所选入口'}…`
                  : copy.preview.status === 'failed'
                    ? '预览构建失败'
                    : url
                      ? displayedUrl !== url
                        ? `正在加载 ${copy.entryPath}…`
                        : `当前预览：${copy.entryPath}`
                      : '保存后生成预览'}
            </div>
            {copy.preview.status === 'failed' && copy.preview.error && (
              <Alert type="error" showIcon title={copy.preview.error} />
            )}
            <div className="edit-workspace-stage">
              <EditWorkspacePreviewFrames
                url={url}
                revision={copy.revision}
                width={width}
                inspectorRef={inspector.frameRef}
                onShown={onPreviewShown}
              />
            </div>
            <PreviewInspector inspector={inspector} onLocateSource={locateSource} />
          </section>
        </div>
      )}
      <Modal
        open={confirmClose}
        title={
          detached
            ? '副本尚未保存到我的作品，确定退出？'
            : state.resumePending
              ? 'Agent 尚未继续，确定退出？'
              : '改动尚未应用，确定退出？'
        }
        width={460}
        mask={{ closable: false }}
        onCancel={() => setConfirmClose(false)}
        footer={[
          <Button key="discard" danger onClick={onClose}>
            {state.resumePending ? '保持暂停并退出' : '放弃改动并退出'}
          </Button>,
          <Button key="continue" type="primary" autoFocus onClick={() => setConfirmClose(false)}>
            继续编辑
          </Button>,
        ]}
      >
        <p>
          {detached
            ? '退出会丢弃未保存到我的作品的副本改动。'
            : state.resumePending
              ? '文件已应用到当前工作区。退出后可在对话中继续任务。'
              : '退出会丢弃临时副本中的改动。保存并预览不会应用到当前工作区。'}
        </p>
        {changes.length > 0 && (
          <ul className="edit-workspace-exit-files" aria-label="尚未应用的文件">
            {changes.map((change) => (
              <li key={change.path}>
                <FileTypeIcon path={change.path} />
                <span>{change.path}</span>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </Modal>
  );
}
