import { redirectToLogin } from '../auth';

const base = '/api/d2c';

export type ApiError = Error & { status?: number };
type Envelope<T> = {
  success: boolean;
  resultMessage: string;
  data: T;
  rows?: unknown[];
  total?: number;
};

/** 所有业务请求使用同源登录态，写入带 CSRF 标记；不记录请求体或凭据。 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const headers = new Headers(init.headers);
  headers.set('X-Requested-With', 'PixelPrint');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (response.status === 401) redirectToLogin();
  if (!response.ok || body?.success !== true) {
    const message =
      response.status === 401
        ? '登录已失效，请重新登录后刷新页面'
        : body?.resultMessage || `请求失败（${response.status}），请检查登录或服务状态`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return body;
}

/** 普通接口取 data；分页保留后端顶层 rows/total 契约。 */
export async function data<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request<T>(path, init)).data;
}

/** 分页列表显式检查数据形状，避免把登录页或错误响应显示成空列表。 */
export async function page<T>(path: string, signal?: AbortSignal) {
  const body = await request<unknown>(path, { signal });
  if (!Array.isArray(body.rows) || typeof body.total !== 'number') {
    throw new Error('列表响应无效，请检查服务版本');
  }
  return { rows: body.rows as T[], total: body.total };
}

/** 路径 ID 单独编码，不能改变接口路径结构。 */
export function id(value: string) {
  return encodeURIComponent(value);
}

/** 统一页面错误提示；冲突不自动重试写入，防止覆盖服务器新内容。 */
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}
