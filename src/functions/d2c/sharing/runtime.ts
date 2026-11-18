import type { FastifyInstance } from 'fastify';
import { createD2cConfigReader } from '@/config/d2c';
import { createPreviewCache } from '../preview/cache';
import { sessionPreviewInput } from '../preview/session';
import { publishedSession } from './access';
import type { EditService } from '../edit/service';
import { EDIT_TTL_MS } from '../edit/store';
import type { createSavedWorkService } from '../savedWork/service';
import type { createSharingService } from './service';

type SavedWorks = ReturnType<typeof createSavedWorkService>;
type Sharing = ReturnType<typeof createSharingService>;

declare module 'fastify' {
  interface FastifyInstance {
    getSharingService(): Promise<Sharing>;
    getSavedWorkService(): Promise<SavedWorks>;
    getPlazaEditService(): Promise<EditService>;
    getSavedWorkEditService(): Promise<EditService>;
  }
}

/** 按需装配隔离编辑器；广场、个人作品与原工作区使用不同 Redis 命名空间。 */
export function installSharingEditors(app: FastifyInstance) {
  let runtime: Promise<Awaited<ReturnType<typeof initialize>>> | undefined;
  let plaza: Promise<EditService> | undefined;
  let personal: Promise<EditService> | undefined;

  /** 客户端仅在首次实际访问时初始化，注册路由不会触发数据库或存储请求。 */
  async function initialize() {
    const [{ createStorageFileClient }, { createSharingService }, { createSavedWorkService }] =
      await Promise.all([
        import('@/hooks/tools/storage'),
        import('./service'),
        import('../savedWork/service'),
      ]);
    const readConfig = createD2cConfigReader(() => app.runtimeConfig.get());
    const binary = createStorageFileClient(readConfig, 'pro');
    const options = { binary: () => binary, readLimits: () => readConfig().d2c.limits };
    return {
      ...options,
      sharing: createSharingService(app.mysql, options),
      works: createSavedWorkService(app.mysql, options),
    };
  }

  /** 初始化失败允许下次重试，不缓存永久 rejected Promise。 */
  function getRuntime() {
    runtime ??= initialize().catch((error) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  }

  app.decorate('getSharingService', async () => (await getRuntime()).sharing);
  app.decorate('getSavedWorkService', async () => (await getRuntime()).works);
  app.decorate('getPlazaEditService', async () => {
    plaza ??= Promise.all([getRuntime(), import('../edit/service'), import('../edit/store')])
      .then(([runtime, { createEditService }, { createRedisEditStore }]) =>
        createEditService(app.mysql, {
          store: createRedisEditStore(app.redis, 'pixelprint:plaza-edit:v1'),
          binary: runtime.binary,
          readLimits: runtime.readLimits,
          cache: createPreviewCache('.runtime/plaza-edit-previews', { ttlMs: EDIT_TTL_MS }),
          detached: {
            previewPrefix: 'plazaedit-',
            authorize: async (eid, sourceId) => {
              await publishedSession(app.mysql, eid, sourceId);
            },
            source: async (eid, sourceId, entryPath, transaction, limits) => {
              const published = await publishedSession(app.mysql, eid, sourceId, transaction);
              const frozen = await sessionPreviewInput(
                app.mysql,
                eid,
                published.session.sessionId!,
                entryPath,
                transaction,
                limits,
                false,
                async () => publishedSession(app.mysql, eid, sourceId, transaction),
              );
              return {
                ...frozen,
                fileRevision: frozen.session.fileRevision,
                target: frozen.session.target!,
              };
            },
          },
        }),
      )
      .catch((error) => {
        plaza = undefined;
        throw error;
      });
    return plaza;
  });
  app.decorate('getSavedWorkEditService', async () => {
    personal ??= Promise.all([getRuntime(), import('../edit/service'), import('../edit/store')])
      .then(([runtime, { createEditService }, { createRedisEditStore }]) =>
        createEditService(app.mysql, {
          store: createRedisEditStore(app.redis, 'pixelprint:work-edit:v1'),
          binary: runtime.binary,
          readLimits: runtime.readLimits,
          cache: createPreviewCache('.runtime/work-edit-previews', { ttlMs: EDIT_TTL_MS }),
          detached: {
            previewPrefix: 'workedit-',
            authorize: async (eid, sourceId) => {
              await runtime.works.authorize(eid, sourceId);
            },
            source: (eid, sourceId, entryPath, transaction, limits) =>
              runtime.works.source(eid, sourceId, entryPath, transaction, limits),
          },
        }),
      )
      .catch((error) => {
        personal = undefined;
        throw error;
      });
    return personal;
  });
  app.addHook('preClose', async () => {
    for (const pending of [plaza, personal]) {
      if (pending)
        await pending.then(
          (service) => service.close(),
          () => undefined,
        );
    }
  });
}
