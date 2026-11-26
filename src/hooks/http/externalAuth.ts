import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { projectConfig } from '@/config/project';
import { cookie, loginReturnPath, sameOrigin } from './authUtils';
import { createExternalSession, guestSessionTtlSeconds } from './identity';
import { exchangeGitHubCode, type GitHubExchange } from './github';

export type ExternalAuthOptions = { github?: { exchangeCode: GitHubExchange } };
const nonceCookie = 'pixelprint_oauth';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stateKey = (state: string) => 'pixelprint:oauth:github:' + digest(state);

/** OAuth Cookie 仅用于浏览器绑定；服务端 Redis 保存一次性的 PKCE 和回跳信息。 */
function oauthCookie(value: string, ttl: number) {
  return `${nonceCookie}=${value}; Path=/auth/github; HttpOnly; SameSite=Lax; Max-Age=${ttl}${new URL(projectConfig.server.publicUrl).protocol === 'https:' ? '; Secure' : ''}`;
}

/** 注册 GitHub、访客和当前身份入口；所有身份均由服务端签发。 */
export function registerExternalAuth(app: FastifyInstance, options: ExternalAuthOptions = {}) {
  const config = { privatePayload: true };
  const callback = () => new URL('/auth/github/callback', projectConfig.server.publicUrl).href;
  app.get('/auth/me', { config }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await request.getUser();
    if (!user.userId) return reply.code(401).send({ error: 'Login required' });
    return {
      userId: user.userId,
      name: user.name,
      provider: user.provider,
      expiresAt: user.expiresAt,
      githubEnabled: projectConfig.auth.github?.enabled === true,
      guestEnabled: projectConfig.auth.guest?.enabled === true,
    };
  });
  app.post('/auth/guest', { config, bodyLimit: 16384 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'Invalid request origin' });
    if (!projectConfig.auth.guest?.enabled)
      return reply.code(403).send({ error: 'Guest access disabled' });
    const returnTo = loginReturnPath(
      (request.body as { returnTo?: unknown } | undefined)?.returnTo,
    );
    if ((await request.getUser()).userId) return reply.redirect(returnTo, 303);
    const id = 'guest-' + randomUUID();
    const token = createExternalSession({ id, name: '访客 ' + id.slice(6, 14), provider: 'guest' });
    return reply
      .header('Set-Cookie', cookie(token, guestSessionTtlSeconds()))
      .redirect(returnTo, 303);
  });
  app.get('/auth/github', { config }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const github = projectConfig.auth.github;
    if (!github?.enabled) return reply.code(503).send({ error: 'GitHub login is not configured' });
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const returnTo = loginReturnPath((request.query as { returnTo?: unknown }).returnTo);
    try {
      await app.redis.set(
        stateKey(state),
        JSON.stringify({ nonceHash: digest(nonce), verifier, returnTo }),
        { EX: 600 },
      );
    } catch {
      return reply.code(503).send({ error: 'GitHub login temporarily unavailable' });
    }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: github.clientId,
      redirect_uri: callback(),
      scope: 'read:user',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return reply.header('Set-Cookie', oauthCookie(nonce, 600)).redirect(url.href);
  });
  app.get('/auth/github/callback', { config }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const fail = (reason: string) =>
      reply.header('Set-Cookie', oauthCookie('', 0)).redirect('/login?error=' + reason, 303);
    if (!projectConfig.auth.github?.enabled) return fail('github_unavailable');
    const query = request.query as { state?: unknown; code?: unknown; error?: unknown };
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(nonceCookie + '='));
    const nonce = cookies.length === 1 ? cookies[0].slice(nonceCookie.length + 1) : '';
    if (
      typeof query.state !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce)
    )
      return fail('github_state');
    let record: { nonceHash: string; verifier: string; returnTo: string };
    try {
      const raw = await app.redis.getDel(stateKey(query.state));
      if (!raw) return fail('github_state');
      record = JSON.parse(raw);
      if (
        typeof record.nonceHash !== 'string' ||
        !/^[a-f\d]{64}$/.test(record.nonceHash) ||
        !timingSafeEqual(Buffer.from(record.nonceHash), Buffer.from(digest(nonce))) ||
        typeof record.verifier !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.verifier)
      )
        return fail('github_state');
    } catch {
      return reply
        .header('Set-Cookie', oauthCookie('', 0))
        .code(503)
        .send({ error: 'GitHub login temporarily unavailable' });
    }
    if (query.error) return fail('github_denied');
    if (
      typeof query.code !== 'string' ||
      !query.code ||
      query.code.length > 1024 ||
      /[\u0000-\u0020\u007f]/u.test(query.code)
    )
      return fail('github_state');
    try {
      const profile = await (options.github?.exchangeCode ?? exchangeGitHubCode)({
        code: query.code,
        codeVerifier: record.verifier,
        redirectUri: callback(),
      });
      if (!/^[1-9]\d{0,19}$/.test(profile.id) || typeof profile.login !== 'string')
        return fail('github_failed');
      const name =
        (profile.name || profile.login)
          .replace(/[\u0000-\u001f\u007f]/gu, ' ')
          .trim()
          .slice(0, 160) || profile.login;
      const token = createExternalSession({ id: 'github-' + profile.id, name, provider: 'github' });
      return reply
        .header('Set-Cookie', [
          cookie(token, projectConfig.auth.sessionTtlSeconds),
          oauthCookie('', 0),
        ])
        .redirect(loginReturnPath(record.returnTo), 303);
    } catch {
      return fail('github_failed');
    }
  });
}
