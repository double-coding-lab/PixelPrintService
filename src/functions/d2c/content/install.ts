import type { FastifyInstance } from 'fastify';
import { createImageFileClient } from '@/hooks/tools/imageVariants';
import { createBinaryTextBackend } from './backend';
import { createTextContentStore, TextContentError } from './store';
import { contentStorageSchema, installTextContentRuntime } from './runtime';
import { checkpointStorageSchema, installCheckpointContentRuntime } from './checkpointRuntime';
import { createCheckpointContentStore, checkpointMaximumBytes } from './checkpointStore';

/** 只在真正外置或读取引用时创建存储；默认配置不触及新列、密钥或对象服务。 */
export function installContentStorage(app: FastifyInstance): void {
  const read = () =>
    app.runtimeConfig.get<{
      d2c?: {
        contentStorage?: unknown;
        checkpointStorage?: unknown;
        limits?: { uploadBytes?: number };
      };
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
        createBinaryTextBackend(createImageFileClient(app, read, 'pro'), maximum),
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
  /** 执行状态独立装配；新正文统一文件存储，旧BLOB继续原样读取。 */
  const readCheckpointSettings = () =>
    checkpointStorageSchema.parse(read()?.d2c?.checkpointStorage ?? {});
  let checkpointStore: ReturnType<typeof createCheckpointContentStore> | undefined;
  installCheckpointContentRuntime(app.mysql, {
    readSettings: readCheckpointSettings,
    maxBytes: checkpointMaximumBytes,
    store: () => {
      checkpointStore ??= createCheckpointContentStore(
        createBinaryTextBackend(createImageFileClient(app, read, 'pro'), maximum),
        {
          maxBytes: checkpointMaximumBytes,
          maxObjectBytes: () => {
            const configured = read()?.d2c?.limits?.uploadBytes;
            if (!Number.isSafeInteger(configured) || configured! <= 36)
              throw new TextContentError('INVALID_CONFIG');
            return Math.min(maximum, configured!);
          },
          concurrency: readCheckpointSettings().concurrency,
          readKeys: () => {
            const keys = readCheckpointSettings().encryption;
            if (!keys) throw new TextContentError('INVALID_CONFIG');
            return keys;
          },
        },
      );
      return checkpointStore;
    },
  });
}
