import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { DatabaseError, type Sequelize, type Transaction } from 'sequelize';
import type { D2cMessageAttachment } from '../../../models/D2cMessageAttachment';
import { StorageError, type StorageFileClient } from '../../../hooks/tools/storage';
import { ownedSession, requireIdentifier, SessionError } from './access';
import { imageObjectName } from '../utils/imageObjectName';
import { createRunImageCache, type RunImageCache } from '../run/agent/imageCache';

export const attachmentMaxBytes = 10 * 1024 * 1024;
export const attachmentBodyLimit = 4 * Math.ceil(attachmentMaxBytes / 3) + 4096;
export type AttachmentBinary = Pick<StorageFileClient, 'uploadFile' | 'downloadFile'>;
export type AttachmentUpload = { fileName: string; mimeType: string; base64: string };

/** 只识别驱动固定错误码，不读取 SQL、参数或数据库错误正文。 */
function databaseCode(error: unknown) {
  if (!(error instanceof DatabaseError)) return undefined;
  const code = (error.original as NodeJS.ErrnoException).code;
  return code &&
    ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK'].includes(
      code,
    )
    ? code
    : undefined;
}

/** 缺表和旧结构明确提示迁移，其余数据库失败保持固定错误，不回显原始 SQL。 */
async function attachmentDatabase<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof SessionError) throw error;
    const code = databaseCode(error);
    if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR')
      throw new SessionError(
        503,
        'ATTACHMENT_SCHEMA_NOT_READY',
        '附件表尚未就绪，请先执行 d2c-live-preview_附件迁移.sql',
        error,
      );
    throw new SessionError(503, 'ATTACHMENT_DATABASE_UNAVAILABLE', '附件数据暂不可用', error);
  }
}

/** 私有接口日志仅携带固定阶段、错误码和状态，不保存图片、SQL、令牌或上游正文。 */
export function attachmentFailureDetails(error: unknown) {
  const reason = error instanceof SessionError ? error.reason : 'ATTACHMENT_UNAVAILABLE';
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++, current = current.cause) {
    if (current instanceof StorageError)
      return {
        reason,
        stage: 'storage',
        storageStage: current.stage,
        statusCode: current.statusCode,
        storageCode: current.code,
        networkCode: current.networkCode,
      };
    if (current instanceof DatabaseError)
      return { reason, stage: 'database', databaseCode: databaseCode(current) };
  }
  return {
    reason,
    stage: error instanceof SessionError && error.statusCode < 500 ? 'request' : 'unknown',
  };
}

/** 校验只返回固定错误，不能暴露上传字节、对象定位或数据库诊断。 */
function invalid(): never {
  throw new SessionError(422, 'INVALID_ATTACHMENT', '附件须为有效 PNG/JPEG/WebP 图片且尺寸受限');
}

/** 限制解码后的像素数量，避免小压缩包宣称异常大图。 */
function dimensions(width: number, height: number, mimeType: string) {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
    invalid();
  return { width, height, mimeType };
}

/** PNG 检查块边界、CRC、结束标记和有界解压；JPEG/WebP 检查容器及实际图像帧尺寸。 */
export function inspectAttachmentImage(data: Buffer): {
  width: number;
  height: number;
  mimeType: string;
} {
  try {
    if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      let offset = 8;
      let shape: ReturnType<typeof dimensions> | undefined;
      const compressed: Buffer[] = [];
      let bitsPerPixel = 0,
        interlace = 0;
      let ended = false;
      while (offset + 12 <= data.length) {
        const size = data.readUInt32BE(offset);
        if (offset + 12 + size > data.length) invalid();
        const kind = data.toString('ascii', offset + 4, offset + 8);
        let crc = 0xffffffff;
        for (const byte of data.subarray(offset + 4, offset + 8 + size)) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        if ((crc ^ 0xffffffff) >>> 0 !== data.readUInt32BE(offset + 8 + size)) invalid();
        if (!shape) {
          if (kind !== 'IHDR' || size !== 13) invalid();
          shape = dimensions(
            data.readUInt32BE(offset + 8),
            data.readUInt32BE(offset + 12),
            'image/png',
          );
          const depth = data[offset + 16],
            color = data[offset + 17];
          if (
            !(
              {
                0: [1, 2, 4, 8, 16],
                2: [8, 16],
                3: [1, 2, 4, 8],
                4: [8, 16],
                6: [8, 16],
              } as Record<number, number[]>
            )[color]?.includes(depth) ||
            data[offset + 18] ||
            data[offset + 19] ||
            data[offset + 20] > 1
          )
            invalid();
          bitsPerPixel =
            depth * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
          interlace = data[offset + 20];
        } else if (kind === 'IHDR') invalid();
        if (kind === 'IDAT') compressed.push(data.subarray(offset + 8, offset + 8 + size));
        offset += size + 12;
        if (kind === 'IEND') {
          if (size || offset !== data.length) invalid();
          ended = true;
          break;
        }
      }
      if (!shape || !ended || !compressed.length) invalid();
      const raw = inflateSync(Buffer.concat(compressed), {
        maxOutputLength: shape.width * shape.height * 8 + shape.height * 8 + 1024,
      });
      let pixelOffset = 0;
      const passes = interlace
        ? [
            [0, 0, 8, 8],
            [4, 0, 8, 8],
            [0, 4, 4, 8],
            [2, 0, 4, 4],
            [0, 2, 2, 4],
            [1, 0, 2, 2],
            [0, 1, 1, 2],
          ]
        : [[0, 0, 1, 1]];
      for (const [x, y, dx, dy] of passes) {
        const width = Math.max(0, Math.ceil((shape.width - x) / dx));
        const height = Math.max(0, Math.ceil((shape.height - y) / dy));
        if (!width || !height) continue;
        const stride = 1 + Math.ceil((width * bitsPerPixel) / 8);
        for (let row = 0; row < height; row++) {
          if (pixelOffset >= raw.length || raw[pixelOffset] > 4) invalid();
          pixelOffset += stride;
        }
      }
      if (pixelOffset !== raw.length) invalid();
      return shape;
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2;
      let shape: ReturnType<typeof dimensions> | undefined;
      let scanned = false,
        quantized = false;
      while (offset < data.length) {
        if (data[offset++] !== 0xff) invalid();
        while (data[offset] === 0xff) offset++;
        const marker = data[offset++];
        if (marker === 0xd9) {
          if (!shape || !scanned || offset !== data.length) invalid();
          return shape;
        }
        if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
        const size = data.readUInt16BE(offset);
        if (size < 2 || offset + size > data.length) invalid();
        if (marker === 0xdb) quantized = true;
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
          if (
            shape ||
            size < 8 ||
            data[offset + 2] !== 8 ||
            ![1, 3, 4].includes(data[offset + 7]) ||
            size !== 8 + 3 * data[offset + 7]
          )
            invalid();
          shape = dimensions(
            data.readUInt16BE(offset + 5),
            data.readUInt16BE(offset + 3),
            'image/jpeg',
          );
        }
        if (marker === 0xda) {
          if (
            !shape ||
            !quantized ||
            size < 8 ||
            ![1, 2, 3, 4].includes(data[offset + 2]) ||
            size !== 6 + 2 * data[offset + 2]
          )
            invalid();
          offset += size;
          const scanStart = offset;
          while (offset < data.length) {
            if (data[offset] !== 0xff) {
              offset++;
              continue;
            }
            const next = data[offset + 1];
            if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
              offset += 2;
              continue;
            }
            break;
          }
          if (offset === scanStart) invalid();
          scanned = true;
          continue;
        }
        offset += size;
      }
      invalid();
    }
    if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
      if (data.readUInt32LE(4) + 8 !== data.length) invalid();
      let shape: ReturnType<typeof dimensions> | undefined;
      let canvas: ReturnType<typeof dimensions> | undefined;
      for (let offset = 12; offset < data.length; ) {
        if (offset + 8 > data.length) invalid();
        const kind = data.toString('ascii', offset, offset + 4),
          size = data.readUInt32LE(offset + 4),
          start = offset + 8;
        if (start + size + (size % 2) > data.length) invalid();
        if (kind === 'VP8X') {
          if (size !== 10 || data[start] & 2) invalid(); // 首版拒绝动画。
          canvas = dimensions(
            1 + data.readUIntLE(start + 4, 3),
            1 + data.readUIntLE(start + 7, 3),
            'image/webp',
          );
        }
        if (kind === 'VP8 ') {
          if (
            size < 11 ||
            data[start] & 1 ||
            data.readUIntLE(start, 3) >>> 5 > size - 10 ||
            data.toString('hex', start + 3, start + 6) !== '9d012a'
          )
            invalid();
          shape = dimensions(
            data.readUInt16LE(start + 6) & 0x3fff,
            data.readUInt16LE(start + 8) & 0x3fff,
            'image/webp',
          );
        }
        if (kind === 'VP8L') {
          if (size < 6 || data[start] !== 0x2f || data[start + 4] & 0xe0) invalid();
          const bits = data.readUInt32LE(start + 1);
          shape = dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff), 'image/webp');
        }
        offset = start + size + (size % 2);
      }
      if (!shape || (canvas && (canvas.width !== shape.width || canvas.height !== shape.height)))
        invalid();
      return shape;
    }
  } catch (error) {
    if (error instanceof SessionError) throw error;
    invalid();
  }
  return invalid();
}

/** 查询模型时明确失败；旧纯文本链路不要求新表已注册。 */
function model(mysql: Sequelize) {
  const attachments = mysql.models.D2cMessageAttachment as typeof D2cMessageAttachment;
  if (!attachments) throw new SessionError(503, 'MODELS_UNAVAILABLE', '附件模型尚未注册');
  return attachments;
}

/** 页面地址固定走会话鉴权代理，不公开 Storage 永久地址或对象定位。 */
export function attachmentSummary(row: D2cMessageAttachment) {
  return {
    attachmentId: row.attachmentId,
    url: `/api/d2c/sessions/${encodeURIComponent(row.sessionId)}/attachments/${encodeURIComponent(row.attachmentId)}`,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    size: row.size,
  };
}

/** 校验有序附件集合；不去重、不排序，防止幂等重试改变图片身份或顺序。 */
export function validateAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4 || new Set(value).size !== value.length) invalid();
  for (const id of value) requireIdentifier(id);
  return value;
}

/** 在持有工作区/会话锁的消息事务中逐一锁图，并关联到唯一用户消息；失败整体回滚。 */
export async function linkMessageAttachments(
  mysql: Sequelize,
  userId: string,
  sessionId: string,
  messageId: string,
  ids: string[],
  transaction: Transaction,
) {
  const result = [];
  for (const attachmentId of ids) {
    const row = await model(mysql).findOne({
      where: { attachmentId, sessionId, userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (
      !row ||
      row.sessionId !== sessionId ||
      row.userId !== userId ||
      row.attachmentId !== attachmentId
    )
      throw new SessionError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
    if (
      row.messageId ||
      !row.objectLocator ||
      (row.expiresAt && row.expiresAt.getTime() <= Date.now())
    )
      throw new SessionError(409, 'ATTACHMENT_UNAVAILABLE', '附件已关联或已过期，请重新上传');
    await row.update({ messageId, expiresAt: null }, { transaction });
    result.push(attachmentSummary(row));
  }
  return result;
}

/** 上传使用既有 Storage 二进制通道；事务外上传，事务内重新鉴权并保存定位，不接触真实模型。 */
export function createAttachmentService(
  mysql: Sequelize,
  options: { binary: AttachmentBinary; readUploadBytes: () => number },
) {
  return {
    /** 两次校验会话归属，避免未授权上传；外部存储失败返回稳定 SessionError。 */
    async upload(userId: string, sessionId: string, input: AttachmentUpload) {
      await ownedSession(mysql, userId, sessionId, undefined, 'read');
      /** 在上传之前确认附件表可读，缺表时不产生无法登记的远端图片。 */
      await attachmentDatabase(() =>
        model(mysql).findOne({ where: { sessionId, userId }, attributes: ['attachmentId'] }),
      );
      const configured = options.readUploadBytes();
      if (!Number.isSafeInteger(configured) || configured < 1)
        throw new SessionError(503, 'ATTACHMENT_UNAVAILABLE', '附件上传配置不可用');
      const limit = Math.min(attachmentMaxBytes, configured);
      if (typeof input.base64 !== 'string' || input.base64.length > 4 * Math.ceil(limit / 3))
        throw new SessionError(413, 'ATTACHMENT_TOO_LARGE', '附件超过上传大小限制');
      if (
        !input.base64.length ||
        input.base64.length % 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
      )
        invalid();
      const data = Buffer.from(input.base64, 'base64');
      if (data.length > limit)
        throw new SessionError(413, 'ATTACHMENT_TOO_LARGE', '附件超过上传大小限制');
      if (data.toString('base64') !== input.base64) invalid();
      if (
        typeof input.fileName !== 'string' ||
        !input.fileName.trim() ||
        input.fileName.length > 200 ||
        input.fileName === '.' ||
        input.fileName === '..' ||
        /[\\/\u0000-\u001f\u007f%?#]/u.test(input.fileName)
      )
        invalid();
      const image = inspectAttachmentImage(data);
      if (image.mimeType !== input.mimeType) invalid();
      const attachmentId = randomUUID();
      /** 非 ASCII 原名仅替换存储 basename，业务显示名保留原文，不推断或翻译图片语义。 */
      const basename = /^[\x20-\x7e]+$/.test(input.fileName)
        ? input.fileName
        : `attachment.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.split('/')[1]}`;
      let locator;
      try {
        locator = await options.binary.uploadFile({
          content: data,
          fileName: imageObjectName(basename),
          contentType: image.mimeType,
        });
      } catch (error) {
        throw new SessionError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', '附件存储暂不可用', error);
      }
      return attachmentDatabase(() =>
        mysql.transaction(async (transaction) => {
          await ownedSession(mysql, userId, sessionId, transaction);
          const row = await model(mysql).create(
            {
              attachmentId,
              sessionId,
              userId,
              messageId: null,
              fileName: input.fileName,
              ...image,
              size: data.length,
              sha256: createHash('sha256').update(data).digest('hex'),
              objectLocator: locator,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { transaction },
          );
          return attachmentSummary(row);
        }),
      );
    },
    /** 展示和模型边界共享鉴权及完整性校验；不会跟随客户端提供的 URL 下载。 */
    async read(userId: string, sessionId: string, attachmentId: string, cache?: RunImageCache) {
      requireIdentifier(attachmentId);
      const row = await attachmentDatabase(() =>
        mysql.transaction(async (transaction) => {
          await ownedSession(mysql, userId, sessionId, transaction, 'read');
          const row = await model(mysql).findOne({
            where: { attachmentId, sessionId },
            transaction,
          });
          if (
            !row ||
            row.sessionId !== sessionId ||
            (row.userId !== userId && !row.messageId) ||
            row.attachmentId !== attachmentId ||
            (row.expiresAt && row.expiresAt.getTime() <= Date.now())
          )
            throw new SessionError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
          return row;
        }),
      );
      // 始终先核对当前权限/归属/过期及行版本；不能按引用跳过这些检查。
      const version = JSON.stringify([
        sessionId,
        attachmentId,
        row.sha256,
        row.objectLocator,
        row.size,
        row.mimeType,
        row.width,
        row.height,
      ]);
      let data = cache?.get(version);
      try {
        data ??= await options.binary.downloadFile(row.objectLocator);
      } catch (error) {
        throw new SessionError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', '附件存储暂不可用', error);
      }
      if (
        data.length !== row.size ||
        data.length > attachmentMaxBytes ||
        createHash('sha256').update(data).digest('hex') !== row.sha256
      )
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件完整性校验失败');
      const image = inspectAttachmentImage(data);
      if (
        image.mimeType !== row.mimeType ||
        image.width !== row.width ||
        image.height !== row.height
      )
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件元数据校验失败');
      cache?.set(version, data);
      return { mimeType: row.mimeType, data };
    },
  };
}

/** 每个 Run 创建独立有界缓存；附件行版本逐次重验，capture 由调用方分流。 */
export function resolveAttachmentImages(
  mysql: Sequelize,
  binary: AttachmentBinary,
  userId: string,
  sessionId: string,
) {
  const service = createAttachmentService(mysql, {
    binary,
    readUploadBytes: () => attachmentMaxBytes,
  });
  const cache = createRunImageCache();
  return async (ref: string): Promise<{ mimeType: string; data: Buffer } | null> => {
    if (!ref.startsWith('attachment://')) return null;
    const id = ref.slice('attachment://'.length);
    requireIdentifier(id);
    return service.read(userId, sessionId, id, cache);
  };
}

export type AttachmentService = ReturnType<typeof createAttachmentService>;
