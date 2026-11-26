import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 仅检测 web/src/workspace/appRoutes.ts 历史入口读取的键是否存在（含空值）。
 * 参数值、优先级与路径转换仍由前端 readAppRoute 负责。
 */
function hasLegacyAppQuery(url: string): boolean {
  const query = new URL(url, 'http://application.local').searchParams;
  return ['workspace', 'session', 'view', 'version', 'share', 'work'].some((key) => query.has(key));
}

/** 装配公开静态首页与原 SPA 资源/深链；root 为发布静态目录，不涉及业务鉴权。 */
export async function registerPublicHome(app: FastifyInstance, root: string): Promise<void> {
  app.get(
    '/',
    {
      // 在全局 preValidation 身份解析前返回固定静态内容，不读取 Cookie 或 Token。
      onRequest: async (request, reply) => {
        if (hasLegacyAppQuery(request.url)) return;
        reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
          );
        try {
          const html = await readFile(path.join(root, 'landing.html'));
          return reply.type('text/html; charset=utf-8').send(html);
        } catch {
          // 构建资源缺失或不可读时明确失败，不回退登录或 SPA，避免导航循环。
          return reply.code(503).send({ error: 'Public home unavailable' });
        }
      },
    },
    async (_request, reply) => reply.sendFile('index.html'),
  );
  await app.register(fastifyStatic, { root, prefix: '/', wildcard: true });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (/^\/(?:api|auth|files|H5_Preview|RN_Preview)(?:\/|$)/.test(pathname))
      return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}
