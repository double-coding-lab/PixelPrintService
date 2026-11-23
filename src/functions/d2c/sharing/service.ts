import { runtimeCoverIds } from './runtimeCover';
import { contentModel, resolveTextContent } from '../content/runtime';
import { findOrderedRows } from '../utils/orderedRead';
import { publicOverviewPayload } from './overview';
import { createHash, randomUUID } from 'node:crypto';
import { Op, literal, type Sequelize } from 'sequelize';
import type { D2cWorkspace } from '../../../models/D2cWorkspace';
import type { D2cSession } from '../../../models/D2cSession';
import type { D2cSessionShare } from '../../../models/D2cSessionShare';
import type { D2cRun } from '../../../models/D2cRun';
import type { D2cFile } from '../../../models/D2cFile';
import type { D2cTimeline } from '../../../models/D2cTimeline';
import type { D2cMessageAttachment } from '../../../models/D2cMessageAttachment';
import { ownedSession, requireIdentifier, requireRevision, SessionError } from '../session/access';
import { sameUser } from '../team/access';
import { displayPayload } from '../session/service';
import { attachmentMaxBytes, inspectAttachmentImage } from '../session/attachments';
import { assertArtifactPath } from '../utils/paths';
import { publishedSession, requireSharingIdentity } from './access';

/** 与诊断时间规则一致，缺失和非法值保持未知。 */
function usageTime(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export type SharingBinary = { downloadFile(locator: Record<string, unknown>): Promise<Buffer> };

/** DTO 始终只含显示字段，不含配置、凭据或对象定位。 */
function summary(session: D2cSession, shareId: string, coverAttachmentId?: string) {
  return {
    shareId,
    coverUrl: coverAttachmentId
      ? `/api/d2c/plaza/sessions/${shareId}/attachments/${encodeURIComponent(coverAttachmentId)}`
      : null,
    sessionId: session.sessionId!,
    name: session.name,
    target: session.target,
    creatorName: session.creatorName,
    createdEid: session.createdUserId,
    fileRevision: session.fileRevision,
    timelineSeq: session.timelineSeq,
    createdAt: session.createdAt,
  };
}

/** 排除内部种类、非规范路径、Skill、配置与缓存。 */
function artifact(file: Pick<D2cFile, 'kind' | 'path'>) {
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

/** 所有产物链接走广场登录代理，不暴露存储直链。 */
function fileInfo(row: D2cFile, shareId: string) {
  return {
    fileId: row.fileId,
    path: row.path,
    kind: row.kind,
    mimeType: row.mimeType,
    size: row.size,
    sha256: row.sha256,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: `/api/d2c/plaza/sessions/${shareId}/files/${encodeURIComponent(row.fileId!)}`,
  };
}

/** 摘要与大小校验适用于文本及存储对象，不把不完整内容当成成功读取。 */
function verifyBytes(data: Buffer, size: number | null, sha256: string | null) {
  return (
    Buffer.isBuffer(data) &&
    Number.isSafeInteger(size) &&
    size! >= 0 &&
    data.length === size &&
    typeof sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    createHash('sha256').update(data).digest('hex') === sha256
  );
}

/** 递归处理已投影的显示结构；跨会话链接不复用当前分享权限。 */
function rewrite(value: unknown, sessionId: string, shareId: string): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\/api\/d2c\/sessions\/([A-Za-z0-9_-]+)\/(attachments|files)\/([A-Za-z0-9_-]+)/g,
      (_url, owner: string, kind: string, id: string) =>
        owner === sessionId ? `/api/d2c/plaza/sessions/${shareId}/${kind}/${id}` : '',
    );
  if (Array.isArray(value)) return value.map((item) => rewrite(item, sessionId, shareId));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, sessionId, shareId)]),
    );
  return value;
}

const publicKinds = new Set([
  'session_changed',
  'preview_changed',
  'version_changed',
  'model_status',
  'user_question',
  'reasoning_delta',
  'text_delta',
  'file_changed',
  'message',
  'stage',
  'run_status',
  'tool_call',
  'tool_result',
]);

/** 白名单投影先于 URL 转换；排队消息未发送内容永不出现在广场。 */
function publicEvent(row: D2cTimeline, sessionId: string, shareId: string) {
  if (!row.kind || !publicKinds.has(row.kind)) return null;
  if (
    row.kind === 'stage' &&
    (row.displayPayload?.action === 'message_queue' ||
      row.displayPayload?.stage === 'message_queue')
  )
    return null;
  const data = displayPayload(row.kind, row.displayPayload);
  if (row.kind === 'file_changed' && !artifact({ kind: 'source', path: data.path as string }))
    return null;
  return {
    entryId: row.entryId,
    sessionId,
    runId: row.runId,
    seq: row.seq!,
    kind: row.kind,
    messageId: row.messageId,
    toolCallId: row.toolCallId,
    data: rewrite(data, sessionId, shareId) as Record<string, unknown>,
    completed: row.completed,
    at: row.createdAt,
  };
}

/** 优先使用会话创建者；缺失时仅允许个人工作区拥有者管理历史会话，不回填身份。 */
function canManageSharing(eid: string, session: D2cSession, workspace: D2cWorkspace): boolean {
  const creator = session.createdUserId;
  if (typeof creator === 'string' && creator.trim()) return sameUser(creator, eid);
  return (
    (workspace.teamId === null || workspace.teamId === '') && sameUser(workspace.createdUserId, eid)
  );
}

/** 独立的广场只读服务；发布写入复查统一管理权限，binary 延迟取得，文本读取无需存储。 */
export function createSharingService(mysql: Sequelize, options: { binary: () => SharingBinary }) {
  const shares = mysql.models.D2cSessionShare as typeof D2cSessionShare;
  const files = mysql.models.D2cFile as typeof D2cFile;
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  if (!shares || !files || !timeline || !mysql.models.D2cSession || !mysql.models.D2cWorkspace)
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '公开会话模型尚未注册');

  /** 存储异常仅保留固定错误；二进制耗时后再鉴权，撤销不返回在途下载内容。 */
  async function download(locator: Record<string, unknown>) {
    try {
      return await options.binary().downloadFile(locator);
    } catch (error) {
      throw new SessionError(503, 'SHARE_STORAGE_UNAVAILABLE', '公开文件存储暂不可用', error);
    }
  }

  return {
    /** 状态沿用私有访问权限，历史个人会话与发布写入使用同一授权规则。 */
    async status(eid: string, sessionId: string) {
      requireSharingIdentity(eid);
      const { session, workspace } = await ownedSession(mysql, eid, sessionId, undefined, 'read');
      const share = await shares.findOne({ where: { sessionId } });
      return {
        public: share?.enabled === true,
        shareId: share?.enabled ? share.shareId : null,
        canManage: canManageSharing(eid, session, workspace),
      };
    },
    /** 锁序复用工作区→会话→发布；并发首次发布由会话锁串行化，重复启用保留 UUID。 */
    async set(eid: string, sessionId: string, enabled: boolean) {
      requireSharingIdentity(eid);
      if (typeof enabled !== 'boolean')
        throw new SessionError(422, 'INVALID_SHARING', '发布状态无效');
      return mysql.transaction(async (transaction) => {
        const { session, workspace } = await ownedSession(mysql, eid, sessionId, transaction);
        if (!canManageSharing(eid, session, workspace))
          throw new SessionError(403, 'SESSION_CREATOR_REQUIRED', '仅会话创建者可发布或撤销');
        const existing = await shares.findOne({
          where: { sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (existing) {
          if (existing.enabled !== enabled)
            await existing.update(
              { enabled, ...(enabled ? { shareId: randomUUID() } : {}) },
              { transaction },
            );
          return { public: enabled, shareId: enabled ? existing.shareId : null, canManage: true };
        }
        if (!enabled) return { public: false, shareId: null, canManage: true };
        const row = await shares.create(
          { sessionId, shareId: randomUUID(), enabled: true },
          { transaction },
        );
        return { public: true, shareId: row.shareId, canManage: true };
      });
    },
    /** 数据库过滤存活关联后分页并计数，仅批量读取当前页元数据。 */
    async list(eid: string, page = 1, pageSize = 12) {
      requireSharingIdentity(eid);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        throw new SessionError(422, 'INVALID_PAGE', '分页参数无效');
      /** 固定 SQL 不插入身份或请求参数；count 与 page 使用同一存活条件。 */
      const result = await shares.findAndCountAll({
        where: {
          enabled: true,
          [Op.and]: literal(
            'EXISTS (SELECT 1 FROM `d2c_session` AS `plaza_session` INNER JOIN `d2c_workspace` AS `plaza_workspace` ON `plaza_workspace`.`workspaceId` = `plaza_session`.`workspaceId` AND `plaza_workspace`.`deletedAt` IS NULL WHERE `plaza_session`.`sessionId` = `D2cSessionShare`.`sessionId` AND `plaza_session`.`deletedAt` IS NULL)',
          ),
        },
        attributes: ['sessionId', 'shareId'],
        order: [
          ['createdAt', 'DESC'],
          ['shareId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (!result.rows.length) return { items: [], total: result.count, page, pageSize };
      const coverIds = await runtimeCoverIds(
        mysql,
        result.rows.map((row) => row.sessionId),
      );
      const sessions = await (mysql.models.D2cSession as typeof D2cSession).findAll({
        where: { sessionId: { [Op.in]: result.rows.map((row) => row.sessionId) } },
        attributes: [
          'sessionId',
          'workspaceId',
          'name',
          'target',
          'creatorName',
          'createdUserId',
          'fileRevision',
          'timelineSeq',
          'createdAt',
          'deletedAt',
        ],
      });
      const workspaces = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findAll({
        where: {
          workspaceId: {
            [Op.in]: sessions.map((row) => row.workspaceId).filter((id): id is string => !!id),
          },
        },
        attributes: ['workspaceId', 'deletedAt'],
      });
      /** 批量复查本页发布，避免查询期间撤销或轮换的链接继续出现在列表。 */
      const current = await shares.findAll({
        where: { enabled: true, shareId: { [Op.in]: result.rows.map((row) => row.shareId) } },
        attributes: ['sessionId', 'shareId', 'enabled'],
      });
      const live = new Set(
        workspaces.filter((row) => !row.deletedAt).map((row) => row.workspaceId),
      );
      const byId = new Map(
        sessions
          .filter((row) => !row.deletedAt && live.has(row.workspaceId))
          .map((row) => [row.sessionId, row]),
      );
      const items = result.rows.flatMap((row) => {
        const session = byId.get(row.sessionId);
        return session &&
          current.some(
            (active) =>
              active.shareId === row.shareId &&
              active.sessionId === row.sessionId &&
              active.enabled,
          )
          ? [summary(session, row.shareId, coverIds.get(session.sessionId!))]
          : [];
      });
      const total = result.count;
      return { items, total, page, pageSize };
    },
    /** 返回最新稳定元数据，既不冻结快照也不暴露工作区配置。 */
    async get(eid: string, shareId: string) {
      const { session } = await publishedSession(mysql, eid, shareId);
      const coverIds = await runtimeCoverIds(mysql, [session.sessionId!]);
      await publishedSession(mysql, eid, shareId);
      return summary(session, shareId, coverIds.get(session.sessionId!));
    },
    /** 汇总已去重持久化的主/子模型用量；不重放模型事件、不读取私有诊断。 */
    async usage(eid: string, shareId: string) {
      const { session } = await publishedSession(mysql, eid, shareId);
      const runs = mysql.models.D2cRun as typeof D2cRun | undefined;
      if (!runs) throw new SessionError(503, 'DIAGNOSTICS_UNAVAILABLE', '执行用量暂不可用');
      const rows = await runs.findAll({
        where: { sessionId: session.sessionId },
        attributes: ['runId', 'status', 'usage', 'createdAt', 'updatedAt'],
      });
      /** SQL 仅提取停止状态，不加载时间线大字段、SDK 历史或检查点。 */
      const events = (await timeline.findAll({
        where: { sessionId: session.sessionId, kind: 'run_status' },
        attributes: [
          'runId',
          'createdAt',
          [literal("JSON_UNQUOTE(JSON_EXTRACT(`displayPayload`, '$.status'))"), 'status'],
        ],
        raw: true,
      })) as unknown as Array<{ runId: string | null; createdAt: unknown; status: string }>;
      const observedAt = new Date().toISOString();
      const stopped = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
      const ends = new Map<string, number>();
      for (const event of events) {
        const at = usageTime(event.createdAt);
        if (event.runId && at !== null && stopped.has(event.status))
          ends.set(event.runId, Math.min(ends.get(event.runId) ?? at, at));
      }
      let sessionElapsedMs: number | null = 0;
      for (const run of rows) {
        const start = usageTime(run.createdAt);
        const end =
          (run.runId ? ends.get(run.runId) : undefined) ??
          (stopped.has(run.status) ? usageTime(run.updatedAt) : Date.parse(observedAt));
        if (start === null || end === null) {
          sessionElapsedMs = null;
          break;
        }
        sessionElapsedMs += Math.max(0, end - start);
        if (!Number.isSafeInteger(sessionElapsedMs)) {
          sessionElapsedMs = null;
          break;
        }
      }
      /** 与 SessionDiagnostics 一致：非法计数为 null，Token 仅来自已报告请求。 */
      const count = (usage: Record<string, unknown> | null, key: string) => {
        const value = usage?.[key];
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          ? value
          : null;
      };
      const sum = (key: string, token = false) => {
        const values = rows
          .filter((run) => !token || !!count(run.usage, 'reportedRequests'))
          .map((run) => count(run.usage, key));
        if (!values.length || values.some((value) => value === null)) return null;
        const total = values.reduce<number>((total, value) => total + value!, 0);
        return Number.isSafeInteger(total) ? total : null;
      };
      const completeness = rows.map((run) => run.usage?.usageComplete);
      const usage = {
        requests: sum('requests'),
        reportedRequests: sum('reportedRequests'),
        completedRequests: sum('completedRequests'),
        failedRequests: sum('failedRequests'),
        interruptedRequests: sum('interruptedRequests'),
        pendingRequests: sum('pendingRequests'),
        unreportedRequests: sum('unreportedRequests'),
        usageComplete: completeness.includes(false)
          ? false
          : completeness.length && completeness.every((value) => value === true)
            ? true
            : null,
        inputTokens: sum('inputTokens', true),
        outputTokens: sum('outputTokens', true),
        totalTokens: sum('totalTokens', true),
      };
      await publishedSession(mysql, eid, shareId);
      return { usage, sessionElapsedMs, observedAt };
    },
    /** 双向游标以扫描行推进，过滤草稿的整页仍能继续，子 Agent 同样经过 displayPayload。 */
    async timeline(
      eid: string,
      shareId: string,
      afterSeq = 0,
      limit = 500,
      beforeSeq?: number,
      agentId?: string,
    ) {
      const { session } = await publishedSession(mysql, eid, shareId);
      requireRevision(afterSeq);
      if (beforeSeq !== undefined) requireRevision(beforeSeq);
      if (beforeSeq !== undefined && afterSeq !== 0)
        throw new SessionError(422, 'INVALID_PAGE', '前后游标不能同时使用');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new SessionError(422, 'INVALID_PAGE', '时间线分页无效');
      if (
        agentId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)
      )
        throw new SessionError(422, 'INVALID_IDENTIFIER', '子会话标识无效');
      const rows = await findOrderedRows(timeline, 'seq', {
        where: {
          sessionId: session.sessionId,
          ...(agentId
            ? {
                kind: 'stage',
                'displayPayload.stage': 'subagent',
                'displayPayload.agentId': agentId,
              }
            : {}),
          ...(beforeSeq === undefined
            ? { seq: { [Op.gt]: afterSeq } }
            : beforeSeq > 0
              ? { seq: { [Op.lt]: beforeSeq } }
              : {}),
        },
        order: [['seq', beforeSeq === undefined ? 'ASC' : 'DESC']],
        limit: limit + 1,
        attributes: [
          'entryId',
          'runId',
          'seq',
          'kind',
          'messageId',
          'toolCallId',
          ...(agentId
            ? ['displayPayload']
            : [
                [publicOverviewPayload(), 'displayPayload'] as [ReturnType<typeof literal>, string],
              ]),
          'completed',
          'createdAt',
        ],
      });
      const scanned = rows.slice(0, limit);
      const entries = scanned.flatMap((row) => {
        if (
          !Number.isSafeInteger(row.seq) ||
          row.seq! <= 0 ||
          row.seq! > 4294967295 ||
          (beforeSeq === undefined && row.seq! <= afterSeq) ||
          (beforeSeq !== undefined && beforeSeq > 0 && row.seq! >= beforeSeq)
        )
          throw new SessionError(503, 'TIMELINE_CORRUPT', '时间线序号无效');
        const event = publicEvent(row, session.sessionId!, shareId);
        return event ? [event] : [];
      });
      if (beforeSeq !== undefined) entries.reverse();
      await publishedSession(mysql, eid, shareId);
      return {
        entries,
        nextSeq:
          beforeSeq === undefined
            ? (scanned.at(-1)?.seq ?? afterSeq)
            : (scanned[0]?.seq ?? afterSeq),
        ...(beforeSeq !== undefined ? { previousSeq: scanned.at(-1)?.seq ?? beforeSeq } : {}),
        hasMore: rows.length > limit,
      };
    },
    /** 公开文件树仅列产物，所有 URL 仍复查当前发布状态。 */
    async files(eid: string, shareId: string) {
      const { session } = await publishedSession(mysql, eid, shareId);
      const rows = await files.findAll({
        where: { sessionId: session.sessionId },
        order: [['pathHash', 'ASC']],
        attributes: [
          'fileId',
          'sessionId',
          'path',
          'kind',
          'mimeType',
          'size',
          'sha256',
          'revision',
          'createdAt',
          'updatedAt',
        ],
      });
      await publishedSession(mysql, eid, shareId);
      return rows
        .filter((row) => row.sessionId === session.sessionId && artifact(row))
        .map((row) => fileInfo(row, shareId));
    },
    /** 文本 DTO 含 content；二进制返回 data Buffer + mimeType，路由用 data 字段分流。 */
    async file(eid: string, shareId: string, fileId: string) {
      const { session } = await publishedSession(mysql, eid, shareId);
      requireIdentifier(fileId);
      const row = await contentModel(mysql, files).findOne({
        where: { sessionId: session.sessionId, fileId },
      });
      if (!row || row.sessionId !== session.sessionId || row.fileId !== fileId || !artifact(row))
        throw new SessionError(404, 'FILE_NOT_FOUND', '文件不存在');
      if (row.pathHash !== createHash('sha256').update(row.path!).digest('hex'))
        throw new SessionError(503, 'FILE_CORRUPT', '文件路径元数据无效');
      if (
        row.objectLocator === null &&
        (typeof row.content === 'string' || row.contentRef != null)
      ) {
        const content = await resolveTextContent(mysql, row, 'session:' + session.sessionId);
        if (typeof content !== 'string' || !verifyBytes(Buffer.from(content), row.size, row.sha256))
          throw new SessionError(503, 'FILE_CORRUPT', '文件完整性校验失败');
        await publishedSession(mysql, eid, shareId);
        return { ...fileInfo(row, shareId), content };
      }
      if (
        row.content !== null ||
        !row.objectLocator ||
        !row.mimeType ||
        !/^[\w.+-]+\/[\w.+-]+$/.test(row.mimeType)
      )
        throw new SessionError(503, 'FILE_CORRUPT', '文件元数据无效');
      const data = await download(row.objectLocator);
      if (!verifyBytes(data, row.size, row.sha256))
        throw new SessionError(503, 'FILE_CORRUPT', '文件完整性校验失败');
      await publishedSession(mysql, eid, shareId);
      return {
        data,
        mimeType:
          /^(?:image\/(?:png|jpeg|webp|gif|avif|svg\+xml|x-icon)|font\/(?:woff2?|ttf|otf)|audio\/(?:mpeg|wav|ogg)|video\/(?:mp4|webm)|text\/(?:plain|css)|application\/(?:json|javascript|pdf|octet-stream))$/.test(
            row.mimeType,
          )
            ? row.mimeType
            : 'application/octet-stream',
      };
    },
    /** 仅消息已发送且明确引用的附件可读；未发上传、队列草稿和借用别会话附件全部拒绝。 */
    async attachment(eid: string, shareId: string, attachmentId: string) {
      const { session } = await publishedSession(mysql, eid, shareId);
      requireIdentifier(attachmentId);
      const attachments = mysql.models.D2cMessageAttachment as typeof D2cMessageAttachment;
      if (!attachments) throw new SessionError(503, 'MODELS_UNAVAILABLE', '附件模型尚未注册');
      const row = await attachments.findOne({
        where: { sessionId: session.sessionId!, attachmentId },
      });
      if (
        !row ||
        row.sessionId !== session.sessionId ||
        row.attachmentId !== attachmentId ||
        !row.messageId ||
        row.expiresAt
      )
        throw new SessionError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
      const message = await timeline.findOne({
        where: { sessionId: session.sessionId, kind: 'message', messageId: row.messageId },
        attributes: ['kind', 'displayPayload', 'messageId'],
      });
      if (!message || message.kind !== 'message' || message.messageId !== row.messageId)
        throw new SessionError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
      const dataView = displayPayload('message', message.displayPayload);
      const refs = dataView.attachments as Array<{ attachmentId: string; url: string }> | undefined;
      if (
        !refs?.some(
          (ref) =>
            ref.attachmentId === attachmentId &&
            ref.url === `/api/d2c/sessions/${session.sessionId}/attachments/${attachmentId}`,
        )
      )
        throw new SessionError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
      if (
        !row.objectLocator ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(row.mimeType) ||
        !Number.isSafeInteger(row.size) ||
        row.size < 1 ||
        row.size > attachmentMaxBytes
      )
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件元数据无效');
      const data = await download(row.objectLocator);
      if (!verifyBytes(data, row.size, row.sha256))
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件完整性校验失败');
      let image;
      try {
        image = inspectAttachmentImage(data);
      } catch {
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件图片无效');
      }
      if (
        image.mimeType !== row.mimeType ||
        image.width !== row.width ||
        image.height !== row.height
      )
        throw new SessionError(503, 'ATTACHMENT_CORRUPT', '附件元数据无效');
      await publishedSession(mysql, eid, shareId);
      return { data, mimeType: row.mimeType };
    },
  };
}

export type SharingService = ReturnType<typeof createSharingService>;
