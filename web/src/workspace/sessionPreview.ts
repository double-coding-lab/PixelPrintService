import { data, errorMessage, id } from './api';
import type { FileInfo, Target } from './types';

export type SessionPreviewSummary = {
  previewId: string;
  status: string;
  target: Target;
  entryPath: string;
  fileRevision: number;
  validatedFileRevision?: number;
  error?: { message: string; code?: string; file?: string; module?: string } | null;
};
export type SessionPreviewState = {
  current: SessionPreviewSummary | null;
  lastReady: SessionPreviewSummary | null;
  entries: string[];
  fileRevision: number;
};

/** 文件列表顺序和报告更新不触发 ensure，源码与资源新增、删除、重命名和修订均参与。 */
export function previewFileKey(files: FileInfo[]) {
  return JSON.stringify(
    files
      .filter((file) => file.kind === 'source' || file.kind === 'asset')
      .map((file) => [file.fileId, file.path, file.revision])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/** 只在当前构建尚未完成时跟踪，空入口、失败和成功均停止查询。 */
export function previewBuilding(state: SessionPreviewState | null) {
  return (
    !!state?.current && ['queued', 'building', 'pending', 'running'].includes(state.current.status)
  );
}

/** 对齐后端推荐入口规则，组件 index 不参与页面歧义判断。 */
function preferredPreviewEntry(entries: string[]) {
  const pages = entries.filter((entry) =>
    /^(?:src\/)?pages\/[^/]+\/index\.(?:tsx|jsx)$/i.test(entry),
  );
  if (pages.length === 1) return pages[0];
  if (pages.length > 1) return '';
  const conventional = [
    'src/App.tsx',
    'src/App.jsx',
    'App.tsx',
    'App.jsx',
    'src/index.tsx',
    'index.tsx',
  ].filter((entry) => entries.includes(entry));
  return conventional.length === 1 ? conventional[0] : entries.length === 1 ? entries[0] : '';
}

/** 文件变更合并 ensure，SSE 只读刷新；所有旧请求均隔离，不回写过期响应。 */
export function watchSessionPreview({
  sessionId,
  entryPath,
  onState,
  onError,
  request = data,
  schedule = setTimeout,
  unschedule = clearTimeout,
}: {
  sessionId: string;
  entryPath: string;
  onState: (state: SessionPreviewState) => void;
  onError: (message: string) => void;
  request?: typeof data;
  schedule?: typeof setTimeout;
  unschedule?: typeof clearTimeout;
}) {
  const path = `/sessions/${id(sessionId)}/previews`;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ensuring = false;
  let disposed = false;
  let revision = -1;
  let latestState: SessionPreviewState | null = null;
  let lookupEntry = entryPath;

  /** 清理待执行查询并取消网络请求，服务端幂等构建不受客户端取消影响。 */
  function cancel() {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    controller?.abort();
  }

  /** 仅接受当前文件修订，保留已有成功结果直到新页面可用。 */
  function publish(state: SessionPreviewState) {
    if (state.fileRevision < revision) return;
    revision = state.fileRevision;
    latestState = state;
    onState(state);
    onError('');
  }

  /** 查询完成后才安排下一次低频跟踪，不并行、不在终态轮询。 */
  async function read(ensure: boolean, retry = false) {
    timer = undefined;
    const active = new AbortController();
    controller = active;
    try {
      if (ensure) {
        /** 先纯查入口：已有选择或唯一推荐页面自动构建，真实页面歧义留给用户。 */
        const discovered = await request<SessionPreviewState>(
          `${path}${entryPath ? `?entryPath=${encodeURIComponent(entryPath)}` : ''}`,
          { signal: active.signal },
        );
        if (disposed || active.signal.aborted) return;
        publish(discovered);
        const candidate =
          entryPath ||
          discovered.current?.entryPath ||
          discovered.lastReady?.entryPath ||
          preferredPreviewEntry(discovered.entries);
        lookupEntry = discovered.entries.includes(candidate) ? candidate : '';
        const ready = discovered.current;
        if (
          ready?.status === 'ready' &&
          ready.entryPath === lookupEntry &&
          (ready.validatedFileRevision ?? ready.fileRevision) === discovered.fileRevision
        ) {
          ensuring = false;
          return;
        }
        if (!lookupEntry) {
          ensuring = false;
          return;
        }
      }
      const state = await request<SessionPreviewState>(
        ensure
          ? path
          : `${path}${lookupEntry ? `?entryPath=${encodeURIComponent(lookupEntry)}` : ''}`,
        ensure
          ? {
              method: 'POST',
              body: JSON.stringify({
                ...(lookupEntry ? { entryPath: lookupEntry } : {}),
                ...(retry ? { retry: true } : {}),
              }),
              signal: active.signal,
            }
          : { signal: active.signal },
      );
      if (disposed || active.signal.aborted) return;
      ensuring = false;
      publish(state);
      if (previewBuilding(latestState)) timer = schedule(() => void read(false), 5000);
    } catch (reason) {
      if (!disposed && !active.signal.aborted) {
        ensuring = false;
        onError(errorMessage(reason));
      }
    }
  }

  return {
    /** 新修订立即取消旧查询，稳定 800ms 后确保最新输入。 */
    ensure() {
      if (disposed) return;
      cancel();
      ensuring = true;
      timer = schedule(() => void read(true), 800);
    },
    /** 只有用户显式刷新才重试失败记录；实时通知继续保持纯查询。 */
    retry() {
      if (disposed) return;
      cancel();
      ensuring = true;
      void read(true, true);
    },
    /** 构建状态通知不重复创建任务，也不打断尚未完成的 ensure。 */
    refresh() {
      if (disposed || ensuring) return;
      cancel();
      void read(false);
    },
    /** 会话、入口切换或卸载后停止所有客户端工作。 */
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
