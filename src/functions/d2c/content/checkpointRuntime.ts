import { createHash } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { z } from 'zod';
import { contentStorageSchema, type ContentStorageSettings } from './runtime';
import { TextContentError } from './store';
import {
  parseBinaryContentReference,
  type BinaryContentReference,
  type createBinaryContentStore,
} from './binaryStore';

/** 检查点与文件正文独立灰度；不能因第一阶段启用而自动改变执行恢复格式。 */
export const checkpointStorageSchema = contentStorageSchema;
type BinaryStore = ReturnType<typeof createBinaryContentStore>;
type Runtime = {
  readSettings: () => ContentStorageSettings;
  store: BinaryStore | (() => BinaryStore);
  maxBytes: number;
  writeMaxBytes?: () => number;
};
const runtimes = new WeakMap<Sequelize, Runtime & { schemaReady?: boolean }>();
const disabled = checkpointStorageSchema.parse({});

/** 只装配依赖，不连接存储或查询新列，保持旧schema默认可用。 */
export function installCheckpointContentRuntime(mysql: Sequelize, runtime: Runtime): void {
  if (!Number.isSafeInteger(runtime.maxBytes) || runtime.maxBytes < 1)
    throw new TextContentError('INVALID_CONFIG');
  runtimes.set(mysql, { ...runtime });
}

/** schemaReady在进程内固定，写模式回退时继续允许历史引用读取。 */
function settings(mysql: Sequelize): ContentStorageSettings {
  const runtime = runtimes.get(mysql);
  if (!runtime) return disabled;
  try {
    const parsed = checkpointStorageSchema.parse(runtime.readSettings());
    if (runtime.schemaReady !== undefined && runtime.schemaReady !== parsed.schemaReady)
      throw new TextContentError('INVALID_CONFIG');
    runtime.schemaReady ??= parsed.schemaReady;
    return parsed;
  } catch {
    throw new TextContentError('INVALID_CONFIG');
  }
}

/** 仅在新列全部就绪时应用引用scope，保留原where、事务和其他模型行为。 */
export function checkpointModel<T extends ModelStatic<Model>>(mysql: Sequelize, model: T): T {
  return settings(mysql).schemaReady ? (model.scope('checkpointBody') as T) : model;
}

/** 元数据投影仅追加本次所需的引用，默认关闭时完全保留旧字段列表。 */
export function checkpointAttributes(
  mysql: Sequelize,
  attributes: string[],
  referenceFields: string[],
): string[] {
  return settings(mysql).schemaReady
    ? [...new Set([...attributes, ...referenceFields])]
    : attributes;
}

/** 运维只读取安全策略，不能获取密钥或私有对象定位。 */
export function checkpointContentPolicy(mysql: Sequelize) {
  const config = settings(mysql);
  const runtime = runtimes.get(mysql);
  const cap = runtime?.writeMaxBytes ? runtime.writeMaxBytes() : (runtime?.maxBytes ?? 0);
  if (!Number.isSafeInteger(cap) || cap < 0) throw new TextContentError('INVALID_CONFIG');
  return {
    schemaReady: config.schemaReady,
    mode: config.mode,
    thresholdBytes: config.thresholdBytes,
    maxBytes: Math.min(cap, runtime?.maxBytes ?? 0),
  };
}

const scopeSchema = z
  .object({
    sessionId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    namespaceHash: z.string().regex(/^[a-f0-9]{64}$/),
    checkpointId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    kind: z.enum(['checkpoint', 'metadata', 'write']),
    type: z.string().min(1).max(128),
    taskHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    idx: z.number().int().min(-2147483648).max(2147483647).optional(),
  })
  .strict();
export type CheckpointPayloadIdentity = z.infer<typeof scopeSchema>;

/** 将typed编码及完整行身份绑定为固定长度scope，防止namespace、通道或载荷互换。 */
export function checkpointPayloadScope(input: CheckpointPayloadIdentity): string {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) throw new TextContentError('INVALID_REFERENCE');
  const row = parsed.data;
  if (
    (row.kind === 'write' && (row.taskHash === undefined || row.idx === undefined)) ||
    (row.kind !== 'write' && (row.taskHash !== undefined || row.idx !== undefined))
  )
    throw new TextContentError('INVALID_REFERENCE');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        row.sessionId,
        row.namespaceHash,
        row.checkpointId,
        row.kind,
        row.type,
        row.taskHash ?? null,
        row.idx ?? null,
      ]),
    )
    .digest('hex');
  return `checkpoint:${row.sessionId}:${digest}`;
}

/** 上传发生在租约事务外；提交时必须重新检查租约、原行身份及业务写入顺序。 */
export async function prepareCheckpointPayload(
  mysql: Sequelize,
  scope: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ payload: Buffer | null; reference?: BinaryContentReference | null }> {
  if (signal?.aborted) throw new DOMException('检查点操作已取消', 'AbortError');
  if (!(bytes instanceof Uint8Array)) throw new TextContentError('INVALID_TEXT');
  const payload = Buffer.from(bytes);
  const config = settings(mysql);
  if (!config.schemaReady) return { payload };
  if (config.mode === 'inline' || payload.length < config.thresholdBytes)
    return { payload, reference: null };
  const policy = checkpointContentPolicy(mysql);
  if (payload.length > policy.maxBytes) return { payload, reference: null };
  const runtime = runtimes.get(mysql)!;
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  const reference = parseBinaryContentReference(await store.put(scope, payload, { signal }));
  if (
    reference.scope !== scope ||
    reference.size !== payload.length ||
    reference.sha256 !== createHash('sha256').update(payload).digest('hex')
  )
    throw new TextContentError('INTEGRITY_FAILED');
  return { payload: config.mode === 'shadow' ? payload : null, reference };
}

/** 旧BLOB优先，外置引用严格绑定行和typed编码；损坏不返回空状态或静默重建。 */
export async function resolveCheckpointPayload(
  mysql: Sequelize,
  row: { payload: Uint8Array | null | undefined; reference?: unknown },
  expectedScope: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (signal?.aborted) throw new DOMException('检查点操作已取消', 'AbortError');
  if (row.payload instanceof Uint8Array) return Buffer.from(row.payload);
  if (row.payload != null) throw new TextContentError('INVALID_TEXT');
  if (row.reference == null) return null;
  if (!settings(mysql).schemaReady) throw new TextContentError('INVALID_CONFIG');
  const reference = parseBinaryContentReference(row.reference);
  if (reference.scope !== expectedScope) throw new TextContentError('INVALID_REFERENCE');
  const runtime = runtimes.get(mysql)!;
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  return Buffer.from(await store.read(expectedScope, reference, { signal }));
}
