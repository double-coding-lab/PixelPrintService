import { createHash, randomUUID } from 'node:crypto';
import { Op, type Sequelize, type CreationAttributes } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { D2cCredential } from '@/models/D2cCredential';
import type { D2cFile } from '@/models/D2cFile';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { D2cMessageAttachment } from '@/models/D2cMessageAttachment';
import {
  contentModel,
  prepareTextContent,
  resolveTextContent,
  type PreparedText,
} from '../content/runtime';
import {
  ownedWorkspace,
  requireIdentifier,
  requireRevision,
  SessionError,
} from '../session/access';
import { displayPayload } from '../session/service';
import { sameUser } from '../team/access';
import { assertArtifactPath } from '../utils/paths';
import { findOrderedRows } from '../utils/orderedRead';
import { publishedSession, requireSharingIdentity } from './access';

export type ForkInput = {
  workspaceId: string;
  credentialId: string;
  clientRequestId: string;
  name?: string;
};
export type ForkOptions = {
  readLimits?: () => { textFileBytes: number; filesPerSession: number };
  personalModelCredential?: (userId: string) => Promise<string>;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** 固定命名空间的 UUIDv5 同时满足重试幂等和 Agent 检查点的 UUID 契约。 */
function forkSessionId(parts: string[]) {
  const digest = createHash('sha1')
    .update(Buffer.from('503f72c1ec8544129bdab9757a19bbdf', 'hex'))
    .update(JSON.stringify(parts))
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 公开产物与广场文件树采用同一受控路径范围；固定包、缓存和内部文件不进入分支。 */
function artifact(file: D2cFile) {
  try {
    return (
      ['source', 'asset', 'attachment'].includes(file.kind!) &&
      typeof file.path === 'string' &&
      !file.path.endsWith('/') &&
      Buffer.byteLength(file.path) <= 1024 &&
      assertArtifactPath(file.path) === file.path
    );
  } catch {
    return false;
  }
}
function summary(session: D2cSession) {
  return {
    workspaceId: session.workspaceId!,
    sessionId: session.sessionId!,
    name: session.name,
    target: session.target,
    fileRevision: session.fileRevision,
    timelineSeq: session.timelineSeq,
    activeRunId: session.activeRunId,
    validationState: session.validationState,
  };
}

/** 设计地址仅从已公开正文提取，源会话的私有元数据与配置不复制。 */
function publicFigma(messages: Array<{ text: string }>) {
  for (const message of messages)
    for (const match of message.text.matchAll(/https:\/\/(?:www\.)?figma\.com\/[^\s<>"')]+/g)) {
      try {
        const url = new URL(match[0]);
        if (
          !url.username &&
          !url.password &&
          !url.port &&
          !url.hash &&
          url.href.length <= 2048 &&
          ![...url.searchParams.keys()].some((key) => /token|auth|secret|key/i.test(key))
        )
          return url.href;
      } catch {
        /* 正文中的非URL片段不是会话设计元数据。 */
      }
    }
  return null;
}

/**
 * 冻结公开聊天与产物，创建当前用户的独立空闲会话。
 * 外置文本准备在短事务前完成，提交时锁定双方工作区并复核发布和源码修订。
 * 仅复制重新投影的普通消息，不复制SDK工具历史、检查点、队列、原凭据或执行状态。
 */
export async function forkPublishedSession(
  mysql: Sequelize,
  userId: string,
  shareId: string,
  input: ForkInput,
  options: ForkOptions = {},
  creatorName?: string,
) {
  requireSharingIdentity(userId);
  requireIdentifier(input.workspaceId);
  requireIdentifier(input.credentialId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.clientRequestId,
    )
  )
    throw new SessionError(422, 'INVALID_INPUT', '创建请求标识无效');
  const sessions = mysql.models.D2cSession as typeof D2cSession;
  const workspaces = mysql.models.D2cWorkspace as typeof D2cWorkspace;
  const credentials = mysql.models.D2cCredential as typeof D2cCredential;
  const files = mysql.models.D2cFile as typeof D2cFile;
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  const attachments = mysql.models.D2cMessageAttachment as typeof D2cMessageAttachment;
  const workspace = await ownedWorkspace(mysql, userId, input.workspaceId);
  if (workspace.teamId || !sameUser(workspace.createdUserId, userId))
    throw new SessionError(403, 'PERSONAL_WORKSPACE_REQUIRED', '请选择自己的个人工作区');
  if (workspace.status !== 'ready' || !workspace.activeResourceRevisionId)
    throw new SessionError(409, 'WORKSPACE_NOT_READY', '工作区尚未就绪');
  const sessionId = forkSessionId([
    'plaza-fork',
    userId,
    shareId,
    input.workspaceId,
    input.clientRequestId,
  ]);
  const existing = await sessions.findOne({
    where: { sessionId, workspaceId: input.workspaceId, createdUserId: userId },
  });
  if (existing) return summary(existing);
  const source = await publishedSession(mysql, userId, shareId);
  const ownCredential = await credentials.findOne({
    where: {
      credentialId: input.credentialId,
      ownerUserId: userId,
      kind: 'figma',
      status: 'active',
    },
  });
  if (!ownCredential || ownCredential.ownerUserId !== userId || ownCredential.status !== 'active')
    throw new SessionError(422, 'CREDENTIAL_UNAVAILABLE', '请先配置自己的 Figma Token');
  if (!options.personalModelCredential)
    throw new SessionError(503, 'MODEL_CREDENTIAL_UNAVAILABLE', '个人模型凭据服务尚未就绪');
  const personalModelId = await options.personalModelCredential(userId);
  if (!['h5', 'rn'].includes(source.session.target ?? ''))
    throw new SessionError(503, 'SOURCE_INVALID', '来源目标无效');
  requireRevision(source.session.fileRevision);
  requireRevision(source.session.timelineSeq);
  const defaultName =
    (source.session.name || '广场作品')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 193) + ' · 分支';
  const name = (input.name ?? defaultName).trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
    throw new SessionError(422, 'INVALID_NAME', '分支名称须为1至200个字符');
  const limits = options.readLimits?.() ?? { textFileBytes: 104857600, filesPerSession: 2000 };
  const candidateFiles = await contentModel(mysql, files).findAll({
    where: {
      sessionId: source.session.sessionId!,
      kind: { [Op.in]: ['source', 'asset', 'attachment'] },
    },
    limit: limits.filesPerSession + 1,
  });
  if (candidateFiles.length > limits.filesPerSession)
    throw new SessionError(413, 'FORK_TOO_LARGE', '来源文件超过当前工作区限额');
  const sourceFiles = candidateFiles.filter(artifact);
  const fileIds = new Map<string, string>();
  const preparedFiles: Array<CreationAttributes<D2cFile>> = [];
  let bytes = 0;
  for (const file of sourceFiles) {
    if (
      file.pathHash !== hash(file.path!) ||
      !Number.isSafeInteger(file.size) ||
      file.size! < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
    )
      throw new SessionError(503, 'FILE_CORRUPT', '来源文件元数据无效');
    bytes += file.size!;
    if (bytes > 128 * 1024 * 1024 || (!file.objectLocator && file.size! > limits.textFileBytes))
      throw new SessionError(413, 'FORK_TOO_LARGE', '来源文件超过分支复制限额');
    const fileId = randomUUID();
    fileIds.set(file.fileId!, fileId);
    let stored: PreparedText = { content: null };
    if (!file.objectLocator) {
      const content = await resolveTextContent(mysql, file, `session:${source.session.sessionId}`);
      if (
        typeof content !== 'string' ||
        Buffer.byteLength(content) !== file.size ||
        hash(content) !== file.sha256
      )
        throw new SessionError(503, 'FILE_CORRUPT', '来源文件完整性校验失败');
      stored = await prepareTextContent(mysql, `session:${sessionId}`, content);
    } else if (file.content !== null || file.contentRef != null)
      throw new SessionError(503, 'FILE_CORRUPT', '来源文件存储状态无效');
    preparedFiles.push({
      fileId,
      sessionId,
      path: file.path,
      pathHash: file.pathHash,
      kind: file.kind,
      ...stored,
      objectLocator: file.objectLocator ? structuredClone(file.objectLocator) : null,
      mimeType: file.mimeType,
      size: file.size,
      sha256: file.sha256,
      revision: 1,
    });
  }
  const messages: Array<{
    role: 'user' | 'assistant';
    text: string;
    attachments?: Array<Record<string, any>>;
    messageId: string | null;
  }> = [];
  let after = 0,
    historyBytes = 0;
  while (after < source.session.timelineSeq) {
    const rows = await findOrderedRows(timeline, 'seq', {
      where: {
        sessionId: source.session.sessionId!,
        kind: 'message',
        completed: true,
        seq: { [Op.gt]: after, [Op.lte]: source.session.timelineSeq },
      },
      attributes: ['seq', 'kind', 'messageId', 'displayPayload'],
      order: [['seq', 'ASC']],
      limit: 250,
    });
    if (!rows.length) break;
    for (const row of rows) {
      const value = displayPayload('message', row.displayPayload) as {
        role: 'user' | 'assistant';
        text: string;
        attachments?: Array<Record<string, any>>;
      };
      historyBytes += Buffer.byteLength(JSON.stringify(value));
      if (messages.length >= 10000 || historyBytes > 16 * 1024 * 1024)
        throw new SessionError(413, 'FORK_TOO_LARGE', '来源公开对话超过分支复制限额');
      messages.push({ ...value, messageId: row.messageId });
    }
    const next = rows.at(-1)!.seq!;
    if (next <= after) throw new SessionError(503, 'TIMELINE_CORRUPT', '来源对话序号无效');
    after = next;
  }
  const copiedAttachments: Array<Record<string, any>> = [];
  const copiedAttachmentIds = new Set<string>();
  const sourceMessageIds = new Set(messages.map((message) => message.messageId));
  const entries: Array<Record<string, any>> = [];
  const provenance = {
    shareId,
    fileRevision: source.session.fileRevision,
    throughSeq: source.session.timelineSeq,
  };
  const addMessage = (
    role: 'user' | 'assistant',
    text: string,
    refs: Array<Record<string, any>> = [],
    extra = {},
  ) => {
    const messageId = randomUUID();
    const content =
      role === 'user' && refs.length
        ? [
            { type: 'input_text', text },
            ...refs.map((ref) => ({ type: 'input_image', attachmentId: ref.attachmentId })),
          ]
        : text;
    entries.push({
      entryId: randomUUID(),
      sessionId,
      runId: null,
      seq: entries.length + 1,
      kind: 'message',
      messageId,
      toolCallId: null,
      completed: true,
      displayPayload: displayPayload('message', {
        role,
        text,
        ...(refs.length ? { attachments: refs } : {}),
      }),
      sdkItem: { type: 'message', role, id: messageId, status: 'completed', content, ...extra },
    });
    return messageId;
  };
  addMessage(
    'assistant',
    `此会话基于广场作品《${source.session.name || '未命名作品'}》创建独立分支。来源：/plaza/${shareId}；文件修订 r${source.session.fileRevision}，公开对话截至序号 ${source.session.timelineSeq}。历史正文仅作上下文，原作者的凭据、工具执行状态与检查点未继承。`,
    [],
    { forkSource: provenance },
  );
  for (const message of messages) {
    const refs = [];
    const attachmentRows = [];
    for (const ref of message.attachments ?? []) {
      const expected = `/api/d2c/sessions/${source.session.sessionId}/attachments/${ref.attachmentId}`;
      if (ref.url !== expected)
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '来源附件引用无效');
      const row = await attachments.findOne({
        where: { sessionId: source.session.sessionId!, attachmentId: ref.attachmentId },
      });
      if (
        !row ||
        !row.messageId ||
        !sourceMessageIds.has(row.messageId) ||
        !messages.some(
          (message) =>
            message.messageId === row.messageId &&
            message.attachments?.some(
              (value) => value.attachmentId === ref.attachmentId && value.url === expected,
            ),
        ) ||
        row.expiresAt ||
        !row.objectLocator ||
        row.size !== ref.size ||
        row.width !== ref.width ||
        row.height !== ref.height ||
        row.mimeType !== ref.mimeType ||
        !/^[a-f0-9]{64}$/.test(row.sha256)
      )
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '来源附件不可复制');
      const attachmentId = hash(JSON.stringify([sessionId, ref.attachmentId]));
      refs.push({
        ...ref,
        attachmentId,
        url: `/api/d2c/sessions/${sessionId}/attachments/${attachmentId}`,
      });
      if (!copiedAttachmentIds.has(attachmentId)) {
        copiedAttachmentIds.add(attachmentId);
        attachmentRows.push({
          attachmentId,
          sessionId,
          userId,
          fileName: row.fileName,
          mimeType: row.mimeType,
          width: row.width,
          height: row.height,
          size: row.size,
          sha256: row.sha256,
          objectLocator: structuredClone(row.objectLocator),
          expiresAt: null,
        });
      }
    }
    let text = message.text;
    for (const [oldId, newId] of fileIds)
      text = text.replaceAll(
        `/api/d2c/sessions/${source.session.sessionId}/files/${oldId}`,
        `/api/d2c/sessions/${sessionId}/files/${newId}`,
      );
    for (let i = 0; i < refs.length; i++)
      text = text.replaceAll(message.attachments![i].url, refs[i].url);
    const messageId = addMessage(message.role, text, refs);
    copiedAttachments.push(...attachmentRows.map((row) => ({ ...row, messageId })));
  }
  return mysql.transaction(async (transaction) => {
    // 同时锁双方工作区，按稳定标识排序，保持跨工作区分支的锁序一致。
    await workspaces.findAll({
      where: {
        workspaceId: {
          [Op.in]: [...new Set([input.workspaceId, source.session.workspaceId!])].sort(),
        },
      },
      attributes: ['workspaceId'],
      order: [['workspaceId', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const target = await ownedWorkspace(mysql, userId, input.workspaceId, transaction);
    if (
      target.teamId ||
      !sameUser(target.createdUserId, userId) ||
      target.status !== 'ready' ||
      !target.activeResourceRevisionId
    )
      throw new SessionError(409, 'WORKSPACE_NOT_READY', '个人工作区状态已变化');
    const repeated = await sessions.findOne({
      where: { sessionId, workspaceId: input.workspaceId, createdUserId: userId },
      transaction,
    });
    if (repeated) return summary(repeated);
    const current = await publishedSession(mysql, userId, shareId, transaction);
    if (
      current.session.sessionId !== source.session.sessionId ||
      current.session.workspaceId !== source.session.workspaceId ||
      current.session.fileRevision !== source.session.fileRevision
    )
      throw new SessionError(409, 'SOURCE_CHANGED', '来源代码已更新，请重新创建分支');
    const credential = await credentials.findOne({
      where: {
        credentialId: input.credentialId,
        ownerUserId: userId,
        kind: 'figma',
        status: 'active',
      },
      transaction,
    });
    if (!credential || credential.ownerUserId !== userId || credential.status !== 'active')
      throw new SessionError(422, 'CREDENTIAL_UNAVAILABLE', '请先配置自己的 Figma Token');
    const session = await sessions.create(
      {
        sessionId,
        workspaceId: input.workspaceId,
        createdUserId: userId,
        creatorName: creatorName?.trim().slice(0, 100) || null,
        name,
        target: source.session.target,
        figmaUrl: publicFigma(messages),
        credentialId: input.credentialId,
        ...(personalModelId ? { modelCredentialId: personalModelId } : {}),
        fileRevision: preparedFiles.length ? 1 : 0,
        timelineSeq: entries.length,
        activeRunId: null,
        contextSummary: null,
        summaryThroughSeq: 0,
        validationState: { status: 'not_checked' },
      },
      { transaction },
    );
    if (preparedFiles.length) await files.bulkCreate(preparedFiles, { transaction });
    if (copiedAttachments.length)
      await attachments.bulkCreate(copiedAttachments as never, { transaction });
    await timeline.bulkCreate(entries as never, { transaction });
    return summary(session);
  });
}
