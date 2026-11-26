import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createBinaryContentStore, parseBinaryContentReference } from './binaryStore';
import {
  checkAbort,
  limiter,
  safeLocator,
  TextContentError,
  type ContentOperation,
  type TextContentBackend,
  type TextContentKeys,
} from './store';

export const checkpointMaximumBytes = 128 * 1024 * 1024;
const overhead = 36;
const maxParts = 256;
const maxManifestBytes = 4 * 1024 * 1024;
const identity = {
  format: z.literal('pixelprint.checkpoint.v2'),
  objectId: z.string().uuid(),
  scope: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
  size: z.number().int().min(1).max(checkpointMaximumBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const headerSchema = z.object(identity).strict();
const referenceSchema = z.object({ ...identity, manifest: z.unknown() }).strict();
const manifestSchema = z
  .object({ ...identity, parts: z.array(z.unknown()).min(1).max(maxParts) })
  .strict();
type ChunkedReference = z.infer<typeof headerSchema> & {
  manifest: ReturnType<typeof parseBinaryContentReference>;
};
export type CheckpointContentReference =
  | ReturnType<typeof parseBinaryContentReference>
  | ChunkedReference;

/** 只复制有限的普通数据；分块列表位于加密清单中，数据库引用保持固定大小。 */
export function parseCheckpointContentReference(value: unknown): CheckpointContentReference {
  const owned = safeLocator(value, true);
  if (owned.format === 'pixelprint.blob.v1') return parseBinaryContentReference(owned);
  const result = referenceSchema.safeParse(owned);
  if (!result.success) throw new TextContentError('INVALID_REFERENCE');
  const reference = { ...result.data, manifest: parseBinaryContentReference(result.data.manifest) };
  if (
    reference.manifest.scope !== partScope(reference, 'manifest') ||
    reference.manifest.size > maxManifestBytes
  )
    throw new TextContentError('INVALID_REFERENCE');
  return reference;
}

/** 每个清单和分块绑定完整父范围、随机对象身份及顺序，防止跨行或同大小分块互换。 */
function partScope(header: z.infer<typeof headerSchema>, part: number | 'manifest') {
  const hash = createHash('sha256').update(header.scope).digest('hex');
  return `checkpoint-part:${hash}:${header.objectId}:${part}`;
}

/** 原文摘要与协议大小分别核对，typed bytes全程保持二进制。 */
function digest(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

/** 新写入受动态单对象限额控制，旧对象读取沿用固定物理能力；不依赖数据库回退。 */
export function createCheckpointContentStore(
  backend: TextContentBackend,
  options: {
    maxBytes: number;
    maxObjectBytes: () => number;
    concurrency?: number;
    readKeys: () => TextContentKeys;
  },
) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > checkpointMaximumBytes
  )
    throw new TextContentError('INVALID_CONFIG');
  const legacy = createBinaryContentStore(backend, {
    maxBytes: Math.min(options.maxBytes, backend.maxObjectBytes - overhead),
    concurrency: options.concurrency,
    readKeys: options.readKeys,
  });
  const limited = limiter(options.concurrency ?? 2, options.maxBytes * 2);
  return {
    /** 全部对象上传并回读校验后才返回引用；失败时不产生可提交的半成品清单。 */
    async put(
      scope: string,
      input: Uint8Array,
      operation: ContentOperation = {},
    ): Promise<CheckpointContentReference> {
      checkAbort(operation.signal);
      let bytes: Buffer;
      try {
        if (!(input instanceof Uint8Array) || input.byteLength > options.maxBytes)
          throw new TextContentError('INVALID_TEXT');
        bytes = Buffer.from(input);
      } catch {
        throw new TextContentError('INVALID_TEXT');
      }
      const header = headerSchema.safeParse({
        format: 'pixelprint.checkpoint.v2',
        objectId: randomUUID(),
        scope,
        size: Math.max(1, bytes.length),
        sha256: digest(bytes),
      });
      if (!header.success) throw new TextContentError('INVALID_REFERENCE');
      let cap: number;
      try {
        cap = options.maxObjectBytes();
      } catch {
        throw new TextContentError('INVALID_CONFIG');
      }
      if (!Number.isSafeInteger(cap) || cap <= overhead || cap > backend.maxObjectBytes)
        throw new TextContentError('INVALID_CONFIG');
      const chunkBytes = Math.min(cap - overhead, options.maxBytes);
      if (Math.ceil(bytes.length / chunkBytes) > maxParts)
        throw new TextContentError('INVALID_TEXT');
      return limited(operation.signal, bytes.length, async () => {
        if (bytes.length <= chunkBytes) return legacy.put(scope, bytes, operation);
        const root = header.data;
        const parts = [];
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
          checkAbort(operation.signal);
          parts.push(
            await legacy.put(
              partScope(root, parts.length),
              bytes.subarray(offset, offset + chunkBytes),
              operation,
            ),
          );
        }
        const manifestBytes = Buffer.from(JSON.stringify({ ...root, parts }));
        if (manifestBytes.length > Math.min(chunkBytes, maxManifestBytes))
          throw new TextContentError('INVALID_TEXT');
        const manifest = await legacy.put(partScope(root, 'manifest'), manifestBytes, operation);
        return { ...root, manifest };
      });
    },
    /** 旧单文件协议原样读取；新清单先认证，再顺序还原分块并核对完整原文。 */
    async read(
      scope: string,
      input: unknown,
      operation: ContentOperation = {},
    ): Promise<Uint8Array> {
      checkAbort(operation.signal);
      const reference = parseCheckpointContentReference(input);
      if (reference.scope !== scope || reference.size > options.maxBytes)
        throw new TextContentError('INVALID_REFERENCE');
      if (reference.format === 'pixelprint.blob.v1')
        return legacy.read(scope, reference, operation);
      return limited(operation.signal, reference.size, async () => {
        const raw = await legacy.read(
          partScope(reference, 'manifest'),
          reference.manifest,
          operation,
        );
        let value: unknown;
        try {
          value = JSON.parse(Buffer.from(raw).toString('utf8'));
        } catch {
          throw new TextContentError('INTEGRITY_FAILED');
        }
        const checked = manifestSchema.safeParse(value);
        if (!checked.success) throw new TextContentError('INTEGRITY_FAILED');
        const { parts, ...header } = checked.data;
        const { manifest: _manifest, ...expected } = reference;
        if (JSON.stringify(header) !== JSON.stringify(expected))
          throw new TextContentError('INTEGRITY_FAILED');
        const refs = parts.map(parseBinaryContentReference);
        let size = 0;
        for (const [index, part] of refs.entries()) {
          if (!part.size || part.scope !== partScope(reference, index))
            throw new TextContentError('INTEGRITY_FAILED');
          size += part.size;
        }
        if (size !== reference.size) throw new TextContentError('INTEGRITY_FAILED');
        const result = Buffer.allocUnsafe(size);
        let offset = 0;
        for (const [index, part] of refs.entries()) {
          checkAbort(operation.signal);
          const bytes = await legacy.read(partScope(reference, index), part, operation);
          result.set(bytes, offset);
          offset += bytes.length;
        }
        checkAbort(operation.signal);
        if (digest(result) !== reference.sha256) throw new TextContentError('INTEGRITY_FAILED');
        return result;
      });
    },
  };
}
