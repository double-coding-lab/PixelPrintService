import { createHash, randomUUID } from 'node:crypto';
import type { Sequelize, Transaction } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cMessageAttachment } from '@/models/D2cMessageAttachment';
import type { createPreviewInspection } from '../preview/inspection';
import {
  attachmentMaxBytes,
  attachmentSummary,
  createAttachmentService,
  inspectAttachmentImage,
  type AttachmentBinary,
} from '../session/attachments';
import { appendSessionEvent } from '../session/service';
import { imageObjectName } from '../utils/imageObjectName';
import { createRunLeases, type RunLease } from './leases';

type Screenshot = Parameters<
  NonNullable<Parameters<typeof createPreviewInspection>[0]['saveCapture']>
>[0];

/** 保存实际运行截图及聊天消息；上传不持有数据库锁，附件和时间线在同一租约事务提交。 */
export function createRunScreenshotWriter(input: {
  mysql: Sequelize;
  leases: ReturnType<typeof createRunLeases>;
  lease: RunLease;
  binary: AttachmentBinary;
  userId: string;
  uploadBytes: number;
  assertLease: () => Promise<void>;
  notify: (sessionId: string, seq: number) => void;
}) {
  const attachments = input.mysql.models.D2cMessageAttachment as typeof D2cMessageAttachment;
  const reader = createAttachmentService(input.mysql, {
    binary: input.binary,
    readUploadBytes: () => input.uploadBytes,
  });
  /** 附件和消息原子写入，重试不会重新上传图片。 */
  function commit<T>(write: (session: D2cSession, transaction: Transaction) => Promise<T>) {
    return input.leases.commit(input.lease, write, { retryDeadlocks: true });
  }
  const objectNames = new Map<string, string>();
  /** 同轮同预览采用稳定身份，重试时复用已发布图片，不把重新截图的像素冒充旧图。 */
  return async (value: Screenshot) => {
    await input.assertLease();
    const { capture } = value;
    if (!attachments) throw new Error('截图附件模型尚未注册');
    if (capture.image.length > Math.min(attachmentMaxBytes, input.uploadBytes))
      throw new Error('运行截图超过附件大小限制');
    const shape = inspectAttachmentImage(capture.image);
    if (
      shape.mimeType !== capture.mimeType ||
      shape.width !== capture.width ||
      shape.height !== capture.height
    )
      throw new Error('运行截图元数据不一致');
    const attachmentId = createHash('sha256')
      .update(
        `${input.lease.runId}:${value.previewId}:${capture.width}${value.inspectionKey ? `:${value.inspectionKey}` : ''}`,
      )
      .digest('hex');
    const where = { attachmentId, sessionId: input.lease.sessionId, userId: input.userId };
    const existing = await commit(async (_session, transaction) =>
      attachments.findOne({ where, transaction }),
    );
    if (existing)
      return {
        imageRef: `attachment://${attachmentId}`,
        image: await reader.read(input.userId, input.lease.sessionId, attachmentId),
      };
    const fileName = `preview-r${value.fileRevision}.png`;
    /** 数据库提交失败后重试仍用原对象名，由存储客户端核对内容且禁止覆写。 */
    if (!objectNames.has(attachmentId)) objectNames.set(attachmentId, imageObjectName(fileName));
    const locator = await input.binary.uploadFile({
      content: capture.image,
      fileName: objectNames.get(attachmentId)!,
      contentType: capture.mimeType,
      webpRequired: true,
    });
    await input.assertLease();
    await commit(async (session, transaction) => {
      if (await attachments.findOne({ where, transaction })) return;
      const messageId = randomUUID();
      const row = await attachments.create(
        {
          ...where,
          messageId,
          fileName,
          ...shape,
          size: capture.image.length,
          sha256: createHash('sha256').update(capture.image).digest('hex'),
          objectLocator: locator,
          expiresAt: null,
        },
        { transaction },
      );
      await appendSessionEvent(input.mysql, session, transaction, {
        runId: input.lease.runId,
        kind: 'message',
        messageId,
        displayPayload: {
          role: 'assistant',
          text: `运行截图 · 文件修订 r${value.fileRevision}\n\n入口：${value.entryPath}${capture.coverage?.mode === 'focused' ? '\n\n本图仅展示目标区域，不能代表整页检查。' : capture.truncated ? `\n\n${capture.coverage?.reason === 'nested_scroll' ? '页面含内部滚动区域，本图未覆盖其全部内容。' : capture.coverage?.reason === 'byte_limit' ? '截图达到图片大小限制，仅展示页面部分内容。' : capture.coverage?.reason === 'height_limit' ? '截图达到 12000 像素高度限制，仅展示页面部分内容。' : '本图仅展示页面部分内容，未覆盖区域尚未检查。'}` : ''}`,
          attachments: [attachmentSummary(row)],
        },
      });
      const seq = session.timelineSeq;
      transaction.afterCommit(() => {
        try {
          input.notify(input.lease.sessionId, seq);
        } catch {
          /** 时间线补读兜底。 */
        }
      });
    });
    return {
      imageRef: `attachment://${attachmentId}`,
      image: await reader.read(input.userId, input.lease.sessionId, attachmentId),
    };
  };
}
