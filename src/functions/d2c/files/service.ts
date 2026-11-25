import type { ImageVariants } from '../images/variants';
import { findOrderedRows } from '../utils/orderedRead';
import { assetUrl } from '../utils/assetUrls';
import { createHash, randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cFile } from '@/models/D2cFile';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cSession } from '@/models/D2cSession';
import { isExecutionDocument, assertArtifactPath, normalizeRelativePath } from '../utils/paths';
import { ownedSession, requireIdentifier, requireRevision, SessionError } from '../session/access';
import { appendFileEvent } from '../session/service';
import { contentModel, prepareTextContent, resolveTextContent } from '../content/runtime';

type FileMetadata = ReturnType<typeof summary>;
type WebpMetadata = FileMetadata & { sourceFileId: string };

type FileLimits = { textFileBytes: number; filesPerSession: number };

/** 文本/路径按 UTF-8 计算摘要，实际内容与数据库元数据一起提交。 */
function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 仅允许用户产物路径，模板、配置、缓存和隐藏文件保持受保护。 */
function sourcePath(value: string) {
  try {
    if (typeof value !== 'string' || value.endsWith('/') || Buffer.byteLength(value) > 1024)
      throw new Error();
    return assertArtifactPath(value);
  } catch {
    throw new SessionError(422, 'INVALID_PATH', '文件路径无效或属于内部资源');
  }
}

/** 已保存产物的 HTTP 链接供浏览器直接访问，内部文件不提供访问链接。 */
function fileUrl(file: D2cFile) {
  if (!['asset', 'attachment'].includes(file.kind!) || !file.objectLocator) return null;
  return assetUrl(file.objectLocator);
}

/** 文件摘要返回产物直链，其余内部存储参数保持在服务端。 */
function summary(file: D2cFile) {
  return {
    fileId: file.fileId,
    path: file.path,
    kind: file.kind,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    revision: file.revision,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    url: fileUrl(file),
  };
}

/**
 * 创建会话稳定文本服务；MySQL 是正文、摘要、文件修订和事件的长期事实源。
 * 手工写入统一锁定工作区及会话；副本应用可协调暂停，拒绝与 Agent 执行并行写入。
 * @param readLimits 每次写入时读取 RuntimeConfig 的文本字节和会话文件数量限额。
 * @param notify 事务提交后发布 sessionId/seq 提示，失败不回滚已保存文件。
 * @param imageVariants 只读派生索引；虚拟图片单列返回，不计入稳定文件或修订。
 */
export function createFileService(
  mysql: Sequelize,
  readLimits: () => FileLimits | undefined,
  notify?: (sessionId: string, seq: number) => void,
  imageVariants?: () => Pick<ImageVariants, 'existing'> | undefined,
) {
  const files = contentModel(mysql, mysql.models.D2cFile as typeof D2cFile);
  const runs = mysql.models.D2cRun as typeof D2cRun;
  if (
    !files ||
    !runs ||
    !mysql.models.D2cTimeline ||
    !mysql.models.D2cSession ||
    !mysql.models.D2cWorkspace
  ) {
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '文件模型尚未注册');
  }

  /** 每次写入读取平台限额，缺失配置时明确失败，不使用隐式无限配额。 */
  function limits() {
    let value: FileLimits | undefined;
    try {
      value = readLimits();
    } catch {
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额读取失败');
    }
    if (
      !value ||
      !Number.isSafeInteger(value.textFileBytes) ||
      value.textFileBytes < 1 ||
      !Number.isSafeInteger(value.filesPerSession) ||
      value.filesPerSession < 1
    ) {
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', 'RuntimeConfig 文件限额尚未配置');
    }
    return value;
  }

  /** 校验文本字节和 UTF-8 可逆性，拒绝 NUL 与静默替换的孤立代理字符。 */
  function text(value: string, maximum: number) {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      Buffer.from(value).toString('utf8') !== value ||
      Buffer.byteLength(value) > maximum
    ) {
      throw new SessionError(422, 'INVALID_CONTENT', '文本格式无效或超过字节限额');
    }
    return { content: value, size: Buffer.byteLength(value), sha256: hash(value) };
  }

  /** 临时副本应用允许无租约的暂停、排队或等待回答轮次；执行中的写入仍须先停止。 */
  async function editable(session: D2cSession, transaction: Transaction, applying = false) {
    const active = await runs.findOne({
      where: {
        sessionId: session.sessionId,
        status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (session.activeRunId || active) {
      if (
        !applying ||
        !active ||
        active.runId !== session.activeRunId ||
        !['interrupted', 'waiting_input', 'queued'].includes(active.status) ||
        active.leaseOwner != null ||
        active.leaseExpiresAt != null
      ) {
        throw new SessionError(
          409,
          'SESSION_BUSY',
          applying
            ? 'Agent 正在写入文件，请等待暂停完成后再应用'
            : '请先完成或明确结束当前轮次再编辑文件',
        );
      }
    }
    requireRevision(session.fileRevision);
    return active;
  }

  /** fileId 必须属于当前会话，完整路径及其 hash 同时核对，不能跨会话借用。 */
  async function fileFor(sessionId: string, fileId: string, transaction?: Transaction) {
    requireIdentifier(fileId);
    const file = await files.findOne({
      where: { sessionId, fileId },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!file || file.sessionId !== sessionId || file.fileId !== fileId)
      throw new SessionError(404, 'FILE_NOT_FOUND', '文件不存在');
    if (typeof file.path !== 'string' || file.pathHash !== hash(file.path))
      throw new SessionError(503, 'FILE_CORRUPT', '文件路径元数据无效');
    return file;
  }

  /** 只允许编辑完整文本源码，不修改附件、二进制或内部资料。 */
  async function editableFile(file: D2cFile, base: number) {
    requireRevision(base, false);
    if (file.kind !== 'source' || file.objectLocator !== null)
      throw new SessionError(409, 'FILE_NOT_EDITABLE', '该文件不能作为文本编辑');
    sourcePath(file.path!);
    if (file.revision !== base)
      throw new SessionError(409, 'FILE_CONFLICT', '文件已更新，请重新读取');
    const content = await resolveTextContent(mysql, file, `session:${file.sessionId}`);
    if (content === null)
      throw new SessionError(409, 'FILE_NOT_EDITABLE', '该文件不能作为文本编辑');
    return content;
  }

  /** 文件修订、会话修订、校验失效与时间线在同一事务提交，失败全部回滚。 */
  async function changed(
    session: D2cSession,
    transaction: Transaction,
    file: D2cFile,
    action: 'created' | 'updated' | 'deleted',
  ) {
    const fileRevision = session.fileRevision + 1;
    await session.update(
      { fileRevision, validationState: { status: 'stale', fileRevision } },
      { transaction },
    );
    const seq = await appendFileEvent(mysql, session, transaction, {
      action,
      fileId: file.fileId!,
      path: file.path!,
      revision: file.revision,
      fileRevision,
    });
    if (notify)
      transaction.afterCommit(() => {
        try {
          notify(session.sessionId!, seq);
        } catch {
          /** 通知失败不改变已提交的文件结果。 */
        }
      });
    return fileRevision;
  }

  return {
    /** 文件树返回产物直链，不携带正文或完整对象定位。 */
    async list(
      userId: string,
      sessionId: string,
    ): Promise<{
      fileRevision: number;
      files: FileMetadata[];
      webpFiles?: WebpMetadata[];
    }> {
      const { session } = await ownedSession(mysql, userId, sessionId);
      const rows = await findOrderedRows(files, 'pathHash', {
        where: { sessionId },
        order: [['pathHash', 'ASC']],
        attributes: [
          'fileId',
          'path',
          'kind',
          'mimeType',
          'size',
          'sha256',
          'revision',
          'createdAt',
          'updatedAt',
          'objectLocator',
        ],
      });
      const metadata = rows.map(summary);
      const result = { fileRevision: session.fileRevision, files: metadata };
      if (!imageVariants) return result;
      const webpFiles: WebpMetadata[] = [];
      try {
        // 索引绑定真实上传回执；展示地址可能已按本地访问前缀投影。
        const candidates = rows.flatMap((row, index) => {
          const file = metadata[index];
          const url = row.objectLocator?.url;
          return file.url && file.mimeType?.startsWith('image/') && typeof url === 'string'
            ? [{ file, url }]
            : [];
        });
        const ready = await imageVariants()?.existing(
          candidates.map(({ file, url }) => ({ url, sha256: file.sha256! })),
        );
        for (const [index, { file }] of candidates.entries()) {
          const image = ready?.[index];
          if (!image) continue;
          webpFiles.push({
            ...file,
            sourceFileId: file.fileId!,
            fileId: `webp:${file.fileId}`,
            path: `${file.path}_.webp`,
            kind: 'asset',
            mimeType: 'image/webp',
            url: image.url,
            size: image.size,
            sha256: image.sha256,
          });
        }
      } catch {
        // 派生服务不可用时，原文件清单仍正常返回。
      }
      return { ...result, webpFiles };
    },
    /** 本人会话文本、执行清单与受控缓存 JSON 可只读查看；其他内部资料和二进制仍拒绝。 */
    async get(userId: string, sessionId: string, fileId: string) {
      await ownedSession(mysql, userId, sessionId);
      const file = await fileFor(sessionId, fileId);
      let cacheJson = false;
      try {
        cacheJson =
          normalizeRelativePath(file.path!) === file.path &&
          (file.path === '.d2c-cache/image-directories.json' ||
            /^\.d2c-cache\/[^/]+\/.+\.json$/.test(file.path!));
      } catch {
        /** 不符合受控缓存路径的内部资料继续拒绝读取。 */
      }
      if (file.kind === 'internal' && !cacheJson && !isExecutionDocument(file.path!))
        throw new SessionError(403, 'INTERNAL_FILE', '内部执行资料不通过源码接口返回');
      if (file.objectLocator !== null)
        throw new SessionError(409, 'BINARY_DOWNLOAD_UNAVAILABLE', '二进制文件请使用受控下载入口');
      const content = await resolveTextContent(mysql, file, `session:${sessionId}`);
      if (content === null)
        throw new SessionError(409, 'BINARY_DOWNLOAD_UNAVAILABLE', '二进制文件请使用受控下载入口');
      if (file.size !== Buffer.byteLength(content) || file.sha256 !== hash(content))
        throw new SessionError(503, 'FILE_CORRUPT', '文件内容摘要不一致');
      return { ...summary(file), content };
    },
    /**
     * 在空闲会话创建文本源码，先校验路径和 UTF-8 字节，再在事务内检查文件树修订。
     * 同时检查路径重复、路径摘要冲突及数量限额；正文、修订和事件同事务保存。
     * @param input baseFileRevision 是页面读取的会话文件树修订，过期返回冲突。
     * @returns 文件正文、文件元数据及提交后的会话 fileRevision。
     */
    async create(
      userId: string,
      sessionId: string,
      input: { path: string; content: string; baseFileRevision: number },
    ) {
      const settings = limits(),
        path = sourcePath(input.path),
        data = text(input.content, settings.textFileBytes);
      requireRevision(input.baseFileRevision);
      await ownedSession(mysql, userId, sessionId);
      const storage = await prepareTextContent(mysql, `session:${sessionId}`, data.content);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        await editable(session, transaction);
        if (session.fileRevision !== input.baseFileRevision)
          throw new SessionError(409, 'FILES_CONFLICT', '会话文件已更新，请重新读取');
        const prior = await files.findOne({
          where: { sessionId, pathHash: hash(path) },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior)
          throw new SessionError(
            409,
            prior.path === path ? 'PATH_EXISTS' : 'PATH_HASH_CONFLICT',
            '文件路径已存在或标识冲突',
          );
        const current = await files.findAll({
          where: { sessionId },
          attributes: ['fileId'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (current.length >= settings.filesPerSession)
          throw new SessionError(422, 'FILE_LIMIT', '会话文件数量已达到限额');
        const file = await files.create(
          {
            fileId: randomUUID(),
            sessionId,
            path,
            pathHash: hash(path),
            kind: 'source',
            ...data,
            ...storage,
            objectLocator: null,
            mimeType: 'text/plain',
            revision: 1,
          },
          { transaction },
        );
        const fileRevision = await changed(session, transaction, file, 'created');
        return { ...summary(file), content: data.content, fileRevision };
      });
    },
    /**
     * 以文件级修订比较更新正文，只有本人空闲会话中的可编辑文本允许写入。
     * 正文、摘要、文件修订、会话修订及校验失效标记同事务提交；冲突不覆盖内容。
     * @param baseRevision 页面上次读取的文件修订。
     */
    async update(
      userId: string,
      sessionId: string,
      fileId: string,
      baseRevision: number,
      content: string,
    ) {
      const data = text(content, limits().textFileBytes);
      await ownedSession(mysql, userId, sessionId);
      await editableFile(await fileFor(sessionId, fileId), baseRevision);
      const storage = await prepareTextContent(mysql, `session:${sessionId}`, content);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        await editable(session, transaction);
        const file = await fileFor(sessionId, fileId, transaction);
        await editableFile(file, baseRevision);
        await file.update({ ...data, ...storage, revision: baseRevision + 1 }, { transaction });
        const fileRevision = await changed(session, transaction, file, 'updated');
        return { ...summary(file), content, fileRevision };
      });
    },
    /**
     * 临时编辑显式 apply：先锁工作区/会话并核对整体修订，预检全部已有源码后一次提交。
     * 不新增/删除文件；正文、摘要、修订、校验失效及事件任一失败全部回滚。
     * beforeCommit 由临时副本服务核验 Redis apply owner，失败同样回滚 MySQL。
     */
    async apply(
      userId: string,
      sessionId: string,
      input: {
        baseFileRevision: number;
        files: Array<{ path: string; content: string }>;
        originals?: Array<{ path: string; content: string }>;
      },
      beforeCommit?: () => Promise<void>,
    ) {
      requireRevision(input.baseFileRevision);
      const settings = limits();
      if (!Array.isArray(input.files) || input.files.length > settings.filesPerSession)
        throw new SessionError(422, 'FILE_LIMIT', '写回文件数量超出限额');
      const seen = new Set<string>();
      const updates = input.files.map((file) => {
        const path = sourcePath(file.path);
        if (path !== file.path || seen.has(path))
          throw new SessionError(422, 'INVALID_PATH', '文件路径重复或无效');
        seen.add(path);
        return { path, data: text(file.content, settings.textFileBytes) };
      });
      await ownedSession(mysql, userId, sessionId);
      const prepared = new Map<string, Awaited<ReturnType<typeof prepareTextContent>>>();
      for (const update of updates) {
        prepared.set(
          update.path,
          await prepareTextContent(mysql, `session:${sessionId}`, update.data.content),
        );
      }
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const active = await editable(session, transaction, true);
        if (session.fileRevision !== input.baseFileRevision && !input.originals)
          throw new SessionError(409, 'FILES_CONFLICT', '会话文件已更新，请重新进入编辑');
        const pending: Array<{ file: D2cFile; data: ReturnType<typeof text> }> = [];
        for (const update of updates.sort((a, b) => a.path.localeCompare(b.path))) {
          const file = await files.findOne({
            where: { sessionId, pathHash: hash(update.path) },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!file || file.path !== update.path)
            throw new SessionError(409, 'FILES_CONFLICT', '源码文件已变更，请重新进入编辑');
          const content = await editableFile(file, file.revision);
          if (
            input.originals &&
            content !== update.data.content &&
            input.originals.find((original) => original.path === update.path)?.content !== content
          ) {
            throw new SessionError(
              409,
              'FILES_CONFLICT',
              `文件 ${update.path} 已被 Agent 更新，编辑副本已保留，请核对后重新编辑`,
            );
          }
          if (file.sha256 !== hash(content) || file.size !== Buffer.byteLength(content))
            throw new SessionError(503, 'FILE_CORRUPT', '文件内容摘要不一致');
          if (content !== update.data.content) pending.push({ file, data: update.data });
        }
        const fileRevision = session.fileRevision + (pending.length ? 1 : 0);
        requireRevision(fileRevision);
        if (pending.length) {
          await session.update(
            { fileRevision, validationState: { status: 'stale', fileRevision } },
            { transaction },
          );
          for (const { file, data } of pending) {
            requireRevision(file.revision + 1, false);
            await file.update(
              { ...data, ...prepared.get(file.path!), revision: file.revision + 1 },
              { transaction },
            );
            const seq = await appendFileEvent(mysql, session, transaction, {
              action: 'updated',
              fileId: file.fileId!,
              path: file.path!,
              revision: file.revision,
              fileRevision,
            });
            if (notify)
              transaction.afterCommit(() => {
                try {
                  notify(sessionId, seq);
                } catch {
                  /** 已提交的文件不受通知失败影响。 */
                }
              });
          }
        }
        if (active && pending.length) {
          await active.update(
            {
              baseFileRevision: fileRevision,
              checkpoint: { ...active.checkpoint, sourceChangedByUser: true },
            },
            { transaction },
          );
        }
        await beforeCommit?.();
        return { fileRevision };
      });
    },
    /** 删除同样要求文件修订与会话空闲，事件只记录路径和摘要修订，不包含正文。 */
    async remove(userId: string, sessionId: string, fileId: string, baseRevision: number) {
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        await editable(session, transaction);
        const file = await fileFor(sessionId, fileId, transaction);
        await editableFile(file, baseRevision);
        await file.destroy({ transaction });
        return { fileId, fileRevision: await changed(session, transaction, file, 'deleted') };
      });
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;
