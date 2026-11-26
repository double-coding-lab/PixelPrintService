import { createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectConfig } from '@/config/project';
import { isExternalUserId } from '@/common/userIdentity';

export const sessionCookieName = 'pixelprint_session';
const derivePassword = promisify(scrypt);

export type IdentityProvider = 'local' | 'github' | 'guest';
export type SessionIdentity = {
  id: string;
  name: string;
  provider: IdentityProvider;
  expiresAt: number;
};
export type User = {
  userId: string;
  id: string;
  name: string;
  cname: string;
  provider?: IdentityProvider;
  expiresAt?: number;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: User | undefined;
    getUser(): Promise<User>;
    uid: string | null | undefined;
    getUid(): Promise<string | null>;
    getCid(): string;
  }
}

/** 启动时拒绝缺失或过短的会话密钥及无效时限，禁止默认匿名身份。 */
export function validateSessionConfig() {
  const { sessionSecret, sessionTtlSeconds } = projectConfig.auth;
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('auth.sessionSecret must contain at least 32 bytes');
  }
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error('auth.sessionTtlSeconds must be a positive integer');
  }
  if (projectConfig.auth.users.some((user) => /^(?:github|guest)-/i.test(user.id)))
    throw new Error('auth.users.id reserves github- and guest- prefixes for external identities');
  const github = projectConfig.auth.github;
  if (github?.enabled && (!github.clientId.trim() || !github.clientSecret.trim()))
    throw new Error('auth.github requires clientId and clientSecret');
}

/** 验证 scrypt$saltHex$keyHex；salt 的十六进制文本直接作为 Node scrypt 的盐值。 */
export async function verifyPassword(password: unknown, passwordHash: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 4096) return false;
  const parts = /^scrypt\$([a-f\d]{32,128})\$([a-f\d]{128})$/i.exec(passwordHash);
  if (!parts || parts[1].length % 2) return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = (await derivePassword(password, parts[1], 64)) as Buffer;
  return timingSafeEqual(actual, expected);
}

/** 对编码后的会话载荷计算 HMAC，不接受客户端声明的算法。 */
function signature(payload: string) {
  return createHmac('sha256', projectConfig.auth.sessionSecret).update(payload).digest('base64url');
}

/** 签发带创建时间与过期时间的会话，身份仅保存本地用户 ID。 */
export function createSession(userId: string, now = Date.now()): string {
  validateSessionConfig();
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      iat: issuedAt,
      exp: issuedAt + projectConfig.auth.sessionTtlSeconds,
    }),
  ).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

/** 访客有效期固定且不滑动续期；同一浏览器刷新继续使用原临时身份。 */
export function guestSessionTtlSeconds() {
  return Math.min(
    projectConfig.auth.sessionTtlSeconds,
    projectConfig.auth.guest?.ttlSeconds ?? 86400,
  );
}

/** 仅由已验证的 GitHub 回调或服务端访客入口签发，客户端不能自报身份。 */
export function createExternalSession(
  identity: Pick<SessionIdentity, 'id' | 'name'> & { provider: 'github' | 'guest' },
  now = Date.now(),
): string {
  validateSessionConfig();
  if (
    !isExternalUserId(identity.id) ||
    !identity.id.startsWith(identity.provider + '-') ||
    !identity.name ||
    identity.name.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(identity.name)
  )
    throw new Error('Invalid external identity');
  if (
    identity.provider === 'guest'
      ? !projectConfig.auth.guest?.enabled
      : !projectConfig.auth.github?.enabled
  )
    throw new Error('Identity provider disabled');
  const iat = Math.floor(now / 1000);
  const ttl =
    identity.provider === 'guest' ? guestSessionTtlSeconds() : projectConfig.auth.sessionTtlSeconds;
  const payload = Buffer.from(
    JSON.stringify({
      sub: identity.id,
      name: identity.name,
      provider: identity.provider,
      iat,
      exp: iat + ttl,
    }),
  ).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

/** 验证签名、编码、时限和身份提供方；本地账号仍实时复查配置中的存在性。 */
export function readSessionIdentity(
  token: string | undefined,
  now = Date.now(),
): SessionIdentity | null {
  if (!token || token.length > 4096) return null;
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) return null;
  const expected = Buffer.from(signature(parts[1]));
  const supplied = Buffer.from(parts[2]);
  if (!timingSafeEqual(expected, supplied)) return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64url');
    if (decoded.toString('base64url') !== parts[1]) return null;
    const value = JSON.parse(decoded.toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (
      typeof value.sub !== 'string' ||
      !value.sub ||
      !Number.isSafeInteger(value.iat) ||
      !Number.isSafeInteger(value.exp) ||
      value.iat > seconds ||
      value.exp <= seconds ||
      value.exp <= value.iat ||
      value.exp - value.iat > projectConfig.auth.sessionTtlSeconds
    )
      return null;
    if (value.provider === undefined || value.provider === 'local') {
      const user = projectConfig.auth.users.find((user) => user.id === value.sub);
      return user && !/^(?:github|guest)-/i.test(user.id)
        ? { id: user.id, name: user.name, provider: 'local', expiresAt: value.exp * 1000 }
        : null;
    }
    if (
      !isExternalUserId(value.sub) ||
      typeof value.name !== 'string' ||
      !value.name ||
      value.name.length > 160 ||
      /[\u0000-\u001f\u007f]/u.test(value.name)
    )
      return null;
    if (
      (value.provider === 'github' &&
        projectConfig.auth.github?.enabled &&
        value.sub.startsWith('github-')) ||
      (value.provider === 'guest' &&
        projectConfig.auth.guest?.enabled &&
        value.sub.startsWith('guest-') &&
        value.exp - value.iat <= guestSessionTtlSeconds())
    )
      return {
        id: value.sub,
        name: value.name,
        provider: value.provider,
        expiresAt: value.exp * 1000,
      };
    return null;
  } catch {
    return null;
  }
}

/** 兼容既有调用方的账号 ID 读取接口。 */
export function readSession(token: string | undefined, now = Date.now()): string | null {
  return readSessionIdentity(token, now)?.id ?? null;
}

/** 只读取指定会话 Cookie，不信任 Header、业务参数或客户端用户 ID。 */
function sessionToken(request: FastifyRequest): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${sessionCookieName}=`));
  return values.length === 1 ? values[0].slice(sessionCookieName.length + 1) : undefined;
}

/** 仅对本地配置的 API Token 做固定长度摘要恒定时间比较。 */
function bearerUserId(request: FastifyRequest): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
  if (!match || match[1].length > 4096) return null;
  const supplied = createHash('sha256').update(match[1]).digest();
  let id: string | null = null;
  for (const user of projectConfig.auth.users) {
    const token = user.apiToken;
    if (typeof token !== 'string' || token.length < 32) continue;
    const expected = createHash('sha256').update(token).digest();
    if (timingSafeEqual(supplied, expected)) id = user.id;
  }
  return id;
}

/** 注入请求级身份缓存；旧 userId 字段等于本地 userid，便于归属校验兼容。 */
export function registerIdentity(app: FastifyInstance) {
  validateSessionConfig();
  app.decorateRequest('uid', undefined);
  app.decorateRequest('user', undefined);
  app.decorateRequest('getUid', async function (this: FastifyRequest) {
    if (this.uid === undefined) this.uid = readSession(sessionToken(this)) ?? bearerUserId(this);
    return this.uid;
  });
  app.decorateRequest('getUser', async function (this: FastifyRequest) {
    if (this.user !== undefined) return this.user;
    const id = await this.getUid();
    const user = projectConfig.auth.users.find((item) => item.id === id);
    const external = readSessionIdentity(sessionToken(this));
    const profile = user
      ? { id: user.id, name: user.name, provider: 'local' as const }
      : external?.id === id
        ? external
        : undefined;
    this.user = {
      userId: profile?.id ?? '',
      id: profile?.id ?? '',
      name: profile?.name ?? '',
      cname: profile?.name ?? '',
      provider: profile?.provider,
      expiresAt: external?.id === id ? external.expiresAt : undefined,
    };
    return this.user;
  });
  app.decorateRequest('getCid', function (this: FastifyRequest) {
    return this.id;
  });
}
