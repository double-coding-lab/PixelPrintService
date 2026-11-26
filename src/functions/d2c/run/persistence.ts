import { binaryMimeType } from '../utils/binaryMimeType';
import { findOrderedRows } from '../utils/orderedRead';
import { decisionInstructions } from './decisions';
import { modelActivitySchema, type ModelActivity } from './agent/modelActivity';
import { updateModelUsage } from './agent/usage';
import { pendingInteractionSchema } from './interaction';
import type { D2cTimeline } from '@/models/D2cTimeline';
import type { AgentTextSnapshot } from './agent/textStream';
import { sliceProgressSchema, type SliceProgress } from './sliceProgress';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sequelize, Transaction } from 'sequelize';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cCredential } from '@/models/D2cCredential';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { D2cWorkspaceRevision } from '@/models/D2cWorkspaceRevision';
import type { D2cFile } from '@/models/D2cFile';
import { appendFileEvent, appendSessionEvent } from '../session/service';
import { ownedWorkspace, SessionError } from '../session/access';
import { isExecutionDocument, assertArtifactPath, normalizeRelativePath } from '../utils/paths';
import { createRunLeases, type RunLease } from './leases';
import type { ExecutionFile } from './workspace';
import type { AgentRecord } from './types';
import { subagentEventSchema, type SubagentEvent } from './subagent';
import { repairToolHistory, replayHistory } from './history';
import { describeToolActivity } from './toolActivity';
import { readToolFeedback } from './toolFeedback';
import { figmaSessionName } from '../session/name';
import {
  contentModel,
  copyTextStorage,
  prepareTextContent,
  resolveTextContent,
} from '../content/runtime';
export { replayHistory } from './history';

const modelSchema = z
  .object({
    modelCredentialId: z.string().min(1).max(64).optional(),
    MODEL_BASE_URL: z.string().url(),
    MODEL_NAME: z.string().min(1),
    contextBudgetTokens: z.number().int().positive(),
    requestTimeoutMs: z.number().int().min(1000).max(600000).default(180000),
    reasoningPolicy: z.enum(['adaptive', 'provider-default']).optional(),
    /** 兼容旧快照；单次输出上限已交由模型网关决定，读取时丢弃。 */
    maxOutputTokens: z.unknown().optional(),
    maxTurns: z.number().int().positive(),
    /** 兼容数据库中的旧快照；读取时丢弃已停用的检查次数配置。 */
    maxRepairRounds: z.unknown().optional(),
    runTimeoutMs: z.number().int().positive(),
  })
  .strict()
  .transform(({ maxRepairRounds: _legacy, maxOutputTokens: _legacyOutput, ...model }) => model);

/**
 * 为单次租约提供固定输入读取、私有 SDK 历史、稳定文件及执行检查点的数据库边界。
 * 所有写入复用 leases.commit；文件内容/定位、修订、校验失效和展示事件原子提交。
 * @param options 文件限额、提交后唤醒回调和本轮敏感材料脱敏器。
 * @returns 有状态的持久化接口；必须先 load 建立文件修订基线再提交文件或完成检查点。
 */
export function createRunPersistence(
  mysql: Sequelize,
  leases: ReturnType<typeof createRunLeases>,
  lease: RunLease,
  options: {
    signal?: AbortSignal;
    limits: { textFileBytes: number; filesPerSession: number };
    notify: (id: string, seq: number) => void;
    redact: (value: string) => string;
  },
) {
  const runs = mysql.models.D2cRun as typeof D2cRun;
  const files = contentModel(mysql, mysql.models.D2cFile as typeof D2cFile);
  let fileRevision: number | undefined;
  /** 仅重试数据库回调；外部正文准备和本地修订基线更新均在事务之外。 */
  function commit<T>(write: (session: D2cSession, transaction: Transaction) => Promise<T>) {
    return leases.commit(lease, write, { retryDeadlocks: true, signal: options.signal });
  }
  /** 通知失败只影响实时性，不能回滚已保存的执行结果。 */
  function notify(session: D2cSession, transaction: Transaction) {
    const seq = session.timelineSeq;
    transaction.afterCommit(() => {
      try {
        options.notify(session.sessionId!, seq);
      } catch {
        /** 数据库补读兜底。 */
      }
    });
  }
  /** 对所有后续写入核对本执行器最后一次提交的稳定文件修订。 */
  function current(session: D2cSession) {
    if (fileRevision === undefined || fileRevision !== session.fileRevision)
      throw new Error('稳定文件修订冲突');
  }
  const persistence = {
    /** 在租约事务中只更新默认会话名称，事件与标题同时提交，重复读取不反复改名。 */
    async nameFromFigma(nodeName: string) {
      await commit(async (session, transaction) => {
        const name = figmaSessionName(session.name, session.target!, options.redact(nodeName));
        if (!name) return;
        await session.update({ name }, { transaction });
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'session_changed',
          displayPayload: { name },
        });
        notify(session, transaction);
      });
    },
    /**
     * 在同一租约事务内读取固定资源修订、配置、模型快照、稳定文件和完整配对历史。
     * 资源/配置关联及基础文件修订不一致时拒绝执行；外部下载与凭据解密交给执行器。
     * @returns 不含模型密钥或 Figma 明文 Token 的恢复输入，同时记录本地文件修订基线。
     */
    async load() {
      fileRevision = undefined;
      let baseline: number | undefined;
      const loaded = await commit(async (session, transaction) => {
        const run = await runs.findOne({
          where: { runId: lease.runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const workspace = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
          where: { workspaceId: session.workspaceId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const revision = await (
          mysql.models.D2cWorkspaceRevision as typeof D2cWorkspaceRevision
        ).findOne({
          where: {
            workspaceId: session.workspaceId,
            resourceRevisionId: run?.resourceRevisionId,
            status: 'ready',
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (
          !run ||
          !workspace?.createdUserId ||
          !revision?.bundleObject ||
          !revision.bundleHash ||
          run.baseFileRevision !== session.fileRevision ||
          !run.configSnapshot ||
          run.configSnapshot.target !== session.target ||
          run.configSnapshot.resourceRevisionId !== run.resourceRevisionId ||
          run.configSnapshot.configRevision !== run.configRevision
        )
          throw new Error('固定执行输入不完整');
        /** 入队后成员可能已被移除；执行前复查身份，不能因持有历史 Run 而借用凭据。 */
        if (run.requestedUserId)
          await ownedWorkspace(
            mysql,
            run.requestedUserId,
            session.workspaceId!,
            transaction,
            'read',
          );
        /** 多取一条检测文件数量超限；时间线必须按 seq 回放，不能按显示类型裁剪历史。 */
        const rows = await files.findAll({
          where: { sessionId: session.sessionId },
          transaction,
          lock: transaction.LOCK.UPDATE,
          limit: options.limits.filesPerSession + 1,
        });
        if (rows.length > options.limits.filesPerSession) throw new Error('文件数量超限');
        /** 旧失败轮次可能只保存了调用；在本轮租约事务内补记未知结果，不重放副作用。 */
        const interaction = run.pendingInteraction
          ? pendingInteractionSchema.parse(run.pendingInteraction)
          : null;
        if (interaction && (interaction.state !== 'answered' || !interaction.answer))
          throw new Error('DEEP_CHECKPOINT_RESUME_INVALID');
        const { entries, repaired } = interaction
          ? {
              entries: await findOrderedRows(
                mysql.models.D2cTimeline as typeof D2cTimeline,
                'seq',
                {
                  where: { sessionId: session.sessionId },
                  order: [['seq', 'ASC']],
                  transaction,
                  lock: transaction.LOCK.UPDATE,
                },
              ),
              repaired: false,
            }
          : await repairToolHistory(mysql, session, transaction);
        if (repaired) notify(session, transaction);
        const incoming = entries.find(
          (entry) => entry.runId === lease.runId && entry.sdkItem?.role === 'user',
        );
        if (
          !incoming?.messageId ||
          !(
            typeof incoming.sdkItem?.content === 'string' ||
            Array.isArray(incoming.sdkItem?.content)
          )
        )
          throw new Error('本轮用户消息不完整');
        baseline = session.fileRevision;
        /** 兼容旧确认阻塞：仅迁移在同配置资源轮次中实际保存的完整切图清单。 */
        const legacy = rows.filter(
          (file) =>
            file.kind === 'internal' &&
            /\/slice-manifest-[a-z0-9-]+\.json$/.test(file.path ?? '') &&
            !rows.some(
              (candidate) =>
                candidate.path === file.path!.replace('/slice-manifest-', '/slice-evidence-'),
            ),
        );
        const blocked = legacy.length
          ? await findOrderedRows(runs, 'runId', {
              where: {
                sessionId: lease.sessionId,
                resourceRevisionId: run.resourceRevisionId,
                status: 'failed',
              },
              order: [['updatedAt', 'DESC']],
              limit: 20,
              transaction,
              lock: transaction.LOCK.UPDATE,
            })
          : [];
        const reusableLegacyManifests = legacy
          .filter((file) => {
            const modified = new Date(file.updatedAt).getTime();
            return blocked.some((previous) => {
              const failure = previous.error?.failure as Record<string, unknown> | undefined;
              return (
                failure?.code === 'CONFIRMATION_REQUIRED' &&
                failure.tool === 'prepare_slices' &&
                previous.configSnapshot?.hash === run.configSnapshot?.hash &&
                previous.configSnapshot?.target === run.configSnapshot?.target &&
                modified >= new Date(previous.createdAt).getTime() &&
                modified <= new Date(previous.updatedAt).getTime()
              );
            });
          })
          .map((file) => file.path!);
        const model = modelSchema.parse(run.modelSnapshot);
        if (workspace.teamId && model.modelCredentialId) {
          /** 新团队选择必须有明确发起人及本人有效凭据，不能只跳过会话绑定校验。 */
          const credentialOwner =
            run.requestedUserId ??
            (model.modelCredentialId === session.modelCredentialId
              ? workspace.createdUserId
              : null);
          const credential = credentialOwner
            ? await (mysql.models.D2cCredential as typeof D2cCredential).findOne({
                where: {
                  credentialId: model.modelCredentialId,
                  ownerUserId: credentialOwner,
                  kind: 'model',
                  status: 'active',
                },
                transaction,
              })
            : null;
          if (
            !credential ||
            credential.credentialId !== model.modelCredentialId ||
            credential.ownerUserId !== credentialOwner ||
            credential.kind !== 'model' ||
            credential.status !== 'active'
          )
            throw new Error('固定模型凭据绑定不一致');
        } else if ((session.modelCredentialId ?? null) !== (model.modelCredentialId ?? null)) {
          /** 个人及旧的无凭据团队快照继续执行原绑定规则。 */
          throw new Error('固定模型凭据绑定不一致');
        }
        return {
          message: {
            id: incoming.messageId,
            content: incoming.sdkItem.content as
              | string
              | Array<import('./types').StoredTextBlock | import('./types').StoredImageBlock>,
          },
          reusableLegacyManifests,
          resumeFromRunId: run.resumeFromRunId,
          ownerUserId: run.requestedUserId ?? workspace.createdUserId,
          figmaUrl: session.figmaUrl,
          credentialId: run.credentialId,
          resourceRevisionId: run.resourceRevisionId!,
          configSnapshot: structuredClone(run.configSnapshot),
          model,
          bundleHash: revision.bundleHash,
          bundleObject: structuredClone(revision.bundleObject),
          files: (await Promise.all(
            rows.map(async (row) => ({
              path: row.path,
              kind: row.kind,
              content: row.objectLocator
                ? null
                : await resolveTextContent(mysql, row, `session:${lease.sessionId}`),
              objectLocator: row.objectLocator,
              size: row.size,
              sha256: row.sha256,
            })),
          )) as ExecutionFile[],
          history: interaction ? [] : replayHistory(entries),
          userDecisions: decisionInstructions(entries),
          interaction,
          priorUsage: interaction ? (run.usage ?? undefined) : undefined,
          sourceChangedByUser: run.checkpoint?.sourceChangedByUser === true,
        };
      });
      fileRevision = baseline;
      return loaded;
    },

    /**
     * 追加一个 SDK 新条目：脱敏后的 sdkItem 存入私有历史，消息/工具展示字段单独投影。
     * 由调用方按 SDK 新增流逐项传入；本方法不按 callId 去重，也不追加整份 history。
     * 超限条目在事务前拒绝，记录失败向上传播并使执行器停止。
     */
    async record(entry: AgentRecord) {
      const serialized = JSON.stringify(entry.sdkItem);
      const safeItem = JSON.parse(options.redact(serialized)) as Record<string, unknown>;
      if (Buffer.byteLength(JSON.stringify(safeItem)) > options.limits.textFileBytes)
        throw new Error('执行条目过大');
      await commit(async (session, transaction) => {
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: entry.kind,
          messageId: entry.kind === 'message' ? randomUUID() : undefined,
          toolCallId: entry.callId,
          sdkItem: safeItem,
          displayPayload:
            entry.kind === 'message'
              ? {
                  role: 'assistant',
                  text: options.redact(entry.text ?? '').slice(0, 65536),
                  ...(entry.streamId ? { streamId: entry.streamId } : {}),
                }
              : {
                  callId: entry.callId!,
                  ...(entry.name ? { name: entry.name } : {}),
                  ...(entry.kind === 'tool_call' ? { detail: describeToolActivity(safeItem) } : {}),
                  ...(entry.kind === 'tool_result'
                    ? { feedback: readToolFeedback(safeItem.output) }
                    : {}),
                  status:
                    entry.kind === 'tool_call'
                      ? 'started'
                      : safeItem.status === 'error'
                        ? 'failed'
                        : 'completed',
                },
        });
        notify(session, transaction);
        return seq;
      });
    },

    /** 模型生命周期只存白名单元数据，复用租约事务和提交后通知。 */
    async recordModelActivity(entry: ModelActivity) {
      const displayPayload = modelActivitySchema.parse(entry);
      await commit(async (session, transaction) => {
        const messageId = `${entry.operationId}:${entry.status === 'started' ? 'start' : 'finish'}`;
        const prior = await (mysql.models.D2cTimeline as typeof D2cTimeline).findOne({
          where: {
            sessionId: lease.sessionId,
            runId: lease.runId,
            kind: 'model_status',
            messageId,
          },
          transaction,
        });
        if (prior) return;
        const run = await runs.findOne({
          where: { runId: lease.runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(409, 'LEASE_LOST', '执行租约失效');
        await run.update({ usage: updateModelUsage(run.usage, displayPayload) }, { transaction });
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'model_status',
          messageId,
          displayPayload,
        });
        notify(session, transaction);
      });
    },

    /** 合并后的正文快照只写展示记录，跨实例SSE与断线补读复用原有提交后通知。 */
    async recordText(entry: AgentTextSnapshot) {
      await commit(async (session, transaction) => {
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: entry.channel === 'reasoning' ? 'reasoning_delta' : 'text_delta',
          messageId: entry.streamId,
          displayPayload: {
            streamId: entry.streamId,
            text: options.redact(entry.text),
            status: entry.status,
          },
        });
        notify(session, transaction);
      });
    },

    /** 切图进度只进入展示时间线，不参与模型工具历史回放。 */
    async recordProgress(entry: SliceProgress) {
      const displayPayload = sliceProgressSchema.parse(entry);
      await commit(async (session, transaction) => {
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'stage',
          displayPayload,
        });
        notify(session, transaction);
      });
    },
    /** 专家过程作为纯展示事件保存，不混入主 Agent 的 SDK 工具调用配对历史。 */
    async recordSubagent(entry: SubagentEvent) {
      const displayPayload = subagentEventSchema.parse(
        JSON.parse(options.redact(JSON.stringify(entry))),
      );
      await commit(async (session, transaction) => {
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'stage',
          displayPayload,
        });
        notify(session, transaction);
      });
    },

    /**
     * 将源码或 .d2c-cache 内部文本保存到 MySQL；拒绝敏感材料、非法路径和超限内容。
     * 相同内容不增加修订；实际变更同时使会话校验过期，源码额外追加 file_changed 事件。
     * @param kind source 受产物路径规则约束，internal 允许执行缓存及 Skill 执行清单。
     */
    async write(relative: string, content: string, kind: 'source' | 'internal' = 'source') {
      if (
        normalizeRelativePath(relative) !== relative ||
        Buffer.byteLength(relative) > 1024 ||
        (kind === 'source'
          ? assertArtifactPath(relative) !== relative
          : !relative.startsWith('.d2c-cache/') && !isExecutionDocument(relative))
      )
        throw new Error('文件路径无效');
      if (
        options.redact(relative) !== relative ||
        options.redact(content) !== content ||
        content.includes('\0') ||
        Buffer.from(content).toString('utf8') !== content ||
        Buffer.byteLength(content) > options.limits.textFileBytes
      )
        throw new Error('文件内容无效或含敏感材料');
      /** 先短事务核验租约与基线，再在锁外准备对象；真正写入时再次检查租约。 */
      const original = await commit(async (session, transaction) => {
        current(session);
        const prior = await files.findOne({
          where: {
            sessionId: lease.sessionId,
            pathHash: createHash('sha256').update(relative).digest('hex'),
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior && (prior.path !== relative || prior.kind !== kind || prior.objectLocator))
          throw new Error('文件类型或路径冲突');
        return prior
          ? {
              content: prior.content,
              contentRef: prior.contentRef,
              size: prior.size,
              sha256: prior.sha256,
              revision: prior.revision,
              fileId: prior.fileId,
            }
          : null;
      });
      const unchanged =
        original !== null &&
        (await resolveTextContent(mysql, original, `session:${lease.sessionId}`)) === content;
      const storage = unchanged
        ? copyTextStorage(mysql, original!)
        : await prepareTextContent(mysql, `session:${lease.sessionId}`, content);
      await commit(async (session, transaction) => {
        current(session);
        const pathHash = createHash('sha256').update(relative).digest('hex');
        /** hash 仅用于索引定位，命中后仍核对完整路径和存储类型，防止覆盖其他文件。 */
        const prior = await files.findOne({
          where: { sessionId: lease.sessionId, pathHash },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior && (prior.path !== relative || prior.kind !== kind || prior.objectLocator))
          throw new Error('文件类型或路径冲突');
        if (
          prior &&
          (await resolveTextContent(mysql, prior, `session:${lease.sessionId}`)) === content
        )
          return session.fileRevision;
        if (
          (prior === null) !== (original === null) ||
          (prior && (prior.revision !== original?.revision || prior.fileId !== original?.fileId))
        )
          throw new Error('稳定文件修订冲突');
        if (
          !prior &&
          (await files.count({ where: { sessionId: lease.sessionId }, transaction })) >=
            options.limits.filesPerSession
        )
          throw new Error('文件数量超限');
        const revision = (prior?.revision ?? 0) + 1;
        if (revision > 4294967294 || session.fileRevision >= 4294967294)
          throw new Error('文件修订已耗尽');
        const values = {
          ...storage,
          size: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
          revision,
        };
        const row = prior
          ? await prior.update(values, { transaction })
          : await files.create(
              {
                fileId: randomUUID(),
                sessionId: lease.sessionId,
                path: relative,
                pathHash,
                kind,
                objectLocator: null,
                mimeType: 'text/plain; charset=utf-8',
                ...values,
              },
              { transaction },
            );
        /** 文件及会话修订、校验状态和事件共用事务，任何一步失败均不产生部分保存。 */
        await session.update(
          { fileRevision: session.fileRevision + 1, validationState: { status: 'stale' } },
          { transaction },
        );
        if (kind === 'source')
          await appendFileEvent(mysql, session, transaction, {
            action: prior ? 'updated' : 'created',
            fileId: row.fileId!,
            path: relative,
            revision,
            fileRevision: session.fileRevision,
          });
        notify(session, transaction);
        return session.fileRevision;
      }).then((revision) => {
        /** 仅在事务已提交后推进本执行器的修订基线，回滚不能更新本地记账。 */
        fileRevision = revision;
      });
    },

    /**
     * 保存已上传二进制的不可变定位、字节数和摘要，数据库不保存二进制正文。
     * 相同摘要及大小视为无变化；事务失败不回滚先前外部上传，也不会登记新定位。
     * @param objectLocator 可信存储返回的下载定位，后续恢复时仍须核对实际字节及摘要。
     */
    async writeBinary(relative: string, content: Buffer, objectLocator: Record<string, unknown>) {
      if (
        assertArtifactPath(relative) !== relative ||
        Buffer.byteLength(relative) > 1024 ||
        options.redact(relative) !== relative
      )
        throw new Error('资源路径无效');
      const sha256 = createHash('sha256').update(content).digest('hex');
      await commit(async (session, transaction) => {
        current(session);
        const pathHash = createHash('sha256').update(relative).digest('hex');
        const prior = await files.findOne({
          where: { sessionId: lease.sessionId, pathHash },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (prior && (prior.path !== relative || prior.kind !== 'asset'))
          throw new Error('资源类型冲突');
        if (prior?.sha256 === sha256 && prior.size === content.length) {
          const clean = copyTextStorage(mysql, { content: null });
          const mimeType = binaryMimeType(objectLocator, prior.mimeType);
          if (prior.mimeType !== mimeType || ('contentRef' in clean && prior.contentRef != null))
            await prior.update({ ...clean, mimeType }, { transaction });
          return session.fileRevision;
        }
        if (
          !prior &&
          (await files.count({ where: { sessionId: lease.sessionId }, transaction })) >=
            options.limits.filesPerSession
        )
          throw new Error('文件数量超限');
        const revision = (prior?.revision ?? 0) + 1;
        if (revision > 4294967294 || session.fileRevision >= 4294967294)
          throw new Error('文件修订已耗尽');
        const values = {
          ...copyTextStorage(mysql, { content: null }),
          objectLocator,
          mimeType: binaryMimeType(objectLocator),
          size: content.length,
          sha256,
          revision,
        };
        const row = prior
          ? await prior.update(values, { transaction })
          : await files.create(
              {
                fileId: randomUUID(),
                sessionId: lease.sessionId,
                path: relative,
                pathHash,
                kind: 'asset',
                ...values,
              },
              { transaction },
            );
        await session.update(
          { fileRevision: session.fileRevision + 1, validationState: { status: 'stale' } },
          { transaction },
        );
        await appendFileEvent(mysql, session, transaction, {
          action: prior ? 'updated' : 'created',
          fileId: row.fileId!,
          path: relative,
          revision,
          fileRevision: session.fileRevision,
        });
        notify(session, transaction);
        return session.fileRevision;
      }).then((revision) => {
        fileRevision = revision;
      });
    },

    /** 删除与文件事件、会话修订同事务；失去租约的旧实例不能提交。 */
    async remove(relative: string) {
      assertArtifactPath(relative);
      await commit(async (session, transaction) => {
        current(session);
        const row = await files.findOne({
          where: {
            sessionId: lease.sessionId,
            pathHash: createHash('sha256').update(relative).digest('hex'),
          },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!row || row.path !== relative)
          throw new SessionError(404, 'FILE_NOT_FOUND', '文件不存在');
        if (row.kind !== 'source')
          throw new SessionError(422, 'FILE_DELETE_NOT_ALLOWED', '仅允许删除源码文件');
        if (session.fileRevision >= 4294967294) throw new Error('文件修订已耗尽');
        await row.destroy({ transaction });
        await session.update(
          { fileRevision: session.fileRevision + 1, validationState: { status: 'stale' } },
          { transaction },
        );
        await appendFileEvent(mysql, session, transaction, {
          action: 'deleted',
          fileId: row.fileId!,
          path: relative,
          revision: row.revision,
          fileRevision: session.fileRevision,
        });
        notify(session, transaction);
        return session.fileRevision;
      }).then((revision) => {
        fileRevision = revision;
      });
    },

    /**
     * 在当前文件修订上保存实际用量、文件/时间线检查点及可选的真实校验结论。
     * 只读提问省略 validation，保留已有产物的校验状态，不伪造本轮规则通过。
     * 这里只更新 MySQL 执行元数据，不追加完成事件或改变轮次终态；结算由执行器另行调用。
     */
    async complete(usage: Record<string, unknown>, validation?: Record<string, unknown>) {
      await commit(async (session, transaction) => {
        current(session);
        const run = await runs.findOne({
          where: { runId: lease.runId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!run) throw new SessionError(409, 'LEASE_LOST', '执行租约失效');
        await run.update(
          {
            usage: run.usage?.trackingVersion === 1 ? run.usage : usage,
            pendingInteraction: null,
            checkpoint: {
              ...run.checkpoint,
              fileRevision: session.fileRevision,
              timelineSeq: session.timelineSeq,
            },
          },
          { transaction },
        );
        if (validation) await session.update({ validationState: validation }, { transaction });
      });
    },
  };
  let commitQueue: Promise<unknown> = Promise.resolve();
  /** 串行提交本实例的操作及提交后修订记账；失败仍交还调用方，不阻塞后续租约检查。 */
  function serial<Args extends unknown[], Result>(
    action: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => {
      const pending = commitQueue.then(() => action(...args));
      commitQueue = pending.catch(() => {});
      return pending;
    };
  }
  return {
    nameFromFigma: serial(persistence.nameFromFigma),
    load: serial(persistence.load),
    record: serial(persistence.record),
    recordModelActivity: serial(persistence.recordModelActivity),
    recordText: serial(persistence.recordText),
    recordProgress: serial(persistence.recordProgress),
    recordSubagent: serial(persistence.recordSubagent),
    write: serial(persistence.write),
    writeBinary: serial(persistence.writeBinary),
    remove: serial(persistence.remove),
    complete: serial(persistence.complete),
  };
}
