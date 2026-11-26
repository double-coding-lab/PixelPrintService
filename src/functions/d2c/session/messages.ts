import { createModelCredentialService } from '../credential/model';
import { findOrderedOne } from '../utils/orderedRead';
import { automaticRecoveryPlan } from '../run/automaticRecovery';
import { readMessageQueue } from './queue';
import { linkMessageAttachments, validateAttachmentIds } from './attachments';
import { pendingInteractionSchema } from '../run/interaction';
import { parseD2cRuntimeConfig } from '@/config/d2c';
import type { D2cCredential } from '@/models/D2cCredential';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { D2cWorkspaceRevision } from '@/models/D2cWorkspaceRevision';
import type { StoredAgentMessage } from '../run/types';
import { randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import { createConfigSnapshot, parseWorkspaceConfigs } from '../utils/config';
import { ownedSession, requireIdentifier, requireRevision, SessionError } from './access';
import { appendSessionEvent } from './service';
import { repairToolHistory } from '../run/history';

export const messageMaxBytes = 65536;
export type MessageInput = { clientRequestId: string; content: string; attachmentIds?: string[] };

/** 消息按原文保存；仅拒绝空白、非法 UTF-8 和超额内容，不自动改写代码缩进。 */
export function validateInput(input: MessageInput) {
  requireIdentifier(input.clientRequestId);
  const attachmentIds = validateAttachmentIds(input.attachmentIds);
  if (typeof input.content === 'string' && /\bfigd_[a-zA-Z0-9_-]{16,}/.test(input.content))
    throw new SessionError(
      422,
      'INVALID_MESSAGE',
      '请通过 Figma 凭据入口保存 Token，不要发送到聊天',
    );
  if (
    typeof input.content !== 'string' ||
    (!input.content.trim() && !attachmentIds.length) ||
    input.content.includes('\0') ||
    Buffer.from(input.content).toString('utf8') !== input.content ||
    Buffer.byteLength(input.content) > messageMaxBytes
  )
    throw new SessionError(422, 'INVALID_MESSAGE', '消息不能为空且须为不超过 64 KiB 的有效文本');
}

/** 请求及运行摘要只投影页面所需字段，配置、模型参数和私有检查点不返回。 */
function runSummary(run: D2cRun, messageId: string) {
  return { runId: run.runId!, messageId, status: run.status, stage: run.stage };
}

/**
 * 将用户消息、固定执行快照和排队轮次原子保存至 MySQL，供后台 Worker 后续领取。
 * 请求以会话内 clientRequestId 幂等；返回数据只含页面摘要，不含凭据或私有配置。
 * @param options 当前运行配置读取器及可选的事务提交后通知回调。
 * @returns 消息入队与未领取轮次取消接口；创建服务不会调用模型。
 */
export function createMessageService(
  mysql: Sequelize,
  options: { readConfig: () => unknown; notify?: (sessionId: string, seq: number) => void },
) {
  const runs = mysql.models.D2cRun as typeof D2cRun;
  const timeline = mysql.models.D2cTimeline as typeof D2cTimeline;
  const revisions = mysql.models.D2cWorkspaceRevision as typeof D2cWorkspaceRevision;
  const credentials = mysql.models.D2cCredential as typeof D2cCredential;
  if (!runs || !timeline || !revisions || !credentials)
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '消息模型尚未注册');

  /** 唤醒只在提交后发生，通知不可用不改变消息或取消结果。 */
  function afterCommit(transaction: Transaction, sessionId: string, seq: number) {
    if (options.notify)
      transaction.afterCommit(() => {
        try {
          options.notify!(sessionId, seq);
        } catch {
          /** 辅助通知失败由数据库补读兜底。 */
        }
      });
  }

  /** 幂等重试读取已存原消息；同一请求 ID 携带不同正文返回冲突。 */
  async function original(
    run: D2cRun,
    transaction: Transaction,
    content?: string,
    attachmentIds?: string[],
  ) {
    const entry = await findOrderedOne(timeline, 'seq', {
      where: {
        sessionId: run.sessionId,
        runId: run.runId,
        kind: { [Op.in]: ['message', 'stage'] },
      },
      order: [['seq', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const data = entry?.displayPayload;
    const continuation =
      entry?.kind === 'stage' &&
      data?.action === 'resume' &&
      !!run.resumeFromRunId &&
      entry.sdkItem?.role === 'user';
    const originalText = continuation ? entry?.sdkItem?.content : data?.text;
    if (
      !entry?.messageId ||
      (!continuation && data?.role !== 'user') ||
      typeof originalText !== 'string'
    )
      throw new SessionError(503, 'MESSAGE_CORRUPT', '已保存的请求记录不完整');
    if (content !== undefined && content !== originalText)
      throw new SessionError(409, 'REQUEST_CONFLICT', '相同请求标识不能提交不同消息');
    if (attachmentIds !== undefined) {
      const originalIds = Array.isArray(data?.attachments)
        ? data.attachments.map((attachment: { attachmentId: string }) => attachment.attachmentId)
        : [];
      if (JSON.stringify(originalIds) !== JSON.stringify(attachmentIds))
        throw new SessionError(409, 'REQUEST_CONFLICT', '相同请求标识不能提交不同附件');
    }
    return entry.messageId;
  }

  /** 取消已执行过的提问轮次前，在同一事务内关闭未配对调用，不重新执行工具。 */
  async function closePendingQuestion(
    run: D2cRun,
    session: Parameters<typeof repairToolHistory>[1],
    transaction: Transaction,
  ) {
    if (!run.pendingInteraction) return;
    await run.update({ status: 'interrupted' }, { transaction });
    await repairToolHistory(mysql, session, transaction, run.runId!);
  }

  const service = {
    /**
     * 校验消息后按工作区→会话锁序检查归属，在同一事务内保存消息、排队事件及 activeRunId。
     * 幂等命中先核对原文并返回原轮次，不受后来的繁忙状态或配置变化影响。
     * @returns 已保存轮次与消息的公开摘要；同请求 ID 不同正文或会话繁忙时返回冲突错误。
     */
    async enqueue(
      userId: string,
      sessionId: string,
      input: MessageInput,
      resumeFromRunId?: string,
      queued?: {
        transaction: Transaction;
        messageId: string;
        attachments: Awaited<ReturnType<typeof linkMessageAttachments>>;
      },
      automatic = false,
      transaction?: Transaction,
    ) {
      validateInput(input);
      const action = async (transaction: Transaction) => {
        const { workspace, session } = await ownedSession(mysql, userId, sessionId, transaction);
        const prior = await runs.findOne({
          where: { sessionId, clientRequestId: input.clientRequestId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior) {
          if (prior.requestedUserId && prior.requestedUserId !== userId)
            throw new SessionError(409, 'REQUEST_CONFLICT', '请求标识已由其他成员使用');
          if ((prior.resumeFromRunId ?? undefined) !== resumeFromRunId)
            throw new SessionError(409, 'REQUEST_CONFLICT', '请求标识已用于其他轮次');
          return runSummary(
            prior,
            await original(prior, transaction, input.content, input.attachmentIds ?? []),
          );
        }
        if (!queued && !resumeFromRunId) {
          const pending = await readMessageQueue(mysql, sessionId, transaction);
          if (pending.some((item) => item.clientRequestId === input.clientRequestId))
            throw new SessionError(409, 'REQUEST_CONFLICT', '请求标识已用于排队消息');
          if (pending.some((item) => ['queued', 'guidance_pending'].includes(item.status)))
            throw new SessionError(
              409,
              'MESSAGE_QUEUE_PENDING',
              '请先处理排队消息或将新消息加入队列',
            );
        }
        let recovery: ReturnType<typeof automaticRecoveryPlan> = null;
        if (resumeFromRunId) {
          const previous = await runs.findOne({
            where: { runId: resumeFromRunId, sessionId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!previous) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
          if (
            previous.status !== 'interrupted' ||
            previous.leaseOwner !== null ||
            previous.leaseExpiresAt !== null ||
            session.activeRunId !== resumeFromRunId
          )
            throw new SessionError(
              409,
              'RUN_NOT_INTERRUPTED',
              '只能继续当前已中断且租约已释放的轮次',
            );
          if (automatic) {
            recovery = automaticRecoveryPlan(previous);
            if (!recovery)
              throw new SessionError(409, 'AUTO_RECOVERY_BLOCKED', '当前中断不符合自动恢复条件');
          }
          if (
            previous.resourceRevisionId !== workspace.activeResourceRevisionId ||
            previous.configRevision !== workspace.configRevision
          )
            throw new SessionError(
              409,
              'RESUME_INPUT_CHANGED',
              '工作区资源或配置已改变，请先结束中断轮次，再发送新消息',
            );
          await repairToolHistory(mysql, session, transaction, resumeFromRunId);
          await previous.update(
            { status: 'cancelled', stage: 'cancelled', cancelRequested: true },
            { transaction },
          );
          await appendSessionEvent(mysql, session, transaction, {
            runId: resumeFromRunId,
            kind: 'run_status',
            displayPayload: { status: 'cancelled' },
          });
          await session.update({ activeRunId: null }, { transaction });
        }
        /** activeRunId 与未结束记录双重阻止新轮次；中断记录也必须先被明确处理。 */
        if (
          session.activeRunId ||
          (await runs.findOne({
            where: { sessionId, status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] } },
            transaction,
            lock: transaction.LOCK.UPDATE,
          }))
        )
          throw new SessionError(409, 'SESSION_BUSY', '请先完成或明确结束当前轮次再发送消息');
        if (workspace.status !== 'ready' || !workspace.activeResourceRevisionId)
          throw new SessionError(409, 'WORKSPACE_NOT_READY', '工作区尚未就绪');
        if (session.target !== 'h5' && session.target !== 'rn')
          throw new SessionError(503, 'SESSION_CORRUPT', '会话目标无效');
        requireRevision(session.fileRevision);
        requireRevision(session.timelineSeq);
        if (session.timelineSeq > 4294967291)
          throw new SessionError(409, 'REVISION_EXHAUSTED', '会话事件序号已达到上限');
        /** 固定就绪资源并验证本人有效凭据，仅保存凭据 ID，不在入队过程中解密。 */
        const resource = await revisions.findOne({
          where: {
            workspaceId: workspace.workspaceId,
            resourceRevisionId: workspace.activeResourceRevisionId,
            status: 'ready',
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !resource?.bundleObject ||
          typeof resource.bundleObject !== 'object' ||
          Array.isArray(resource.bundleObject) ||
          !Object.keys(resource.bundleObject).length ||
          !/^[a-f0-9]{64}$/.test(resource.bundleHash ?? '')
        )
          throw new SessionError(503, 'RESOURCE_UNAVAILABLE', '工作区资源修订不可用');
        let credentialId = session.credentialId;
        if (credentialId || workspace.teamId) {
          let credential = credentialId
            ? await credentials.findOne({
                where: {
                  credentialId,
                  kind: 'figma',
                  status: 'active',
                },
                transaction,
                lock: transaction.LOCK.UPDATE,
              })
            : null;
          /** 团队共享会话不共享个人凭据，改由当前发起人的有效凭据执行。 */
          if (credential?.ownerUserId !== userId)
            credential = await findOrderedOne(credentials, 'credentialId', {
              where: { ownerUserId: userId, kind: 'figma', status: 'active' },
              order: [['revision', 'DESC']],
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
          if (
            credentialId &&
            (!credential || credential.ownerUserId !== userId || credential.status !== 'active')
          )
            throw new SessionError(422, 'CREDENTIAL_UNAVAILABLE', '请先配置本人的有效 Figma 凭据');
          credentialId = credential?.credentialId ?? null;
        }
        /** 配置快照和执行限额在入队时冻结；模型密钥只参与敏感内容检查，不写快照。 */
        let configSnapshot;
        try {
          configSnapshot = createConfigSnapshot(
            parseWorkspaceConfigs(workspace.configJson),
            session.target,
            workspace.configRevision,
            workspace.activeResourceRevisionId,
          );
        } catch {
          throw new SessionError(422, 'INVALID_CONFIG', '工作区生成配置或修订无效');
        }
        let runtime;
        try {
          runtime = parseD2cRuntimeConfig(options.readConfig());
        } catch {
          throw new SessionError(503, 'RUNTIME_UNAVAILABLE', 'RuntimeConfig 执行参数尚未就绪');
        }
        let model = runtime.modelConfigs[0];
        let modelCredentialId = session.modelCredentialId ?? null;
        // 首条消息前允许保存个人设置；之后会话固定原修订，恢复也不换模型。
        if (!modelCredentialId && !recovery && session.timelineSeq === 0) {
          const latest = await findOrderedOne(credentials, 'credentialId', {
            where: { ownerUserId: userId, kind: 'model', status: 'active' },
            attributes: ['credentialId'],
            order: [['revision', 'DESC']],
            transaction,
          });
          if (latest?.credentialId) {
            modelCredentialId = latest.credentialId;
            await session.update({ modelCredentialId }, { transaction });
          }
        }
        if (modelCredentialId) {
          const credential = await credentials.findOne({
            where: {
              credentialId: modelCredentialId,
              ownerUserId: userId,
              kind: 'model',
              status: 'active',
            },
            attributes: ['credentialId', 'ownerUserId', 'kind', 'status'],
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (
            !credential ||
            credential.ownerUserId !== userId ||
            credential.kind !== 'model' ||
            credential.status !== 'active' ||
            credential.credentialId !== modelCredentialId
          )
            throw new SessionError(
              422,
              'MODEL_CREDENTIAL_UNAVAILABLE',
              '请先配置本人的有效模型连接',
            );
          let personalToken;
          try {
            const personalCredentials = createModelCredentialService(
              mysql,
              () => runtime.d2c.secrets,
              () => runtime.modelConfigs,
            );
            model = {
              ...model,
              ...(await personalCredentials.getConnection(userId, modelCredentialId, transaction)),
            };
            personalToken = await personalCredentials.getToken(
              userId,
              modelCredentialId,
              model,
              transaction,
            );
          } catch {
            throw new SessionError(
              422,
              'MODEL_CREDENTIAL_UNAVAILABLE',
              '本会话绑定的模型凭据不可用',
            );
          }
          if (input.content.includes(personalToken))
            throw new SessionError(422, 'INVALID_MESSAGE', '请勿在聊天中提交密钥');
        }
        if (
          recovery &&
          ((recovery.modelSnapshot as Record<string, unknown>).modelCredentialId ?? null) !==
            modelCredentialId
        )
          throw new SessionError(
            422,
            'MODEL_CREDENTIAL_UNAVAILABLE',
            '恢复轮次的模型凭据绑定不一致',
          );
        if (runtime.modelConfigs.some((entry) => input.content.includes(entry.MODEL_API_KEY)))
          throw new SessionError(
            422,
            'INVALID_MESSAGE',
            '请勿在聊天中提交密钥，请使用配置或凭据入口',
          );
        const runId = randomUUID(),
          messageId = queued?.messageId ?? randomUUID();
        const run = await runs.create(
          {
            runId,
            sessionId,
            requestedUserId: userId,
            clientRequestId: input.clientRequestId,
            status: 'queued',
            stage: 'queued',
            resourceRevisionId: workspace.activeResourceRevisionId,
            configRevision: workspace.configRevision,
            configSnapshot,
            modelSnapshot: recovery?.modelSnapshot ?? {
              ...(modelCredentialId ? { modelCredentialId } : {}),
              MODEL_BASE_URL: model.MODEL_BASE_URL,
              MODEL_NAME: model.MODEL_NAME,
              contextBudgetTokens: model.contextBudgetTokens,
              requestTimeoutMs: model.requestTimeoutMs ?? 180000,
              ...(model.reasoningPolicy !== undefined
                ? { reasoningPolicy: model.reasoningPolicy }
                : {}),
              maxTurns: runtime.d2c.execution.maxTurns,
              runTimeoutMs: runtime.d2c.execution.runTimeoutMs,
            },
            credentialId,
            baseFileRevision: session.fileRevision,
            resumeFromRunId: resumeFromRunId ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            stopRequested: false,
            cancelRequested: false,
            checkpoint: recovery ? { automaticRecoveryAttempts: recovery.attempts } : null,
            pendingInteraction: null,
            error: null,
            usage: null,
          },
          { transaction },
        );
        /** 普通消息公开原文；继续操作仅公开状态，恢复指引留在私有SDK输入中。 */
        const attachments =
          queued?.attachments ??
          (await linkMessageAttachments(
            mysql,
            userId,
            sessionId,
            messageId,
            input.attachmentIds ?? [],
            transaction,
          ));
        const sdkItem = {
          role: 'user',
          content: attachments.length
            ? [
                { type: 'input_text', text: input.content },
                ...attachments.map(({ attachmentId }) => ({
                  type: 'input_image' as const,
                  attachmentId,
                })),
              ]
            : input.content,
        } satisfies StoredAgentMessage;
        const inputSeq = await appendSessionEvent(mysql, session, transaction, {
          runId,
          kind: resumeFromRunId ? 'stage' : 'message',
          messageId,
          sdkItem,
          displayPayload: resumeFromRunId
            ? {
                action: 'resume',
                status: 'queued',
                stage: 'queued',
                ...(automatic ? { automatic: true } : {}),
              }
            : {
                role: 'user',
                authorUserId: userId,
                text: input.content,
                ...(attachments.length ? { attachments } : {}),
              },
        });
        const seq = resumeFromRunId
          ? inputSeq
          : await appendSessionEvent(mysql, session, transaction, {
              runId,
              kind: 'stage',
              displayPayload: { status: 'queued', stage: 'queued' },
            });
        await session.update({ activeRunId: runId }, { transaction });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, messageId);
      };
      return queued
        ? action(queued.transaction)
        : transaction
          ? action(transaction)
          : mysql.transaction(action);
    },

    /** 本人回答持久问题后重新排队原轮次，HTTP不直接调用模型；同请求标识幂等。 */
    async answer(
      userId: string,
      sessionId: string,
      input: { runId: string; questionId: string; clientRequestId: string; answer: string },
    ) {
      requireIdentifier(input.runId);
      requireIdentifier(input.questionId);
      validateInput({ clientRequestId: input.clientRequestId, content: input.answer });
      return mysql.transaction(async (transaction) => {
        const { workspace, session } = await ownedSession(mysql, userId, sessionId, transaction);
        const run = await runs.findOne({
          where: { runId: input.runId, sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
        const prior = await timeline.findOne({
          where: {
            sessionId,
            runId: input.runId,
            kind: 'message',
            messageId: input.clientRequestId,
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior) {
          if (
            prior.displayPayload?.questionId !== input.questionId ||
            prior.displayPayload?.text !== input.answer ||
            (prior.displayPayload?.authorUserId && prior.displayPayload.authorUserId !== userId) ||
            prior.sdkItem !== null
          )
            throw new SessionError(409, 'REQUEST_CONFLICT', '相同请求标识不能提交不同回答');
          return runSummary(run, input.clientRequestId);
        }
        const parsed = pendingInteractionSchema.safeParse(run.pendingInteraction);
        if (
          run.status !== 'waiting_input' ||
          session.activeRunId !== run.runId ||
          run.leaseOwner !== null ||
          run.leaseExpiresAt !== null ||
          !parsed.success ||
          parsed.data.state !== 'waiting' ||
          parsed.data.questionId !== input.questionId
        )
          throw new SessionError(
            409,
            'QUESTION_NOT_PENDING',
            '该问题已处理或当前没有等待回答的问题，请刷新会话',
          );
        if (
          workspace.status !== 'ready' ||
          workspace.activeResourceRevisionId !== run.resourceRevisionId ||
          workspace.configRevision !== run.configRevision ||
          session.fileRevision !== run.baseFileRevision
        )
          throw new SessionError(
            409,
            'RESUME_INPUT_CHANGED',
            '等待期间资源或文件已改变，请结束本轮后重新发送消息',
          );
        const runtime = parseD2cRuntimeConfig(options.readConfig());
        if (run.modelSnapshot?.modelCredentialId) {
          let token;
          try {
            if (
              run.requestedUserId !== userId ||
              run.modelSnapshot.modelCredentialId !== session.modelCredentialId
            )
              throw new Error();
            token = await createModelCredentialService(
              mysql,
              () => runtime.d2c.secrets,
              () => runtime.modelConfigs,
            ).getToken(userId, String(run.modelSnapshot.modelCredentialId), undefined, transaction);
          } catch {
            throw new SessionError(
              422,
              'MODEL_CREDENTIAL_UNAVAILABLE',
              '本会话绑定的模型凭据不可用',
            );
          }
          if (input.answer.includes(token))
            throw new SessionError(422, 'INVALID_MESSAGE', '请勿在回答中提交密钥');
        }
        if (runtime.modelConfigs.some((model) => input.answer.includes(model.MODEL_API_KEY)))
          throw new SessionError(422, 'INVALID_MESSAGE', '请勿在回答中提交密钥');
        await appendSessionEvent(mysql, session, transaction, {
          runId: input.runId,
          kind: 'message',
          messageId: input.clientRequestId,
          displayPayload: {
            role: 'user',
            authorUserId: userId,
            text: input.answer,
            questionId: input.questionId,
          },
        });
        await run.update(
          {
            status: 'queued',
            stage: 'queued',
            pendingInteraction: {
              ...parsed.data,
              state: 'answered',
              answer: input.answer,
              clientRequestId: input.clientRequestId,
            },
            heartbeatAt: null,
            stopRequested: false,
            cancelRequested: false,
          },
          { transaction },
        );
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId: input.runId,
          kind: 'stage',
          displayPayload: { status: 'queued', stage: 'queued' },
        });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, input.clientRequestId);
      });
    },

    /** 放弃当前问题时结束等待并释放会话，既有文件和历史保留。 */
    async endWaiting(userId: string, sessionId: string, runId: string, questionId: string) {
      requireIdentifier(runId);
      requireIdentifier(questionId);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const run = await runs.findOne({
          where: { runId, sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
        if (run.status === 'cancelled') return runSummary(run, await original(run, transaction));
        const parsed = pendingInteractionSchema.safeParse(run.pendingInteraction);
        if (
          run.status !== 'waiting_input' ||
          session.activeRunId !== runId ||
          run.leaseOwner !== null ||
          run.leaseExpiresAt !== null ||
          !parsed.success ||
          parsed.data.state !== 'waiting' ||
          parsed.data.questionId !== questionId
        )
          throw new SessionError(409, 'QUESTION_NOT_PENDING', '仅支持结束当前等待回答的问题');
        await closePendingQuestion(run, session, transaction);
        await run.update(
          {
            status: 'cancelled',
            stage: 'cancelled',
            pendingInteraction: null,
            cancelRequested: true,
          },
          { transaction },
        );
        await session.update({ activeRunId: null }, { transaction });
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId,
          kind: 'run_status',
          displayPayload: { status: 'cancelled' },
        });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, await original(run, transaction));
      });
    },

    /** 持久停止请求；排队任务直接取消，执行中任务由现有租约/心跳协作中止。 */
    async requestStop(userId: string, sessionId: string, runId: string) {
      requireIdentifier(runId);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const run = await runs.findOne({
          where: { runId, sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
        const messageId = await original(run, transaction);
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status))
          return runSummary(run, messageId);
        if (session.activeRunId !== runId)
          throw new SessionError(409, 'RUN_CONFLICT', '会话当前轮次已改变');
        if (run.status === 'stopping') return runSummary(run, messageId);
        if (!['queued', 'running'].includes(run.status))
          throw new SessionError(409, 'INVALID_RUN_STATUS', '当前轮次不能停止');
        const status = run.status === 'queued' ? 'cancelled' : 'stopping';
        if (status === 'cancelled') await closePendingQuestion(run, session, transaction);
        await run.update(
          {
            status,
            stage: status,
            stopRequested: true,
            ...(status === 'cancelled' ? { cancelRequested: true, pendingInteraction: null } : {}),
          },
          { transaction },
        );
        if (status === 'cancelled') await session.update({ activeRunId: null }, { transaction });
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId,
          kind: 'run_status',
          displayPayload: { status },
        });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, messageId);
      });
    },

    /** 用户继续时开启关联原轮次的新Run；旧执行不会被强行重放，请求标识保证网络重试幂等。 */
    async resume(
      userId: string,
      sessionId: string,
      runId: string,
      clientRequestId: string,
    ): Promise<ReturnType<typeof runSummary>> {
      requireIdentifier(runId);
      return service.enqueue(
        userId,
        sessionId,
        {
          clientRequestId,
          content:
            '继续当前任务。先核对已保存文件和工具结果，保留既有产物，不重复执行结果未知的副作用；按当前会话上下文继续。',
        },
        runId,
      );
    },

    /** 后台恢复沿用用户继续的事务与权限检查，稳定请求标识避免多实例重复续作。 */
    async automaticallyResume(userId: string, sessionId: string, runId: string) {
      return service.enqueue(
        userId,
        sessionId,
        {
          clientRequestId: `auto-${runId}`,
          content:
            '继续当前任务。先核对已保存文件和工具结果，保留既有产物，不重复执行结果未知的副作用；按当前会话上下文继续。',
        },
        runId,
        undefined,
        true,
      );
    },

    /**
     * 用户明确结束已中断的轮次：补齐未知工具结果、记为取消并释放会话。
     * 仅允许无租约的 interrupted，历史、文件与原始错误保留；重复请求不影响新轮次。
     */
    async endInterrupted(userId: string, sessionId: string, runId: string) {
      requireIdentifier(runId);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const run = await runs.findOne({
          where: { runId, sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
        const messageId = await original(run, transaction);
        if (run.status === 'cancelled') return runSummary(run, messageId);
        if (run.status !== 'interrupted' || run.leaseOwner !== null || run.leaseExpiresAt !== null)
          throw new SessionError(409, 'RUN_NOT_INTERRUPTED', '仅支持结束已中断且租约已释放的轮次');
        if (session.activeRunId !== runId)
          throw new SessionError(409, 'RUN_CONFLICT', '会话当前轮次已改变');
        /** 先以中断状态补记结果，再取消；同事务回滚避免留下无法回放的历史。 */
        await repairToolHistory(mysql, session, transaction, runId);
        await run.update(
          { status: 'cancelled', stage: 'cancelled', cancelRequested: true },
          { transaction },
        );
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId,
          kind: 'run_status',
          displayPayload: { status: 'cancelled' },
        });
        await session.update({ activeRunId: null }, { transaction });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, messageId);
      });
    },

    /**
     * 仅取消没有租约/心跳痕迹且仍占用会话的 queued 轮次，已取消请求幂等返回。
     * 与领取共用锁序，取消状态、事件和会话解锁原子提交；不处理运行中轮次的停止。
     */
    async cancelQueued(userId: string, sessionId: string, runId: string) {
      requireIdentifier(runId);
      return mysql.transaction(async (transaction) => {
        const { session } = await ownedSession(mysql, userId, sessionId, transaction);
        const run = await runs.findOne({
          where: { runId, sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(404, 'RUN_NOT_FOUND', '执行轮次不存在');
        const messageId = await original(run, transaction);
        if (run.status === 'cancelled') return runSummary(run, messageId);
        if (
          run.status !== 'queued' ||
          run.leaseOwner !== null ||
          run.leaseExpiresAt !== null ||
          run.heartbeatAt !== null
        )
          throw new SessionError(409, 'RUN_NOT_QUEUED', '仅支持取消尚未领取的排队轮次');
        if (session.activeRunId !== runId)
          throw new SessionError(409, 'RUN_CONFLICT', '会话当前轮次已改变');
        await closePendingQuestion(run, session, transaction);
        await run.update(
          {
            pendingInteraction: null,
            status: 'cancelled',
            stage: 'cancelled',
            cancelRequested: true,
          },
          {
            transaction,
          },
        );
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId,
          kind: 'stage',
          displayPayload: { status: 'cancelled', stage: 'cancelled' },
        });
        await session.update({ activeRunId: null }, { transaction });
        afterCommit(transaction, sessionId, seq);
        return runSummary(run, messageId);
      });
    },
  };
  return service;
}

export type MessageService = ReturnType<typeof createMessageService>;
