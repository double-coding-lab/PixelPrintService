import type { FastifyInstance } from 'fastify';
import { createStorageFileClient } from '@/hooks/tools/storage';
import { createBinaryTextBackend } from './backend';
import { createTextContentStore, TextContentError } from './store';
import { contentStorageSchema, installTextContentRuntime } from './runtime';

/** 只在真正外置或读取引用时创建存储；默认配置不触及新列、密钥或对象服务。 */
export function installContentStorage(app: FastifyInstance): void {
  const read = () =>
    app.runtimeConfig.get<{
      d2c?: { contentStorage?: unknown; limits?: { uploadBytes?: number } };
    }>();
  const readSettings = () => contentStorageSchema.parse(read()?.d2c?.contentStorage ?? {});
  const maximum = 128 * 1024 * 1024 + 36;
  let store: ReturnType<typeof createTextContentStore> | undefined;
  installTextContentRuntime(app.mysql, {
    readSettings,
    maxBytes: maximum - 36,
    writeMaxBytes: () => {
      const configured = read()?.d2c?.limits?.uploadBytes;
      if (!Number.isSafeInteger(configured) || configured! < 1)
        throw new TextContentError('INVALID_CONFIG');
      return Math.max(0, Math.min(maximum, configured!) - 36);
    },
    store: () => {
      store ??= createTextContentStore(
        createBinaryTextBackend(createStorageFileClient(read, 'pro'), maximum),
        {
          maxBytes: maximum - 36,
          concurrency: readSettings().concurrency,
          readKeys: () => {
            const keys = readSettings().encryption;
            if (!keys) throw new TextContentError('INVALID_CONFIG');
            return keys;
          },
        },
      );
      return store;
    },
  });
}
