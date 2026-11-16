import { fetch, ProxyAgent } from 'undici';
import { setTimeout as sleep } from 'node:timers/promises';
import { toolIssue } from './toolFeedback';

const context = { stage: 'tool', tool: 'prepare_slices' } as const;

/** 每次切图独享代理与重试状态，不修改进程环境、全局fetch或其他会话的凭据。 */
export function createSliceNetwork(options: {
  proxyUrl: string;
  allowedHosts: string[];
  token: string;
  signal: AbortSignal;
  uploadBytes: number;
}) {
  const dispatcher = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined;
  /** API携带Token，图片下载不携带；手工拒绝重定向并限制整个响应大小。 */
  async function request(address: string, kind: 'json' | 'image'): Promise<Buffer> {
    const url = new URL(address);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !options.allowedHosts.some((host) =>
        host.startsWith('*.')
          ? url.hostname.endsWith(host.slice(1)) && url.hostname !== host.slice(2)
          : url.hostname === host,
      ) ||
      (kind === 'json' && url.hostname !== 'api.figma.com')
    )
      throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', context);
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      let delay = 1000 * 2 ** attempt;
      try {
        const response = await fetch(url, {
          dispatcher,
          redirect: 'manual',
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]),
          headers: kind === 'json' ? { 'X-Figma-Token': options.token } : {},
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403)
            throw toolIssue('ACCESS_REQUIRED', 'CREDENTIAL_UNAVAILABLE', context);
          if (response.status === 429) {
            const raw = response.headers.get('retry-after');
            const seconds = raw === null ? NaN : Number(raw);
            delay = Math.max(
              delay,
              Number.isFinite(seconds)
                ? seconds * 1000
                : Math.max(0, Date.parse(raw ?? '') - Date.now()) || 0,
            );
            if (delay > 300000) throw toolIssue('RATE_LIMIT_WAIT', 'FIGMA_REQUEST_FAILED', context);
            if (attempt >= 2)
              throw toolIssue('RATE_LIMITED', 'FIGMA_REQUEST_FAILED', context, {
                retryAfterMs: delay,
              });
          } else if (response.status < 500 || response.status > 599) {
            throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
          } else if (attempt >= 2) throw toolIssue('NETWORK_RETRY', 'NETWORK_UNAVAILABLE', context);
        } else {
          const maximum = options.uploadBytes;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response.body ?? []) {
            size += chunk.byteLength;
            if (size > maximum) {
              throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
            }
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        }
      } catch (error) {
        options.signal.throwIfAborted();
        if (error && typeof error === 'object' && 'feedback' in error) throw error;
        const code =
          (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
          (error as { code?: string })?.code;
        if (
          [
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'SELF_SIGNED_CERT_IN_CHAIN',
            'CERT_HAS_EXPIRED',
            'DEPTH_ZERO_SELF_SIGNED_CERT',
            'ERR_TLS_CERT_ALTNAME_INVALID',
          ].includes(code ?? '')
        )
          throw toolIssue('TLS_REQUIRED', 'TLS_CERTIFICATE_FAILED', context);
        if (attempt >= 2) throw toolIssue('NETWORK_RETRY', 'NETWORK_TIMEOUT', context);
      }
      await sleep(delay, undefined, { signal: options.signal });
    }
  }
  return { request, close: () => dispatcher?.destroy() ?? Promise.resolve() };
}
