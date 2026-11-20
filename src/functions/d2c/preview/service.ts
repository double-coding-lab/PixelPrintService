import { findOrderedRows } from '../utils/orderedRead';
import { previewDiagnostic, previewFailureDiagnostic, previewFailureDetails } from './diagnostics';
import { PreviewBuildError } from './runner';
import { missingPreviewFile } from './session';
import type { D2cRun } from '@/models/D2cRun';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Op, Transaction, fn, col, literal, type Sequelize } from 'sequelize';
import { createPreviewCache, type PreviewCache, type CachedPreviewFile } from './cache';
import { sessionPreviewInput, validateSessionEntry, type PreviewSnapshotFile } from './session';
import type { D2cPreview } from '@/models/D2cPreview';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { D2cFile } from '@/models/D2cFile';
import type { D2cVersion } from '@/models/D2cVersion';
import type { D2cVersionFile } from '@/models/D2cVersionFile';
import type { StorageFileClient } from '@/hooks/tools/storage';
import { ownedSession, requireIdentifier, SessionError } from '../session/access';
import { assertArtifactPath } from '../utils/paths';
import { imageObjectName } from '../utils/imageObjectName';
import type { runPreviewBuild } from './runner';

type FileObject = Record<string, unknown>;
type Ticket = { hash: string; expiresAt: number; ownerUserId?: string };
type Manifest = {
  target: 'h5' | 'rn';
  entryPath: string;
  snapshot?: PreviewSnapshotFile[];
  inputHash?: string;
  entries?: string[];
  observedFileRevision?: number;
  files?: Array<{
    path: string;
    mimeType: string;
    size: number;
    sha256: string;
    object?: FileObject;
  }>;
  tickets?: Ticket[];
  publicToken?: string;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** 读取与创建共用运行修订，避免自动预览命中旧模板产物。 */
function runtimeRevision(target: string) {
  return target === 'h5' ? 'h5-react-scss-v3' : 'rn-web-v3';
}

/** 预览元信息只投影状态，构建定位、读取票据和固定配置不向页面暴露。 */
function summary(row: D2cPreview) {
  const manifest = row.buildManifest as Manifest;
  return {
    previewId: row.previewId!,
    versionId: row.versionId,
    fileRevision: row.fileRevision,
    validatedFileRevision: manifest.observedFileRevision ?? row.fileRevision,
    ...(manifest.inputHash ? { inputHash: manifest.inputHash } : {}),
    status: row.status,
    target: manifest.target,
    entryPath: manifest.entryPath,
    error: row.status === 'failed' ? previewFailureDiagnostic(row.error) : null,
  };
}

/** 不可变版本预览服务；登录用户申请作品长期链接或私有会话短时票据。 */
export function createPreviewService(
  mysql: Sequelize,
  options: {
    binary: () => StorageFileClient;
    run: typeof runPreviewBuild;
    readLimits: () => { textFileBytes: number; filesPerSession: number; uploadBytes: number };
    report?: (phase: string, reason: string, details?: Record<string, unknown>) => void;
    cache?: PreviewCache;
    notify?: (sessionId: string) => void;
  },
) {
  const previews = mysql.models.D2cPreview as typeof D2cPreview;
  const versions = mysql.models.D2cVersion as typeof D2cVersion;
  const versionFiles = mysql.models.D2cVersionFile as typeof D2cVersionFile;
  const cache = options.cache ?? createPreviewCache();
  const shutdown = new AbortController();
  const listeners = new Set<(sessionId: string) => void>();
  const rebuilding = new Map<string, Promise<void>>();
  const rebuildErrors = new Map<string, NonNullable<ReturnType<typeof previewDiagnostic>>>();

  /** 私有预览必须沿用会话归属，版本路径保持登录用户共享语义。 */
  async function authorize(userId: string, row: D2cPreview) {
    if (row.sessionId) await ownedSession(mysql, userId, row.sessionId, undefined, 'read');
  }

  /** 会话父目录固定；输入修订叶子保持不可变，旧 iframe 仍可读取原来的分块。 */
  function cacheKey(row: D2cPreview) {
    const value = row.buildManifest as Manifest;
    return `sessions/${row.sessionId}/${sha(value.entryPath)}/${value.inputHash}`;
  }

  /** 旧扁平缓存按原摘要迁入会话目录，升级服务不要求重新编译。 */
  async function cacheAvailable(row: D2cPreview) {
    const key = cacheKey(row);
    if (await cache.has(key)) return true;
    const value = row.buildManifest as Manifest;
    const legacy = sha(
      JSON.stringify([row.sessionId, value.inputHash, row.runtimeRevision, value.entryPath]),
    );
    return cache.migrate(legacy, key);
  }

  /** 状态/静态读取剔除源码快照；实际编译和票据写入仍读取完整清单。 */
  const metadataAttributes = {
    exclude: ['buildManifest'],
    include: [
      [fn('JSON_REMOVE', col('buildManifest'), literal("'$.snapshot'")), 'buildManifest'] as [
        ReturnType<typeof fn>,
        string,
      ],
    ],
  };
  const headAttributes = {
    exclude: ['buildManifest'],
    include: [
      [
        fn(
          'JSON_REMOVE',
          col('buildManifest'),
          literal("'$.snapshot'"),
          literal("'$.files'"),
          literal("'$.tickets'"),
        ),
        'buildManifest',
      ] as [ReturnType<typeof fn>, string],
    ],
  };

  /** 排队排序只携带领取所需元信息，避免源码快照耗尽 MySQL 排序内存。 */
  const claimAttributes = [
    'id',
    'previewId',
    'sessionId',
    [
      fn(
        'JSON_OBJECT',
        literal("'entryPath'"),
        fn('JSON_EXTRACT', col('buildManifest'), literal("'$.entryPath'")),
      ),
      'buildManifest',
    ] as [ReturnType<typeof fn>, string],
  ];

  /** 本地 miss 不向调用方声称 ready；纯查询不会启动构建。 */
  async function visible(row: D2cPreview, activeRunId?: string | null) {
    const value = summary(row);
    if (row.sessionId && row.status === 'ready' && !(await cacheAvailable(row)))
      return rebuildErrors.has(cacheKey(row))
        ? { ...value, status: 'failed' as const, error: rebuildErrors.get(cacheKey(row))! }
        : { ...value, status: 'queued' as const };
    if (
      row.sessionId &&
      row.status === 'failed' &&
      activeRunId &&
      value.error?.code === 'MODULE_NOT_FOUND'
    ) {
      const run = await (mysql.models.D2cRun as typeof D2cRun).findOne({
        where: { runId: activeRunId, sessionId: row.sessionId },
        attributes: ['status'],
      });
      if (run && ['queued', 'running'].includes(run.status)) {
        const full = await find(row.previewId!);
        const waitingForFile = missingPreviewFile(
          value.error,
          (full.buildManifest as Manifest).snapshot ?? [],
        );
        if (waitingForFile)
          return { ...value, status: 'waiting_files', error: null, waitingForFile };
      }
    }
    return value;
  }

  /** 通知失败不影响已提交的状态；主 Agent 可接入 SSE 唤醒。 */
  function notify(sessionId: string) {
    for (const listener of [options.notify, ...listeners]) {
      if (!listener) continue;
      try {
        void Promise.resolve(listener(sessionId)).catch(() => undefined);
      } catch {
        /* 单个监听器异常不阻断其他订阅，也不改变已提交的状态。 */
      }
    }
  }

  /** 状态通知只在所属事务提交之后发送。 */
  function changed(row: D2cPreview, transaction: Transaction) {
    if (row.sessionId) transaction.afterCommit(() => notify(row.sessionId!));
  }

  /** 所有状态和票据修改都持有该预览行锁。 */
  async function find(previewId: string, transaction?: Transaction, full = true) {
    requireIdentifier(previewId);
    const row = await previews.findOne({
      where: { previewId },
      ...(!full ? { attributes: metadataAttributes } : {}),
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!row) throw new SessionError(404, 'PREVIEW_NOT_FOUND', '预览不存在');
    return row;
  }
  /** 根据固定版本准备输入，逐个核验正文或二进制，内部资料不进入构建。 */
  async function inputs(row: D2cPreview, signal: AbortSignal, onFile?: (path: string) => void) {
    const rows = row.sessionId
      ? (row.buildManifest as Manifest).snapshot
      : await findOrderedRows(versionFiles, 'pathHash', {
          where: { versionId: row.versionId },
          order: [['pathHash', 'ASC']],
        });
    if (!rows) throw new Error('INPUT_SNAPSHOT_MISSING');
    const files: Array<{ path: string; content: Buffer }> = [];
    const limits = options.readLimits();
    let bytes = 0;
    for (const file of rows.filter((file) => file.kind !== 'internal')) {
      signal.throwIfAborted();
      if (
        !file.path ||
        assertArtifactPath(file.path) !== file.path ||
        ('pathHash' in file && sha(file.path) !== file.pathHash)
      )
        throw new Error('INPUT_PATH');
      if (!['source', 'asset', 'attachment'].includes(file.kind ?? ''))
        throw new Error('INPUT_KIND');
      onFile?.(file.path);
      const content =
        file.kind === 'source' && typeof file.content === 'string'
          ? Buffer.from(file.content)
          : file.objectLocator
            ? await options.binary().downloadFile(file.objectLocator)
            : null;
      if (!content || content.length !== file.size || sha(content) !== file.sha256)
        throw new Error('INPUT_CORRUPT');
      if (file.kind === 'source' && content.length > limits.textFileBytes)
        throw new Error('INPUT_LIMIT');
      bytes += content.length;
      if (bytes > 64 * 1024 * 1024 || files.length >= limits.filesPerSession)
        throw new Error('INPUT_LIMIT');
      files.push({ path: file.path, content });
    }
    return files;
  }
  /** 统一固定输入和模板参数，重建也绝不读取最新会话文件。 */
  async function build(
    row: D2cPreview,
    signal: AbortSignal,
    progress?: (phase: string, artifactPath?: string) => void,
  ) {
    const manifest = row.buildManifest as Manifest;
    const config = row.configSnapshot?.config as
      | { unit?: { outputUnit?: string; outputBase?: number } }
      | undefined;
    progress?.('input');
    const files = await inputs(row, signal, (file) => progress?.('input', file));
    progress?.('build', manifest.entryPath);
    signal.throwIfAborted();
    return options.run({
      files,
      target: manifest.target,
      entryPath: manifest.entryPath,
      unit: {
        outputUnit: manifest.target === 'h5' || config?.unit?.outputUnit === 'vw' ? 'vw' : 'px',
        outputBase: Number(config?.unit?.outputBase ?? 750),
      },
      signal,
    });
  }

  /** 发布前核验输出白名单、重复路径和体积；版本与会话共用同一约束。 */
  function validateBuilt(files: CachedPreviewFile[]) {
    if (!files.some((file) => file.path === 'index.html') || files.length > 500)
      throw new Error('BUILD_OUTPUT');
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (
        !file.path ||
        file.path.startsWith('/') ||
        /[\\\x00-\x1f:%?#]/.test(file.path) ||
        file.path.split('/').some((part) => !part || part === '..' || part.startsWith('.')) ||
        !/\.(?:html|js|css|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|ico|mp4|webm|mp3|wav)$/i.test(
          file.path,
        ) ||
        paths.has(file.path)
      )
        throw new Error('BUILD_OUTPUT');
      paths.add(file.path);
      total += file.content.length;
      if (total > Math.min(options.readLimits().uploadBytes, 30000000))
        throw new Error('BUILD_LIMIT');
    }
  }

  /** ready 在其他实例并不意味着本机有文件；本机重建合并且保留数据库票据。 */
  function rebuild(row: D2cPreview) {
    const key = cacheKey(row);
    if (rebuilding.has(key)) return rebuilding.get(key)!;
    rebuildErrors.delete(key);
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000)]);
    let phase = 'cache';
    let artifactPath: string | undefined;
    const task = Promise.resolve()
      .then(async () => {
        if (await cache.has(key)) return;
        phase = 'snapshot';
        const built = await build(
          await find(row.previewId!, undefined, true),
          signal,
          (next, file) => {
            phase = next;
            artifactPath = file;
          },
        );
        signal.throwIfAborted();
        phase = 'output';
        artifactPath = undefined;
        validateBuilt(built);
        phase = 'cache';
        await cache.write(key, built);
        notify(row.sessionId!);
      })
      .catch((error) => {
        rebuildErrors.set(
          key,
          previewFailureDiagnostic(
            signal.aborted
              ? { reason: shutdown.signal.aborted ? 'BUILD_INTERRUPTED' : 'BUILD_TIMEOUT' }
              : { diagnostic: error instanceof PreviewBuildError ? error.diagnostic : undefined },
          ),
        );
        if (rebuildErrors.size > 1000) rebuildErrors.delete(rebuildErrors.keys().next().value!);
        notify(row.sessionId!);
        try {
          options.report?.(phase, 'PREVIEW_REBUILD_FAILED', {
            previewId: row.previewId,
            sessionId: row.sessionId,
            ...(artifactPath ? { artifactPath } : {}),
            ...previewFailureDetails(error),
          });
        } catch {
          /* 日志不改变重建状态。 */
        }
      })
      .finally(() => {
        rebuilding.delete(key);
      });
    rebuilding.set(key, task);
    return task;
  }

  /** miss 明确返回重建原因，后台构建不能在请求中运行未隔离代码。 */
  async function requireCache(row: D2cPreview) {
    if (await cacheAvailable(row)) return;
    void rebuild(row);
    throw new SessionError(409, 'PREVIEW_CACHE_MISS', '本机预览缓存已失效，正在重建，请稍后重试');
  }

  /** 修订与配置未变时只读轻量元数据，不搬运所有源码或历史构建文件。 */
  async function cachedSessionPreview(
    userId: string,
    sessionId: string,
    entryPath: string | undefined,
    create: boolean,
    retry = false,
  ) {
    const result = await mysql.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const { workspace: authorized, session } = await ownedSession(
          mysql,
          userId,
          sessionId,
          transaction,
          'read',
        );
        const workspace = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
          where: { workspaceId: authorized.workspaceId },
          attributes: ['workspaceId', 'configRevision', 'activeResourceRevisionId'],
          transaction,
        });
        if (!workspace || !session.target) return null;
        const rows = await findOrderedRows(previews, 'previewId', {
          where: { sessionId, runtimeRevision: runtimeRevision(session.target) },
          attributes: headAttributes,
          order: [
            ['fileRevision', 'DESC'],
            ['createdAt', 'DESC'],
            ['id', 'DESC'],
          ],
          transaction,
        });
        const current = rows.find((row) => {
          const manifest = row.buildManifest as Manifest;
          return (
            (entryPath === undefined || manifest.entryPath === entryPath) &&
            (manifest.observedFileRevision ?? row.fileRevision) === session.fileRevision &&
            row.configSnapshot?.configRevision === workspace.configRevision &&
            row.resourceRevisionId === workspace.activeResourceRevisionId &&
            row.error?.reason !== 'PREVIEW_SUPERSEDED'
          );
        });
        if (!current) return null;
        if (create && retry && current.status === 'failed') return null;
        const manifest = current.buildManifest as Manifest;
        const entries =
          manifest.entries ??
          (
            await (mysql.models.D2cFile as typeof D2cFile).findAll({
              where: { sessionId, kind: 'source' },
              attributes: ['path'],
              transaction,
            })
          ).flatMap((file) =>
            typeof file.path === 'string' && /\.(?:tsx|jsx)$/i.test(file.path) ? [file.path] : [],
          );
        let lastReady: ReturnType<typeof summary> | null = null;
        const candidates = [
          ...(current.status === 'ready' ? [current] : []),
          ...rows.filter(
            (row) =>
              row.previewId !== current.previewId &&
              row.status === 'ready' &&
              (row.buildManifest as Manifest).entryPath === manifest.entryPath,
          ),
        ];
        for (const row of candidates) {
          if (await cacheAvailable(row)) {
            lastReady = summary(row);
            break;
          }
        }
        return {
          row: current,
          entries,
          fileRevision: session.fileRevision,
          lastReady,
          activeRunId: session.activeRunId,
        };
      },
    );
    if (!result) return null;
    const { row, activeRunId, ...state } = result;
    if (create && row.status === 'ready' && state.lastReady?.previewId !== row.previewId)
      void rebuild(row);
    return {
      current:
        state.lastReady?.previewId === row.previewId
          ? summary(row)
          : await visible(row, activeRunId),
      ...state,
    };
  }

  /** 查询和创建共用一致性快照；会话锁合并同入口重复 POST 与过时排队输入。 */
  async function sessionPreview(
    userId: string,
    sessionId: string,
    entryPath: string | undefined,
    create: boolean,
    retry = false,
  ) {
    validateSessionEntry(entryPath);
    const cached = await cachedSessionPreview(userId, sessionId, entryPath, create, retry);
    if (cached) return cached;
    const result = await mysql.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const input = await sessionPreviewInput(
          mysql,
          userId,
          sessionId,
          entryPath,
          transaction,
          options.readLimits(),
          create,
        );
        const revision = runtimeRevision(input.session.target!);
        const inputHash = sha(JSON.stringify([input.fingerprint, input.entryPath, revision]));
        const rows = await findOrderedRows(previews, 'previewId', {
          where: { sessionId },
          attributes: headAttributes,
          order: [
            ['fileRevision', 'DESC'],
            ['createdAt', 'DESC'],
            ['id', 'DESC'],
          ],
          transaction,
          ...(create ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        const matching = rows.filter(
          (row) =>
            (row.buildManifest as Manifest).entryPath === input.entryPath &&
            row.runtimeRevision === revision,
        );
        let current = input.entryPath
          ? (matching.find(
              (row) =>
                (row.buildManifest as Manifest).inputHash === inputHash &&
                row.error?.reason !== 'PREVIEW_SUPERSEDED',
            ) ?? null)
          : null;
        if (create && current) {
          const latest = await find(current.previewId!, transaction);
          await latest.update(
            {
              ...(retry && latest.status === 'failed'
                ? {
                    status: 'queued',
                    error: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                  }
                : {}),
              configSnapshot: input.configSnapshot,
              buildManifest: {
                ...latest.buildManifest,
                entries: input.entries,
                observedFileRevision: input.session.fileRevision,
              },
            },
            { transaction },
          );
          current = latest;
          if (retry && current.status === 'queued') changed(current, transaction);
        }
        if (create && input.entryPath && !current) {
          for (const row of matching.filter((row) => row.status === 'queued')) {
            await row.update(
              { status: 'failed', error: { reason: 'PREVIEW_SUPERSEDED' } },
              { transaction },
            );
            changed(row, transaction);
          }
          current = await previews.create(
            {
              previewId: randomUUID(),
              sessionId,
              versionId: null,
              fileRevision: input.session.fileRevision,
              manifestHash: inputHash,
              configSnapshot: input.configSnapshot,
              resourceRevisionId: input.resourceRevisionId,
              runtimeRevision: revision,
              status: 'queued',
              leaseOwner: null,
              leaseExpiresAt: null,
              error: null,
              buildManifest: {
                target: input.session.target!,
                entryPath: input.entryPath,
                inputHash,
                entries: input.entries,
                observedFileRevision: input.session.fileRevision,
                snapshot: input.snapshot,
              },
            },
            { transaction },
          );
          changed(current, transaction);
        }
        let lastReady: ReturnType<typeof summary> | null = null;
        for (const row of matching) {
          if (row.status === 'ready' && (await cacheAvailable(row))) {
            lastReady = summary(row);
            break;
          }
        }
        return {
          currentRow: current,
          activeRunId: input.session.activeRunId,
          lastReady,
          entries: input.entries,
          fileRevision: input.session.fileRevision,
        };
      },
    );
    const { currentRow, activeRunId, ...rest } = result;
    if (create && currentRow?.status === 'ready' && !(await cacheAvailable(currentRow)))
      void rebuild(currentRow);
    return { current: currentRow ? await visible(currentRow, activeRunId) : null, ...rest };
  }

  return {
    /** 订阅提交后的会话预览变化；返回退订函数，供路由生命周期释放。 */
    subscribe(listener: (sessionId: string) => void) {
      if (shutdown.signal.aborted) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 当前会话预览幂等入队；没有可用入口时返回 current:null。 */
    createSession(userId: string, sessionId: string, entryPath?: string, retry = false) {
      return sessionPreview(userId, sessionId, entryPath, true, retry);
    },
    /** 只读查询一致性输入和本机可用的最近成功结果，不触发编译。 */
    existingSession(userId: string, sessionId: string, entryPath?: string) {
      return sessionPreview(userId, sessionId, entryPath, false);
    },
    /** 内部截图读取：先校验会话归属，缺失缓存显式唤醒本机重建，不开放 HTTP。 */
    async captureInputs(userId: string, previewId: string) {
      requireIdentifier(userId);
      const row = await find(previewId, undefined, false);
      await authorize(userId, row);
      if (row.status !== 'ready')
        throw new SessionError(409, 'PREVIEW_NOT_READY', '预览尚未构建完成');
      const manifest = row.buildManifest as Manifest;
      let files: CachedPreviewFile[];
      if (row.sessionId) {
        await requireCache(row);
        try {
          files = await cache.readAll(cacheKey(row));
        } catch {
          void rebuild(row);
          throw new SessionError(
            409,
            'PREVIEW_CACHE_MISS',
            '本机预览缓存已失效，正在重建，请稍后重试',
          );
        }
      } else {
        files = [];
        for (const file of manifest.files ?? []) {
          const content = await options
            .binary()
            .downloadFile(file.object!)
            .catch(() => {
              throw new SessionError(503, 'PREVIEW_READ_FAILED', '预览资源读取失败');
            });
          if (content.length !== file.size || sha(content) !== file.sha256)
            throw new SessionError(503, 'PREVIEW_READ_FAILED', '预览资源读取失败');
          files.push({ path: file.path, content, mimeType: file.mimeType });
        }
      }
      return {
        files,
        target: manifest.target,
        entryPath: manifest.entryPath,
        fileRevision: row.fileRevision,
        ...(manifest.inputHash ? { inputHash: manifest.inputHash } : {}),
      };
    },
    /** 停止本机重建并等待已接收的任务释放隔离执行器。 */
    async close() {
      shutdown.abort();
      await Promise.all(rebuilding.values());
      listeners.clear();
    },
    /** 清理只触及可再生成的编译目录。 */
    cleanup() {
      return cache.cleanup();
    },
    /** 入队只保存固定版本和入口；不修改版本、不启动请求内构建。 */
    async create(userId: string, versionId: string, entryPath: string) {
      requireIdentifier(userId);
      requireIdentifier(versionId);
      try {
        if (assertArtifactPath(entryPath) !== entryPath || !/\.(?:tsx|jsx)$/i.test(entryPath))
          throw new Error();
      } catch {
        throw new SessionError(422, 'INVALID_ENTRY', '请选择实际的 TSX 或 JSX 页面入口');
      }
      return mysql.transaction(async (transaction) => {
        const version = await versions.findOne({
          where: { versionId, status: 'ready' },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!version?.archiveObject || !version.target)
          throw new SessionError(404, 'VERSION_NOT_FOUND', '暂存版本不存在');
        const entry = await versionFiles.findOne({
          where: { versionId, pathHash: sha(entryPath), kind: 'source' },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (entry?.path !== entryPath)
          throw new SessionError(422, 'INVALID_ENTRY', '版本中不存在该源码入口');
        const revision = runtimeRevision(version.target);
        const existingRows = await findOrderedRows(previews, 'previewId', {
          where: { versionId, status: { [Op.in]: ['queued', 'building', 'ready'] } },
          order: [['createdAt', 'DESC']],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const existing = existingRows.find(
          (item) =>
            (item.buildManifest as Manifest)?.entryPath === entryPath &&
            item.runtimeRevision === revision,
        );
        if (existing) return summary(existing);
        const row = await previews.create(
          {
            previewId: randomUUID(),
            versionId,
            sessionId: null,
            fileRevision: version.sourceFileRevision,
            manifestHash: version.manifestHash,
            configSnapshot: version.configSnapshot,
            resourceRevisionId: version.resourceRevisionId,
            runtimeRevision: revision,
            status: 'queued',
            leaseOwner: null,
            leaseExpiresAt: null,
            buildManifest: { target: version.target, entryPath },
            error: null,
          },
          { transaction },
        );
        return summary(row);
      });
    },
    /** 只读查找当前版本/入口/运行修订的已有预览，不加写锁、不入队或触发构建。 */
    async existing(userId: string, versionId: string, entryPath: string) {
      requireIdentifier(userId);
      requireIdentifier(versionId);
      try {
        if (assertArtifactPath(entryPath) !== entryPath || !/\.(?:tsx|jsx)$/i.test(entryPath))
          throw new Error();
      } catch {
        throw new SessionError(422, 'INVALID_ENTRY', '请选择实际的 TSX 或 JSX 页面入口');
      }
      const version = await versions.findOne({ where: { versionId, status: 'ready' } });
      if (!version?.archiveObject || !version.target)
        throw new SessionError(404, 'VERSION_NOT_FOUND', '暂存版本不存在');
      const entry = await versionFiles.findOne({
        where: { versionId, pathHash: sha(entryPath), kind: 'source' },
      });
      if (entry?.path !== entryPath)
        throw new SessionError(422, 'INVALID_ENTRY', '版本中不存在该源码入口');
      const rows = await findOrderedRows(previews, 'previewId', {
        where: {
          versionId,
          runtimeRevision: runtimeRevision(version.target),
          status: { [Op.in]: ['queued', 'building', 'ready'] },
        },
        order: [['createdAt', 'DESC']],
      });
      const row = rows.find((item) => (item.buildManifest as Manifest)?.entryPath === entryPath);
      return row ? summary(row) : null;
    },
    /** 构建状态读取面向所有登录用户，不返回其他用户的私有会话信息。 */
    async get(userId: string, previewId: string) {
      requireIdentifier(userId);
      const row = await find(previewId, undefined, false);
      await authorize(userId, row);
      return visible(row);
    },
    /** 作品链接持久复用；私有短票据保存摘要并绑定用户，读取时重新验证访问权。 */
    async ticket(userId: string, previewId: string) {
      requireIdentifier(userId);
      await authorize(userId, await find(previewId, undefined, false));
      return mysql.transaction(async (transaction) => {
        const row = await find(previewId, transaction);
        if (row.status !== 'ready')
          throw new SessionError(409, 'PREVIEW_NOT_READY', '预览尚未构建完成');
        if (row.sessionId) await requireCache(row);
        const value = row.buildManifest as Manifest;
        if (!row.sessionId && row.versionId) {
          const token = value.publicToken ?? randomBytes(32).toString('hex');
          if (!value.publicToken)
            await row.update({ buildManifest: { ...value, publicToken: token } }, { transaction });
          return {
            url: `/${value.target === 'h5' ? 'H5_Preview' : 'RN_Preview'}/${previewId}/${token}/index.html`,
            expiresAt: null,
          };
        }
        const token = randomBytes(32).toString('hex'),
          expiresAt = Date.now() + 300000;
        const tickets = (value.tickets ?? []).filter((ticket) => ticket.expiresAt > Date.now());
        if (tickets.length >= 1024)
          throw new SessionError(429, 'PREVIEW_TICKET_LIMIT', '当前预览访问较多，请稍后重试');
        await row.update(
          {
            buildManifest: {
              ...value,
              tickets: [
                ...tickets,
                { hash: sha(token), expiresAt, ...(row.sessionId ? { ownerUserId: userId } : {}) },
              ],
            },
          },
          { transaction },
        );
        return {
          url: `/${value.target === 'h5' ? 'H5_Preview' : 'RN_Preview'}/${previewId}/${token}/index.html`,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      });
    },
    /** 读取已登记资产；票据不具备其他预览、源码或API读取能力。 */
    async asset(target: 'h5' | 'rn', previewId: string, token: string, path: string) {
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new SessionError(404, 'PREVIEW_NOT_FOUND', '预览资源不存在');
      const row = await find(previewId, undefined, false),
        manifest = row.buildManifest as Manifest;
      const publicVersion = !row.sessionId && !!row.versionId;
      const ticket = manifest.tickets?.find(
        (ticket) => ticket.hash === sha(token) && (publicVersion || ticket.expiresAt > Date.now()),
      );
      const permanent = publicVersion && manifest.publicToken === token;
      if (
        row.status !== 'ready' ||
        manifest.target !== target ||
        (!ticket && !permanent) ||
        (row.sessionId && !ticket?.ownerUserId)
      )
        throw new SessionError(404, 'PREVIEW_NOT_FOUND', '预览链接已失效，请刷新预览');
      if (row.sessionId) {
        await authorize(ticket!.ownerUserId!, row);
        await requireCache(row);
        try {
          return await cache.read(cacheKey(row), path);
        } catch (error) {
          if (error instanceof Error && error.message === 'CACHE_FILE_NOT_FOUND')
            throw new SessionError(404, 'PREVIEW_FILE_NOT_FOUND', '预览资源不存在');
          void rebuild(row);
          throw new SessionError(
            409,
            'PREVIEW_CACHE_MISS',
            '本机预览缓存已失效，正在重建，请稍后重试',
          );
        }
      }
      const file = manifest.files?.find((file) => file.path === path);
      if (!file) throw new SessionError(404, 'PREVIEW_FILE_NOT_FOUND', '预览资源不存在');
      try {
        const content = await options.binary().downloadFile(file.object!);
        if (content.length !== file.size || sha(content) !== file.sha256) throw new Error();
        return { content, mimeType: file.mimeType };
      } catch {
        throw new SessionError(503, 'PREVIEW_READ_FAILED', '预览资源读取失败');
      }
    },
    /** 数据库领取防止同一个构建被多实例重复执行，失效租约结算失败不重放。 */
    async work(signal: AbortSignal) {
      const owner = randomUUID();
      const row = await mysql.transaction(async (transaction) => {
        const expired = await previews.findAll({
          attributes: ['id', 'previewId', 'sessionId'],
          where: { status: 'building', leaseExpiresAt: { [Op.lt]: new Date() } },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        for (const item of expired) {
          await item.update(
            {
              status: 'failed',
              leaseOwner: null,
              leaseExpiresAt: null,
              error: { reason: 'BUILD_INTERRUPTED' },
            },
            { transaction },
          );
          changed(item, transaction);
        }
        const candidates = await previews.findAll({
          attributes: ['id', 'previewId', 'sessionId'],
          where: { status: 'queued' },
          order: [
            ['createdAt', 'ASC'],
            ['previewId', 'ASC'],
          ],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const active = await previews.findAll({
          attributes: claimAttributes,
          where: { status: 'building' },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        let next: D2cPreview | undefined;
        for (const candidate of candidates) {
          if (
            candidate.sessionId &&
            active.some((item) => item.sessionId === candidate.sessionId)
          ) {
            const metadata = await previews.findOne({
              where: { previewId: candidate.previewId },
              attributes: claimAttributes,
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (
              active.some(
                (item) =>
                  item.sessionId === candidate.sessionId &&
                  (item.buildManifest as Manifest).entryPath ===
                    (metadata?.buildManifest as Manifest)?.entryPath,
              )
            )
              continue;
          }
          next = candidate;
          break;
        }
        if (!next) return null;
        const selected = await find(next.previewId!, transaction);
        await selected.update(
          { status: 'building', leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 300000) },
          { transaction },
        );
        changed(selected, transaction);
        return selected;
      });
      if (!row) return false;
      const previewId = row.previewId!;
      const controller = new AbortController();
      let abortReason = 'BUILD_INTERRUPTED';
      const stop = () => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      const timeout = setTimeout(() => {
        abortReason = 'BUILD_TIMEOUT';
        stop();
      }, 120000);
      /** 长构建续租失败立即取消；结算仍校验owner，不接受旧执行者写入。 */
      async function settle(values: Record<string, unknown>) {
        return mysql.transaction(async (transaction) => {
          const current = await find(previewId, transaction);
          if (current.status !== 'building' || current.leaseOwner !== owner)
            throw new Error('LEASE_LOST');
          await current.update(values, { transaction });
          if (values.status) changed(current, transaction);
        });
      }
      let heartbeat: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (heartbeat) return;
        heartbeat = settle({ leaseExpiresAt: new Date(Date.now() + 300000) })
          .catch(stop)
          .finally(() => {
            heartbeat = undefined;
          });
      }, 30000);
      timer.unref();
      let phase = 'input';
      try {
        const manifest = row.buildManifest as Manifest;
        phase = 'build';
        const built = await build(row, controller.signal);
        validateBuilt(built);
        if (row.sessionId) {
          phase = 'cache';
          await cache.write(cacheKey(row), built);
        }
        phase = row.sessionId ? 'cache' : 'upload';
        const output: NonNullable<Manifest['files']> = [];
        for (const file of built) {
          controller.signal.throwIfAborted();
          const object = row.sessionId
            ? undefined
            : await options.binary().uploadFile({
                content: file.content,
                fileName: file.mimeType.startsWith('image/')
                  ? imageObjectName(file.path.split('/').pop()!)
                  : `preview-${row.previewId}-${randomUUID()}.${file.path.split('.').at(-1)}`,
                contentType: file.mimeType.split(';', 1)[0].trim(),
              });
          if (
            object &&
            (object.size !== file.content.length || object.sha256 !== sha(file.content))
          )
            throw new Error('UPLOAD_RECEIPT');
          output.push({
            path: file.path,
            mimeType: file.mimeType,
            size: file.content.length,
            sha256: sha(file.content),
            ...(object ? { object } : {}),
          });
        }
        controller.signal.throwIfAborted();
        await settle({
          status: 'ready',
          leaseOwner: null,
          leaseExpiresAt: null,
          error: null,
          buildManifest: { ...manifest, files: output, tickets: [] },
        });
      } catch (error) {
        const reason = controller.signal.aborted
          ? abortReason
          : error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
            ? error.message
            : 'BUILD_FAILED';
        options.report?.(phase, reason, {
          previewId: row.previewId,
          sessionId: row.sessionId,
          ...previewFailureDetails(error),
        });
        if (error instanceof PreviewBuildError && error.cleanupFailed)
          options.report?.('cleanup', 'PREVIEW_CLEANUP_FAILED');
        await settle({
          status: 'failed',
          leaseOwner: null,
          leaseExpiresAt: null,
          error: {
            phase,
            reason,
            ...(error instanceof PreviewBuildError && error.cleanupFailed
              ? { cleanupFailed: true }
              : {}),
            ...(error instanceof PreviewBuildError && error.diagnostic
              ? { diagnostic: previewDiagnostic(error.diagnostic) }
              : {}),
          },
        }).catch(() => undefined);
      } finally {
        clearTimeout(timeout);
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
        await heartbeat;
      }
      return true;
    },
    /** 后台领取异常使用固定诊断上报，不输出 SQL、快照或数据库连接信息。 */
    reportWorkerFailure(error: unknown) {
      const code = (error as { original?: { code?: unknown } } | null)?.original?.code;
      try {
        options.report?.('claim', 'PREVIEW_CLAIM_FAILED', {
          ...(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? { causeCode: code } : {}),
        });
      } catch {
        /* 诊断上报失败不阻断后续领取。 */
      }
    },
  };
}
export type PreviewService = ReturnType<typeof createPreviewService>;

/** 本地只持有执行取消句柄；排队与构建状态都以MySQL为准。 */
export function startPreviewWorker(service: PreviewService) {
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  const tick = () => {
    if (!running && !controller.signal.aborted)
      running = service
        .work(controller.signal)
        .catch((error) => service.reportWorkerFailure(error))
        .finally(() => {
          running = undefined;
        });
  };
  let cleaning: Promise<unknown> | undefined;
  /** 容量写入时强制检查，定期扫描同时回收无新写入时的过期结果。 */
  const clean = () => {
    cleaning ??= service
      .cleanup()
      .catch(() => undefined)
      .finally(() => {
        cleaning = undefined;
      });
  };
  const cleanupTimer = setInterval(clean, 60000);
  cleanupTimer.unref();
  clean();
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      clearInterval(cleanupTimer);
      controller.abort();
      await running;
      await service.close();
      await cleaning;
    },
  };
}
