import {
  pendingInteractionSchema,
  userQuestionSchema,
  type PendingInteraction,
} from './interaction';
import { randomUUID } from 'node:crypto';
import { Op, QueryTypes, type Sequelize, type Transaction } from 'sequelize';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import { requireIdentifier, SessionError } from '../session/access';
import { appendSessionEvent } from '../session/service';
import { runFailureSchema, type RunFailure } from './errors';
import { repairToolHistory } from './history';

const maxTimelineSeq = 4294967294;

export type RunLease = { runId: string; sessionId: string; owner: string };
type Outcome = 'succeeded' | 'failed' | 'interrupted';
type Reason = 'EXECUTION_FAILED' | 'WORKER_INTERRUPTED' | 'LEASE_EXPIRED' | 'SNAPSHOT_CONFLICT';

/**
 * 协调排队轮次的领取、续租、稳定写入与结算，所有权限判断均在数据库锁内复查。
 * 使用数据库时钟避免实例时钟偏差；这里只改变数据库状态，不执行或重放工具副作用。
 *
 * @param mysql 已注册轮次、会话、工作区和时间线模型的数据库连接。
 * @param options 租期、可选全局并发限额、提交后通知及测试时钟。
 * @returns 共享同一锁序和租约资格判断的协调接口。
 */
export function createRunLeases(
  mysql: Sequelize,
  options: {
    leaseMs: number;
    /** 正式消费者必须传入全局并发限额；公共工作区锚点行锁串行化所有领取。 */
    concurrency?: number;
    notify?: (sessionId: string, seq: number) => void;
    /** 离线测试可注入时钟，正式装配使用默认数据库时间，避免实例时钟偏差。 */
    now?: (transaction?: Transaction) => Promise<number>;
  },
) {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 3000)
    throw new SessionError(503, 'INVALID_LEASE', '执行租约配置无效');
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 32)
  )
    throw new SessionError(503, 'INVALID_CONCURRENCY', '执行并发配置无效');
  const runs = mysql.models.D2cRun as typeof D2cRun;
  const sessions = mysql.models.D2cSession as typeof D2cSession;
  const workspaces = mysql.models.D2cWorkspace as typeof D2cWorkspace;
  if (!runs || !sessions || !workspaces || !mysql.models.D2cTimeline)
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '执行协调模型尚未注册');

  /** 时间取自数据库；原始连接错误不进入公开状态或时间线。 */
  async function now(transaction?: Transaction) {
    try {
      const value = options.now
        ? await options.now(transaction)
        : Number(
            (
              await mysql.query<{ nowMs: number | string }>(
                'SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS nowMs',
                { type: QueryTypes.SELECT, transaction },
              )
            )[0]?.nowMs,
          );
      if (!Number.isSafeInteger(value) || value <= 0 || value + options.leaseMs > 8640000000000000)
        throw new Error();
      return value;
    } catch {
      throw new SessionError(503, 'CLOCK_UNAVAILABLE', '执行数据库时钟不可用');
    }
  }

  /** 仅识别可重试的事务锁冲突；连接、时钟和业务资格故障不能按锁争用吞掉。 */
  function isLockConflict(error: unknown) {
    const failure = error as {
      original?: { code?: unknown };
      parent?: { code?: unknown };
      code?: unknown;
    };
    const code = failure?.original?.code ?? failure?.parent?.code ?? failure?.code;
    return code === 'ER_LOCK_WAIT_TIMEOUT' || code === 'ER_LOCK_DEADLOCK';
  }

  /** 已核对有效 owner 后，在当前短事务内记录执行进展，沿用原租期和数据库时间。 */
  async function renew(run: D2cRun, transaction: Transaction, time: number) {
    /** 同一数据库毫秒内已完成续租时无需再更新该行，减少并行检查和短提交的写争用。 */
    if (
      run.heartbeatAt?.getTime() === time &&
      run.leaseExpiresAt?.getTime() === time + options.leaseMs
    )
      return;
    await run.update(
      { heartbeatAt: new Date(time), leaseExpiresAt: new Date(time + options.leaseMs) },
      { transaction },
    );
  }

  /**
   * 先用无锁候选定位工作区，再在事务内按工作区→会话→轮次加锁并重读。
   * 领取准入额外先锁全局锚点；任一定位记录不存在时返回 null，不调用 action。
   *
   * @param admission 是否串行化全实例领取并检查正在运行/停止的总数。
   * @returns action 的事务结果，或记录不可用、配额已满时的 null。
   */
  async function locked<T>(
    runId: string,
    action: (
      run: D2cRun,
      session: D2cSession,
      workspace: D2cWorkspace,
      transaction: Transaction,
    ) => Promise<T>,
    admission = false,
  ): Promise<T | null> {
    requireIdentifier(runId);
    const candidate = await runs.findOne({ where: { runId } });
    if (!candidate?.sessionId) return null;
    const initial = await sessions.findOne({ where: { sessionId: candidate.sessionId } });
    if (!initial?.workspaceId) return null;
    return mysql.transaction(async (transaction) => {
      if (admission && options.concurrency !== undefined) {
        /** 固定首行作为全实例领取互斥锚点；软删除保留该行，禁止直接物理清理。 */
        const anchor = await workspaces.findOne({
          attributes: ['workspaceId'],
          order: [['id', 'ASC']],
          /** 软删除仍保留准入锚点，不能随工作区隐藏而更换全局锁。 */
          paranoid: false,
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!anchor) return null;
        /** 已过期但尚未回收的运行记录仍计入配额，避免靠忽略租约抢占并发。 */
        const active = await runs.count({
          where: { status: { [Op.in]: ['running', 'stopping'] } },
          transaction,
        });
        if (active >= options.concurrency) return null;
      }
      const workspace = await workspaces.findOne({
        where: { workspaceId: initial.workspaceId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!workspace) return null;
      const session = await sessions.findOne({
        where: { sessionId: candidate.sessionId, workspaceId: workspace.workspaceId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!session) return null;
      const run = await runs.findOne({
        where: { runId, sessionId: session.sessionId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!run) return null;
      return action(run, session, workspace, transaction);
    });
  }

  /** 提交后仅发唤醒提示；辅助通知失败不回滚状态。 */
  function notify(transaction: Transaction, sessionId: string, seq: number) {
    transaction.afterCommit(() => {
      try {
        options.notify?.(sessionId, seq);
      } catch {
        /** 事件仍可通过数据库补读。 */
      }
    });
  }

  /** 状态和时间线同事务；中断保留 activeRunId，要求明确恢复或结束后再编辑。 */
  async function finish(
    run: D2cRun,
    session: D2cSession,
    transaction: Transaction,
    status: Outcome,
    reason?: Reason,
    failure?: RunFailure,
  ) {
    await run.update(
      {
        status,
        stage: status,
        leaseOwner: null,
        leaseExpiresAt: null,
        pendingInteraction: null,
        error: reason ? { reason, ...(failure ? { failure } : {}) } : null,
      },
      { transaction },
    );
    /** 已终止执行的缺失结果与终态一并保存；过期 owner 无权单独补写。 */
    if (status === 'failed' || status === 'interrupted')
      await repairToolHistory(mysql, session, transaction, run.runId!);
    if (status !== 'interrupted') await session.update({ activeRunId: null }, { transaction });
    const seq = await appendSessionEvent(mysql, session, transaction, {
      runId: run.runId!,
      kind: 'run_status',
      displayPayload: {
        status,
        ...(status === 'succeeded' && session.validationState
          ? { validation: session.validationState }
          : {}),
        ...(reason ? { reason } : {}),
        ...(failure ? { failure } : {}),
      },
    });
    notify(transaction, session.sessionId!, seq);
  }

  /** 会话当前轮次、随机 owner、运行状态和未过期时间须同时匹配，旧实例不能复用权限。 */
  function owns(run: D2cRun, session: D2cSession, lease: RunLease, time: number) {
    return (
      run.sessionId === lease.sessionId &&
      session.activeRunId === run.runId &&
      run.leaseOwner === lease.owner &&
      ['running', 'stopping'].includes(run.status) &&
      run.leaseExpiresAt instanceof Date &&
      run.leaseExpiresAt.getTime() > time
    );
  }

  /** 扫描有界，候选列表只提供定位；领取时必须在事务内复查。 */
  function limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100)
      throw new SessionError(422, 'INVALID_LIMIT', '轮次扫描数量无效');
    return value;
  }

  return {
    /** 此候选列表不是内存队列，重启后仍从 MySQL 的 queued 记录扫描。 */
    async pending(size = 20) {
      const rows = await runs.findAll({
        where: { status: 'queued' },
        attributes: ['runId'],
        order: [
          ['createdAt', 'ASC'],
          ['runId', 'ASC'],
        ],
        limit: limit(size),
      });
      return rows
        .map((row) => row.runId)
        .filter((id): id is string => typeof id === 'string' && !!id);
    },

    /**
     * 在全局准入及实体锁内将 queued 原子转换为 running，并写入状态事件。
     * @returns 含本次随机 owner 的租约；资格不符、配额已满或快照冲突时返回 null。
     */
    async claim(runId: string, workerId: string): Promise<RunLease | null> {
      requireIdentifier(workerId);
      return locked(
        runId,
        async (run, session, workspace, transaction) => {
          /** 仅允许无任何领取痕迹、未停止且仍是会话当前轮次的排队记录进入执行。 */
          if (
            run.status !== 'queued' ||
            session.activeRunId !== runId ||
            workspace.status !== 'ready' ||
            run.stopRequested ||
            run.cancelRequested ||
            run.leaseOwner !== null ||
            run.leaseExpiresAt !== null ||
            run.heartbeatAt !== null
          )
            return null;
          if (session.timelineSeq > maxTimelineSeq - 2)
            throw new SessionError(
              409,
              'REVISION_EXHAUSTED',
              '事件序号不足以记录本轮执行，请取消排队轮次',
            );
          /** 入队后资源或文件修订改变时直接失败，禁止用当前内容替换已固定的执行输入。 */
          if (
            run.resourceRevisionId !== workspace.activeResourceRevisionId ||
            run.baseFileRevision !== session.fileRevision ||
            !run.configSnapshot ||
            !run.modelSnapshot
          ) {
            await finish(run, session, transaction, 'failed', 'SNAPSHOT_CONFLICT');
            return null;
          }
          /** 租约和 running 事件同事务提交；只有提交后才通知 SSE 补读。 */
          const time = await now(transaction);
          const owner = `${workerId}:${randomUUID()}`;
          await run.update(
            {
              status: 'running',
              stage: 'starting',
              checkpoint: { ...run.checkpoint, executionStartedAt: new Date(time).toISOString() },
              leaseOwner: owner,
              heartbeatAt: new Date(time),
              leaseExpiresAt: new Date(time + options.leaseMs),
            },
            { transaction },
          );
          const seq = await appendSessionEvent(mysql, session, transaction, {
            runId,
            kind: 'run_status',
            displayPayload: { status: 'running' },
          });
          notify(transaction, session.sessionId!, seq);
          return { runId, sessionId: session.sessionId!, owner };
        },
        true,
      );
    },

    /**
     * 有效 owner 按数据库当前时间延长租期，同时读取停止/取消请求供执行器处理。
     * @returns 请求标记；过期、owner 失配或记录不可用时返回 null，不能复活旧租约。
     */
    async heartbeat(lease: RunLease) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await locked(lease.runId, async (run, session, _workspace, transaction) => {
            const time = await now(transaction);
            if (!owns(run, session, lease, time)) return null;
            await renew(run, transaction, time);
            return { stopRequested: run.stopRequested, cancelRequested: run.cancelRequested };
          });
        } catch (error) {
          /** 回滚后最多重试两次，每次重新加锁并核对当前时间，绝不复活过期租约。 */
          if (attempt >= 2 || !isLockConflict(error)) throw error;
        }
      }
    },

    /**
     * 把稳定写入放在租约锁事务内，写入前后均复查权限并预留结束事件序号。
     * @param write 仅执行本事务内的数据库操作，不能将外部副作用当作可回滚写入。
     * @returns write 的结果；写入中途租约到期或序号耗尽时抛错并回滚整个事务。
     */
    async commit<T>(
      lease: RunLease,
      write: (session: D2cSession, transaction: Transaction) => Promise<T>,
    ) {
      const result = await locked(lease.runId, async (run, session, _workspace, transaction) => {
        if (!owns(run, session, lease, await now(transaction)))
          throw new SessionError(409, 'LEASE_LOST', '执行租约已失效');
        const value = await write(session, transaction);
        if (session.timelineSeq >= maxTimelineSeq)
          throw new SessionError(409, 'REVISION_EXHAUSTED', '须保留轮次结束事件序号');
        const time = await now(transaction);
        if (!owns(run, session, lease, time))
          throw new SessionError(409, 'LEASE_LOST', '执行租约已失效');
        /** 持续的短写入也是存活证据，避免它们排挤周期心跳后反而让活跃 owner 失租。
         * 长事务必须先通过原到期时间校验；失败及回滚不留下续租，write 也不自动重放。
         */
        await renew(run, transaction, time);
        return { value };
      });
      if (!result) throw new SessionError(409, 'LEASE_LOST', '执行租约已失效');
      return result.value;
    },

    /** 检查点已保存后释放执行资格并等待业务答复，保留会话占用和当前文件修订。 */
    async waitForInput(lease: RunLease, value: PendingInteraction) {
      const interaction = pendingInteractionSchema.parse(value);
      return locked(lease.runId, async (run, session, _workspace, transaction) => {
        if (
          !owns(run, session, lease, await now(transaction)) ||
          run.stopRequested ||
          run.cancelRequested
        )
          return false;
        await run.update(
          {
            status: 'waiting_input',
            stage: 'waiting_input',
            pendingInteraction: interaction,
            baseFileRevision: session.fileRevision,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          },
          { transaction },
        );
        await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'user_question',
          displayPayload: {
            ...userQuestionSchema.parse(interaction),
            fileRevision: session.fileRevision,
          },
        });
        const seq = await appendSessionEvent(mysql, session, transaction, {
          runId: lease.runId,
          kind: 'run_status',
          displayPayload: { status: 'waiting_input' },
        });
        notify(transaction, session.sessionId!, seq);
        return true;
      });
    },

    /**
     * 以仍有效的租约提交终态和时间线；成功/失败释放 activeRunId，中断保留会话占用。
     * 调用方负责先完成实际执行和校验；存在停止请求时拒绝成功结算。
     * @returns 是否成功结算；权限已丢失或记录不存在时为 false。
     */
    async settle(lease: RunLease, status: Outcome, failure?: RunFailure) {
      if (!['succeeded', 'failed', 'interrupted'].includes(status))
        throw new SessionError(422, 'INVALID_RUN_STATUS', '轮次结束状态无效');
      /** 即使调用方传入任意文字，也只持久化固定原因表重建的公开诊断。 */
      const safeFailure =
        status !== 'succeeded' && failure ? runFailureSchema.parse(failure) : undefined;
      return Boolean(
        await locked(lease.runId, async (run, session, _workspace, transaction) => {
          if (!owns(run, session, lease, await now(transaction))) return false;
          if (status === 'succeeded' && (run.stopRequested || run.cancelRequested))
            throw new SessionError(409, 'STOP_PENDING', '停止请求尚未处理，不能标记成功');
          await finish(
            run,
            session,
            transaction,
            status,
            status === 'failed'
              ? 'EXECUTION_FAILED'
              : status === 'interrupted'
                ? 'WORKER_INTERRUPTED'
                : undefined,
            safeFailure,
          );
          return true;
        }),
      );
    },

    /**
     * 有界扫描过期或无到期时间的运行记录，在锁内重查状态和数据库时间后标记中断。
     * 保留稳定历史、文件及 activeRunId，不自动重排可能已有外部副作用的任务。
     * 锁等待或数据库死锁由事务回滚后跳过该候选，不阻断其他工作区；其他错误继续抛出。
     * @returns 本次实际回收数；扫描后已续期或遇锁的候选不会被计入。
     */
    async recoverExpired(size = 20, onLocked?: (runId: string, error: unknown) => void) {
      const time = await now();
      const rows = await runs.findAll({
        where: {
          status: { [Op.in]: ['running', 'stopping'] },
          [Op.or]: [{ leaseExpiresAt: { [Op.lte]: new Date(time) } }, { leaseExpiresAt: null }],
        },
        attributes: ['runId'],
        order: [
          ['createdAt', 'ASC'],
          ['runId', 'ASC'],
        ],
        limit: limit(size),
      });
      let count = 0;
      for (const row of rows) {
        if (!row.runId) continue;
        let recovered;
        try {
          recovered = await locked(row.runId, async (run, session, _workspace, transaction) => {
            if (!['running', 'stopping'].includes(run.status) || session.activeRunId !== run.runId)
              return false;
            if (
              run.leaseExpiresAt instanceof Date &&
              run.leaseExpiresAt.getTime() > (await now(transaction))
            )
              return false;
            await finish(run, session, transaction, 'interrupted', 'LEASE_EXPIRED');
            return true;
          });
        } catch (error) {
          if (!isLockConflict(error)) throw error;
          try {
            onLocked?.(row.runId, error);
          } catch {
            /** 日志回调失败不阻断其他候选回收。 */
          }
          continue;
        }
        if (recovered) count++;
      }
      return count;
    },
  };
}
