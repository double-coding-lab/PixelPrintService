import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import {
  checkAbort,
  keyFor,
  limiter,
  safeLocator,
  TextContentError,
  type ContentOperation,
  type TextContentBackend,
  type TextContentKeys,
} from './store';

const prefix = Buffer.from('PPBLB01\0');
const overhead = prefix.length + 12 + 16;
const maximumBytes = 128 * 1024 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const scopeSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const keyIdSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const referenceSchema = z
  .object({
    format: z.literal('pixelprint.blob.v1'),
    objectId: z.string().uuid(),
    scope: scopeSchema,
    keyId: keyIdSchema,
    encoding: z.literal('binary'),
    compression: z.enum(['gzip', 'none']),
    size: z.number().int().nonnegative().max(maximumBytes),
    storedSize: z
      .number()
      .int()
      .min(overhead)
      .max(maximumBytes + overhead),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    locator: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Immutable encrypted bytes; size/hash identify the original uncompressed payload. */
export type BinaryContentReference = z.infer<typeof referenceSchema>;

/** Copy through descriptors before validation; never execute a reference getter or toJSON. */
export function parseBinaryContentReference(value: unknown): BinaryContentReference {
  const parsed = referenceSchema.safeParse(safeLocator(value, true));
  if (!parsed.success) throw new TextContentError('INVALID_REFERENCE');
  const reference = parsed.data;
  const payloadSize = reference.storedSize - overhead;
  if (
    (reference.compression === 'none' && payloadSize !== reference.size) ||
    (reference.compression === 'gzip' && (payloadSize === 0 || payloadSize >= reference.size))
  )
    throw new TextContentError('INVALID_REFERENCE');
  return reference;
}

/** Bind every protocol field, including codec and both sizes; locator is the later upload receipt. */
function authenticatedData(reference: Omit<BinaryContentReference, 'locator'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      reference.format,
      reference.objectId,
      reference.scope,
      reference.keyId,
      reference.encoding,
      reference.compression,
      reference.size,
      reference.storedSize,
      reference.sha256,
    ]),
  );
}

/** Own the exact byte view before any await; reject hostile/detached views with fixed errors. */
function snapshotBytes(
  value: unknown,
  maximum: number,
  code: 'INVALID_TEXT' | 'INTEGRITY_FAILED',
): Buffer {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength > maximum)
      throw new TextContentError(code);
    return Buffer.from(value);
  } catch {
    throw new TextContentError(code);
  }
}

/** SHA-256 always covers bytes, with no UTF-8 or Base64 conversion. */
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Prepare immutable binary objects without database I/O or deletion. The backend must enforce
 * streaming download bounds and cancellation; callers commit references in their own transactions.
 */
export function createBinaryContentStore(
  backend: TextContentBackend,
  options: { maxBytes: number; concurrency?: number; readKeys: () => TextContentKeys },
) {
  const maxBytes = options.maxBytes;
  const concurrency = options.concurrency ?? 2;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > maximumBytes ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isSafeInteger(backend.maxObjectBytes) ||
    backend.maxObjectBytes < maxBytes + overhead
  )
    throw new TextContentError('INVALID_CONFIG');
  const limited = limiter(concurrency, maxBytes * 2);

  /** Project key-provider/getter failures instead of exposing private configuration. */
  function encryptionKey(keyId?: string): { keyId: string; key: Buffer } {
    try {
      const config = options.readKeys();
      const id = keyId ?? config.activeKeyId;
      if (!keyIdSchema.safeParse(id).success) throw new TextContentError('INVALID_CONFIG');
      return { keyId: id, key: keyFor(config, id) };
    } catch {
      throw new TextContentError('INVALID_CONFIG');
    }
  }

  return {
    /** Snapshot at invocation, then queue compression/encryption/upload with a bounded byte budget. */
    async put(
      scope: string,
      value: Uint8Array,
      operation: ContentOperation = {},
    ): Promise<BinaryContentReference> {
      checkAbort(operation.signal);
      if (!scopeSchema.safeParse(scope).success) throw new TextContentError('INVALID_REFERENCE');
      const bytes = snapshotBytes(value, maxBytes, 'INVALID_TEXT');
      return limited(operation.signal, bytes.length, async () => {
        let compressed: Buffer;
        try {
          compressed = await gzipAsync(bytes);
        } catch {
          checkAbort(operation.signal);
          throw new TextContentError('INTEGRITY_FAILED');
        }
        checkAbort(operation.signal);
        const beneficial = compressed.length < bytes.length;
        const payload = beneficial ? compressed : bytes;
        const { keyId, key } = encryptionKey();
        const reference: Omit<BinaryContentReference, 'locator'> = {
          format: 'pixelprint.blob.v1',
          objectId: randomUUID(),
          scope,
          keyId,
          encoding: 'binary',
          compression: beneficial ? 'gzip' : 'none',
          size: bytes.length,
          storedSize: payload.length + overhead,
          sha256: digest(bytes),
        };
        let packet: Buffer;
        try {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          cipher.setAAD(authenticatedData(reference));
          const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
          packet = Buffer.concat([prefix, iv, cipher.getAuthTag(), encrypted]);
        } catch {
          throw new TextContentError('INTEGRITY_FAILED');
        } finally {
          key.fill(0);
        }
        checkAbort(operation.signal);
        const packetHash = digest(packet);
        let uploaded: unknown;
        try {
          uploaded = await backend.put({
            key: `d2c-checkpoint-bodies/${reference.objectId}.bin`,
            bytes: packet,
            signal: operation.signal,
          });
        } catch {
          checkAbort(operation.signal);
          throw new TextContentError('UPLOAD_FAILED');
        }
        checkAbort(operation.signal);
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
        const verified = snapshotBytes(saved, reference.storedSize, 'INTEGRITY_FAILED');
        if (verified.length !== reference.storedSize || digest(verified) !== packetHash)
          throw new TextContentError('INTEGRITY_FAILED');
        return { ...reference, locator };
      });
    },

    /** Authenticate before decompressing, cap the entire output, and verify original bytes/hash. */
    async read(
      scope: string,
      value: unknown,
      operation: ContentOperation = {},
    ): Promise<Uint8Array> {
      checkAbort(operation.signal);
      const reference = parseBinaryContentReference(value);
      if (reference.scope !== scope || reference.size > maxBytes)
        throw new TextContentError('INVALID_REFERENCE');
      return limited(operation.signal, maxBytes, async () => {
        const { key } = encryptionKey(reference.keyId);
        try {
          let raw: Uint8Array;
          try {
            raw = await backend.get(reference.locator, {
              maxBytes: reference.storedSize,
              signal: operation.signal,
            });
          } catch {
            checkAbort(operation.signal);
            throw new TextContentError('DOWNLOAD_FAILED');
          }
          checkAbort(operation.signal);
          const packet = snapshotBytes(raw, reference.storedSize, 'INTEGRITY_FAILED');
          if (packet.length !== reference.storedSize || !packet.subarray(0, 8).equals(prefix))
            throw new TextContentError('INTEGRITY_FAILED');
          let bytes: Buffer;
          try {
            const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(8, 20));
            decipher.setAAD(authenticatedData(reference));
            decipher.setAuthTag(packet.subarray(20, 36));
            bytes = Buffer.concat([decipher.update(packet.subarray(36)), decipher.final()]);
            if (reference.compression === 'gzip')
              bytes = await gunzipAsync(bytes, {
                maxOutputLength: Math.min(reference.size, maxBytes),
              });
          } catch {
            checkAbort(operation.signal);
            throw new TextContentError('INTEGRITY_FAILED');
          }
          checkAbort(operation.signal);
          if (bytes.length !== reference.size || digest(bytes) !== reference.sha256)
            throw new TextContentError('INTEGRITY_FAILED');
          return bytes;
        } finally {
          key.fill(0);
        }
      });
    },
  };
}
