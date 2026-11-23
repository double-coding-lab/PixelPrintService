import { data, errorMessage, id } from './api';
import type { PersonalWork } from './sharing';
import { pauseForEdit } from './editRunControl';

export type EditFile = { path: string; content: string };
export type EditCopy = {
  editId: string;
  revision: number;
  baseFileRevision: number;
  files: EditFile[];
  entries: string[];
  entryPath: string | null;
  target: 'h5' | 'rn';
  expiresAt: string;
  preview: {
    status: 'idle' | 'building' | 'ready' | 'failed';
    url?: string;
    expiresAt?: string;
    error?: string;
  };
};
export type EditState = {
  copy: EditCopy | null;
  originalFiles?: EditFile[];
  originalEntryPath?: string | null;
  files: EditFile[];
  entryPath: string | null;
  pending: 'opening' | 'saving' | 'applying' | 'library' | null;
  savedWork?: PersonalWork;
  librarySaved?: boolean;
  error: string;
  applyPhase?: 'pausing' | 'writing' | 'resuming';
  resumePending?: boolean;
};

/** 与进入时的源码比较；保存副本不会清除尚未应用的文件改动。 */
export function editChanges(state: EditState) {
  if (!state.copy) return [];
  const original = new Map(
    (state.originalFiles ?? state.copy.files).map((file) => [file.path, file.content]),
  );
  const saved = new Map(state.copy.files.map((file) => [file.path, file.content]));
  return state.files
    .filter(
      (file) => original.get(file.path) !== file.content || saved.get(file.path) !== file.content,
    )
    .map((file) => ({
      path: file.path,
      saved: saved.get(file.path) === file.content,
      restored: original.get(file.path) === file.content,
    }));
}

/** 未保存正文或保存后尚未应用的改动都需要退出保护。 */
export function editNeedsExitConfirmation(state: EditState) {
  return editDirty(state) || editChanges(state).length > 0;
}

/** 内容和入口共同参与脏状态判断，恢复原文后无需再保存。 */
export function editDirty(state: EditState) {
  const { copy, files, entryPath } = state;
  return (
    !!copy &&
    (entryPath !== copy.entryPath ||
      files.length !== copy.files.length ||
      files.some(
        (file, index) =>
          file.path !== copy.files[index]?.path || file.content !== copy.files[index]?.content,
      ))
  );
}

/** 只接受同源预览入口，拒绝脚本协议、外域、查询串及路径穿越。 */
export function editPreviewUrl(copy: EditCopy) {
  const { url, expiresAt, status } = copy.preview;
  const expiry = expiresAt ?? copy.expiresAt;
  const prefix = copy.target === 'rn' ? 'RN_Preview' : 'H5_Preview';
  if (
    status !== 'ready' ||
    !url ||
    Date.parse(expiry) <= Date.now() ||
    !Number.isFinite(Date.parse(expiry))
  )
    return null;
  const parts = url.split('/');
  return parts.length === 5 &&
    parts[0] === '' &&
    parts[1] === prefix &&
    parts
      .slice(2, 4)
      .every((part) => /^[a-zA-Z0-9_~.-]+$/.test(part) && part !== '.' && part !== '..') &&
    parts[4] === 'index.html'
    ? url
    : null;
}

export type EditWorkspaceOptions = { root?: string; detached?: boolean };

/** 与保存作品接口的 trim().min(1).max(200) 契约保持一致。 */
export const WORK_NAME_MAX_LENGTH = 200;

/** 广场首次保存加本地短日期；已有作品和本次已保存的作品沿用当前名称。 */
export function defaultWorkName(sourceName?: string, existing = false, now = new Date()) {
  const name = sourceName?.trim() || '未命名作品';
  const suffix = existing
    ? ''
    : ` · ${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return (
    name
      .slice(0, WORK_NAME_MAX_LENGTH - suffix.length)
      .replace(/[\uD800-\uDBFF]$/, '')
      .trimEnd() + suffix
  );
}

/** 每个弹窗独立管理 CAS、请求互斥和轮询；退出后晚到的新副本也会删除。 */
export class EditWorkspaceController {
  private state: EditState = { copy: null, files: [], entryPath: null, pending: null, error: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private read: AbortController | null = null;
  private write: AbortController | null = null;
  private readonly root: string;
  private resumeRun: { runId: string; clientRequestId: string } | null = null;
  private applied = false;

  constructor(
    sessionId: string,
    private readonly request: typeof data = data,
    private readonly options: EditWorkspaceOptions = {},
  ) {
    this.root = options.root ?? `/sessions/${id(sessionId)}/edit`;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 发布不可变快照供 React 与测试共享同一状态机。 */
  private update(patch: Partial<EditState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** 停止客户端轮询，不修改后端构建任务。 */
  private stopPolling() {
    clearTimeout(this.timer);
    this.read?.abort();
    this.read = null;
  }

  /** 删除失败由服务端 TTL 兜底，不让退出产生未处理 rejection。 */
  private discard(editId: string) {
    void this.request(`${this.root}/${id(editId)}`, { method: 'DELETE' }).catch(() => {});
  }

  /** 仅 building 时每半秒读取一次；poll 永远不接管本地 files 和 entryPath。 */
  private poll() {
    this.stopPolling();
    const copy = this.state.copy;
    if (!this.active || !copy || copy.preview.status !== 'building') return;
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      const controller = new AbortController();
      this.read = controller;
      try {
        const value = await this.request<EditCopy>(`${this.root}/${id(copy.editId)}`, {
          signal: controller.signal,
        });
        if (
          !this.active ||
          generation !== this.generation ||
          controller.signal.aborted ||
          this.state.copy?.revision !== copy.revision
        )
          return;
        this.update({ copy: { ...this.state.copy, preview: value.preview } });
        this.poll();
      } catch (reason) {
        if (this.active && generation === this.generation && !controller.signal.aborted)
          this.update({ error: errorMessage(reason) });
      }
    }, 500);
  }

  /** 每次进入新 POST；不取消创建请求，以便退出后收到 editId 时立即 DELETE。 */
  async open() {
    if (this.active) return;
    this.active = true;
    this.resumeRun = null;
    this.applied = false;
    const generation = ++this.generation;
    this.update({
      copy: null,
      originalFiles: [],
      files: [],
      entryPath: null,
      pending: 'opening',
      error: '',
      resumePending: false,
      applyPhase: undefined,
      savedWork: undefined,
      librarySaved: false,
    });
    try {
      const copy = await this.request<EditCopy>(this.root, { method: 'POST', body: '{}' });
      if (!this.active || generation !== this.generation) {
        this.discard(copy.editId);
        return;
      }
      this.update({
        copy,
        originalFiles: copy.files.map((file) => ({ ...file })),
        originalEntryPath: copy.entryPath,
        files: copy.files,
        entryPath: copy.entryPath,
        pending: null,
      });
      this.poll();
    } catch (reason) {
      if (this.active && generation === this.generation)
        this.update({ pending: null, error: errorMessage(reason) });
    }
  }

  /** 修改只留在当前弹窗内存；保存过程中仍可继续编辑。 */
  changeFile(path: string, content: string) {
    if (!this.active || this.state.pending === 'applying' || this.applied) return;
    this.update({
      files: this.state.files.map((file) => (file.path === path ? { path, content } : file)),
    });
  }

  /** 更换构建入口同样需要保存，不能以旧入口直接应用。 */
  changeEntry(entryPath: string) {
    if (this.active && this.state.pending !== 'applying' && !this.applied)
      this.update({ entryPath });
  }

  /** 下拉选择立即保存编辑副本并构建该入口；已有请求期间保持单写入，避免 CAS 冲突。 */
  async selectEntry(entryPath: string) {
    const { copy, pending } = this.state;
    if (!this.active || !copy || pending || this.applied || !copy.entries.includes(entryPath))
      return false;
    if (entryPath === this.state.entryPath && entryPath === copy.entryPath) return true;
    this.changeEntry(entryPath);
    return this.save();
  }

  /** PUT 使用副本 revision；响应不覆盖请求期间继续键入的正文或入口。 */
  async save() {
    const { copy, files, entryPath, pending } = this.state;
    if (!this.active || !copy || pending || this.applied) return false;
    this.stopPolling();
    const generation = this.generation;
    const controller = new AbortController();
    this.write = controller;
    this.update({ pending: 'saving', error: '' });
    try {
      const value = await this.request<EditCopy>(`${this.root}/${id(copy.editId)}`, {
        method: 'PUT',
        signal: controller.signal,
        body: JSON.stringify({
          baseRevision: copy.revision,
          files: files.filter(
            (file) =>
              copy.files.find((prior) => prior.path === file.path)?.content !== file.content,
          ),
          ...(entryPath ? { entryPath } : {}),
        }),
      });
      if (!this.active || generation !== this.generation || controller.signal.aborted) return false;
      this.update({
        copy: value,
        pending: null,
        files: this.state.files === files ? value.files : this.state.files,
        entryPath: this.state.entryPath === entryPath ? value.entryPath : this.state.entryPath,
      });
      this.poll();
      return true;
    } catch (reason) {
      if (this.active && generation === this.generation && !controller.signal.aborted) {
        this.update({ pending: null, error: errorMessage(reason) });
        this.poll();
      }
      return false;
    }
  }

  /** 持久化独立副本；正文仍有新修改时保留编辑状态，避免保存旧修订。 */
  async saveToLibrary(name?: string) {
    if (!this.options.detached || !this.active || !this.state.copy || this.state.pending)
      return false;
    const workName = name?.trim();
    if (name !== undefined && (!workName || workName.length > WORK_NAME_MAX_LENGTH)) {
      this.update({ error: `请输入 1–${WORK_NAME_MAX_LENGTH} 字符的作品名称` });
      return false;
    }
    if (editDirty(this.state) && !(await this.save())) return false;
    if (!this.active || !this.state.copy || this.state.pending) return false;
    if (editDirty(this.state)) {
      this.update({ error: '内容已变化，请再次保存到我的作品' });
      return false;
    }
    const copy = this.state.copy!;
    const generation = this.generation;
    const controller = new AbortController();
    this.write = controller;
    this.stopPolling();
    this.update({ pending: 'library', error: '' });
    try {
      const work = await this.request<PersonalWork>(`${this.root}/${id(copy.editId)}/save`, {
        method: 'POST',
        body: JSON.stringify({
          baseRevision: copy.revision,
          ...(workName === undefined ? {} : { name: workName }),
        }),
        signal: controller.signal,
      });
      if (!this.active || generation !== this.generation || controller.signal.aborted) return false;
      this.update({
        savedWork: work,
        librarySaved: true,
        originalFiles: copy.files,
        originalEntryPath: copy.entryPath,
        pending: null,
      });
      this.poll();
      return true;
    } catch (reason) {
      if (this.active && generation === this.generation && !controller.signal.aborted) {
        this.update({ pending: null, error: errorMessage(reason) });
        this.poll();
      }
      return false;
    }
  }

  /** ZIP 始终对应已保存的副本修订，未保存正文时先保存并预览。 */
  downloadPath() {
    const { copy, pending } = this.state;
    return this.options.detached && copy && !pending && !editDirty(this.state)
      ? `/api/d2c${this.root}/${id(copy.editId)}/download`
      : undefined;
  }

  /** 禁止未保存或并发应用；只有显式 apply POST 可以改变当前工作区。 */
  async apply() {
    const { copy, pending } = this.state;
    if (this.options.detached || !this.active || !copy || pending || editDirty(this.state))
      return false;
    const generation = this.generation;
    const controller = new AbortController();
    this.write = controller;
    this.stopPolling();
    this.update({ pending: 'applying', error: '' });
    try {
      if (!this.applied) {
        const runId = await pauseForEdit(
          this.request,
          this.root.replace(/\/edit$/, ''),
          controller.signal,
          () => this.update({ applyPhase: 'pausing' }),
        );
        if (runId) this.resumeRun ??= { runId, clientRequestId: crypto.randomUUID() };
        this.update({ applyPhase: 'writing' });
        /** 领取恰好发生在状态读取之后时，再等待一次停止；普通修订冲突不自动重试。 */
        try {
          await this.writeApplication(copy, controller.signal);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('Agent 正在写入文件'))
            throw error;
          const claimed = await pauseForEdit(
            this.request,
            this.root.replace(/\/edit$/, ''),
            controller.signal,
            () => this.update({ applyPhase: 'pausing' }),
          );
          if (claimed) this.resumeRun ??= { runId: claimed, clientRequestId: crypto.randomUUID() };
          this.update({ applyPhase: 'writing' });
          await this.writeApplication(copy, controller.signal);
        }
        this.applied = true;
        this.update({ originalFiles: this.state.files, resumePending: !!this.resumeRun });
      }
      if (this.resumeRun) {
        this.update({ applyPhase: 'resuming' });
        await this.request(`${this.root.replace(/\/edit$/, '')}/resume`, {
          method: 'POST',
          body: JSON.stringify(this.resumeRun),
          signal: controller.signal,
        });
      }
      if (!this.active || generation !== this.generation || controller.signal.aborted) return false;
      this.resumeRun = null;
      this.update({ pending: null, resumePending: false, applyPhase: undefined });
      return true;
    } catch (reason) {
      if (this.active && generation === this.generation && !controller.signal.aborted) {
        this.update({
          pending: null,
          applyPhase: undefined,
          error: this.applied
            ? `文件已应用，但 Agent 继续失败：${errorMessage(reason)}。请点击重试继续 Agent。`
            : errorMessage(reason),
        });
        this.poll();
      }
      return false;
    }
  }

  /** 写回成功后更新本地副本修订，继续失败时重试只恢复 Agent，不重复写回。 */
  private async writeApplication(copy: EditCopy, signal: AbortSignal) {
    const value = await this.request<EditCopy>(`${this.root}/${id(copy.editId)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ baseRevision: copy.revision }),
      signal,
    });
    if (signal.aborted || !this.active) throw new Error('应用操作已取消');
    if (value?.editId) this.update({ copy: value });
  }

  /** 关闭、切换会话和卸载同步失效旧回调，并丢弃副本与本地正文。 */
  dispose() {
    this.active = false;
    ++this.generation;
    this.stopPolling();
    this.write?.abort();
    if (this.state.copy) this.discard(this.state.copy.editId);
    this.update({
      copy: null,
      originalFiles: [],
      files: [],
      entryPath: null,
      pending: null,
      error: '',
    });
  }
}
