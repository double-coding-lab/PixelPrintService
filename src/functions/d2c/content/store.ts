import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const prefix = Buffer.from('PPTXT01\0');
const overhead = prefix.length + 12 + 16;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const reasons = {
  INVALID_REFERENCE: '正文引用无效或与授权范围不匹配',
  INVALID_CONFIG: '正文存储或加密配置无效',
  INVALID_TEXT: '正文编码无效或超过限额',
  INTEGRITY_FAILED: '正文对象校验失败',
  UPLOAD_FAILED: '正文对象保存失败',
  VERIFY_FAILED: '正文对象上传后核验失败',
  DOWNLOAD_FAILED: '正文对象读取失败',
  BUSY: '正文存储并发队列已满',
} as const;

/** 固定失败分类，不将上游异常正文、对象定位或密钥输出给调用方。 */
export class TextContentError extends Error {
  constructor(public readonly code: keyof typeof reasons) {
    super(reasons[code]);
    this.name = 'TextContentError';
  }
}

export type TextContentKeys = { activeKeyId: string; keys: Record<string, string> };
export type ContentOperation = { signal?: AbortSignal };
/** 适配器负责不可变写入，以及下载流的字节上限；不得仅在下载结束后检查。 */
export type TextContentBackend = {
  maxObjectBytes: number;
  put(input: { key: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<unknown>;
  get(
    locator: Record<string, unknown>,
    input: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
};

/** 正文引用独立于二进制objectLocator；此记录只供服务端存储，不是公开文件DTO。 */
const referenceSchema = z
  .object({
    format: z.literal('pixelprint.text.v1'),
    objectId: z.string().uuid(),
    scope: identifier,
    keyId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
    encoding: z.literal('utf-8'),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024 * 1024),
    storedSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    locator: z.record(z.string(), z.unknown()),
  })
  .strict();
export type TextContentReference = z.infer<typeof referenceSchema>;

/** 定位按描述符复制有限JSON；完整引用仅增加元数据预算，拒绝反射异常及任意getter。 */
export function safeLocator(value: unknown, enclosingReference = false): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TextContentError('INVALID_REFERENCE');
    let entries = 0;
    function copy(item: unknown, depth: number): unknown {
      if (++entries > (enclosingReference ? 160 : 128) || depth > (enclosingReference ? 7 : 6))
        throw new TextContentError('INVALID_REFERENCE');
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'string' && item.length <= 4096) return item;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.getPrototypeOf(item) !== Object.prototype
      )
        throw new TextContentError('INVALID_REFERENCE');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const result: Record<string, unknown> = {};
      for (const name of Reflect.ownKeys(descriptors)) {
        if (
          typeof name !== 'string' ||
          name.length > 512 ||
          ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(name)
        )
          throw new TextContentError('INVALID_REFERENCE');
        const descriptor = descriptors[name];
        if (!('value' in descriptor)) throw new TextContentError('INVALID_REFERENCE');
        result[name] = copy(descriptor.value, depth + 1);
      }
      return result;
    }
    const result = copy(value, 0) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(result)) > 16384 + (enclosingReference ? 2048 : 0))
      throw new TextContentError('INVALID_REFERENCE');
    return result;
  } catch {
    throw new TextContentError('INVALID_REFERENCE');
  }
}

/** 读取/冻结共用严格引用校验，避免只校验部分字段就复制损坏对象描述。 */
export function parseTextContentReference(value: unknown): TextContentReference {
  const parsed = referenceSchema.safeParse(safeLocator(value, true));
  if (!parsed.success || parsed.data.storedSize !== parsed.data.size + overhead)
    throw new TextContentError('INVALID_REFERENCE');
  return parsed.data;
}

/** 明确取消与普通存储失败分开，避免把正常停止统计为一次执行错误。 */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('正文操作已取消', 'AbortError');
}

/** 校验固定32字节标准Base64密钥，使用后清空临时密钥Buffer。 */
export function keyFor(config: TextContentKeys, keyId: string): Buffer {
  const material =
    config?.keys && Object.hasOwn(config.keys, keyId) ? config.keys[keyId] : undefined;
  if (typeof material !== 'string' || !/^[a-zA-Z0-9+/]{43}=$/.test(material))
    throw new TextContentError('INVALID_CONFIG');
  const key = Buffer.from(material, 'base64');
  if (key.length !== 32 || key.toString('base64') !== material) {
    key.fill(0);
    throw new TextContentError('INVALID_CONFIG');
  }
  return key;
}

/** AAD绑定范围、对象身份、正文摘要和格式，禁止跨会话移用或篡改元数据。 */
function authenticatedData(ref: Omit<TextContentReference, 'locator'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      ref.format,
      ref.objectId,
      ref.scope,
      ref.keyId,
      ref.encoding,
      ref.size,
      ref.storedSize,
      ref.sha256,
    ]),
  );
}

/** 有界FIFO并发；排队取消不占用后续槽位，失败必释放，未启动的动作不上传。 */
export function limiter(maximum: number, maxPendingBytes: number) {
  let pendingBytes = 0;
  let active = 0;
  const waiting: Array<{ start: () => void; cancel: () => void }> = [];
  return async function limited<T>(
    signal: AbortSignal | undefined,
    weight: number,
    action: () => Promise<T>,
  ): Promise<T> {
    checkAbort(signal);
    if (active >= maximum) {
      if (waiting.length >= 64 || pendingBytes + weight > maxPendingBytes)
        throw new TextContentError('BUSY');
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: () => {
            signal?.removeEventListener('abort', entry.cancel);
            pendingBytes -= weight;
            active++;
            resolve();
          },
          cancel: () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) {
              waiting.splice(index, 1);
              pendingBytes -= weight;
            }
            signal?.removeEventListener('abort', entry.cancel);
            reject(new DOMException('正文操作已取消', 'AbortError'));
          },
        };
        waiting.push(entry);
        pendingBytes += weight;
        signal?.addEventListener('abort', entry.cancel, { once: true });
        if (signal?.aborted) entry.cancel();
      });
    } else active++;
    try {
      checkAbort(signal);
      return await action();
    } finally {
      active--;
      waiting.shift()?.start();
    }
  };
}

/**
 * 创建独立的加密正文对象协议。调用方必须先完成权限校验，再传入可信scope。
 * put只准备不可变对象；数据库引用须由调用方在短事务内按旧修订比较后提交。
 * 本模块不接入运行链路，不改变旧正文读写，也不提供对象自动清理。
 */
export function createTextContentStore(
  backend: TextContentBackend,
  options: { maxBytes: number; concurrency?: number; readKeys: () => TextContentKeys },
) {
  const concurrency = options.concurrency ?? 2;
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 128 * 1024 * 1024 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  )
    throw new TextContentError('INVALID_CONFIG');
  if (
    !Number.isSafeInteger(backend.maxObjectBytes) ||
    backend.maxObjectBytes < options.maxBytes + overhead
  )
    throw new TextContentError('INVALID_CONFIG');
  const limited = limiter(concurrency, options.maxBytes * 2);
  function keys(): TextContentKeys {
    try {
      return options.readKeys();
    } catch {
      throw new TextContentError('INVALID_CONFIG');
    }
  }
  return {
    /** UTF-8原样保存，采用随机对象身份，不按内容覆盖既有版本。 */
    put(
      scope: string,
      text: string,
      operation: ContentOperation = {},
    ): Promise<TextContentReference> {
      return limited(
        operation.signal,
        typeof text === 'string' ? Buffer.byteLength(text) : 0,
        async () => {
          if (!identifier.safeParse(scope).success) throw new TextContentError('INVALID_REFERENCE');
          if (
            typeof text !== 'string' ||
            Buffer.byteLength(text) > options.maxBytes ||
            Buffer.from(text).toString('utf8') !== text
          )
            throw new TextContentError('INVALID_TEXT');
          const bytes = Buffer.from(text);
          const config = keys();
          if (!config || !referenceSchema.shape.keyId.safeParse(config.activeKeyId).success)
            throw new TextContentError('INVALID_CONFIG');
          const key = keyFor(config, config.activeKeyId);
          const reference: Omit<TextContentReference, 'locator'> = {
            format: 'pixelprint.text.v1',
            objectId: randomUUID(),
            scope,
            keyId: config.activeKeyId,
            encoding: 'utf-8',
            size: bytes.length,
            storedSize: bytes.length + overhead,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
          const iv = randomBytes(12);
          let packet: Buffer;
          try {
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(authenticatedData(reference));
            const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
            packet = Buffer.concat([prefix, iv, cipher.getAuthTag(), encrypted]);
          } finally {
            key.fill(0);
          }
          checkAbort(operation.signal);
          const packetHash = createHash('sha256').update(packet).digest('hex');
          let uploaded: unknown;
          try {
            uploaded = await backend.put({
              key: 'd2c-bodies/' + reference.objectId + '.bin',
              bytes: packet,
              signal: operation.signal,
            });
          } catch {
            checkAbort(operation.signal);
            throw new TextContentError('UPLOAD_FAILED');
          }
          checkAbort(operation.signal);
          // 拒绝适配器返回不可持久化定位；失败对象保留为孤立候选，绝不删除已有对象。
          const locator = safeLocator(uploaded);
          let saved: Uint8Array;
          try {
            saved = await backend.get(locator, {
              maxBytes: reference.storedSize,
              signal: operation.signal,
            });
          } catch {
            checkAbort(operation.signal);
            throw new TextContentError('VERIFY_FAILED');
          }
          checkAbort(operation.signal);
          if (
            !(saved instanceof Uint8Array) ||
            saved.byteLength !== reference.storedSize ||
            createHash('sha256').update(saved).digest('hex') !== packetHash
          )
            throw new TextContentError('INTEGRITY_FAILED');
          return { ...reference, locator };
        },
      );
    },
    /** 引用存在但损坏/失效必须报错，不以空字符串或过期库内副本掩盖故障。 */
    read(scope: string, value: unknown, operation: ContentOperation = {}): Promise<string> {
      return limited(operation.signal, options.maxBytes, async () => {
        const reference = parseTextContentReference(value);
        if (
          reference.scope !== scope ||
          reference.size > options.maxBytes ||
          reference.storedSize !== reference.size + overhead
        )
          throw new TextContentError('INVALID_REFERENCE');
        const locator = safeLocator(reference.locator);
        const key = keyFor(keys(), reference.keyId);
        let raw: Uint8Array;
        try {
          try {
            raw = await backend.get(locator, {
              maxBytes: reference.storedSize,
              signal: operation.signal,
            });
          } catch {
            checkAbort(operation.signal);
            throw new TextContentError('DOWNLOAD_FAILED');
          }
          checkAbort(operation.signal);
          if (!(raw instanceof Uint8Array) || raw.byteLength !== reference.storedSize)
            throw new TextContentError('INTEGRITY_FAILED');
          const packet = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
          if (!packet.subarray(0, prefix.length).equals(prefix))
            throw new TextContentError('INTEGRITY_FAILED');
          let bytes: Buffer;
          try {
            const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(8, 20));
            decipher.setAAD(authenticatedData(reference));
            decipher.setAuthTag(packet.subarray(20, 36));
            bytes = Buffer.concat([decipher.update(packet.subarray(36)), decipher.final()]);
          } catch {
            throw new TextContentError('INTEGRITY_FAILED');
          }
          if (
            bytes.length !== reference.size ||
            createHash('sha256').update(bytes).digest('hex') !== reference.sha256
          )
            throw new TextContentError('INTEGRITY_FAILED');
          const text = bytes.toString('utf8');
          if (!Buffer.from(text).equals(bytes)) throw new TextContentError('INTEGRITY_FAILED');
          return text;
        } finally {
          key.fill(0);
        }
      });
    },
  };
}
