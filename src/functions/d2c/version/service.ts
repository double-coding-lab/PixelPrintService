import { findOrderedRows } from '../utils/orderedRead';
import { appendSessionEvent } from '../session/service';
import { createGalleryService } from './gallery';
import { createHash, randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cVersion } from '@/models/D2cVersion';
import type { D2cVersionFile } from '@/models/D2cVersionFile';
import type { D2cFile } from '@/models/D2cFile';
import type { StorageFileClient } from '@/hooks/tools/storage';
import { ownedSession, requireIdentifier, requireRevision, SessionError } from '../session/access';
import { assertArtifactPath } from '../utils/paths';
import { createConfigSnapshot, parseWorkspaceConfigs } from '../utils/config';
import { buildVersionArchive, type ArchiveFile } from './archive';
import { contentModel, copyTextStorage, resolveTextContent } from '../content/runtime';

export type VersionInput = { clientRequestId: string; name?: string; baseFileRevision?: number };
type Limits = { textFileBytes: number; filesPerSession: number; uploadBytes: number };

/** 输出已授权会话的重试信息和公开摘要，存储定位、配置与源码保持私有。 */
function summary(row: D2cVersion, privateView = true) {
  return {
    versionId: row.versionId!,
    name: row.name!,
    status: row.status,
    target: row.target,
    sourceFileRevision: row.sourceFileRevision,
    validationSummary: row.validationSummary,
    createdUserId: row.createdUserId,
    creatorName: row.creatorName,
    createdAt: row.createdAt,
    ...(privateView ? { clientRequestId: row.clientRequestId } : {}),
    error: row.status === 'failed' ? { message: '版本打包未完成，请重试' } : null,
  };
}

/** 冻结版本清单的稳定指纹，不使用当前会话内容替换已冻结文件。 */
function manifest(files: ArchiveFile[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => [file.path, file.kind, file.size, file.sha256]),
      ),
    )
    .digest('hex');
}

/** 复用版本两表与Storage，冻结事务和外部上传分离，失败可按原请求重建。 */
export function createVersionService(
  mysql: Sequelize,
  options: {
    readLimits: () => Limits;
    binary: () => Pick<StorageFileClient, 'uploadFile' | 'downloadFile'>;
    notify?: (sessionId: string, seq: number) => void;
    onBackgroundError?: () => void;
  },
) {
  const versions = mysql.models.D2cVersion as typeof D2cVersion;
  const versionFiles = mysql.models.D2cVersionFile as typeof D2cVersionFile;
  const files = mysql.models.D2cFile as typeof D2cFile;
  if (!versions || !versionFiles || !files)
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '版本模型尚未注册');

  /** 所有版本更新沿用工作区→会话→版本锁序，并核对来源会话。 */
  async function ownedVersion(
    userId: string,
    sessionId: string,
    versionId: string,
    transaction?: Transaction,
  ) {
    requireIdentifier(versionId);
    const { workspace } = await ownedSession(mysql, userId, sessionId, transaction);
    const row = await versions.findOne({
      where: { versionId, sessionId, workspaceId: workspace.workspaceId },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!row) throw new SessionError(404, 'VERSION_NOT_FOUND', '暂存版本不存在');
    return row;
  }

  /** 读取冻结文件，并校验文件元数据；完整字节由打包器和存储客户端核对。 */
  async function frozen(versionId: string): Promise<ArchiveFile[]> {
    const rows = await findOrderedRows(contentModel(mysql, versionFiles), 'pathHash', {
      where: { versionId },
      order: [['pathHash', 'ASC']],
    });
    return rows.map((row) => {
      if (
        !row.path ||
        row.size === null ||
        !row.sha256 ||
        !['source', 'asset', 'attachment'].includes(row.kind ?? '')
      )
        throw new Error('VERSION_MANIFEST_INVALID');
      if (createHash('sha256').update(row.path).digest('hex') !== row.pathHash)
        throw new Error('VERSION_PATH_INVALID');
      return {
        path: row.path,
        kind: row.kind as ArchiveFile['kind'],
        ...copyTextStorage(mysql, row),
        objectLocator: row.objectLocator,
        mimeType: row.mimeType,
        size: row.size,
        sha256: row.sha256,
      };
    });
  }

  const jobs = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let recovering: Promise<void> | undefined;
  let closed = false;

  /** 完成状态与时间线同事务保存，通知仅在提交后发布。 */
  async function changed(sessionId: string, row: D2cVersion, transaction: Transaction) {
    /** 调用方已通过ownedVersion持有工作区和会话锁，此处直接读取同事务实例。 */
    const session = await (mysql.models.D2cSession as typeof D2cSession).findOne({
      where: { sessionId },
      transaction,
    });
    if (!session) throw new SessionError(404, 'SESSION_NOT_FOUND', '会话不存在');
    const seq = await appendSessionEvent(mysql, session, transaction, {
      kind: 'version_changed',
      displayPayload: { versionId: row.versionId, name: row.name, status: row.status },
    });
    transaction.afterCommit(() => {
      try {
        options.notify?.(sessionId, seq);
      } catch {
        /** 通知异常不改变已提交版本。 */
      }
    });
  }

  /** 进程重启或旧持有者失效后，以原请求及冻结快照接回未完成打包。 */
  async function recover() {
    if (closed || recovering) return recovering;
    recovering = (async () => {
      const rows = await findOrderedRows(versions, 'versionId', {
        where: { status: 'saving' },
        order: [['createdAt', 'ASC']],
        limit: 100,
      });
      for (const row of rows) {
        if (closed || jobs.size >= 2) break;
        if (Number(row.error?.leaseUntil ?? 0) > Date.now()) continue;
        try {
          await service.enqueue(row.createdUserId!, row.sessionId!, {
            clientRequestId: row.clientRequestId!,
            name: row.name!,
            baseFileRevision: row.sourceFileRevision!,
          });
        } catch {
          try {
            options.onBackgroundError?.();
          } catch {
            /** 日志失败不阻止后续扫描。 */
          }
        }
      }
    })().finally(() => {
      recovering = undefined;
    });
    return recovering;
  }

  const service = {
    /** HTTP入口只等待冻结快照，打包上传由服务端继续执行。 */
    enqueue(
      userId: string,
      sessionId: string,
      input: VersionInput,
    ): Promise<ReturnType<typeof summary>> {
      if (closed)
        throw new SessionError(503, 'VERSION_SERVICE_CLOSED', '版本服务正在关闭，请稍后重试');
      return service.save(userId, sessionId, input, true);
    },
    /** 默认应用启动恢复扫描；无需浏览器保活或重新提交。 */
    start() {
      if (closed || timer) return;
      const tick = () => {
        void recover().catch(() => {
          try {
            options.onBackgroundError?.();
          } catch {
            /** 日志仅用于诊断。 */
          }
        });
      };
      timer = setInterval(tick, 15000);
      timer.unref();
      tick();
    },
    /** 等待已接收的本实例打包，便于应用关闭和独立脚本验收。 */
    async drain() {
      await Promise.all([...jobs]);
    },
    /** 停止恢复扫描，等待本实例已接收的后台打包完成。 */
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await recovering;
      await service.drain();
    },
    recover,
    gallery: createGalleryService(mysql, options.binary),
    /** 任何执行状态均可冻结已保存文件；省略基础修订时取锁内最新修订，重试使用原快照。 */
    async save(
      userId: string,
      sessionId: string,
      input: VersionInput,
      background = false,
    ): Promise<ReturnType<typeof summary>> {
      requireIdentifier(input.clientRequestId);
      if (input.baseFileRevision !== undefined) requireRevision(input.baseFileRevision);
      if (
        input.name !== undefined &&
        (typeof input.name !== 'string' ||
          input.name.trim().length > 200 ||
          (input.name.trim() && /[\u0000-\u001f\u007f]/u.test(input.name)))
      )
        throw new SessionError(422, 'INVALID_NAME', '版本名称无效');
      const requestedName = input.name?.trim();
      const attemptId = randomUUID();
      const claim = () => ({ attemptId, leaseUntil: Date.now() + 120000 });
      const value = await mysql.transaction(async (transaction) => {
        const { workspace, session } = await ownedSession(mysql, userId, sessionId, transaction);
        const prior = await versions.findOne({
          where: { sessionId, clientRequestId: input.clientRequestId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior) {
          if (
            prior.createdUserId !== userId ||
            (requestedName && prior.name !== requestedName) ||
            (input.baseFileRevision !== undefined &&
              prior.sourceFileRevision !== input.baseFileRevision)
          )
            throw new SessionError(409, 'REQUEST_CONFLICT', '相同请求标识不能用于不同版本内容');
          if (prior.status === 'saving' && Number(prior.error?.leaseUntil) > Date.now()) {
            if (background) return prior;
            throw new SessionError(409, 'VERSION_SAVING', '此版本仍在打包，请稍后刷新列表');
          }
          if (prior.status !== 'ready')
            await prior.update({ status: 'saving', error: claim() }, { transaction });
          return prior;
        }
        /** 与Agent文件写入共用会话锁；仅冻结已提交文件，不修改执行状态或租约。 */
        if (input.baseFileRevision !== undefined && session.fileRevision !== input.baseFileRevision)
          throw new SessionError(409, 'FILE_REVISION_CONFLICT', '文件已更新，请刷新后再暂存');
        if (!workspace.activeResourceRevisionId || !session.target)
          throw new SessionError(503, 'RESOURCE_UNAVAILABLE', '工作区固定资源尚未就绪');
        const rows = await findOrderedRows(contentModel(mysql, files), 'pathHash', {
          where: { sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
          order: [['pathHash', 'ASC']],
        });
        const snapshot: ArchiveFile[] = rows
          .filter((row) => row.kind !== 'internal')
          .map((row) => {
            if (
              !row.path ||
              row.size === null ||
              !row.sha256 ||
              !['source', 'asset', 'attachment'].includes(row.kind ?? '')
            )
              throw new SessionError(503, 'FILE_CORRUPT', '产物文件元数据无效');
            try {
              assertArtifactPath(row.path);
            } catch {
              throw new SessionError(503, 'FILE_CORRUPT', '产物文件路径无效');
            }
            if (createHash('sha256').update(row.path).digest('hex') !== row.pathHash)
              throw new SessionError(503, 'FILE_CORRUPT', '产物文件路径摘要无效');
            return {
              path: row.path,
              kind: row.kind as ArchiveFile['kind'],
              ...copyTextStorage(mysql, row),
              objectLocator: row.objectLocator,
              mimeType: row.mimeType,
              size: row.size,
              sha256: row.sha256,
            };
          });
        if (
          !snapshot.some(
            (file) => file.kind === 'source' && /\.(?:[jt]sx?|html|vue|svelte)$/i.test(file.path),
          )
        )
          throw new SessionError(422, 'NO_SOURCE_FILES', '当前没有可暂存的源码文件');
        const limits = options.readLimits();
        if (
          snapshot.length > limits.filesPerSession ||
          snapshot.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024
        )
          throw new SessionError(422, 'VERSION_TOO_LARGE', '产物超出版本包限额');
        const config = createConfigSnapshot(
          parseWorkspaceConfigs(workspace.configJson),
          session.target,
          workspace.configRevision,
          workspace.activeResourceRevisionId,
        );
        /** 会话锁内分配名称，版本序号区分同一文件修订的多次暂存；重试沿用原记录。 */
        const existing = await versions.findAll({
          where: { sessionId },
          attributes: ['name'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const names = new Set(existing.map((version) => version.name));
        if (requestedName && names.has(requestedName))
          throw new SessionError(
            409,
            'VERSION_NAME_EXISTS',
            '当前会话已存在同名版本，请使用其他名称',
          );
        let name = requestedName;
        if (!name) {
          let sequence = existing.length + 1;
          do {
            const suffix = ` · r${session.fileRevision} · v${sequence++}`;
            name = `${(session.name?.trim() || '未命名会话').slice(0, 200 - suffix.length)}${suffix}`;
          } while (names.has(name));
        }
        const versionId = randomUUID();
        const version = await versions.create(
          {
            versionId,
            sessionId,
            workspaceId: workspace.workspaceId,
            clientRequestId: input.clientRequestId,
            name,
            target: session.target,
            createdUserId: userId,
            creatorName: null,
            sourceFileRevision: session.fileRevision,
            resourceRevisionId: workspace.activeResourceRevisionId,
            configRevision: workspace.configRevision,
            configSnapshot: config as unknown as Record<string, unknown>,
            validationSummary: session.validationState,
            manifestHash: manifest(snapshot),
            status: 'saving',
            archiveObject: null,
            error: claim(),
          },
          { transaction },
        );
        for (const file of snapshot)
          await versionFiles.create(
            { ...file, versionId, pathHash: createHash('sha256').update(file.path).digest('hex') },
            { transaction },
          );
        return version;
      });
      if (value.status === 'ready' || (background && value.error?.attemptId !== attemptId))
        return summary(value);
      /** 耗时工作只读取已提交的冻结快照，HTTP连接不参与其生命周期。 */
      async function pack() {
        let lost = false;
        let renewing: Promise<void> | undefined;
        /** 元数据短租约避免多实例同时打同一版本；心跳失败后禁止提交上传结果。 */
        async function renew() {
          await mysql.transaction(async (transaction) => {
            const row = await ownedVersion(userId, sessionId, value.versionId!, transaction);
            if (row.status !== 'saving' || row.error?.attemptId !== attemptId)
              throw new Error('VERSION_CLAIM_LOST');
            await row.update({ error: claim() }, { transaction });
          });
        }
        const timer = setInterval(() => {
          if (renewing || lost) return;
          renewing = renew()
            .catch(() => {
              lost = true;
            })
            .finally(() => {
              renewing = undefined;
            });
        }, 30000);
        timer.unref();
        try {
          const snapshot = await frozen(value.versionId!);
          if (manifest(snapshot) !== value.manifestHash)
            throw new Error('VERSION_MANIFEST_CHANGED');
          const client = options.binary();
          const content = await buildVersionArchive(
            snapshot,
            (locator) => client.downloadFile(locator),
            options.readLimits(),
            (file) => resolveTextContent(mysql, file),
          );
          if (lost) throw new Error('VERSION_CLAIM_LOST');
          await renew();
          const object = await client.uploadFile({
            content,
            fileName: `version-${value.versionId}-${randomUUID()}.zip`,
            contentType: 'application/zip',
          });
          if (
            object.sha256 !== createHash('sha256').update(content).digest('hex') ||
            object.size !== content.length
          )
            throw new Error('VERSION_ARCHIVE_MISMATCH');
          const current = await mysql.transaction(async (transaction) => {
            const row = await ownedVersion(userId, sessionId, value.versionId!, transaction);
            if (row.status === 'ready') return row;
            if (lost || row.error?.attemptId !== attemptId) throw new Error('VERSION_CLAIM_LOST');
            await row.update(
              { status: 'ready', archiveObject: object, error: null },
              { transaction },
            );
            await changed(sessionId, row, transaction);
            return row;
          });
          return summary(current);
        } catch {
          const settled = await mysql.transaction(async (transaction) => {
            const row = await ownedVersion(userId, sessionId, value.versionId!, transaction);
            if (row.status === 'ready') return row;
            if (row.error?.attemptId === attemptId) {
              await row.update(
                { status: 'failed', error: { message: '版本打包失败，可使用相同请求重试' } },
                { transaction },
              );
              await changed(sessionId, row, transaction);
            }
            return null;
          });
          if (settled) return summary(settled);
          throw new SessionError(
            503,
            'VERSION_SAVE_FAILED',
            '版本快照已保留，打包或上传失败，请重试',
          );
        } finally {
          clearInterval(timer);
          await renewing;
        }
      }
      if (!background) return pack();
      const result = summary(value);
      const job = new Promise<ReturnType<typeof summary>>((resolve, reject) => {
        setImmediate(() => {
          void pack().then(resolve, reject);
        });
      }).then(
        () => undefined,
        () => {
          try {
            options.onBackgroundError?.();
          } catch {
            /** 后台失败已保存，日志不覆盖结果。 */
          }
        },
      );
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
      return result;
    },

    /** 按已授权会话列全部成员版本；失败和准备中的快照也保留供重试。 */
    async list(userId: string, sessionId: string, page = 1, pageSize = 10) {
      const { workspace } = await ownedSession(mysql, userId, sessionId);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 50
      )
        throw new SessionError(422, 'INVALID_PAGE', '分页参数无效');
      const where = { sessionId, workspaceId: workspace.workspaceId };
      const rows = await findOrderedRows(versions, 'versionId', {
        where,
        order: [
          ['createdAt', 'DESC'],
          ['versionId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return {
        rows: rows.map((row) => summary(row)),
        total: await versions.count({ where }),
        page,
        pageSize,
      };
    },

    /** 下载只读取已上传的固定ZIP，校验完成后以附件返回，不重新打包当前会话。 */
    async archive(userId: string, sessionId: string, versionId: string) {
      const row = await ownedVersion(userId, sessionId, versionId);
      if (row.status !== 'ready' || !row.archiveObject)
        throw new SessionError(409, 'VERSION_NOT_READY', '版本包尚未就绪，请稍后刷新或重试');
      try {
        const content = await options.binary().downloadFile(row.archiveObject);
        if (
          content.length !== row.archiveObject.size ||
          createHash('sha256').update(content).digest('hex') !== row.archiveObject.sha256
        )
          throw new Error('VERSION_ARCHIVE_CORRUPT');
        return { content, fileName: `pixelprint-${row.versionId}.zip` };
      } catch {
        throw new SessionError(503, 'VERSION_DOWNLOAD_FAILED', '版本包读取失败，请稍后重试');
      }
    },
  };
  return service;
}
export type VersionService = ReturnType<typeof createVersionService>;
