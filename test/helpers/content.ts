import { randomBytes } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { createTextContentStore } from '../../src/functions/d2c/content/store';
import {
  contentStorageSchema,
  installTextContentRuntime,
} from '../../src/functions/d2c/content/runtime';

/** 内存对象替身；只为新迁移集成测试启用schema scope，不改变原存储替身默认行为。 */
export function enableTextContent(
  mysql: Sequelize,
  mode: 'inline' | 'shadow' | 'external' = 'external',
  thresholdBytes = 1,
) {
  const objects = new Map<string, Buffer>();
  const operations: Array<'put' | 'get'> = [];
  const encryption = {
    activeKeyId: 'test-body',
    keys: { 'test-body': randomBytes(32).toString('base64') },
  };
  let settings = contentStorageSchema.parse({
    schemaReady: true,
    mode,
    thresholdBytes,
    encryption,
  });
  const backend = {
    maxObjectBytes: 2097152 + 36,
    async put(input: { key: string; bytes: Uint8Array }) {
      operations.push('put');
      if (objects.has(input.key)) throw new Error('immutable collision');
      objects.set(input.key, Buffer.from(input.bytes));
      return { provider: 'memory', key: input.key };
    },
    async get(locator: Record<string, unknown>, options: { maxBytes: number }) {
      operations.push('get');
      const bytes = objects.get(String(locator.key));
      if (!bytes || bytes.length > options.maxBytes) throw new Error('missing or oversized');
      return Buffer.from(bytes);
    },
  };
  const store = createTextContentStore(backend, { maxBytes: 2097152, readKeys: () => encryption });
  for (const name of ['D2cFile', 'D2cVersionFile', 'D2cSavedWorkFile']) {
    const model = mysql.models[name];
    if (model && typeof model.scope !== 'function') Object.assign(model, { scope: () => model });
  }
  installTextContentRuntime(mysql, { readSettings: () => settings, store, maxBytes: 2097152 });
  return {
    objects,
    operations,
    backend,
    store,
    settings: () => settings,
    configure: (patch: Record<string, unknown>) => {
      settings = contentStorageSchema.parse({ ...settings, ...patch });
    },
  };
}
