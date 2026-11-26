import type { FastifyRequest } from 'fastify';
import { projectConfig } from '@/config/project';
import { sessionCookieName } from './identity';

/** 登录后只返回本站页面，拒绝外站、控制字符及认证/API 循环。 */
export function loginReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  )
    return '/workbench';
  try {
    const url = new URL(value, 'http://application.local');
    const pathname = decodeURIComponent(url.pathname);
    if (
      url.origin !== 'http://application.local' ||
      pathname.startsWith('//') ||
      /[\\\u0000-\u001f\u007f]/u.test(pathname) ||
      /^\/(?:login|logout|api|auth)(?:\/|$)/i.test(pathname)
    )
      return '/workbench';
    url.searchParams.delete('ticket');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/workbench';
  }
}

/** 对写操作校验浏览器来源；无 Origin 的本地 CLI 可使用 JSON 请求。 */
export function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (origin === undefined) return true;
  return origin === new URL(projectConfig.server.publicUrl).origin;
}

/** HTML 属性与文本统一转义，避免 returnTo 注入登录页面。 */
export function escapeHtml(value: string) {
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
export function cookie(value: string, maxAge: number) {
  return `${sessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    new URL(projectConfig.server.publicUrl).protocol === 'https:' ? '; Secure' : ''
  }`;
}
