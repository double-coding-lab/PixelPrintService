import { createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projectConfig } from '@/config/project';

export const sessionCookieName = 'pixelprint_session';
const derivePassword = promisify(scrypt);

export type User = { userId: string; id: string; name: string; cname: string };

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

/** 验证签名、编码、时限与本地账号是否仍存在；无效会话不返回任何身份。 */
export function readSession(token: string | undefined, now = Date.now()): string | null {
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
      value.exp - value.iat > projectConfig.auth.sessionTtlSeconds ||
      !projectConfig.auth.users.some((user) => user.id === value.sub)
    )
      return null;
    return value.sub;
  } catch {
    return null;
  }
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
    this.user = {
      userId: user?.id ?? '',
      id: user?.id ?? '',
      name: user?.name ?? '',
      cname: user?.name ?? '',
    };
    return this.user;
  });
  app.decorateRequest('getCid', function (this: FastifyRequest) {
    return this.id;
  });
}
