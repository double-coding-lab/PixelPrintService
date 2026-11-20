import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Transaction, type Sequelize } from 'sequelize';
import type { StorageFileClient } from '@/hooks/tools/storage';
import { createFileService } from '../files/service';
import { createPreviewCache, type CachedPreviewFile, type PreviewCache } from '../preview/cache';
import { PreviewBuildError, runPreviewBuild } from '../preview/runner';
import { previewFailureDetails, previewFailureDiagnostic } from '../preview/diagnostics';
import {
  type EditSourceSnapshot,
  type PreviewSnapshotFile,
  hydratePreviewSnapshot,
  sessionPreviewInput,
  validateSessionEntry,
} from '../preview/session';
import { ownedSession, requireIdentifier, requireRevision, SessionError } from '../session/access';
import { EDIT_TTL_MS, type EditRecord, type EditStore } from './store';
import { createEditAssetCache } from './assetCache';
import { createWarmPreviewRunner } from '../preview/warmRunner';

export type { EditSourceSnapshot } from '../preview/session';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Limits = { textFileBytes: number; filesPerSession: number; uploadBytes: number };
type BuildPhase = 'snapshot' | 'input' | 'build' | 'output' | 'cache' | 'publish';
export type EditDraft = Pick<
  EditRecord,
  | 'editId'
  | 'revision'
  | 'baseFileRevision'
  | 'files'
  | 'entries'
  | 'entryPath'
  | 'target'
  | 'expiresAt'
> & {
  preview: {
    status: 'idle' | 'building' | 'ready' | 'failed';
    url?: string;
    expiresAt?: string;
    error?: string;
  };
};
export type SaveEditInput = {
  baseRevision: number;
  files: Array<{ path: string; content: string }>;
  entryPath?: string;
};

export type DetachedEditOptions = {
  authorize(eid: string, sourceId: string): Promise<void>;
  /** Read frozen storage metadata only; source implementations must not hydrate inside this transaction. */
  source(
    eid: string,
    sourceId: string,
    entryPath: string | undefined,
    transaction: Transaction,
    limits: Limits,
  ): Promise<EditSourceSnapshot>;
  previewPrefix: string;
};
export type EditSnapshotExport = Omit<EditSourceSnapshot, 'fileRevision'> & {
  editId: string;
  revision: number;
  sourceId: string;
  baseFileRevision: number;
};

/** 固定错误不含源码、token、对象定位或构建器 stderr。 */
function conflict(): never {
  throw new SessionError(409, 'EDIT_CONFLICT', '临时副本已更新，请重新读取');
}
/** 过期、跨会话及被替换的旧 editId 使用相同结果。 */
function missing(): never {
  throw new SessionError(404, 'EDIT_NOT_FOUND', '临时副本不存在或已过期，请重新进入编辑');
}
/** 网关和构建输出均不能把路径解释为任意宿主路径。 */
function assetPath(path: string) {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    !/[\\\x00-\x1f\x7f:%?#]/.test(path) &&
    path.split('/').every((part) => part && !part.startsWith('.'))
  );
}

/**
 * 主 agent 接线：createEditService(app.mysql, { store: createRedisEditStore(app.redis),
 * binary: () => binaryClient, readLimits: () => readConfig().d2c.limits, notify? })。
 * run 默认 runPreviewBuild，完整传递 AbortSignal；close() 中止并等待本机任务。
 * routes 注册于现有 session 鉴权作用域；静态网关按 edit- 前缀分发到 asset()，
 * 所有 HTML 继续走既有 sandbox CSP / inspector 注入，不能另开无 CSP 静态路由。
 */
export function createEditService(
  mysql: Sequelize,
  options: {
    store: EditStore;
    detached?: DetachedEditOptions;
    binary: () => Pick<StorageFileClient, 'downloadFile'>;
    run?: typeof runPreviewBuild;
    readLimits: () => Limits;
    notify?: (sessionId: string, seq?: number) => void;
    cache?: PreviewCache;
    assetCache?: ReturnType<typeof createEditAssetCache>;
    report?: (details: Record<string, unknown>) => void | Promise<void>;
  },
) {
  const { store, detached } = options;
  const previewPrefix = detached?.previewPrefix ?? 'edit-';
  if (!/^[a-z][a-z0-9-]{0,31}-$/.test(previewPrefix) || !previewPrefix.endsWith('-'))
    throw new Error('EDIT_PREVIEW_PREFIX_INVALID');
  /** Detached namespaces isolate owners and source kinds without changing record.sessionId. */
  function storeKey(owner: string, sourceId: string) {
    return detached
      ? `detached:${sha(JSON.stringify([previewPrefix, owner, sourceId]))}`
      : sourceId;
  }
  function recordKey(record: EditRecord) {
    return storeKey(record.ownerUserId, record.sessionId);
  }
  async function authorize(owner: string, sourceId: string) {
    requireIdentifier(owner);
    requireIdentifier(sourceId);
    if (detached) await detached.authorize(owner, sourceId);
    else await ownedSession(mysql, owner, sourceId, undefined, 'read');
  }
  const cache =
    options.cache ?? createPreviewCache('.runtime/edit-previews', { ttlMs: EDIT_TTL_MS });
  const warm = options.run ? undefined : createWarmPreviewRunner();
  const assetCache = options.assetCache ?? (options.run ? undefined : createEditAssetCache());
  const files = detached ? undefined : createFileService(mysql, options.readLimits, options.notify);
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closed = false;

  /** 每次请求/构建读取限额，不以缺失配置放宽输入。 */
  function limits() {
    let value: Limits;
    try {
      value = options.readLimits();
    } catch {
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额暂不可用');
    }
    if (
      !value ||
      !['textFileBytes', 'filesPerSession', 'uploadBytes'].every(
        (key) => Number.isSafeInteger(value[key as keyof Limits]) && value[key as keyof Limits] > 0,
      )
    )
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额尚未配置');
    return value;
  }
  /** 通知仅唤醒页面重读临时副本，不落 MySQL Timeline/预览/版本。 */
  function notify(sessionId: string) {
    try {
      void Promise.resolve(options.notify?.(sessionId)).catch(() => undefined);
    } catch {
      /** 无副作用。 */
    }
  }
  /** 只取消本次提交实际替换的旧 job，迟到回调不能触及新副本或新修订的构建。 */
  function abortJob(jobId: string | undefined) {
    if (jobId) jobs.get(jobId)?.controller.abort();
  }
  /** active editId、账号认证 归属和固定期限每次重新检查，旧请求不能越过重入。 */
  async function load(userId: string, sessionId: string, editId: string) {
    requireIdentifier(editId);
    await authorize(userId, sessionId);
    const record = await store.load(storeKey(userId, sessionId));
    if (
      !record ||
      record.editId !== editId ||
      record.sessionId !== sessionId ||
      record.ownerUserId !== userId ||
      Date.parse(record.expiresAt) <= Date.now()
    )
      missing();
    return record;
  }
  /** 修改必须使用客户端见过的副本修订，apply 期间拒绝保存和丢弃。 */
  function writable(record: EditRecord, revision?: number) {
    if (closed) throw new SessionError(503, 'EDIT_CLOSED', '临时编辑服务正在关闭');
    if (record.applying) throw new SessionError(409, 'EDIT_APPLYING', '副本正在写回，请稍后重试');
    if (revision !== undefined) {
      requireRevision(revision, false);
      if (record.revision !== revision) conflict();
      requireRevision(revision + 1, false);
    }
  }
  /** 只保存白名单文本，文件集固定，不接受路径别名、重复或新增文件。 */
  function patch(record: EditRecord, input: SaveEditInput) {
    const settings = limits();
    if (!Array.isArray(input.files) || input.files.length > settings.filesPerSession)
      throw new SessionError(422, 'EDIT_FILE_LIMIT', '临时编辑文件数量超出限额');
    const updates = new Map<string, string>();
    for (const file of input.files) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !record.files.some((f) => f.path === file.path) ||
        updates.has(file.path)
      )
        throw new SessionError(422, 'EDIT_SOURCE_ONLY', '只能编辑副本内已有源码文件');
      if (
        typeof file.content !== 'string' ||
        file.content.includes('\0') ||
        Buffer.from(file.content).toString('utf8') !== file.content ||
        Buffer.byteLength(file.content) > settings.textFileBytes
      )
        throw new SessionError(422, 'INVALID_CONTENT', '文本无效或超过字节限额');
      updates.set(file.path, file.content);
    }
    validateSessionEntry(input.entryPath);
    const entryPath = input.entryPath ?? record.entryPath;
    if (entryPath && !record.entries.includes(entryPath))
      throw new SessionError(422, 'INVALID_ENTRY', '请选择副本内已有页面入口');
    const result = record.files.map((file) => ({
      ...file,
      content: updates.get(file.path) ?? file.content,
    }));
    if (result.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 64 * 1024 * 1024)
      throw new SessionError(422, 'EDIT_FILE_LIMIT', '临时编辑文本超出总量限制');
    return { files: result, entryPath };
  }
  /** 每次任务有随机 owner；即使同一修订重建，旧任务也不能覆盖新结果。 */
  function building(): EditRecord['preview'] {
    return { status: 'building', job: randomUUID(), startedAt: Date.now() };
  }
  /** 仅当前 active draft/revision/job 可发布；票据不写副本，避免 GET 争抢保存 CAS。 */
  async function settle(record: EditRecord, preview: EditRecord['preview']) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await store.load(recordKey(record));
      if (
        !current ||
        current.editId !== record.editId ||
        current.revision !== record.revision ||
        current.preview.job !== record.preview.job ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        return;
      if (await store.cas(recordKey(record), current, { ...current, preview })) {
        notify(record.sessionId);
        return;
      }
    }
  }
  /** 不可变输出键按 editId/revision/job 隔离，旧 iframe 票据仍指向旧结果。 */
  function key(record: EditRecord) {
    return sha(
      JSON.stringify([record.editId, record.revision, record.preview.job, record.entryPath]),
    );
  }
  /** 冻结的配置和二进制定位重建；不访问最新会话文件，不创建 D2cPreview。 */
  async function build(
    record: EditRecord,
    signal: AbortSignal,
    progress: (phase: BuildPhase, artifactPath?: string) => void,
  ) {
    progress('input');
    const settings = limits();
    const output: Array<{ path: string; content: Buffer }> = [];
    let total = 0;
    for (const file of record.snapshot) {
      progress('input', file.path);
      signal.throwIfAborted();
      const source = record.files.find((item) => item.path === file.path);
      const content =
        file.kind === 'source'
          ? Buffer.from(source!.content)
          : assetCache
            ? await assetCache.read(
                file,
                () => options.binary().downloadFile(file.objectLocator!),
                signal,
              )
            : await options.binary().downloadFile(file.objectLocator!);
      signal.throwIfAborted();
      if (file.kind !== 'source' && (content.length !== file.size || sha(content) !== file.sha256))
        throw new Error('EDIT_INPUT_CORRUPT');
      total += content.length;
      if (
        total > 64 * 1024 * 1024 ||
        output.length >= settings.filesPerSession ||
        (file.kind === 'source' && content.length > settings.textFileBytes)
      )
        throw new Error('EDIT_INPUT_LIMIT');
      output.push({ path: file.path, content });
    }
    const config = record.configSnapshot.config as
      | { unit?: { outputUnit?: string; outputBase?: number } }
      | undefined;
    const input: Parameters<typeof runPreviewBuild>[0] = {
      files: output,
      target: record.target,
      entryPath: record.entryPath!,
      unit: {
        outputUnit: record.target === 'h5' || config?.unit?.outputUnit === 'vw' ? 'vw' : 'px',
        outputBase: Number(config?.unit?.outputBase ?? 750),
      },
      signal,
    };
    progress('build');
    return options.run ? options.run(input) : warm!.run(record.editId, input);
  }
  /** 构建器输出不能注入可遍历路径、特殊 MIME 或无限大小。HTML 安全策略由既有网关实施。 */
  function validateBuilt(built: CachedPreviewFile[]) {
    if (
      !Array.isArray(built) ||
      !built.length ||
      built.length > 500 ||
      !built.some((file) => file.path === 'index.html')
    )
      throw new Error('EDIT_BUILD_OUTPUT');
    const seen = new Set<string>();
    let total = 0;
    for (const file of built) {
      if (
        !assetPath(file.path) ||
        !/\.(?:html|js|css|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|ico|mp4|webm|mp3|wav)$/i.test(
          file.path,
        ) ||
        seen.has(file.path) ||
        !Buffer.isBuffer(file.content) ||
        typeof file.mimeType !== 'string' ||
        /[\r\n]/.test(file.mimeType)
      )
        throw new Error('EDIT_BUILD_OUTPUT');
      seen.add(file.path);
      total += file.content.length;
      if (total > Math.min(limits().uploadBytes, 30000000)) throw new Error('EDIT_BUILD_LIMIT');
    }
  }
  /** 后台错误仅返回固定说明；过期/取消任务的输出绝不发布到新稿。 */
  function schedule(record: EditRecord) {
    if (closed || record.preview.status !== 'building' || !record.preview.job || !record.entryPath)
      return;
    const jobId = record.preview.job;
    if (jobs.has(jobId)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    let phase: BuildPhase = 'snapshot';
    let artifactPath: string | undefined;
    const progress = (next: BuildPhase, file?: string) => {
      phase = next;
      artifactPath = file;
    };
    const done = Promise.resolve()
      .then(async () => {
        const current = await store.load(recordKey(record));
        signal.throwIfAborted();
        if (
          !current ||
          current.editId !== record.editId ||
          current.revision !== record.revision ||
          current.preview.job !== jobId ||
          Date.parse(current.expiresAt) <= Date.now()
        )
          return;
        const built = await build(record, signal, progress);
        signal.throwIfAborted();
        progress('output');
        validateBuilt(built);
        progress('snapshot');
        const latest = await store.load(recordKey(record));
        if (
          !latest ||
          latest.editId !== record.editId ||
          latest.revision !== record.revision ||
          latest.preview.job !== jobId ||
          Date.parse(latest.expiresAt) <= Date.now()
        )
          return;
        progress('cache');
        await cache.write(key(record), built);
        signal.throwIfAborted();
        progress('publish');
        await settle(record, { status: 'ready', key: key(record) });
      })
      .catch(async (error: unknown) => {
        if (controller.signal.aborted || closed) {
          await settle(record, {
            status: 'failed',
            error: previewFailureDiagnostic({ reason: 'BUILD_INTERRUPTED' }).message,
          }).catch(() => undefined);
          return;
        }
        const errorId = randomUUID();
        const diagnostic = signal.aborted
          ? previewFailureDiagnostic({ reason: 'BUILD_TIMEOUT' })
          : phase === 'build'
            ? previewFailureDiagnostic(error instanceof PreviewBuildError ? error : null)
            : null;
        const messages: Record<BuildPhase, string> = {
          snapshot: '临时预览状态读取失败，请重试并检查 Redis 服务。',
          input: '预览输入文件读取或校验失败，请重试并检查图片存储及访问链路。',
          build: '临时预览编译失败，请检查入口、依赖或编译环境。',
          output: '预览产物校验失败，请检查构建输出与文件限额。',
          cache: '临时预览缓存保存失败，请检查服务目录权限及磁盘空间。',
          publish: '临时预览状态保存失败，请重试并检查 Redis 服务。',
        };
        try {
          void Promise.resolve(
            options.report?.({
              errorId,
              editId: record.editId,
              sourceId: record.sessionId,
              revision: record.revision,
              editor: detached ? previewPrefix.slice(0, -1) : 'workspace',
              phase,
              ...(artifactPath ? { artifactPath } : {}),
              ...previewFailureDetails(error),
              ...(diagnostic ? { diagnostic } : {}),
            }),
          ).catch(() => undefined);
        } catch {
          /** 日志故障不能阻止本次构建结算。 */
        }
        const location = diagnostic?.file ? ` 文件：${diagnostic.file}` : '';
        await settle(record, {
          status: 'failed',
          error: `${diagnostic?.message ?? messages[phase]}${location} 排查编号：${errorId}`,
        }).catch(() => undefined);
      })
      .finally(() => {
        jobs.delete(jobId);
      });
    jobs.set(jobId, { controller, done });
  }
  /** 公开结果只包含源码和 UI 状态，不泄露资产定位/固定配置/任务令牌。 */
  async function visible(record: EditRecord): Promise<EditDraft> {
    const { editId, revision, baseFileRevision, entries, entryPath, target, expiresAt } = record;
    const result: EditDraft = {
      editId,
      revision,
      baseFileRevision,
      files: record.files.map((file) => ({ path: file.path, content: file.content })),
      entries: [...entries],
      entryPath,
      target,
      expiresAt,
      preview: { status: record.preview.status },
    };
    if (record.preview.status === 'failed') result.preview.error = record.preview.error;
    if (record.preview.status === 'ready' && record.preview.key) {
      const token = randomBytes(32).toString('hex');
      const ticketExpiry = new Date(
        Math.min(Date.now() + 300000, Date.parse(expiresAt)),
      ).toISOString();
      await store.ticket(sha(token), {
        editId,
        sessionId: record.sessionId,
        target,
        key: record.preview.key,
        expiresAt: ticketExpiry,
      });
      result.preview.url = `/${target === 'h5' ? 'H5_Preview' : 'RN_Preview'}/${previewPrefix}${editId}/${token}/index.html`;
      result.preview.expiresAt = ticketExpiry;
    }
    return result;
  }
  return {
    /** 每次 POST 都从最新生成产物取完整冻结快照并替换旧副本，不延用旧编辑内容。 */
    async create(userId: string, sessionId: string, input: { entryPath?: string } = {}) {
      const entryPath = input.entryPath;
      validateSessionEntry(entryPath);
      /** Storage representation may change without changing content identity; binary inputs stay fixed. */
      function inputHash(source: EditSourceSnapshot) {
        return sha(
          JSON.stringify([
            source.target,
            source.configSnapshot,
            source.entries,
            source.entryPath,
            source.snapshot.map((file) => [
              file.path,
              file.kind,
              file.size,
              file.sha256,
              file.kind === 'source' ? null : file.objectLocator,
            ]),
          ]),
        );
      }
      /** Both passes reauthorize under the original locks; only the final pass can replace a draft. */
      async function attempt(
        transaction: Transaction,
        prepared?: {
          fileRevision: number;
          inputHash: string;
          snapshot: PreviewSnapshotFile[];
          prior: Pick<EditRecord, 'editId' | 'revision' | 'ownerUserId'> | null;
        },
      ) {
        if (closed) throw new SessionError(503, 'EDIT_CLOSED', '临时编辑服务正在关闭');
        if (detached) await authorize(userId, sessionId);
        const detachedSource = detached
          ? await detached.source(userId, sessionId, entryPath, transaction, limits())
          : undefined;
        const sessionSource = !detachedSource
          ? await sessionPreviewInput(
              mysql,
              userId,
              sessionId,
              entryPath,
              transaction,
              limits(),
              true,
            )
          : undefined;
        const frozen: EditSourceSnapshot = detachedSource ?? {
          fileRevision: sessionSource!.session.fileRevision,
          target: sessionSource!.session.target!,
          snapshot: sessionSource!.snapshot,
          configSnapshot: sessionSource!.configSnapshot,
          entries: sessionSource!.entries,
          entryPath: sessionSource!.entryPath,
        };
        if (entryPath && !frozen.entryPath)
          throw new SessionError(422, 'INVALID_ENTRY', '请选择已有页面入口');
        const hash = inputHash(frozen);
        if (
          prepared &&
          (prepared.fileRevision !== frozen.fileRevision || prepared.inputHash !== hash)
        )
          conflict();
        const prior = await store.load(storeKey(userId, sessionId));
        if (
          prepared &&
          (prior?.editId !== prepared.prior?.editId ||
            prior?.revision !== prepared.prior?.revision ||
            prior?.ownerUserId !== prepared.prior?.ownerUserId)
        )
          conflict();
        /** 有权成员的未过期副本继续互斥；仅明确 404 失权才允许 CAS 回收旧副本。 */
        if (
          !detached &&
          prior &&
          prior.ownerUserId !== userId &&
          Date.parse(prior.expiresAt) > Date.now()
        ) {
          let accessible = true;
          try {
            await ownedSession(mysql, prior.ownerUserId, sessionId, transaction, 'read');
          } catch (error) {
            if (!(error instanceof SessionError) || error.statusCode !== 404) throw error;
            accessible = false;
          }
          if (accessible)
            throw new SessionError(409, 'EDIT_IN_USE', '其他成员正在编辑，请待其关闭编辑后重试');
        }

        if (
          !prepared &&
          frozen.snapshot.some((file) => file.kind === 'source' && typeof file.content !== 'string')
        )
          return {
            type: 'hydrate' as const,
            frozen: structuredClone(frozen),
            inputHash: hash,
            prior: prior
              ? { editId: prior.editId, revision: prior.revision, ownerUserId: prior.ownerUserId }
              : null,
          };
        // Inline inputs need no storage I/O and retain the original single-transaction path.
        const snapshot =
          prepared?.snapshot ?? (await hydratePreviewSnapshot(mysql, frozen.snapshot));
        const next: EditRecord = {
          editId: randomUUID(),
          sessionId,
          ownerUserId: userId,
          revision: 1,
          baseFileRevision: frozen.fileRevision,
          files: snapshot
            .filter((file) => file.kind === 'source')
            .map((file) => ({ path: file.path, content: file.content! })),
          entries: frozen.entries,
          entryPath: frozen.entryPath,
          target: frozen.target,
          snapshot,
          configSnapshot: frozen.configSnapshot,
          expiresAt: new Date(Date.now() + EDIT_TTL_MS).toISOString(),
          preview: frozen.entryPath ? building() : { status: 'idle' },
        };
        await store.index(next.editId, recordKey(next), next.expiresAt);
        if (!(await store.cas(storeKey(userId, sessionId), prior, next))) conflict();
        return {
          type: 'created' as const,
          record: next,
          priorJob: prior?.preview.job,
          priorEditId: prior?.editId,
        };
      }
      let result = await mysql.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
        (transaction) => attempt(transaction),
      );
      if (result.type === 'hydrate') {
        const { frozen, inputHash, prior } = result;
        const snapshot = await hydratePreviewSnapshot(
          mysql,
          frozen.snapshot,
          detached ? undefined : `session:${sessionId}`,
        );
        result = await mysql.transaction(
          { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
          (transaction) =>
            attempt(transaction, { fileRevision: frozen.fileRevision, inputHash, snapshot, prior }),
        );
      }
      if (result.type !== 'created') conflict();
      const { record, priorJob, priorEditId } = result;
      abortJob(priorJob);
      if (priorEditId) await warm?.release(priorEditId);
      schedule(record);
      notify(sessionId);
      return visible(record);
    },
    /** ready 查询续五分钟票据；重启/跨实例缓存缺失或超时任务通过 CAS 恢复重建。 */
    async get(userId: string, sessionId: string, editId: string) {
      let record = await load(userId, sessionId, editId);
      let acquired = false;
      if (
        !closed &&
        !record.applying &&
        record.entryPath &&
        ((record.preview.status === 'ready' &&
          (!record.preview.key || !(await cache.has(record.preview.key)))) ||
          (record.preview.status === 'building' &&
            Date.now() - (record.preview.startedAt ?? 0) > 150000))
      ) {
        const next = { ...record, preview: building() };
        if (await store.cas(storeKey(userId, sessionId), record, next)) {
          abortJob(record.preview.job);
          record = next;
          acquired = true;
        } else record = await load(userId, sessionId, editId);
      }
      if (acquired) schedule(record);
      return visible(record);
    },
    /** 保存只变 Redis；异步隔离构建独立于正常会话预览和版本。files 可为已有文件子集。 */
    async save(userId: string, sessionId: string, editId: string, input: SaveEditInput) {
      const record = await load(userId, sessionId, editId);
      writable(record, input.baseRevision);
      const updates = patch(record, input);
      const next: EditRecord = {
        ...record,
        ...updates,
        revision: record.revision + 1,
        preview: updates.entryPath ? building() : { status: 'idle' },
      };
      if (!(await store.cas(storeKey(userId, sessionId), record, next))) conflict();
      abortJob(record.preview.job);
      schedule(next);
      notify(sessionId);
      return visible(next);
    },
    /** 显式 apply 才触及 MySQL；锁定副本后原子写回变化源码，冲突/失败保留整个副本。 */
    async apply(
      userId: string,
      sessionId: string,
      editId: string,
      input: { baseRevision: number },
    ) {
      if (detached) throw new SessionError(403, 'EDIT_APPLY_FORBIDDEN', '独立副本不能写回来源');
      const record = await load(userId, sessionId, editId);
      writable(record, input.baseRevision);
      const token = randomUUID();
      const reserved = { ...record, applying: token };
      if (!(await store.cas(storeKey(userId, sessionId), record, reserved))) conflict();
      /** save/remove 不能越过 apply reservation；create 持有同一 MySQL 会话锁可替换崩溃预留，旧 owner 提交前重验。 */
      async function owned() {
        const current = await store.load(storeKey(userId, sessionId));
        if (
          !current ||
          current.editId !== editId ||
          current.revision !== record.revision ||
          current.applying !== token ||
          Date.parse(current.expiresAt) - Date.now() < 30000
        )
          conflict();
        return current;
      }
      let fileRevision: number;
      try {
        await owned();
        const originals = await hydratePreviewSnapshot(
          mysql,
          record.snapshot,
          `session:${sessionId}`,
        );
        const changes = record.files.filter(
          (file) => originals.find((old) => old.path === file.path)?.content !== file.content,
        );
        const result = await files!.apply(
          userId,
          sessionId,
          {
            baseFileRevision: record.baseFileRevision,
            files: changes,
            originals: originals
              .filter((file) => file.kind === 'source')
              .map((file) => ({ path: file.path, content: file.content! })),
          },
          async () => {
            await owned();
          },
        );
        fileRevision = result.fileRevision;
      } catch (error) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const current = await store.load(storeKey(userId, sessionId));
          if (!current || current.editId !== editId || current.applying !== token) break;
          const next = { ...current };
          delete next.applying;
          if (await store.cas(storeKey(userId, sessionId), current, next)) break;
        }
        throw error;
      }
      /** MySQL 已提交；新 create 可能已拿锁替换副本，不能把已提交写回误报成冲突或覆盖新稿。 */
      const committed: EditRecord = {
        ...record,
        baseFileRevision: fileRevision,
        revision: record.revision + 1,
        preview: { status: 'idle' },
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        let current: EditRecord | null;
        try {
          current = await store.load(storeKey(userId, sessionId));
        } catch {
          return visible(committed);
        }
        if (!current || current.editId !== editId || current.applying !== token)
          return visible(committed);
        const snapshot = record.snapshot.map((file) => {
          const source = record.files.find(
            (item) => file.kind === 'source' && item.path === file.path,
          );
          return source
            ? {
                path: file.path,
                kind: file.kind,
                content: source.content,
                objectLocator: null,
                size: Buffer.byteLength(source.content),
                sha256: sha(source.content),
              }
            : file;
        });
        const next = {
          ...current,
          baseFileRevision: fileRevision,
          snapshot,
          revision: current.revision + 1,
          preview: current.preview.status === 'building' ? building() : current.preview,
        };
        delete next.applying;
        if (await store.cas(storeKey(userId, sessionId), current, next).catch(() => false)) {
          abortJob(current.preview.job);
          schedule(next);
          notify(sessionId);
          return visible(next);
        }
      }
      return visible(committed);
    },
    /** Acknowledge a persisted personal-work revision without changing draft content or revision. */
    async advanceBaseline(
      userId: string,
      sourceId: string,
      editId: string,
      baseRevision: number,
      newFileRevision: number,
    ): Promise<EditDraft> {
      if (!detached)
        throw new SessionError(403, 'EDIT_BASELINE_FORBIDDEN', '仅独立副本可推进作品基线');
      requireRevision(newFileRevision, false);
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await load(userId, sourceId, editId);
        writable(record, baseRevision);
        if (newFileRevision < record.baseFileRevision) conflict();
        if (newFileRevision === record.baseFileRevision) return visible(record);
        const next = { ...record, baseFileRevision: newFileRevision };
        if (await store.cas(recordKey(record), record, next)) return visible(next);
      }
      conflict();
    },
    /** Export trusted frozen inputs for the personal-works worker, never the latest source. */
    async exportSnapshot(
      userId: string,
      sourceId: string,
      editId: string,
      baseRevision: number,
    ): Promise<EditSnapshotExport> {
      const record = await load(userId, sourceId, editId);
      writable(record, baseRevision);
      const verified = patch(record, { baseRevision, files: record.files });
      const snapshot = record.snapshot.map((file) => {
        if (file.kind !== 'source') return structuredClone(file);
        const source = verified.files.find((item) => item.path === file.path);
        if (!source) throw new SessionError(503, 'FILE_CORRUPT', '副本源码校验失败');
        return {
          path: file.path,
          kind: file.kind,
          content: source.content,
          objectLocator: null,
          size: Buffer.byteLength(source.content),
          sha256: sha(source.content),
        };
      });
      return {
        editId,
        revision: record.revision,
        sourceId,
        target: record.target,
        baseFileRevision: record.baseFileRevision,
        snapshot,
        configSnapshot: structuredClone(record.configSnapshot),
        entries: [...record.entries],
        entryPath: record.entryPath,
      };
    },
    /** 退出只删除仍然 active 的 editId，旧 DELETE 不能丢弃重入后的新副本。 */
    async remove(userId: string, sessionId: string, editId: string) {
      const record = await load(userId, sessionId, editId);
      writable(record);
      if (!(await store.cas(storeKey(userId, sessionId), record, null))) conflict();
      abortJob(record.preview.job);
      await warm?.release(record.editId);
      notify(sessionId);
      return { editId, discarded: true };
    },
    /** 既有静态网关调用；匿名票据绑定 target/editId/不可变缓存键，旧副本票据立即失效。 */
    async asset(target: 'h5' | 'rn', previewId: string, token: string, path: string) {
      if (
        previewId.length !== previewPrefix.length + 36 ||
        !previewId.startsWith(previewPrefix) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          previewId.slice(previewPrefix.length),
        ) ||
        !/^[a-f0-9]{64}$/.test(token) ||
        !assetPath(path)
      )
        missing();
      const editId = previewId.slice(previewPrefix.length);
      const storageKey = await store.locate(editId);
      if (!storageKey) missing();
      const record = await store.load(storageKey);
      const ticket = await store.readTicket(sha(token));
      if (
        !record ||
        record.editId !== editId ||
        record.target !== target ||
        Date.parse(record.expiresAt) <= Date.now() ||
        !ticket ||
        ticket.editId !== editId ||
        ticket.sessionId !== record.sessionId ||
        recordKey(record) !== storageKey ||
        ticket.target !== target ||
        Date.parse(ticket.expiresAt) <= Date.now()
      )
        missing();
      await authorize(record.ownerUserId, record.sessionId);
      try {
        return await cache.read(ticket.key, path);
      } catch {
        throw new SessionError(404, 'PREVIEW_FILE_NOT_FOUND', '临时预览资源不存在，请刷新预览');
      }
    },
    /** 进程只持取消句柄；重启后 GET 可从 Redis 快照恢复缺失的构建缓存。 */
    async close() {
      closed = true;
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map((job) => job.done));
      await warm?.close();
    },
    cleanup: () => cache.cleanup(),
  };
}
export type EditService = ReturnType<typeof createEditService>;
