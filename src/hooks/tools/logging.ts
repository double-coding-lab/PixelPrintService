import pino from 'pino';
import type { FastifyRequest } from 'fastify';
import { projectConfig } from '@/config/project';

export type LogData = {
  message: string;
  title?: string;
  type?: 'info' | 'warn' | 'error';
  addInfo?: Record<string, unknown>;
  [key: string]: unknown;
};

type RequestLogger = {
  (data: LogData, request?: FastifyRequest): void;
  info: (data: LogData, request?: FastifyRequest) => void;
  warn: (data: LogData, request?: FastifyRequest) => void;
  error: (data: LogData, request?: FastifyRequest) => void;
};

const logger = pino({ level: projectConfig.logging.level });
const sensitiveKey =
  /^(?:password|passwordhash|sessionsecret|cookie|setcookie|authorization|token|accesstoken|refreshtoken|apikey|apitoken|secret)$/i;

/** 递归脱敏结构化日志中的凭据，循环引用不进入序列化器。 */
function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key.replace(/[_-]/g, '')) ? '[Redacted]' : redact(item, seen),
    ]),
  );
}

/** 使用 Pino 输出结构化业务日志，只附加请求元数据，不记录 Cookie 或正文。 */
function write(type: 'info' | 'warn' | 'error', data: LogData, request?: FastifyRequest) {
  const { message, title, type: _type, addInfo, ...fields } = data;
  logger[type](
    {
      ...(redact({ ...fields, ...addInfo }) as Record<string, unknown>),
      title,
      ...(request
        ? {
            action: request.routeOptions.url,
            requestId: request.id,
            cid: request.getCid?.(),
            uid: request.uid,
            clientIP: request.ip,
          }
        : {}),
    },
    message,
  );
}

/** 默认调用与 info、warn、error 方法保持已有业务接口兼容。 */
const logging: RequestLogger = (data, request) => write(data.type ?? 'info', data, request);
logging.info = (data, request) => write('info', data, request);
logging.warn = (data, request) => write('warn', data, request);
logging.error = (data, request) => write('error', data, request);
export default logging;
