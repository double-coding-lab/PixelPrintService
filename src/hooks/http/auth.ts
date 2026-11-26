import type { FastifyInstance } from 'fastify';
import { projectConfig } from '@/config/project';
import { createSession, validateSessionConfig, verifyPassword } from './identity';

import { cookie, escapeHtml, loginReturnPath, sameOrigin } from './authUtils';
import { registerExternalAuth, type ExternalAuthOptions } from './externalAuth';
export { loginReturnPath } from './authUtils';

/** 注册本地账号登录页面、表单/JSON 登录和退出；所有路由禁止缓存私有内容。 */
export function registerLoginRoute(app: FastifyInstance, options: ExternalAuthOptions = {}) {
  validateSessionConfig();
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
  }
  const config = { privatePayload: true };
  registerExternalAuth(app, options);
  app.get('/login', { config }, async (request, reply) => {
    const returnTo = loginReturnPath((request.query as { returnTo?: unknown }).returnTo);
    const github = projectConfig.auth.github?.enabled === true;
    const guest = projectConfig.auth.guest?.enabled === true;
    const error = (request.query as { error?: unknown }).error;
    const errors: Record<string, string> = {
      github_state: '登录请求已过期或与当前浏览器不一致，请重新登录。',
      github_denied: '已取消 GitHub 授权，可以重新选择登录方式。',
      github_failed: 'GitHub 登录暂时失败，请稍后重试。',
      github_unavailable: 'GitHub 登录暂不可用，请使用其他登录方式。',
    };
    const notice = typeof error === 'string' ? errors[error] : undefined;
    return reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · PixelPrint</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;background:#f5f7fb;color:#1f2937;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:420px;padding:36px;border:1px solid #e4e7ee;border-radius:20px;background:white;box-shadow:0 16px 60px #24365a0a}.logo{font-size:14px;color:#466dcc;font-weight:700;letter-spacing:.5px}h1{margin:10px 0;font-size:26px;letter-spacing:-.5px}.hint{color:#7c8597;font-size:13px}a.button,button{display:block;width:100%;margin:16px 0 0;padding:12px;border:1px solid #dce1eb;border-radius:10px;text-align:center;text-decoration:none;font:inherit;font-weight:600;cursor:pointer;color:#28374e;background:white}.github{background:#202938!important;color:white!important;border-color:#202938!important}button:hover,a.button:hover{filter:brightness(.96)}.disabled{opacity:.55;cursor:default!important}.guest{color:#466dcc}.notice{padding:10px 12px;background:#fff5e8;border-radius:8px;color:#936318;font-size:13px}label{display:block;margin-top:12px;font-size:13px}input:not([type=hidden]){display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #dce1eb;border-radius:8px;font:inherit}details{margin-top:26px;padding-top:20px;border-top:1px solid #edf0f5}summary{cursor:pointer;color:#7c8597;font-size:13px}small{display:block;margin-top:14px;color:#8a93a3;font-size:12px}</style></head><body><main><div class="logo">PIXELPRINT</div><h1>开始你的创作</h1><p class="hint">登录后保留个人工作区，或先以访客身份体验。</p>${notice ? `<p class="notice" role="alert">${notice}</p>` : ''}${github ? `<a class="button github" href="/auth/github?${escapeHtml(new URLSearchParams({ returnTo }).toString())}">使用 GitHub 登录</a>` : '<button class="github disabled" disabled>GitHub 登录尚未配置</button>'}${guest ? `<form action="/auth/guest" method="post"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button class="guest" type="submit">以访客身份体验 →</button></form><small>访客身份在本浏览器最多保留 ${Math.ceil(Math.min(projectConfig.auth.sessionTtlSeconds, projectConfig.auth.guest?.ttlSeconds ?? 86400) / 3600)} 小时。退出或清除 Cookie 后无法找回访客数据。AI 任务需配置自己的模型凭据。</small>` : ''}<details${!github && !guest ? ' open' : ''}><summary>使用本地账号登录</summary><form action="/login" method="post"><label>账号<input name="id" autocomplete="username" required></label><label>密码<input type="password" name="password" autocomplete="current-password" required></label><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button type="submit">登录</button></form></details></main></body></html>`,
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
