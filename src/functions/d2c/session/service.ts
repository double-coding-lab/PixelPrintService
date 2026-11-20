import { findOrderedPage, findOrderedRows } from '../utils/orderedRead';
import { modelActivitySchema } from '../run/agent/modelActivity';
import { defaultSessionName } from './name';
import { userQuestionSchema, publicQuestion } from '../run/interaction';
import { sliceProgressSchema } from '../run/sliceProgress';
import { randomUUID } from 'node:crypto';
import { Op, Transaction, type Sequelize } from 'sequelize';
import { z } from 'zod';
import type { D2cSession, D2cTarget } from '@/models/D2cSession';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { D2cCredential } from '@/models/D2cCredential';
import type { D2cRun } from '@/models/D2cRun';
import { runFailureSchema } from '../run/errors';
import { toolFeedbackSchema } from '../run/toolFeedback';
import { subagentEventSchema } from '../run/subagent';
import {
  ownedSession,
  ownedWorkspace,
  requireIdentifier,
  requireRevision,
  SessionError,
} from './access';

const fileEventSchema = z.object({
  action: z.enum(['created', 'updated', 'deleted']),
  fileId: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
  revision: z.number().int().min(1).max(4294967295),
  fileRevision: z.number().int().min(1).max(4294967295),
});

const versionEventSchema = z.object({
  versionId: z.string().min(1).max(64),
  name: z.string().max(200),
  status: z.enum(['saving', 'ready', 'failed']),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  authorUserId: z.string().min(1).max(64).optional(),
  text: z.string().max(65536),
  attachments: z
    .array(
      z.object({
        attachmentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        url: z
          .string()
          .regex(/^\/api\/d2c\/sessions\/[A-Za-z0-9_-]{1,64}\/attachments\/[A-Za-z0-9_-]{1,64}$/),
        mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
        size: z
          .number()
          .int()
          .positive()
          .max(10 * 1024 * 1024),
      }),
    )
    .max(4)
    .optional(),
  streamId: z.string().uuid().optional(),
  questionId: z.string().uuid().optional(),
});
const textDeltaSchema = z.object({
  streamId: z.string().uuid(),
  text: z.string().max(65536),
  status: z.enum(['streaming', 'interrupted', 'discarded']),
});
const reasoningDeltaSchema = textDeltaSchema.extend({
  status: z.enum(['streaming', 'completed', 'interrupted']),
});
const toolSchema = z.object({
  callId: z.string().min(1).max(200),
  name: z.string().max(100).optional(),
  detail: z.string().max(512).optional(),
  feedback: toolFeedbackSchema.optional(),
  status: z.enum(['started', 'completed', 'failed', 'interrupted']),
  recovered: z.boolean().optional(),
});
const stageSchema = z.union([
  z.object({
    action: z.literal('message_queue'),
    queueId: z.string(),
    clientRequestId: z.string(),
    content: z.string(),
    attachmentIds: z.array(z.string()).optional(),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(),
    createdAt: z.string(),
    mode: z.enum(['queue', 'guidance']),
    status: z.enum(['queued', 'guidance_pending', 'delivered', 'deleted']),
    targetRunId: z.string().optional(),
    actorUserId: z.string().min(1).max(64).optional(),
  }),
  sliceProgressSchema,
  z.object({
    status: z.enum(['queued', 'cancelled']),
    stage: z.enum(['queued', 'cancelled']),
    action: z.literal('resume').optional(),
    automatic: z.boolean().optional(),
  }),
  subagentEventSchema,
]);
const runStatusSchema = z.object({
  status: z.enum([
    'running',
    'stopping',
    'waiting_input',
    'succeeded',
    'failed',
    'interrupted',
    'cancelled',
  ]),
  reason: z
    .enum(['EXECUTION_FAILED', 'WORKER_INTERRUPTED', 'LEASE_EXPIRED', 'SNAPSHOT_CONFLICT'])
    .optional(),
  failure: runFailureSchema.optional(),
  validation: z
    .object({
      status: z.enum(['passed', 'failed', 'not_checked', 'stale']),
      sourceFiles: z.number().int().nonnegative().optional(),
      reportPath: z.string().max(1024).optional(),
    })
    .optional(),
});

/** 按事件类型投影已实现字段，SDK 回放和检查点始终保持私有。 */
export function displayPayload(kind: string | null, value: unknown): Record<string, unknown> {
  if (kind === 'session_changed') {
    const parsed = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(value);
    if (!parsed.success) throw new SessionError(503, 'TIMELINE_CORRUPT', '会话名称事件无效');
    return parsed.data;
  }
  const schema =
    kind === 'preview_changed'
      ? z.object({ status: z.literal('changed') })
      : kind === 'version_changed'
        ? versionEventSchema
        : kind === 'model_status'
          ? modelActivitySchema
          : kind === 'user_question'
            ? userQuestionSchema.extend({ fileRevision: z.number().int().nonnegative().optional() })
            : kind === 'reasoning_delta'
              ? reasoningDeltaSchema
              : kind === 'text_delta'
                ? textDeltaSchema
                : kind === 'file_changed'
                  ? fileEventSchema
                  : kind === 'message'
                    ? messageSchema
                    : kind === 'stage'
                      ? stageSchema
                      : kind === 'run_status'
                        ? runStatusSchema
                        : kind === 'tool_call' || kind === 'tool_result'
                          ? toolSchema
                          : undefined;
  if (!schema) return {};
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SessionError(503, 'TIMELINE_CORRUPT', '时间线内容格式无效');
  return parsed.data;
}

/** 名称不可含控制字符，不复制配置、上下文或用户凭据到元数据。 */
function sessionName(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SessionError(422, 'INVALID_NAME', '会话名称无效');
  }
  return value.trim();
}

/** Figma 地址只保存官方 HTTPS 链接；禁止 URL 内嵌账号或凭据字段。 */
function figmaAddress(value?: string) {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (
      value.length > 2048 ||
      url.protocol !== 'https:' ||
      !['figma.com', 'www.figma.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => /token|auth|secret|key/i.test(key))
    )
      throw new Error();
    return url.href;
  } catch {
    throw new SessionError(422, 'INVALID_FIGMA_URL', 'Figma 地址无效，请通过凭据入口保存 Token');
  }
}

/** 摘要使用显式字段，不包含配置、上下文摘要、对象定位或私有 SDK 记录。 */
function summary(row: D2cSession) {
  return {
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    name: row.name,
    target: row.target,
    figmaUrl: row.figmaUrl,
    credentialId: row.credentialId,
    createdUserId: row.createdUserId ?? null,
    creatorName: row.creatorName ?? null,
    fileRevision: row.fileRevision,
    timelineSeq: row.timelineSeq,
    activeRunId: row.activeRunId,
    validationState: row.validationState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 在调用方已持有的会话锁和事务中追加事件，并递增同会话的 timelineSeq。
 * sdkItem 供服务端历史回放，displayPayload 经过白名单投影后才用于页面展示。
 * @param transaction 调用方的业务事务，保证事件和业务变更一起提交或回滚。
 * @returns 新事件的数据库顺序号；通知由调用方在整个事务提交后发布。
 */
export async function appendSessionEvent(
  mysql: Sequelize,
  session: D2cSession,
  transaction: Transaction,
  data: {
    runId?: string;
    kind:
      | 'session_changed'
      | 'preview_changed'
      | 'version_changed'
      | 'file_changed'
      | 'message'
      | 'stage'
      | 'run_status'
      | 'tool_call'
      | 'tool_result'
      | 'text_delta'
      | 'reasoning_delta'
      | 'user_question'
      | 'model_status';
    messageId?: string;
    toolCallId?: string;
    sdkItem?: Record<string, unknown>;
    displayPayload: Record<string, unknown>;
  },
) {
  requireRevision(session.timelineSeq);
  if (session.timelineSeq >= 4294967294)
    throw new SessionError(409, 'REVISION_EXHAUSTED', '会话事件序号已达到上限');
  const seq = session.timelineSeq + 1;
  const model = mysql.models.D2cTimeline as typeof D2cTimeline;
  await model.create(
    {
      entryId: randomUUID(),
      sessionId: session.sessionId,
      runId: data.runId ?? null,
      seq,
      kind: data.kind,
      messageId: data.messageId ?? null,
      toolCallId: data.toolCallId ?? null,
      sdkItem: data.sdkItem ?? null,
      displayPayload: displayPayload(data.kind, data.displayPayload),
      completed: true,
    },
    { transaction },
  );
  await session.update({ timelineSeq: seq }, { transaction });
  return seq;
}

/** 文件事件只接收产物元数据，正文与私有执行数据通过独立服务维护。 */
export async function appendFileEvent(
  mysql: Sequelize,
  session: D2cSession,
  transaction: Transaction,
  data: {
    action: 'created' | 'updated' | 'deleted';
    fileId: string;
    path: string;
    revision: number;
    fileRevision: number;
  },
) {
  return appendSessionEvent(mysql, session, transaction, {
    kind: 'file_changed',
    displayPayload: { ...data },
  });
}

/**
 * 创建会话元数据、软删除与时间线查询服务，所有业务操作校验用户归属。
 * 创建会话只写 MySQL；发送消息和执行模型分别由 messages.ts 与 run/ 管理。
 */
export function createSessionService(mysql: Sequelize) {
  const sessions = mysql.models.D2cSession as typeof D2cSession;
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  const credentials = mysql.models.D2cCredential as typeof D2cCredential;
  if (!sessions || !timeline || !credentials || !mysql.models.D2cWorkspace) {
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '会话模型尚未注册');
  }
  return {
    /** 有编辑权限的用户可随时修改会话标题，与名称事件在同一事务内保存。 */
    async rename(userId: string, id: string, value: string) {
      const name = sessionName(value);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, id, transaction);
        if (session.name !== name) {
          await session.update({ name }, { transaction });
          await appendSessionEvent(mysql, session, transaction, {
            kind: 'session_changed',
            displayPayload: { name },
          });
        }
        return summary(session);
      });
    },
    /** 只删除本人空闲会话；paranoid destroy 更新 deletedAt，不移除文件或历史。 */
    async remove(userId: string, id: string) {
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, id, transaction);
        const runs = mysql.models.D2cRun as typeof D2cRun;
        if (
          session.activeRunId ||
          (await runs.findOne({
            where: { sessionId: id, status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] } },
            transaction,
            lock: transaction.LOCK.UPDATE,
          }))
        )
          throw new SessionError(409, 'SESSION_BUSY', '请先完成或明确结束当前轮次再删除会话');
        await session.destroy({ transaction });
        return { sessionId: id, deleted: true };
      });
    },
    /**
     * 在本人就绪工作区下创建拥有独立文件及聊天历史的 H5 或 RN 会话。
     * 同事务核对工作区和凭据；有设计稿时通过入口提供的回调原子保存首条生成消息。
     * @param input 目标、可选名称及设计稿地址和本人凭据编号；空名称按目标自动生成。
     * @returns 包含首条消息入队状态的最新会话摘要。
     */
    async create(
      userId: string,
      workspaceId: string,
      input: { name?: string; target: D2cTarget; figmaUrl?: string; credentialId?: string },
      creatorName?: string,
      startGeneration?: (session: D2cSession, transaction: Transaction) => Promise<void>,
    ) {
      const name = sessionName(
          input.name === undefined || (typeof input.name === 'string' && !input.name.trim())
            ? defaultSessionName(input.target)
            : input.name,
        ),
        figmaUrl = figmaAddress(input.figmaUrl);
      if (!['h5', 'rn'].includes(input.target))
        throw new SessionError(422, 'INVALID_TARGET', '会话目标无效');
      if (input.credentialId !== undefined) requireIdentifier(input.credentialId);
      return mysql.transaction(async (transaction) => {
        const workspace = await ownedWorkspace(mysql, userId, workspaceId, transaction);
        if (workspace.status !== 'ready' || !workspace.activeResourceRevisionId) {
          throw new SessionError(409, 'WORKSPACE_NOT_READY', '工作区尚未就绪');
        }
        if (input.credentialId) {
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
            throw new SessionError(422, 'CREDENTIAL_UNAVAILABLE', 'Figma 凭据不可用');
        }
        const session = await sessions.create(
          {
            sessionId: randomUUID(),
            workspaceId,
            createdUserId: userId,
            creatorName: creatorName?.trim().slice(0, 100) || null,
            name,
            target: input.target,
            figmaUrl,
            credentialId: input.credentialId ?? null,
            fileRevision: 0,
            timelineSeq: 0,
            activeRunId: null,
            contextSummary: null,
            summaryThroughSeq: 0,
            validationState: { status: 'not_checked' },
          },
          { transaction },
        );
        if (figmaUrl && startGeneration) {
          await startGeneration(session, transaction);
          const started = await sessions.findOne({
            where: { sessionId: session.sessionId },
            transaction,
          });
          if (!started) throw new SessionError(503, 'SESSION_NOT_FOUND', '会话创建结果不可用');
          return summary(started);
        }
        return summary(session);
      });
    },
    /** 分页按创建时间及业务 ID 确定排序，只读取本人工作区会话。 */
    async list(userId: string, workspaceId: string, page = 1, pageSize = 20) {
      await ownedWorkspace(mysql, userId, workspaceId);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      ) {
        throw new SessionError(422, 'INVALID_PAGE', '分页参数无效');
      }
      const result = await findOrderedPage(sessions, 'sessionId', {
        where: { workspaceId },
        order: [
          ['createdAt', 'DESC'],
          ['sessionId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { items: result.rows.map(summary), total: result.count };
    },
    /** 只读快照返回一致的会话和运行状态，不争用后台保存所持有的写锁。 */
    async get(userId: string, id: string) {
      return mysql.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
        async (transaction) => {
          const { session } = await ownedSession(mysql, userId, id, transaction, 'read');
          const run = session.activeRunId
            ? await (mysql.models.D2cRun as typeof D2cRun).findOne({
                where: { runId: session.activeRunId, sessionId: id },
                transaction,
                attributes: ['status', 'pendingInteraction'],
              })
            : null;
          return {
            ...summary(session),
            activeRunStatus: run?.status ?? null,
            pendingQuestion:
              run?.status === 'waiting_input' ? publicQuestion(run.pendingInteraction) : null,
          };
        },
      );
    },
    /**
     * 按 seq 补读公开事件；默认向后供 SSE 使用，beforeSeq=0 读取最新页，大于零向前翻页。
     * 多取一条判断是否还有下一页；每次校验归属，私有 sdkItem 永不序列化给前端。
     * @returns entries、下次读取游标 nextSeq 和是否还有事件的 hasMore。
     */
    async timeline(
      userId: string,
      id: string,
      afterSeq = 0,
      limit = 100,
      beforeSeq?: number,
      agentId?: string,
    ) {
      await ownedSession(mysql, userId, id);
      requireRevision(afterSeq);
      if (agentId !== undefined) z.string().uuid().parse(agentId);
      if (beforeSeq !== undefined) requireRevision(beforeSeq);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new SessionError(422, 'INVALID_PAGE', '时间线分页无效');
      const rows = await findOrderedRows(timeline, 'seq', {
        where: {
          sessionId: id,
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
          'sessionId',
          'runId',
          'seq',
          'kind',
          'messageId',
          'toolCallId',
          'displayPayload',
          'completed',
          'createdAt',
        ],
      });
      const entries = rows.slice(0, limit).map((row) => {
        if (
          !Number.isSafeInteger(row.seq) ||
          row.seq! <= 0 ||
          (beforeSeq === undefined && row.seq! <= afterSeq) ||
          (beforeSeq !== undefined && beforeSeq > 0 && row.seq! >= beforeSeq) ||
          row.seq! > 4294967295
        ) {
          throw new SessionError(503, 'TIMELINE_CORRUPT', '时间线序号无效');
        }
        return {
          entryId: row.entryId,
          sessionId: row.sessionId,
          runId: row.runId,
          seq: row.seq!,
          kind: row.kind,
          messageId: row.messageId,
          toolCallId: row.toolCallId,
          data: displayPayload(row.kind, row.displayPayload),
          completed: row.completed,
          at: row.createdAt,
        };
      });
      if (beforeSeq !== undefined) entries.reverse();
      return {
        entries,
        nextSeq: entries.at(-1)?.seq ?? afterSeq,
        ...(beforeSeq !== undefined ? { previousSeq: entries[0]?.seq ?? beforeSeq } : {}),
        hasMore: rows.length > limit,
      };
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
