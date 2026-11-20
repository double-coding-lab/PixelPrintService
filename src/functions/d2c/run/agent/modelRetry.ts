import { RunExecutionError } from '../errors';

export type ModelRetryPlan = { delayMs: number; attempt: number; rateLimited: boolean };

/** 读取响应等待头，兼容SDK的Headers和普通对象；不把上游正文加入事件。 */
function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return;
  if ('get' in headers && typeof headers.get === 'function') {
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

/** 临时失败最多重试两次；429遵守Retry-After，长等待交回用户，权限与执行资格异常不重试。 */
export function modelRetryPlan(
  error: unknown,
  attempt: number,
  now = Date.now(),
): ModelRetryPlan | undefined {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 2) return;
  let current = error;
  let retryable = false;
  let rateLimited = false;
  let requestedDelay = 0;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) return;
    seen.add(current);
    if (
      current instanceof RunExecutionError &&
      !(current.code === 'MODEL_REQUEST_FAILED' && current.context.stage === 'model')
    )
      return;
    const value = current as {
      name?: unknown;
      status?: unknown;
      code?: unknown;
      cause?: unknown;
      headers?: unknown;
    };
    if (current instanceof Error) {
      const kind = current.constructor.name;
      if (['APIUserAbortError', 'AbortError'].includes(kind) || current.name === 'AbortError')
        return;
      if (['APIConnectionTimeoutError', 'APIConnectionError'].includes(kind)) retryable = true;
    }
    if (typeof value.status === 'number' && [400, 401, 403, 404].includes(value.status)) return;
    if (value.status === 429) {
      rateLimited = true;
      const after = header(value.headers, 'retry-after');
      const millis = header(value.headers, 'retry-after-ms');
      let delay: number | undefined;
      if (after !== undefined) {
        const seconds = Number(after);
        delay =
          after.trim() && Number.isFinite(seconds)
            ? seconds >= 0
              ? seconds * 1000
              : undefined
            : Date.parse(after) - now;
      }
      if (
        millis !== undefined &&
        millis.trim() &&
        Number.isFinite(Number(millis)) &&
        Number(millis) >= 0
      )
        delay = Math.max(delay ?? 0, Number(millis));
      if (delay !== undefined && Number.isFinite(delay))
        requestedDelay = Math.max(requestedDelay, Math.max(0, delay));
      else requestedDelay = Math.max(requestedDelay, attempt === 0 ? 5000 : 15000);
    }
    if (typeof value.status === 'number' && [408, 500, 502, 503, 504].includes(value.status))
      retryable = true;
    if (
      typeof value.code === 'string' &&
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(value.code)
    )
      retryable = true;
    current = value.cause;
  }
  if (current) return;
  if ((!rateLimited && !retryable) || requestedDelay > 60000) return;
  return {
    delayMs: rateLimited ? Math.ceil(requestedDelay) : 250 * (attempt + 1),
    attempt: attempt + 1,
    rateLimited,
  };
}

/** 保留调用方使用的瞬时故障判定入口，实际等待由重试计划统一决定。 */
export function canRetryModelRequest(error: unknown): boolean {
  return modelRetryPlan(error, 0) !== undefined;
}

/** 只识别 SDK 固定异常类型及网络码，不按任意消息正文猜测超时。 */
export function modelNetworkFailure(
  error: unknown,
): 'NETWORK_TIMEOUT' | 'NETWORK_UNAVAILABLE' | undefined {
  let current = error;
  let result: 'NETWORK_TIMEOUT' | 'NETWORK_UNAVAILABLE' | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) return;
    seen.add(current);
    if (
      current instanceof RunExecutionError &&
      !(current.code === 'MODEL_REQUEST_FAILED' && current.context.stage === 'model')
    )
      return;
    const value = current as { code?: unknown; status?: unknown; cause?: unknown };
    if (typeof value.status === 'number' && [400, 401, 403, 404, 429].includes(value.status))
      return;
    const kind = current instanceof Error ? current.constructor.name : '';
    if (kind === 'APIUserAbortError' || (current instanceof Error && current.name === 'AbortError'))
      return;
    if (
      kind === 'APIConnectionTimeoutError' ||
      ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(
        String(value.code),
      )
    )
      result = 'NETWORK_TIMEOUT';
    else if (
      !result &&
      (kind === 'APIConnectionError' ||
        ['ECONNRESET', 'UND_ERR_SOCKET'].includes(String(value.code)))
    )
      result = 'NETWORK_UNAVAILABLE';
    current = value.cause;
  }
  return current ? undefined : result;
}
