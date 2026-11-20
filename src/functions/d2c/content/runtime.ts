import { createHash } from 'node:crypto';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { z } from 'zod';
import {
  parseTextContentReference,
  TextContentError,
  type TextContentReference,
  type createTextContentStore,
} from './store';

/** schemaReady独立于写模式；回退库内写入时仍可读取已有外置引用。 */
export const contentStorageSchema = z
  .object({
    schemaReady: z.boolean().default(false),
    mode: z.enum(['inline', 'shadow', 'external']).default('inline'),
    thresholdBytes: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024 * 1024)
      .default(262144),
    concurrency: z.number().int().min(1).max(8).default(2),
    encryption: z
      .object({
        activeKeyId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
        keys: z.record(
          z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
          z.string().regex(/^[a-zA-Z0-9+/]{43}=$/),
        ),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (!value.schemaReady && value.mode !== 'inline')
      context.addIssue({ code: 'custom', path: ['mode'], message: '外置写入需要已确认新列就绪' });
    if (
      value.mode !== 'inline' &&
      (!value.encryption || !Object.hasOwn(value.encryption.keys, value.encryption.activeKeyId))
    )
      context.addIssue({
        code: 'custom',
        path: ['encryption'],
        message: '外置写入需要独立正文密钥',
      });
  });
export type ContentStorageSettings = z.infer<typeof contentStorageSchema>;
export type StoredTextRow = {
  content?: string | null;
  contentRef?: unknown;
  size?: number | null;
  sha256?: string | null;
  objectLocator?: unknown;
};
export type PreparedText = { content: string | null; contentRef?: TextContentReference | null };
type TextStore = ReturnType<typeof createTextContentStore>;
type Runtime = {
  readSettings: () => ContentStorageSettings;
  store: TextStore | (() => TextStore);
  maxBytes: number;
  writeMaxBytes?: () => number;
};
const runtimes = new WeakMap<Sequelize, Runtime & { schemaReady?: boolean }>();
const disabled = contentStorageSchema.parse({});

/** 仅装配依赖，不连存储或查询数据库；未装配的离线/旧调用继续原inline语义。 */
export function installTextContentRuntime(mysql: Sequelize, runtime: Runtime): void {
  if (!Number.isSafeInteger(runtime.maxBytes) || runtime.maxBytes < 1)
    throw new TextContentError('INVALID_CONFIG');
  runtimes.set(mysql, { ...runtime });
}

/** 无配置不启用新列；配置失败不能静默切到旧schema并隐藏已有外置正文。 */
function settings(mysql: Sequelize): ContentStorageSettings {
  const runtime = runtimes.get(mysql);
  if (!runtime) return disabled;
  try {
    const config = contentStorageSchema.parse(runtime.readSettings());
    if (runtime.schemaReady !== undefined && runtime.schemaReady !== config.schemaReady)
      throw new TextContentError('INVALID_CONFIG');
    runtime.schemaReady ??= config.schemaReady;
    return config;
  } catch {
    throw new TextContentError('INVALID_CONFIG');
  }
}

/** 测试/服务装配可读取安全开关，禁止把加密材料放入诊断或公开响应。 */
export function contentEnabled(mysql: Sequelize): boolean {
  return settings(mysql).schemaReady;
}

/** 迁移规划只读取安全策略，不返回密钥、定位或实际正文。 */
export function textContentPolicy(mysql: Sequelize) {
  const config = settings(mysql);
  const runtime = runtimes.get(mysql);
  const writeMaximum = runtime?.writeMaxBytes ? runtime.writeMaxBytes() : (runtime?.maxBytes ?? 0);
  if (!Number.isSafeInteger(writeMaximum) || writeMaximum < 0)
    throw new TextContentError('INVALID_CONFIG');
  return {
    schemaReady: config.schemaReady,
    mode: config.mode,
    thresholdBytes: config.thresholdBytes,
    maxBytes: Math.min(runtime?.maxBytes ?? 0, writeMaximum),
  };
}

/** 默认scope排除新列，schema就绪后显式启用；保留原where/事务/paranoid规则。 */
export function contentModel<T extends ModelStatic<Model>>(mysql: Sequelize, model: T): T {
  return contentEnabled(mysql) ? (model.scope('contentBody') as T) : model;
}

/** 正文查询原有白名单按需追加新列；元数据列表不调用此函数。 */
export function contentAttributes(mysql: Sequelize, attributes: string[]): string[] {
  return contentEnabled(mysql) ? [...new Set([...attributes, 'contentRef'])] : attributes;
}

/** 只认可与当前内容身份一致的引用，避免旧实例改写inline后留下的引用被再次冻结。 */
function matchingReference(row: StoredTextRow): TextContentReference | null {
  if (!row.contentRef || typeof row.contentRef !== 'object' || Array.isArray(row.contentRef))
    return null;
  let reference: TextContentReference;
  try {
    reference = parseTextContentReference(row.contentRef);
  } catch {
    return null;
  }
  if (reference.sha256 !== row.sha256 || reference.size !== row.size) return null;
  if (
    typeof row.content === 'string' &&
    (Buffer.byteLength(row.content) !== reference.size ||
      createHash('sha256').update(row.content).digest('hex') !== reference.sha256)
  )
    return null;
  return reference;
}

/** 冻结复制已有存储描述，不上传、不改变已有版本；二进制永不携带文本引用。 */
export function copyTextStorage(mysql: Sequelize, row: StoredTextRow): PreparedText {
  const content = typeof row.content === 'string' ? row.content : null;
  if (!contentEnabled(mysql)) {
    if (content === null && row.contentRef != null && !row.objectLocator)
      throw new TextContentError('INVALID_CONFIG');
    return { content };
  }
  const reference = row.objectLocator ? null : matchingReference(row);
  if (content === null && row.contentRef != null && !row.objectLocator && !reference)
    throw new TextContentError('INVALID_REFERENCE');
  return { content, contentRef: reference };
}

/**
 * 上传准备必须在业务事务外调用。返回字段再与摘要/修订/事件一起短事务提交。
 * 超出当前单对象能力仍走旧inline路径；不降低既有业务文本上限。
 */
export async function prepareTextContent(
  mysql: Sequelize,
  scope: string,
  text: string,
  signal?: AbortSignal,
): Promise<PreparedText> {
  if (signal?.aborted) throw new DOMException('正文操作已取消', 'AbortError');
  if (typeof text !== 'string' || Buffer.from(text).toString('utf8') !== text)
    throw new TextContentError('INVALID_TEXT');
  const config = settings(mysql);
  if (!config.schemaReady) return { content: text };
  const runtime = runtimes.get(mysql)!;
  const size = Buffer.byteLength(text);
  if (config.mode === 'inline' || size < config.thresholdBytes)
    return { content: text, contentRef: null };
  const writeMaximum = runtime.writeMaxBytes ? runtime.writeMaxBytes() : runtime.maxBytes;
  if (!Number.isSafeInteger(writeMaximum) || writeMaximum < 0)
    throw new TextContentError('INVALID_CONFIG');
  if (size > Math.min(runtime.maxBytes, writeMaximum)) return { content: text, contentRef: null };
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  const reference = await store.put(scope, text, { signal });
  // 注入的适配器也须返回对应内容身份，不能把错误引用提交到业务行。
  if (
    reference.scope !== scope ||
    reference.size !== size ||
    reference.sha256 !== createHash('sha256').update(text).digest('hex')
  )
    throw new TextContentError('INTEGRITY_FAILED');
  return { content: config.mode === 'shadow' ? text : null, contentRef: reference };
}

/**
 * 业务先校验行归属。inline优先以兼容旧写入器；无inline时引用须匹配业务摘要。
 * 冻结行可沿用原引用scope；当前会话调用方额外传expectedScope绑定当前会话。
 */
export async function resolveTextContent(
  mysql: Sequelize,
  row: StoredTextRow,
  expectedScope?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) throw new DOMException('正文操作已取消', 'AbortError');
  if (typeof row.content === 'string') return row.content;
  if (row.contentRef == null) return null;
  if (!contentEnabled(mysql)) throw new TextContentError('INVALID_CONFIG');
  const reference = matchingReference(row);
  if (!reference || row.objectLocator) throw new TextContentError('INVALID_REFERENCE');
  const runtime = runtimes.get(mysql)!;
  const store = typeof runtime.store === 'function' ? runtime.store() : runtime.store;
  return store.read(expectedScope ?? reference.scope, reference, { signal });
}
