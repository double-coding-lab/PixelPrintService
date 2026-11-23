import { findOrderedRows, findOrderedOne } from '../utils/orderedRead';
import { randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import { parseD2cRuntimeConfig } from '@/config/d2c';
import { ownedSession, requireIdentifier, SessionError } from './access';
import { appendSessionEvent } from './service';
import { linkMessageAttachments } from './attachments';
import { createMessageService, validateInput, type MessageInput } from './messages';
import type { RunLease, createRunLeases } from '../run/leases';
import type { StoredAgentMessage } from '../run/types';
import { sameUser } from '../team/access';

export const messageQueueLimit = 32;
export type QueueItem = MessageInput & {
  /** 账号认证 发起人；仅旧时间线记录缺省，不能由请求正文指定。 */
  actorUserId?: string;
  queueId: string;
  createdAt: string;
  status: 'queued' | 'guidance_pending';
};
export type QueueState = Omit<QueueItem, 'status'> & {
  action: 'message_queue';
  mode: 'queue' | 'guidance';
  status: QueueItem['status'] | 'delivered' | 'deleted';
  targetRunId?: string;
  attachments?: Awaited<ReturnType<typeof linkMessageAttachments>>;
};

/** Append-only queue events are folded in database sequence order; tombstones retain request identity. */
export async function readMessageQueue(
  mysql: Sequelize,
  sessionId: string,
  transaction?: Transaction,
  options: { lock?: boolean; runId?: string } = {},
) {
  const rows = await findOrderedRows(mysql.models.D2cTimeline as typeof D2cTimeline, 'seq', {
    where: {
      sessionId,
      kind: 'stage',
      'displayPayload.action': 'message_queue',
      ...(options.runId ? { 'displayPayload.targetRunId': options.runId } : {}),
    },
    order: [['seq', 'ASC']],
    transaction,
    ...(transaction && options.lock !== false ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const states = new Map<string, QueueState>();
  for (const row of rows) {
    const item = row.displayPayload as QueueState;
    states.set(item.queueId, item);
  }
  return [...states.values()];
}

/** Public pending items exclude internal attachment metadata and delivery routing. */
function publicItem(item: QueueState): QueueItem {
  return {
    queueId: item.queueId,
    clientRequestId: item.clientRequestId,
    content: item.content,
    ...(item.actorUserId !== undefined ? { actorUserId: item.actorUserId } : {}),
    ...(item.attachmentIds?.length ? { attachmentIds: item.attachmentIds } : {}),
    createdAt: item.createdAt,
    status: item.status as QueueItem['status'],
  };
}

/** Queue state is committed under the same workspace/session locks as normal messages and leases. */
export function createMessageQueueService(
  mysql: Sequelize,
  options: {
    readConfig: () => unknown;
    notify?: (id: string, seq: number) => void;
  },
) {
  const runs = mysql.models.D2cRun as typeof D2cRun;
  const messages = createMessageService(mysql, options);
  let promotionCursor = '';
  /** Notify only after the queue event and any Run/message have committed. */
  async function save(session: D2cSession, transaction: Transaction, item: QueueState) {
    const seq = await appendSessionEvent(mysql, session, transaction, {
      kind: 'stage',
      displayPayload: { ...item },
    });
    transaction.afterCommit(() => {
      try {
        options.notify?.(session.sessionId!, seq);
      } catch {}
    });
  }
  /** An occupied session must never be implicitly resumed or treated as a question answer. */
  async function active(session: D2cSession, transaction: Transaction) {
    return runs.findOne({
      where: {
        sessionId: session.sessionId,
        ...(session.activeRunId
          ? { runId: session.activeRunId }
          : { status: { [Op.notIn]: ['succeeded', 'cancelled', 'failed'] } }),
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }
  /** Freeze and enqueue one item atomically; a failed dispatch leaves the item pending. */
  async function dispatch(
    workspace: D2cWorkspace,
    session: D2cSession,
    transaction: Transaction,
    item: QueueState,
  ) {
    const userId = item.actorUserId ?? workspace.createdUserId!;
    await ownedSession(mysql, userId, session.sessionId!, transaction);
    await messages.enqueue(userId, session.sessionId!, item, undefined, {
      transaction,
      messageId: item.queueId,
      attachments: item.attachments ?? [],
    });
    const current = await (mysql.models.D2cSession as typeof D2cSession).findOne({
      where: { sessionId: session.sessionId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    await save(current!, transaction, { ...item, status: 'delivered' });
  }
  /** Running guidance targets that exact Run; idle send-now becomes a normal durable Run. */
  async function send(
    workspace: D2cWorkspace,
    session: D2cSession,
    transaction: Transaction,
    item: QueueState,
  ) {
    const actorUserId = item.actorUserId ?? workspace.createdUserId!;
    await ownedSession(mysql, actorUserId, session.sessionId!, transaction);
    const run = await active(session, transaction);
    if (run) {
      if (!sameUser(actorUserId, (run.requestedUserId ?? workspace.createdUserId)!))
        throw new SessionError(
          409,
          'GUIDANCE_ACTOR_MISMATCH',
          '只有当前轮次发起人的消息可以立即指导，请保留普通排队消息',
        );
      if (!['running', 'queued'].includes(run.status!) || run.stopRequested || run.cancelRequested)
        throw new SessionError(
          409,
          'GUIDANCE_NOT_AVAILABLE',
          '当前轮次无法接收指导，请保留排队消息',
        );
      if (item.status === 'guidance_pending' && item.targetRunId === run.runId)
        return publicItem(item);
      item = { ...item, status: 'guidance_pending', targetRunId: run.runId! };
      await save(session, transaction, item);
    } else {
      await dispatch(workspace, session, transaction, item);
    }
    return publicItem(item);
  }
  return {
    /** Ownership is checked even when the queue is empty. */
    async list(userId: string, sessionId: string) {
      return mysql.transaction(async (transaction) => {
        await ownedSession(mysql, userId, sessionId, transaction, 'read');
        return {
          items: (await readMessageQueue(mysql, sessionId, transaction, { lock: false }))
            .filter((item) => ['queued', 'guidance_pending'].includes(item.status))
            .map(publicItem),
        };
      });
    },
    /** Preserve raw text, bind attachments now, and retain idempotency after delivery/deletion. */
    async enqueue(
      userId: string,
      sessionId: string,
      input: MessageInput & { mode: 'queue' | 'guidance' },
    ) {
      validateInput(input);
      if (!['queue', 'guidance'].includes(input.mode))
        throw new SessionError(422, 'INVALID_INPUT', '消息模式无效');
      return mysql.transaction(async (transaction) => {
        const { workspace, session } = await ownedSession(mysql, userId, sessionId, transaction);
        const items = await readMessageQueue(mysql, sessionId, transaction);
        const prior = items.find((item) => item.clientRequestId === input.clientRequestId);
        if (prior) {
          if (
            (prior.actorUserId ?? workspace.createdUserId) !== userId ||
            prior.content !== input.content ||
            prior.mode !== input.mode ||
            JSON.stringify(prior.attachmentIds ?? []) !== JSON.stringify(input.attachmentIds ?? [])
          )
            throw new SessionError(409, 'REQUEST_CONFLICT', '相同请求标识不能提交不同消息');
          if (prior.status === 'deleted' || prior.status === 'delivered')
            return publicItem({
              ...prior,
              status: prior.targetRunId ? 'guidance_pending' : 'queued',
            });
          return publicItem(prior);
        }
        if (
          await runs.findOne({
            where: { sessionId, clientRequestId: input.clientRequestId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        )
          throw new SessionError(409, 'REQUEST_CONFLICT', '请求标识已用于执行轮次');
        if (
          items.filter((item) => ['queued', 'guidance_pending'].includes(item.status)).length >=
          messageQueueLimit
        )
          throw new SessionError(409, 'MESSAGE_QUEUE_FULL', '排队消息最多 32 条');
        const runtime = parseD2cRuntimeConfig(options.readConfig());
        if (runtime.modelConfigs.some((model) => input.content.includes(model.MODEL_API_KEY)))
          throw new SessionError(422, 'INVALID_MESSAGE', '请勿在聊天中提交密钥');
        const queueId = randomUUID();
        const attachments = await linkMessageAttachments(
          mysql,
          userId,
          sessionId,
          queueId,
          input.attachmentIds ?? [],
          transaction,
        );
        const item: QueueState = {
          ...input,
          actorUserId: userId,
          action: 'message_queue',
          queueId,
          createdAt: new Date().toISOString(),
          status: 'queued',
          attachments,
        };
        if (input.mode === 'guidance') return send(workspace, session, transaction, item);
        await save(session, transaction, item);
        return publicItem(item);
      });
    },
    /** Deletion and delivery serialize on the session lock; a consumed message cannot be retracted. */
    async remove(userId: string, sessionId: string, queueId: string) {
      requireIdentifier(queueId);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const item = (await readMessageQueue(mysql, sessionId, transaction)).find(
          (item) => item.queueId === queueId,
        );
        if (!item) throw new SessionError(404, 'QUEUE_ITEM_NOT_FOUND', '排队消息不存在');
        if (item.status === 'delivered')
          throw new SessionError(409, 'QUEUE_ITEM_FINALIZED', '该消息已发送');
        if (item.status !== 'deleted')
          await save(session, transaction, { ...item, status: 'deleted' });
        return { queueId, deleted: true };
      });
    },
    /** Repeated send-now does not create a second run or guidance event. */
    async sendNow(userId: string, sessionId: string, queueId: string) {
      requireIdentifier(queueId);
      return mysql.transaction(async (transaction) => {
        const { workspace, session } = await ownedSession(mysql, userId, sessionId, transaction);
        const item = (await readMessageQueue(mysql, sessionId, transaction)).find(
          (item) => item.queueId === queueId,
        );
        if (!item) throw new SessionError(404, 'QUEUE_ITEM_NOT_FOUND', '排队消息不存在');
        if (item.status === 'deleted')
          throw new SessionError(409, 'QUEUE_ITEM_FINALIZED', '该消息已删除');
        if (item.status === 'delivered')
          return publicItem({ ...item, status: item.targetRunId ? 'guidance_pending' : 'queued' });
        return send(workspace, session, transaction, item);
      });
    },
    /** Existing worker ticks discover persisted queues across browser/process restarts. */
    async promote(limit = 20) {
      const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
      /** Scan only persisted queue events. The cursor bounds each tick and wraps after exhaustion. */
      const candidates = await findOrderedRows(timeline, 'entryId', {
        where: {
          kind: 'stage',
          'displayPayload.action': 'message_queue',
          'displayPayload.status': { [Op.in]: ['queued', 'guidance_pending'] },
          entryId: { [Op.gt]: promotionCursor },
        },
        attributes: ['entryId', 'sessionId', 'seq', 'displayPayload'],
        order: [['entryId', 'ASC']],
        limit,
      });
      promotionCursor = candidates.at(-1)?.entryId ?? '';
      const visited = new Set<string>();
      for (const event of candidates) {
        if (!event.sessionId || visited.has(event.sessionId)) continue;
        /** Historical pending events may have a later tombstone. Skip those before any owner/row locks. */
        const latestEvent = await timeline.findOne({
          where: {
            sessionId: event.sessionId,
            kind: 'stage',
            'displayPayload.action': 'message_queue',
            'displayPayload.queueId': event.displayPayload!.queueId,
          },
          attributes: ['seq'],
          order: [['seq', 'DESC']],
        });
        if (latestEvent?.seq !== event.seq) continue;
        visited.add(event.sessionId);
        const candidate = await (mysql.models.D2cSession as typeof D2cSession).findOne({
          where: { sessionId: event.sessionId },
          attributes: ['sessionId', 'workspaceId', 'activeRunId'],
        });
        if (!candidate || candidate.activeRunId) continue;
        try {
          await mysql.transaction(async (transaction) => {
            /** Worker 先按既有锁序锁定队列容器；每条投递仍以真实发起人重新授权。 */
            const workspace = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
              where: { workspaceId: candidate.workspaceId },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!workspace) return;
            const session = await (mysql.models.D2cSession as typeof D2cSession).findOne({
              where: { sessionId: candidate.sessionId, workspaceId: workspace.workspaceId },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!session) return;
            if (session.activeRunId || (await active(session, transaction))) return;
            const latest = await findOrderedOne(runs, 'runId', {
              where: { sessionId: session.sessionId },
              order: [
                ['createdAt', 'DESC'],
                ['id', 'DESC'],
              ],
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (latest && !['succeeded', 'cancelled'].includes(latest.status!)) return;
            const pending = (await readMessageQueue(mysql, session.sessionId!, transaction)).filter(
              (item) => item.status === 'queued' || item.status === 'guidance_pending',
            );
            for (const item of pending) {
              try {
                await ownedSession(
                  mysql,
                  item.actorUserId ?? workspace.createdUserId!,
                  session.sessionId!,
                  transaction,
                );
              } catch (error) {
                if (!(error instanceof SessionError) || ![403, 404].includes(error.statusCode))
                  throw error;
                /** 撤权消息追加既有取消终态，保留原文、身份和请求标识，并继续 FIFO。 */
                await save(session, transaction, { ...item, status: 'deleted' });
                continue;
              }
              await dispatch(workspace, session, transaction, item);
              break;
            }
          });
        } catch (error) {
          if (!(error instanceof SessionError)) throw error;
          /** 配置或执行状态错误回滚本次调度，保留原事件供后续重试。 */
        }
      }
    },
  };
}

/** Consume at a ROOT beforeModel node, replaying delivered inputs absent from its checkpoint watermark. */
export async function consumeRunGuidance(
  mysql: Sequelize,
  leases: ReturnType<typeof createRunLeases>,
  lease: RunLease,
  applied: string[],
  notify: (id: string, seq: number) => void,
) {
  return leases.commit(
    lease,
    async (session, transaction) => {
      const run = await (mysql.models.D2cRun as typeof D2cRun).findOne({
        where: { runId: lease.runId, sessionId: lease.sessionId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (run?.status !== 'running' || run.stopRequested || run.cancelRequested) return [];
      const items = (
        await readMessageQueue(mysql, lease.sessionId, transaction, { runId: lease.runId })
      ).filter(
        (item) =>
          item.targetRunId === lease.runId &&
          item.status !== 'deleted' &&
          !applied.includes(item.queueId),
      );
      const result: Array<{ id: string; message: StoredAgentMessage }> = [];
      const workspace = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
        where: { workspaceId: session.workspaceId },
        transaction,
      });
      const runActorUserId = run.requestedUserId ?? workspace?.createdUserId;
      for (const item of items) {
        /** 租约已持有写锁；只读复查发起人权限，不改变既有工作区→会话锁序。 */
        const actorUserId = item.actorUserId ?? workspace?.createdUserId;
        if (!actorUserId || !runActorUserId || !sameUser(actorUserId, runActorUserId)) continue;
        try {
          await ownedSession(mysql, actorUserId, lease.sessionId, transaction, 'read');
        } catch (error) {
          if (error instanceof SessionError && [403, 404].includes(error.statusCode)) continue;
          throw error;
        }
        const message: StoredAgentMessage = {
          role: 'user',
          id: item.queueId,
          content: item.attachments?.length
            ? [
                { type: 'input_text', text: item.content },
                ...item.attachments.map((attachment) => ({
                  type: 'input_image' as const,
                  attachmentId: String(attachment.attachmentId),
                })),
              ]
            : item.content,
        };
        if (item.status === 'guidance_pending') {
          await appendSessionEvent(mysql, session, transaction, {
            kind: 'message',
            runId: lease.runId,
            messageId: item.queueId,
            sdkItem: message,
            displayPayload: {
              role: 'user',
              authorUserId: actorUserId,
              text: item.content,
              ...(item.attachments?.length ? { attachments: item.attachments } : {}),
            },
          });
          const seq = await appendSessionEvent(mysql, session, transaction, {
            kind: 'stage',
            displayPayload: { ...item, status: 'delivered' },
          });
          transaction.afterCommit(() => {
            try {
              notify(lease.sessionId, seq);
            } catch {}
          });
        }
        result.push({ id: item.queueId, message });
      }
      return result;
    },
    { retryDeadlocks: true },
  );
}
