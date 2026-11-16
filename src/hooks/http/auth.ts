import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectConfig } from '@/config/project';
import {
  createSession,
  sessionCookieName,
  validateSessionConfig,
  verifyPassword,
} from './identity';

/** 登录后只返回本站页面，拒绝外站、控制字符及认证/API 循环。 */
export function loginReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  )
    return '/';
  try {
    const url = new URL(value, 'http://application.local');
    const pathname = decodeURIComponent(url.pathname);
    if (
      url.origin !== 'http://application.local' ||
      pathname.startsWith('//') ||
      /[\\\u0000-\u001f\u007f]/u.test(pathname) ||
      /^\/(?:login|logout|api)(?:\/|$)/i.test(pathname)
    )
      return '/';
    url.searchParams.delete('ticket');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

/** 对写操作校验浏览器来源；无 Origin 的本地 CLI 可使用 JSON 请求。 */
function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (origin === undefined) return true;
  return origin === new URL(projectConfig.server.publicUrl).origin;
}

/** HTML 属性与文本统一转义，避免 returnTo 注入登录页面。 */
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

/** 会话 Cookie 使用固定作用域；HTTPS 部署额外启用 Secure。 */
function cookie(value: string, maxAge: number) {
  return `${sessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    new URL(projectConfig.server.publicUrl).protocol === 'https:' ? '; Secure' : ''
  }`;
}

/** 注册本地账号登录页面、表单/JSON 登录和退出；所有路由禁止缓存私有内容。 */
export function registerLoginRoute(app: FastifyInstance) {
  validateSessionConfig();
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
  }
  const config = { privatePayload: true };
  app.get('/login', { config }, async (request, reply) => {
    const returnTo = loginReturnPath((request.query as { returnTo?: unknown }).returnTo);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><h1>登录</h1><form action="/login" method="post"><label>账号 <input name="id" autocomplete="username" required></label><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button type="submit">登录</button></form></html>`,
      );
  });
  app.post('/login', { config, bodyLimit: 16384 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'Invalid request origin' });
    const body = request.body as {
      id?: unknown;
      username?: unknown;
      password?: unknown;
      returnTo?: unknown;
    } | null;
    const id = body?.id ?? body?.username;
    const user =
      typeof id === 'string' ? projectConfig.auth.users.find((item) => item.id === id) : undefined;
    // 未知账号也执行相同 scrypt 工作，错误响应不暴露账号是否存在。
    const hash = user?.passwordHash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    const valid = await verifyPassword(body?.password, hash);
    if (!user || !valid) return reply.code(401).send({ error: 'Invalid username or password' });
    return reply
      .header('Set-Cookie', cookie(createSession(user.id), projectConfig.auth.sessionTtlSeconds))
      .redirect(loginReturnPath(body?.returnTo), 303);
  });
  app.post('/logout', { config }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'Invalid request origin' });
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  });
}

/** 为业务模块注册本地登录校验；无会话和无效会话一律拒绝。 */
export function registerAuthGuard(app: FastifyInstance) {
  app.addHook('preHandler', async (request, reply) => {
    if (!(await request.getUser()).userId) {
      return reply.code(401).send({ error: 'Login required' });
    }
  });
}
