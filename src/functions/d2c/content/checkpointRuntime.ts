import { createHash } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { z } from 'zod';
import { contentStorageSchema, type ContentStorageSettings } from './runtime';
import { TextContentError } from './store';
import {
  parseCheckpointContentReference,
  type CheckpointContentReference,
  type createCheckpointContentStore,
} from './checkpointStore';

/** 执行状态与源码正文独立配置，旧模式字段保留解析兼容；新正文统一外置。 */
export const checkpointStorageSchema = contentStorageSchema;
type BinaryStore = ReturnType<typeof createCheckpointContentStore>;
type Runtime = {
  readSettings: () => ContentStorageSettings;
  store: BinaryStore | (() => BinaryStore);
  maxBytes: number;
};
const runtimes = new WeakMap<Sequelize, Runtime & { schemaReady?: boolean }>();
const disabled = checkpointStorageSchema.parse({});

/** 只装配依赖；旧schema仍可读取历史，新增正文必须先就绪文件存储和引用列。 */
export function installCheckpointContentRuntime(mysql: Sequelize, runtime: Runtime): void {
  if (!Number.isSafeInteger(runtime.maxBytes) || runtime.maxBytes < 1)
    throw new TextContentError('INVALID_CONFIG');
  runtimes.set(mysql, { ...runtime });
}

/** schemaReady在进程内固定；历史模式取值不改变新正文的文件写入要求。 */
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
  return {
    schemaReady: config.schemaReady,
    mode: config.schemaReady ? ('external' as const) : ('inline' as const),
    configuredMode: config.mode,
    thresholdBytes: 0,
    maxBytes: runtime?.maxBytes ?? 0,
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
): Promise<{ payload: Buffer | null; reference?: CheckpointContentReference | null }> {
  if (signal?.aborted) throw new DOMException('检查点操作已取消', 'AbortError');
  if (!(bytes instanceof Uint8Array)) throw new TextContentError('INVALID_TEXT');
  const config = settings(mysql);
  if (
    !config.schemaReady ||
    !config.encryption ||
    !Object.hasOwn(config.encryption.keys, config.encryption.activeKeyId)
  )
    throw new TextContentError('INVALID_CONFIG');
  const policy = checkpointContentPolicy(mysql);
  if (bytes.byteLength > policy.maxBytes) throw new TextContentError('INVALID_TEXT');
  const payload = Buffer.from(bytes);
  const runtime = runtimes.get(mysql)!;
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  const reference = parseCheckpointContentReference(await store.put(scope, payload, { signal }));
  if (
    reference.scope !== scope ||
    reference.size !== payload.length ||
    reference.sha256 !== createHash('sha256').update(payload).digest('hex')
  )
    throw new TextContentError('INTEGRITY_FAILED');
  return { payload: null, reference };
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
  const reference = parseCheckpointContentReference(row.reference);
  if (reference.scope !== expectedScope) throw new TextContentError('INVALID_REFERENCE');
  const runtime = runtimes.get(mysql)!;
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  return Buffer.from(await store.read(expectedScope, reference, { signal }));
}
