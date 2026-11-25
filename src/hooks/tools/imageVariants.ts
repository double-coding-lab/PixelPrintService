import { createD2cConfigReader } from '@/config/d2c';
import type { FastifyInstance } from 'fastify';
import { createStorageFileClient, type StorageFileClient } from './storage';
import { createRedisCommand } from '@/functions/d2c/edit/store';
import { createRedisImageVariantStore } from '@/functions/d2c/images/variantStore';
import {
  createImageVariants,
  withImageVariants,
  type ImageVariants,
} from '@/functions/d2c/images/variants';

type VariantState = { variants?: ImageVariants; closed: boolean };
declare module 'fastify' {
  interface FastifyInstance {
    imageVariantState: VariantState;
  }
}

/** 在应用初始化阶段注册关闭回调；不建立新 Redis 连接或等待任何图片任务。 */
export function installImageVariants(app: FastifyInstance) {
  if (app.hasDecorator('imageVariantState')) return;
  const state = { closed: false } as { variants?: ImageVariants; closed: boolean };
  app.decorate('imageVariantState', state);
  app.addHook('onClose', async () => {
    state.closed = true;
    await state.variants?.stop();
  });
}

/** 原客户端只供后台使用，避免派生上传重新触发自己的后台任务。 */
export function imageVariantsFor(
  app: FastifyInstance,
  binary?: StorageFileClient,
): ImageVariants | undefined {
  const state = app.imageVariantState;
  if (!state || state.closed) return undefined;
  try {
    if (state.variants) return state.variants;
    const readConfig = createD2cConfigReader(() => app.runtimeConfig.get());
    state.variants ??= createImageVariants({
      enabled: () => readConfig().d2c.imageVariants?.enabled ?? true,
      store: createRedisImageVariantStore(createRedisCommand(app.redis, 'IMAGE_REDIS_UNAVAILABLE')),
      binary: binary ?? createStorageFileClient(() => app.runtimeConfig.get(), 'pro'),
      report: (phase, imageId) =>
        app.log.error({
          title: '图片 WebP 后台生成',
          message: '缩图后台操作未完成，原图上传与读取保持正常',
          addInfo: { phase, imageId },
        }),
    });
    return state.variants;
  } catch {
    try {
      app.log.error({
        title: '图片 WebP 后台生成',
        message: '缩图后台服务暂不可用，继续使用原图',
      });
    } catch {}
    return undefined;
  }
}

/** 原图调用沿用原 client 的参数、返回值与错误；后台组件初始化也不加入等待链。 */
export function createImageFileClient(
  app: FastifyInstance,
  ...args: Parameters<typeof createStorageFileClient>
): StorageFileClient {
  const raw = createStorageFileClient(...args);
  setImmediate(() => {
    imageVariantsFor(app, raw);
  });
  return withImageVariants(raw, () => imageVariantsFor(app, raw));
}
