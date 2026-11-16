import type { createRunLeases, RunLease } from '../leases';
import { SessionError } from '../../session/access';
import { executionError } from '../errors';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  emptyCheckpoint,
  WRITES_IDX_MAP,
  TASKS,
  compareWritesSortKeys,
  writesSortKey,
  maxChannelVersion,
  getCheckpointId,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type ChannelVersions,
  type PendingWrite,
  type CheckpointPendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { Op, Transaction, type ModelStatic, type Sequelize, type WhereOptions } from 'sequelize';
import type { D2cAgentCheckpoint } from '@/models/D2cAgentCheckpoint';
import type { D2cAgentWrite } from '@/models/D2cAgentWrite';

/**
 * 调用方必须在此事务内锁定本 session/run 的租约行并验证 owner、有效期和会话归属，
 * 持锁到 callback 与提交完成，异常须回滚。不可实现为 assertLease 后另开保存事务。
 * 同会话的 put/putWrites/deleteThread 必须经同一租约行串行化；禁止回调重试已提交事务。
 */
export type WithCheckpointLease = <T>(
  callback: (transaction: Transaction) => Promise<T>,
) => Promise<T>;

export type D2cMySQLCheckpointOptions = {
  sessionId: string;
  sequelize: Sequelize;
  withLease: WithCheckpointLease;
  serde?: SerializerProtocol;
};

/** UTF-8 hash 仅缩短索引；所有命中都继续核对原文。 */
function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 拒绝 MySQL 转码会丢失的孤立代理字符。 */
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value)
    throw new Error(`Invalid checkpoint ${label}`);
  return value;
}

/** ID 限定 ASCII 无空格，消除大小写、尾空格及 MySQL 截断造成的碰撞。 */
function checkpointId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new Error('Invalid checkpoint ID');
  return value;
}

/**
 * LangGraph checkpoint 1.2.1 的 MySQL 候选，使用已初始化模型，不创建数据库连接或表。
 * 完整保存 checkpoint 的 typed bytes（含 channel_values、DeltaSnapshot 和所有版本），
 * 不按 newVersions 剥离 channels，因此该 SDK 不需要额外的 channel blobs 表。
 * 默认继承整数递增版本与 SDK 的 parent-chain delta replay。
 */
export class D2cMySQLCheckpointSaver extends BaseCheckpointSaver {
  readonly threadId: string;
  private readonly sessionId: string;
  private readonly sequelize: Sequelize;
  private readonly withLease: WithCheckpointLease;
  private readonly checkpoints: ModelStatic<D2cAgentCheckpoint>;
  private readonly writes: ModelStatic<D2cAgentWrite>;

  /** sessionId 必须来自已鉴权服务端会话，不接受模型或请求自由切换 thread。 */
  constructor(options: D2cMySQLCheckpointOptions) {
    super(options.serde);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(options.sessionId))
      throw new Error('Checkpoint sessionId must be a canonical UUID');
    this.sessionId = options.sessionId;
    this.threadId = `d2c:${options.sessionId}`;
    this.sequelize = options.sequelize;
    this.withLease = options.withLease;
    this.checkpoints = options.sequelize.models
      .D2cAgentCheckpoint as ModelStatic<D2cAgentCheckpoint>;
    this.writes = options.sequelize.models.D2cAgentWrite as ModelStatic<D2cAgentWrite>;
    if (!this.checkpoints || !this.writes || typeof this.withLease !== 'function')
      throw new Error('Checkpoint models and withLease must be explicitly initialized');
  }

  /** 生成绑定会话的 SDK config；服务端可据此启动 graph。 */
  config(namespace = '', id?: string): RunnableConfig {
    text(namespace, 'namespace');
    return {
      configurable: {
        thread_id: this.threadId,
        checkpoint_ns: namespace,
        ...(id === undefined ? {} : { checkpoint_id: checkpointId(id) }),
      },
    };
  }

  /** 每次操作校验固定 thread，包括 list/before；缺省 thread 也不可跨会话枚举。 */
  private scope(config: RunnableConfig) {
    const values = config.configurable ?? {};
    if (values.thread_id !== undefined && values.thread_id !== this.threadId)
      throw new Error('Checkpoint thread does not match bound session');
    const ns = text(values.checkpoint_ns ?? '', 'namespace');
    const id = getCheckpointId(config);
    if (id) checkpointId(id);
    return { ns, id, where: { sessionId: this.sessionId, namespaceHash: hash(ns) } };
  }

  /** 同时核对原文及归属；hash 或 collation 碰撞必须明确失败。 */
  private verify(row: D2cAgentCheckpoint | D2cAgentWrite, namespace?: string) {
    if (
      row.sessionId !== this.sessionId ||
      row.threadId !== this.threadId ||
      row.checkpointNs === null ||
      row.namespaceHash !== hash(row.checkpointNs) ||
      (namespace !== undefined && row.checkpointNs !== namespace)
    )
      throw new Error('Checkpoint scope/hash mismatch');
    checkpointId(row.checkpointId);
  }

  /** 所有修改只接受租约事务；本类不会另开事务或提前提交。 */
  private mutate<T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.withLease(async (transaction) => {
      const state = transaction as Transaction & { sequelize?: Sequelize; finished?: string };
      if (!transaction || state.sequelize !== this.sequelize || state.finished)
        throw new Error('Checkpoint requires an active lease transaction on the same sequelize');
      return callback(transaction);
    });
  }

  /** 读取同一快照下的有序 pending writes，保留 SDK 的特殊负序号语义。 */
  private async pending(ns: string, id: string, transaction: Transaction) {
    const rows = await this.writes.findAll({
      where: { sessionId: this.sessionId, namespaceHash: hash(ns), checkpointId: id },
      transaction,
      raw: true,
    });
    for (const row of rows) {
      this.verify(row, ns);
      if (
        row.taskId === null ||
        row.taskHash !== hash(row.taskId) ||
        row.taskPath === null ||
        row.channel === null ||
        row.value === null ||
        !row.valueType
      )
        throw new Error('Incomplete checkpoint write');
    }
    rows.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.taskPath!, a.taskId!, a.idx),
        writesSortKey(b.taskPath!, b.taskId!, b.idx),
      ),
    );
    const result: CheckpointPendingWrite[] = [];
    for (const row of rows)
      result.push([
        row.taskId!,
        row.channel!,
        await this.serde.loadsTyped(row.valueType, row.value!),
      ]);
    return result;
  }

  /** 从 typed bytes 还原 tuple；兼容 SDK v4 前 parent TASKS 的迁移语义。 */
  private async tuple(row: D2cAgentCheckpoint, transaction: Transaction): Promise<CheckpointTuple> {
    this.verify(row);
    if (
      row.checkpoint === null ||
      row.metadata === null ||
      !row.checkpointType ||
      !row.metadataType
    )
      throw new Error('Incomplete checkpoint payload');
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpointType,
      row.checkpoint,
    )) as Checkpoint;
    if (checkpoint.id !== row.checkpointId) throw new Error('Checkpoint payload ID mismatch');
    const ns = row.checkpointNs!;
    const parent = row.parentCheckpointId;
    if (parent !== null) checkpointId(parent);
    if (checkpoint.v < 4 && parent !== null) {
      checkpoint.channel_values[TASKS] = (await this.pending(ns, parent, transaction))
        .filter((write) => write[1] === TASKS)
        .map((write) => write[2]);
      const versions = Object.values(checkpoint.channel_versions);
      checkpoint.channel_versions[TASKS] = versions.length ? maxChannelVersion(...versions) : 1;
    }
    return {
      config: this.config(ns, row.checkpointId),
      checkpoint,
      metadata: await this.serde.loadsTyped(row.metadataType, row.metadata),
      ...(parent === null ? {} : { parentConfig: this.config(ns, parent) }),
      pendingWrites: await this.pending(ns, row.checkpointId, transaction),
    };
  }

  /** 返回指定或最新 checkpoint，ID 使用 UTF-8 字节降序，与 SQL binary 排序一致。 */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const scope = this.scope(config);
    return this.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const rows = await this.checkpoints.findAll({
          where: { ...scope.where, ...(scope.id ? { checkpointId: scope.id } : {}) },
          transaction,
          raw: true,
          order: [['checkpointId', 'DESC']],
          limit: 1,
        });
        for (const row of rows) this.verify(row, scope.ns);
        return rows[0] ? this.tuple(rows[0], transaction) : undefined;
      },
    );
  }

  /** 可列出本会话全部 namespaces；filter 在反序列化后比较，limit 只计匹配项。 */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const scope = this.scope(config);
    const before = options.before ? this.scope(options.before).id : undefined;
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0))
      throw new Error('Invalid checkpoint list limit');
    if (options.limit === 0) return;
    const scopedNamespace = config.configurable?.checkpoint_ns !== undefined;
    const tuples = await this.sequelize.transaction(
      { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async (transaction) => {
        const result: CheckpointTuple[] = [];
        let cursor: { checkpointId: string; namespaceHash: string } | undefined;
        const size = options.filter ? 50 : Math.min(options.limit ?? 50, 50);
        while (true) {
          const conditions: WhereOptions[] = [
            { sessionId: this.sessionId },
            ...(scopedNamespace ? [{ namespaceHash: hash(scope.ns) }] : []),
            ...(scope.id ? [{ checkpointId: scope.id }] : []),
            ...(before ? [{ checkpointId: { [Op.lt]: before } }] : []),
            ...(cursor
              ? [
                  {
                    [Op.or]: [
                      { checkpointId: { [Op.lt]: cursor.checkpointId } },
                      {
                        checkpointId: cursor.checkpointId,
                        namespaceHash: { [Op.gt]: cursor.namespaceHash },
                      },
                    ],
                  },
                ]
              : []),
          ];
          /** 先分页读取元数据，只有匹配项才加载完整状态与 pending writes。 */
          const rows = await this.checkpoints.findAll({
            where: { [Op.and]: conditions },
            attributes: [
              'sessionId',
              'threadId',
              'namespaceHash',
              'checkpointNs',
              'checkpointId',
              'metadataType',
              'metadata',
            ],
            order: [
              ['checkpointId', 'DESC'],
              ['namespaceHash', 'ASC'],
            ],
            limit: size,
            transaction,
            raw: true,
          });
          for (const row of rows) {
            this.verify(row, scopedNamespace ? scope.ns : undefined);
            if (!row.metadataType || row.metadata === null)
              throw new Error('Incomplete checkpoint metadata');
            const metadata = (await this.serde.loadsTyped(
              row.metadataType,
              row.metadata,
            )) as Record<string, unknown>;
            if (
              options.filter &&
              !Object.entries(options.filter).every(([key, value]) =>
                isDeepStrictEqual(metadata?.[key], value),
              )
            )
              continue;
            const full = await this.checkpoints.findOne({
              where: {
                sessionId: this.sessionId,
                namespaceHash: row.namespaceHash,
                checkpointId: row.checkpointId,
              },
              transaction,
              raw: true,
            });
            if (!full) throw new Error('Checkpoint disappeared inside read transaction');
            result.push(await this.tuple(full, transaction));
            if (options.limit !== undefined && result.length >= options.limit) return result;
          }
          if (rows.length < size) break;
          const last = rows[rows.length - 1];
          cursor = { checkpointId: last.checkpointId, namespaceHash: last.namespaceHash };
        }
        return result;
      },
    );
    yield* tuples;
  }

  /** 保存完整 channel_values，newVersions 仅为 SDK 增量提示，不能据此丢弃未改变 channels。 */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const scope = this.scope(config);
    const id = checkpointId(checkpoint.id);
    if (scope.id === id) throw new Error('Checkpoint cannot be its own parent');
    const [[checkpointType, bytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    await this.mutate(async (transaction) => {
      const where = { ...scope.where, checkpointId: id };
      const existing = await this.checkpoints.findOne({
        where,
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (existing) this.verify(existing, scope.ns);
      const values = {
        ...where,
        threadId: this.threadId,
        checkpointNs: scope.ns,
        parentCheckpointId: scope.id || null,
        checkpointType,
        checkpoint: Buffer.from(bytes),
        metadataType,
        metadata: Buffer.from(metadataBytes),
      };
      if (existing) await this.checkpoints.update(values, { where, transaction });
      else await this.checkpoints.create(values, { transaction });
    });
    return this.config(scope.ns, id);
  }

  /** 普通重复写 first-wins，特殊负序号 last-wins；整批与租约在同一事务。 */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = '',
  ): Promise<void> {
    const scope = this.scope(config);
    if (!scope.id) throw new Error('putWrites requires checkpoint_id');
    text(taskId, 'taskId');
    text(taskPath, 'taskPath');
    const values = await Promise.all(
      writes.map(async ([channel, value], index) => {
        text(channel, 'channel');
        const [valueType, bytes] = await this.serde.dumpsTyped(value);
        return {
          ...scope.where,
          threadId: this.threadId,
          checkpointNs: scope.ns,
          checkpointId: scope.id,
          taskHash: hash(taskId),
          taskId,
          taskPath,
          idx: Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : index,
          channel,
          valueType,
          value: Buffer.from(bytes),
        };
      }),
    );
    await this.mutate(async (transaction) => {
      for (const value of values) {
        const where = {
          ...scope.where,
          checkpointId: scope.id,
          taskHash: value.taskHash,
          idx: value.idx,
        };
        const existing = await this.writes.findOne({
          where,
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (existing) {
          this.verify(existing, scope.ns);
          if (existing.taskId !== taskId) throw new Error('Checkpoint task hash mismatch');
          if (value.idx >= 0) continue;
          await this.writes.update(value, { where, transaction });
        } else await this.writes.create(value, { transaction });
      }
    });
  }

  /** 仅允许删除本实例绑定的会话；所有 namespaces 和孤立 writes 同事务清理。 */
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.threadId)
      throw new Error('Checkpoint thread does not match bound session');
    this.scope({ configurable: { thread_id: threadId } });
    await this.mutate(async (transaction) => {
      const where = { sessionId: this.sessionId };
      await this.writes.destroy({ where, transaction });
      await this.checkpoints.destroy({ where, transaction });
    });
  }
}

/**
 * 将框架写入接入现有租约保护事务；锁定顺序、owner/过期检查及回滚由 leases.commit 负责。
 * 实例只属于此轮已领取的 session，不允许模型或外部请求选择 thread_id。
 */
export function createRunCheckpointSaver(
  mysql: Sequelize,
  leases: Pick<ReturnType<typeof createRunLeases>, 'commit'>,
  lease: RunLease,
) {
  return new D2cMySQLCheckpointSaver({
    sequelize: mysql,
    sessionId: lease.sessionId,
    withLease: async (action) => {
      try {
        return await leases.commit(lease, async (session, transaction) => {
          if (session.sessionId !== lease.sessionId)
            throw new Error('Checkpoint lease session mismatch');
          return action(transaction);
        });
      } catch (error) {
        if (error instanceof SessionError && error.reason === 'LEASE_LOST')
          throw executionError(error, 'LEASE_LOST', { stage: 'worker' });
        throw executionError(error, 'STORAGE_FAILED', { stage: 'storage' });
      }
    },
  });
}

/** 恢复过程跨多次图更新，单独保存门禁，崩溃后即使 next=[] 也必须重新恢复稳定历史。 */
export function createRecoveryMarker(
  checkpoint: Pick<D2cMySQLCheckpointSaver, 'config' | 'getTuple' | 'put'>,
) {
  const config = checkpoint.config('__pixelprint_recovery');
  return {
    /** 读取门禁不修改图状态或重新执行模型/工具。 */
    async pending() {
      const saved = await checkpoint.getTuple(
        checkpoint.config('__pixelprint_recovery', 'recovery'),
      );
      if (saved && typeof saved.checkpoint.channel_values.pending !== 'boolean')
        throw new Error('DEEP_CHECKPOINT_RECOVERY_INVALID');
      return saved?.checkpoint.channel_values.pending === true;
    },
    /** 标记完成前由既有租约事务持久化；任何写入失败都保留可识别的恢复状态。 */
    async set(pending: boolean) {
      const saved = emptyCheckpoint();
      saved.id = 'recovery';
      saved.channel_values = { pending };
      await checkpoint.put(config, saved, { source: 'update', step: 0, parents: {} }, {});
    },
  };
}
