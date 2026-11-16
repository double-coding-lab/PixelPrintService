import { z } from 'zod';

const messages = {
  MODULE_NOT_FOUND: '预览缺少依赖模块，请补齐对应文件或预览运行环境适配。',
  UNSUPPORTED_IMPORT: '预览不支持动态或非图片 require，请使用静态导入。',
  MODULE_NOT_ALLOWED: '源码引用了预览工作区以外的模块，请检查导入路径。',
  SYNTAX_ERROR: '源码存在语法或编译错误，请检查标记位置。',
  RESOURCE_LIMIT: '预览构建超出执行环境资源限制，请检查页面规模或构建内存。',
  BUILD_FAILED: '预览构建失败，请检查入口、依赖或当前编译环境。',
  BUILD_INTERRUPTED: '预览构建已中断，可能因服务重启或执行停止。点击刷新重新构建。',
  BUILD_TIMEOUT: '预览构建超时。可点击刷新重试，持续超时请检查构建耗时或运行环境。',
} as const;

const location = z
  .string()
  .max(512)
  .regex(/^[\p{L}\p{N}_@./-]+$/u)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.split('/').includes('..') &&
      !/figd_|sk-|token|secret/i.test(value),
  );
const schema = z.object({
  code: z.enum(Object.keys(messages) as [keyof typeof messages, ...Array<keyof typeof messages>]),
  file: location.optional(),
  module: location.optional(),
  line: z.number().int().min(1).max(1000000).optional(),
  column: z.number().int().min(1).max(1000000).optional(),
});
export type PreviewDiagnostic = z.infer<typeof schema>;

/** 对编译协议与数据库旧记录统一白名单投影，不接受原始message、stack或源码。 */
export function previewDiagnostic(value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ...parsed.data, message: messages[parsed.data.code] } : null;
}

/** 旧记录也按已保存的中断/超时原因投影，保留真实编译诊断。 */
export function previewFailureDiagnostic(error: { reason?: unknown; diagnostic?: unknown } | null) {
  const reason = error?.reason;
  if (['BUILD_INTERRUPTED', 'PREVIEW_BUILD_CANCELLED'].includes(String(reason)))
    return previewDiagnostic({ code: 'BUILD_INTERRUPTED' })!;
  if (['BUILD_TIMEOUT', 'PREVIEW_BUILD_TIMEOUT'].includes(String(reason)))
    return previewDiagnostic({ code: 'BUILD_TIMEOUT' })!;
  return previewDiagnostic(error?.diagnostic) ?? previewDiagnostic({ code: 'BUILD_FAILED' })!;
}

/** 只解析可信构建脚本末尾的结构化标记，不把进程或编译器原始输出传给接口。 */
export function diagnosticFromStderr(stderr: string): PreviewDiagnostic | undefined {
  for (const line of stderr.split('\n').reverse()) {
    if (!line.startsWith('PIXELPRINT_PREVIEW_DIAGNOSTIC:')) continue;
    try {
      return (
        previewDiagnostic(JSON.parse(line.slice('PIXELPRINT_PREVIEW_DIAGNOSTIC:'.length))) ??
        undefined
      );
    } catch {
      return;
    }
  }
}

/** 服务日志仅保留固定错误码、资源阶段和安全定位，避免上游正文与凭据泄漏。 */
export function previewFailureDetails(error: unknown) {
  const value = error as {
    code?: unknown;
    networkCode?: unknown;
    stage?: unknown;
    statusCode?: unknown;
    message?: unknown;
    diagnostic?: unknown;
  } | null;
  const allowedCodes = new Set([
    'EACCES',
    'EPERM',
    'ENOENT',
    'ENOSPC',
    'EROFS',
    'EMFILE',
    'ENOMEM',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]);
  const causeCode = [value?.networkCode, value?.code].find(
    (code): code is string => typeof code === 'string' && allowedCodes.has(code),
  );
  const reason =
    typeof value?.message === 'string' &&
    /^(?:INPUT|BUILD|CACHE|PREVIEW)_[A-Z_]{1,50}$/.test(value.message)
      ? value.message
      : undefined;
  const diagnostic = previewDiagnostic(value?.diagnostic);
  return {
    ...(reason ? { failureReason: reason } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(['config', 'token', 'upload', 'download'].includes(String(value?.stage))
      ? { storageStage: String(value?.stage) }
      : {}),
    ...(Number.isInteger(value?.statusCode) ? { statusCode: Number(value?.statusCode) } : {}),
    ...(typeof value?.code === 'number' && Number.isFinite(value.code)
      ? { upstreamCode: value.code }
      : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}
