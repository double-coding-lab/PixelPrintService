import { installPreview } from '@/functions/d2c/preview/runtime';
import d2cRoutes from '@/functions/d2c/index';
import { registerHttpHooks } from '@/hooks/http/index';
import { registerTools } from '@/hooks/tools/index';
import { registerLoginRoute } from '@/hooks/http/auth';
import { registerPublicHome } from '@/hooks/http/publicHome';
import { projectConfig } from '@/config/project';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { applicationRoot } from './paths';

/** 集中注册业务模块，所有业务读取当前登录账号。 */
async function registerModules(app: FastifyInstance) {
  app.register(d2cRoutes, {
    prefix: '/d2c',
    templateRoot: path.join(applicationRoot, 'pixelprint'),
    environment: 'local',
  });
}

/** 创建单进程全栈服务；数据库、缓存、身份和存储由项目内配置装配。 */
export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: 'loopback',
    disableRequestLogging: true,
    logger: { level: projectConfig.logging.level },
  });
  await registerTools(app);
  registerHttpHooks(app);
  registerLoginRoute(app);
  app.get('/health', async () => ({ status: 'ok' }));
  /** 仅插件API允许携带个人Token的跨源调用，不扩展普通业务Cookie权限。 */
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/d2c/plugin/')) return;
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  installPreview(app);
  app.register(registerModules, { prefix: '/api' });
  if (projectConfig.storage.driver === 'local') {
    const root = path.resolve(projectConfig.storage.directory);
    await mkdir(root, { recursive: true });
    await app.register(fastifyStatic, {
      root,
      prefix: '/files/',
      decorateReply: false,
      index: false,
      setHeaders(response) {
        response.header('X-Content-Type-Options', 'nosniff');
        response.header('Content-Security-Policy', "default-src 'none'; sandbox");
        response.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  await registerPublicHome(app, path.join(applicationRoot, 'dist/public'));
  return app;
}
