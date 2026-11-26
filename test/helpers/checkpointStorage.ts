import { randomBytes } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { createCheckpointContentStore } from '../../src/functions/d2c/content/checkpointStore';
import {
  checkpointStorageSchema,
  installCheckpointContentRuntime,
} from '../../src/functions/d2c/content/checkpointRuntime';

/** 二进制协议真实加密/压缩，只有传输和数据库使用离线替身，不读取部署密钥。 */
export function enableCheckpointStorage(
  mysql: Sequelize,
  mode: 'inline' | 'shadow' | 'external' = 'external',
  thresholdBytes = 1,
  limits: { maxBytes?: number; maxObjectBytes?: number } = {},
) {
  let settings = checkpointStorageSchema.parse({
    schemaReady: true,
    mode,
    thresholdBytes,
    encryption: {
      activeKeyId: 'checkpoint-test',
      keys: { 'checkpoint-test': randomBytes(32).toString('base64') },
    },
  });
  const objects = new Map<string, Buffer>();
  const operations: Array<'put' | 'get'> = [];
  const backend = {
    maxObjectBytes: limits.maxObjectBytes ?? 2097152 + 36,
    async put(input: { key: string; bytes: Uint8Array; signal?: AbortSignal }) {
      if (input.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      operations.push('put');
      if (objects.has(input.key)) throw new Error('immutable object collision');
      objects.set(input.key, Buffer.from(input.bytes));
      return { provider: 'memory', key: input.key };
    },
    async get(locator: Record<string, unknown>, input: { maxBytes: number; signal?: AbortSignal }) {
      if (input.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      operations.push('get');
      const bytes = objects.get(String(locator.key));
      if (!bytes || bytes.length > input.maxBytes) throw new Error('object missing or oversized');
      return Buffer.from(bytes);
    },
  };
  const store = createCheckpointContentStore(backend, {
    maxObjectBytes: () => backend.maxObjectBytes,
    maxBytes: limits.maxBytes ?? 2097152,
    readKeys: () => settings.encryption!,
  });
  for (const name of ['D2cAgentCheckpoint', 'D2cAgentWrite']) {
    const model = mysql.models[name];
    if (model && typeof model.scope !== 'function') Object.assign(model, { scope: () => model });
  }
  installCheckpointContentRuntime(mysql, {
    readSettings: () => settings,
    maxBytes: limits.maxBytes ?? 2097152,
    store,
  });
  return {
    objects,
    operations,
    backend,
    store,
    settings: () => settings,
    configure(patch: Record<string, unknown>) {
      settings = checkpointStorageSchema.parse({ ...settings, ...patch });
    },
  };
}
