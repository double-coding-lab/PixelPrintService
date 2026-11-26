import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Op, Transaction, type Model, type ModelStatic, type Sequelize } from 'sequelize';
import { parseCheckpointContentReference } from './checkpointStore';
import {
  checkpointContentPolicy,
  checkpointModel,
  checkpointPayloadScope,
  prepareCheckpointPayload,
  resolveCheckpointPayload,
} from './checkpointRuntime';

export type CheckpointMigrationTable = 'checkpoints' | 'writes';
export type CheckpointMigrationOptions = {
  table: CheckpointMigrationTable;
  afterId?: string;
  untilId?: string;
  batchSize?: number;
  dryRun?: boolean;
  action?: 'externalize' | 'restore';
  signal?: AbortSignal;
};
export type CheckpointMigrationResult = {
  table: CheckpointMigrationTable;
  action: 'externalize' | 'restore';
  dryRun: boolean;
  nextAfterId: string;
  untilId: string;
  scanned: number;
  eligible: number;
  written: number;
  skipped: number;
  conflicts: number;
  hasMore: boolean;
  error?: { id: string; code: string };
};
type Row = Record<string, unknown>;
const models = { checkpoints: 'D2cAgentCheckpoint', writes: 'D2cAgentWrite' } as const;
const common = [
  'id',
  'sessionId',
  'threadId',
  'namespaceHash',
  'checkpointNs',
  'checkpointId',
  'updatedAt',
];
const checkpointFields = [
  'parentCheckpointId',
  'checkpointType',
  'metadataType',
  'checkpoint',
  'metadata',
  'checkpointRef',
  'metadataRef',
];
const writeFields = [
  'taskHash',
  'taskId',
  'taskPath',
  'idx',
  'channel',
  'valueType',
  'value',
  'valueRef',
];
const safeCodes = new Set([
  'INVALID_REFERENCE',
  'INVALID_CONFIG',
  'INVALID_TEXT',
  'INVALID_PAYLOAD',
  'INTEGRITY_FAILED',
  'UPLOAD_FAILED',
  'VERIFY_FAILED',
  'DOWNLOAD_FAILED',
  'BUSY',
]);

/** 运维固定错误，不携带SQL、编码载荷、私有定位或密钥材料。 */
class MigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 只允许本模块固定分类和正文协议的白名单业务码。 */
function errorCode(error: unknown): string {
  if (error instanceof MigrationError) return error.code;
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    safeCodes.has(error.code)
    ? error.code
    : 'MIGRATION_FAILED';
}

/** uint64始终保留规范十进制字符串，不经过Number转换。 */
function cursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new MigrationError('INVALID_REFERENCE');
  return value;
}

/** 统一取消类型，禁止透传signal.reason。 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('检查点迁移已取消', 'AbortError');
}

/** 只展开模型数据，不保留实例的方法或事务状态。 */
function plain(row: Model): Row {
  return typeof row.get === 'function'
    ? (row.get({ plain: true }) as Row)
    : (row as unknown as Row);
}

/** 冻结所有CAS字段并复制Buffer，避免慢I/O期间原始对象被修改。 */
function snapshot(row: Model, fields: string[]): Row {
  const value = plain(row);
  return Object.fromEntries(
    fields.map((key) => [
      key,
      Buffer.isBuffer(value[key]) ? Buffer.from(value[key]) : structuredClone(value[key]),
    ]),
  );
}

/** 摘要只对真实原始字节或原始身份字符串计算，不采用ETag。 */
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 把旧脏行挡在上传之前，namespace/task摘要不能代替原文一致性检查。 */
function verifyIdentity(row: Row, table: CheckpointMigrationTable): void {
  if (
    typeof row.sessionId !== 'string' ||
    row.threadId !== `d2c:${row.sessionId}` ||
    typeof row.checkpointNs !== 'string' ||
    hash(row.checkpointNs) !== row.namespaceHash ||
    (table === 'writes' && (typeof row.taskId !== 'string' || hash(row.taskId) !== row.taskHash))
  )
    throw new MigrationError('INVALID_REFERENCE');
}

/**
 * 固定上界、ID-only分页的检查点/中间写迁移；两个检查点载荷在同一行原子切换。
 * 每次事务先锁父会话再锁载荷行，拒绝活动/失效会话；对象I/O只在两次事务之间发生。
 * 只更新载荷与引用，不改变租约、业务版本/事件，也不删除任何对象。
 */
export async function migrateCheckpointBatch(
  mysql: Sequelize,
  options: CheckpointMigrationOptions,
): Promise<CheckpointMigrationResult> {
  try {
    return await runBatch(mysql, options);
  } catch (error) {
    checkAbort(options.signal);
    throw new MigrationError(errorCode(error));
  }
}

/** 全局查询故障经公开入口投影；行内故障另保存安全续迁游标。 */
async function runBatch(
  mysql: Sequelize,
  options: CheckpointMigrationOptions,
): Promise<CheckpointMigrationResult> {
  if (!Object.hasOwn(models, options.table)) throw new MigrationError('INVALID_REFERENCE');
  const after = cursor(options.afterId ?? '0');
  const batch = options.batchSize ?? 25;
  const dryRun = options.dryRun !== false;
  const action = options.action ?? 'externalize';
  if (
    !Number.isSafeInteger(batch) ||
    batch < 1 ||
    batch > 100 ||
    !['externalize', 'restore'].includes(action)
  )
    throw new MigrationError('INVALID_REFERENCE');
  checkAbort(options.signal);
  const policy = checkpointContentPolicy(mysql);
  if (!dryRun && (!policy.schemaReady || (action === 'externalize' && policy.mode === 'inline')))
    throw new MigrationError('INVALID_CONFIG');
  const original = mysql.models[models[options.table]] as ModelStatic<Model>;
  const sessions = mysql.models.D2cSession as ModelStatic<Model>;
  if (!original || !sessions) throw new MigrationError('INVALID_CONFIG');
  const model = checkpointModel(mysql, original);
  const fields = [...common, ...(options.table === 'checkpoints' ? checkpointFields : writeFields)];
  const last =
    options.untilId === undefined
      ? await model.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
      : null;
  const upper = cursor(options.untilId ?? String(last ? plain(last).id : '0'));
  const result: CheckpointMigrationResult = {
    table: options.table,
    action,
    dryRun,
    nextAfterId: after,
    untilId: upper,
    scanned: 0,
    eligible: 0,
    written: 0,
    skipped: 0,
    conflicts: 0,
    hasMore: false,
  };
  if (BigInt(after) >= BigInt(upper)) return result;
  const heads = await model.findAll({
    attributes: ['id'],
    where: { id: { [Op.gt]: after, [Op.lte]: upper } },
    order: [['id', 'ASC']],
    limit: batch + 1,
  });
  result.hasMore = heads.length > batch;
  for (const head of heads.slice(0, batch)) {
    checkAbort(options.signal);
    const id = cursor(String(plain(head).id));
    try {
      const seed = await model.findOne({ where: { id }, attributes: ['id', 'sessionId'] });
      checkAbort(options.signal);
      if (!seed) {
        result.skipped++;
        result.nextAfterId = id;
        continue;
      }
      const sessionId = plain(seed).sessionId;
      if (typeof sessionId !== 'string') throw new MigrationError('INVALID_REFERENCE');
      result.scanned++;
      const freeze = async (transaction: Transaction) => {
        await lockSession(sessionId, transaction, !dryRun);
        const row = await model.findOne({
          where: { id },
          transaction,
          ...(!dryRun ? { lock: transaction.LOCK.UPDATE } : {}),
        });
        checkAbort(options.signal);
        if (!row || plain(row).sessionId !== sessionId)
          throw new MigrationError('REVISION_CONFLICT');
        return snapshot(row, fields);
      };
      const old = dryRun
        ? await mysql.transaction(
            { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
            freeze,
          )
        : await mysql.transaction(freeze);
      verifyIdentity(old, options.table);
      const patch: Row = {};
      const payloads =
        options.table === 'checkpoints'
          ? ([
              ['checkpoint', 'checkpointRef', 'checkpointType', 'checkpoint'],
              ['metadata', 'metadataRef', 'metadataType', 'metadata'],
            ] as const)
          : ([['value', 'valueRef', 'valueType', 'write']] as const);
      for (const [payloadField, refField, typeField, kind] of payloads) {
        const payload = old[payloadField];
        const reference = old[refField];
        if (payload != null && !Buffer.isBuffer(payload))
          throw new MigrationError('INVALID_REFERENCE');
        if (payload == null && reference == null) continue;
        const binding = checkpointPayloadScope({
          sessionId,
          namespaceHash: old.namespaceHash as string,
          checkpointId: old.checkpointId as string,
          kind,
          type: old[typeField] as string,
          ...(kind === 'write' ? { taskHash: old.taskHash as string, idx: old.idx as number } : {}),
        });
        if (dryRun && reference != null) {
          const checked = parseCheckpointContentReference(reference);
          if (checked.scope !== binding) throw new MigrationError('INVALID_REFERENCE');
        }
        if (action === 'restore') {
          if (Buffer.isBuffer(payload) || reference == null) continue;
          if (dryRun) {
            patch[payloadField] = null;
            continue;
          }
          const restored = await resolveCheckpointPayload(
            mysql,
            { payload: null, reference },
            binding,
            options.signal,
          );
          checkAbort(options.signal);
          if (!Buffer.isBuffer(restored)) throw new MigrationError('INVALID_REFERENCE');
          patch[payloadField] = Buffer.from(restored);
          continue;
        }
        if (
          !Buffer.isBuffer(payload) ||
          payload.length < policy.thresholdBytes ||
          payload.length > policy.maxBytes
        )
          continue;
        const ref = reference && typeof reference === 'object' ? (reference as Row) : null;
        if (
          ref &&
          ref.scope === binding &&
          ref.size === payload.length &&
          ref.sha256 === hash(payload)
        ) {
          if (dryRun) {
            if (policy.mode === 'external') patch[payloadField] = null;
            continue;
          }
          const verified = await resolveCheckpointPayload(
            mysql,
            { payload: null, reference },
            binding,
            options.signal,
          );
          checkAbort(options.signal);
          if (!Buffer.isBuffer(verified) || !verified.equals(payload))
            throw new MigrationError('INVALID_REFERENCE');
          if (policy.mode === 'external') patch[payloadField] = null;
        } else {
          if (dryRun) {
            patch[payloadField] = null;
            continue;
          }
          const prepared = await prepareCheckpointPayload(mysql, binding, payload, options.signal);
          checkAbort(options.signal);
          patch[payloadField] = prepared.payload;
          if (prepared.reference !== undefined) patch[refField] = prepared.reference;
        }
      }
      if (!Object.keys(patch).length) result.skipped++;
      else {
        result.eligible++;
        if (!dryRun) {
          await mysql.transaction(async (transaction) => {
            await lockSession(sessionId, transaction);
            const current = await model.findOne({
              where: { id },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            checkAbort(options.signal);
            if (!current || !isDeepStrictEqual(old, snapshot(current, fields)))
              throw new MigrationError('REVISION_CONFLICT');
            checkAbort(options.signal);
            if (!(old.updatedAt instanceof Date) || !Number.isFinite(old.updatedAt.getTime()))
              throw new MigrationError('INVALID_REFERENCE');
            // 静态update保留显式updatedAt；实例silent会移除该列，不能阻止DB的ON UPDATE。
            const [count] = await model.update(
              { ...patch, updatedAt: old.updatedAt },
              { where: { id, sessionId }, transaction, silent: true, hooks: false },
            );
            if (count !== 1) throw new MigrationError('REVISION_CONFLICT');
            checkAbort(options.signal);
          });
          result.written++;
        }
      }
      result.nextAfterId = id;
    } catch (error) {
      checkAbort(options.signal);
      const code = errorCode(error);
      if (code === 'REVISION_CONFLICT') result.conflicts++;
      result.error = { id, code };
      result.hasMore = true;
      break;
    }
  }
  return result;

  /** 父会话锁与运行领取/租约提交串行；无需读取或改动activeRun的租约。 */
  async function lockSession(
    sessionId: string,
    transaction: Transaction,
    lock = true,
  ): Promise<void> {
    checkAbort(options.signal);
    const row = await sessions.findOne({
      where: { sessionId },
      attributes: ['sessionId', 'activeRunId'],
      transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    checkAbort(options.signal);
    if (!row || plain(row).sessionId !== sessionId) throw new MigrationError('SESSION_NOT_FOUND');
    const active = plain(row).activeRunId;
    if (active !== null && active !== undefined && active !== '')
      throw new MigrationError('SESSION_ACTIVE');
  }
}
