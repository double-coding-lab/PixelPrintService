/** 网关诊断仅进入服务端日志；原因使用固定说明，绝不回显供应商正文。 */
export type GatewayDiagnostics = {
  gatewayRequestId?: string;
  gatewayCode?: string;
  gatewayType?: string;
  gatewayParam?: string;
  gatewayReason?: string;
};

const codes = new Set([
  'invalid_request_error',
  'invalid_request',
  'invalid_parameter',
  'invalid_value',
  'unsupported_parameter',
  'unsupported_value',
  'context_length_exceeded',
  'content_filter',
  'rate_limit_exceeded',
  'model_not_found',
  'authentication_error',
  'permission_denied',
  'server_error',
]);
const params = new Set([
  'messages',
  'tools',
  'tool_choice',
  'reasoning_content',
  'reasoning_effort',
  'thinking',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'stream',
  'stream_options',
  'response_format',
  'model',
]);

/** 只读取错误结构的自有数据字段，不调用异常对象的 getter/toJSON。 */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** 响应编号限定为短标识；拒绝链接、空白、凭据常见前缀和任意响应头。 */
function requestId(value: unknown): string | undefined {
  if (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !/^(?:sk-|figd_|bearer|token|api[-_]?key)/i.test(value)
  )
    return value;
}

/** 兼容 SDK Headers 与普通响应头对象，只查已知请求编号头。 */
function headerRequestId(headers: unknown): string | undefined {
  for (const name of ['x-request-id', 'request-id', 'x-ms-request-id']) {
    const value =
      headers instanceof Headers
        ? headers.get(name)
        : field(
            headers,
            Object.keys(headers && typeof headers === 'object' ? headers : {}).find(
              (key) => key.toLowerCase() === name,
            ) ?? name,
          );
    const id = requestId(value);
    if (id) return id;
  }
}

/** 只在内存匹配原因特征，输出封闭说明；不复制消息中的路径、正文或参数值。 */
function reason(message: unknown, code?: string): string {
  const text = typeof message === 'string' ? message.slice(0, 16384).toLowerCase() : '';
  if (
    code === 'context_length_exceeded' ||
    /context.{0,40}(?:exceed|length|limit|long)/s.test(text)
  )
    return '网关报告上下文长度超限';
  if (/reasoning_content/.test(text) && /missing|required|must|empty|not found/.test(text))
    return '网关报告工具调用历史缺少 reasoning_content';
  if (
    /tool_call|tool_result|tool message/.test(text) &&
    /missing|respond|follow|match|must/.test(text)
  )
    return '网关报告工具调用与结果历史不完整或顺序无效';
  if (
    code === 'unsupported_parameter' ||
    /unsupported|not support|unknown parameter|unrecognized/.test(text)
  )
    return '网关报告不支持请求参数或参数值';
  if (/image|vision|multimodal/.test(text) && /invalid|not support|failed|unable|cannot/.test(text))
    return '网关报告图片输入无效或不受支持';
  if (code === 'content_filter' || /content filter|content policy/.test(text))
    return '网关报告内容策略拒绝';
  if (code === 'model_not_found') return '网关报告模型不可用';
  if (code === 'rate_limit_exceeded') return '网关报告请求限流';
  if (code === 'authentication_error') return '网关报告认证失败';
  if (code === 'permission_denied') return '网关报告权限不足';
  if (/invalid_parameter|invalid_value|invalid_request/.test(code ?? ''))
    return '网关报告请求格式或参数无效';
  return '网关未返回可安全识别的原因，请按请求编号查询网关日志';
}

/** 从最多八层 cause 中提取模型 HTTP 错误；无响应、循环和未知字段均有界退出。 */
export function diagnoseGatewayFailure(error: unknown): GatewayDiagnostics {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = field(current, 'status') ?? field(current, 'statusCode');
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      const body = field(current, 'error');
      const code = field(body, 'code') ?? field(current, 'code');
      const type = field(body, 'type') ?? field(current, 'type');
      const param = field(body, 'param') ?? field(current, 'param');
      const gatewayCode = typeof code === 'string' && codes.has(code) ? code : undefined;
      const gatewayType = typeof type === 'string' && codes.has(type) ? type : undefined;
      const gatewayParam = typeof param === 'string' && params.has(param) ? param : undefined;
      const gatewayRequestId =
        requestId(field(current, 'requestID')) ??
        requestId(field(current, 'request_id')) ??
        headerRequestId(field(current, 'headers')) ??
        requestId(field(body, 'request_id'));
      return {
        ...(gatewayRequestId ? { gatewayRequestId } : {}),
        ...(gatewayCode ? { gatewayCode } : {}),
        ...(gatewayType ? { gatewayType } : {}),
        ...(gatewayParam ? { gatewayParam } : {}),
        gatewayReason: reason(field(body, 'message') ?? field(current, 'message'), gatewayCode),
      };
    }
    current = field(current, 'cause');
  }
  return {};
}
