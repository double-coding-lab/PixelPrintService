import type { FastifyRequest } from 'fastify';

/** 根据已验证的代理主机构造来源，拒绝认证信息、路径或多值主机。 */
function requestOrigin(protocol: string, host: string) {
  if (!['http', 'https'].includes(protocol) || /[\s,/@\\?#]/.test(host)) return null;
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

/** 同源 JSON 写入要求显式标记；浏览器来源元数据兼容代理终止 TLS，不信任任意转发头。 */
export function checkWriteRequest(request: FastifyRequest) {
  if (request.headers['x-requested-with'] !== 'PixelPrint') return false;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
    /** host 仅采用 Fastify trustProxy 判断后的值，保留外部端口并规范默认端口。 */
    if (origin === requestOrigin(request.protocol, request.host)) return true;
    /** 浏览器不能自行设置 Sec-Fetch-Site；仅兼容相同主机/端口的 HTTPS 降至代理内 HTTP。 */
    return (
      site === 'same-origin' &&
      request.protocol === 'http' &&
      url.protocol === 'https:' &&
      origin === requestOrigin('https', request.host)
    );
  } catch {
    return false;
  }
}
