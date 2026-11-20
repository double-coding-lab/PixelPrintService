import { z } from 'zod';

/** 仅供后台日志的切图诊断；固定枚举和有界值，不接收地址、凭据或正文。 */
export const sliceDiagnosticSchema = z.object({
  phase: z.enum(['fetch_node', 'export_image', 'download_image', 'manifest']),
  reason: z.enum([
    'HTTP_ERROR',
    'RESPONSE_TOO_LARGE',
    'NETWORK_ERROR',
    'TLS_ERROR',
    'NODE_MISSING',
    'EXPORT_URL_MISSING',
    'INVALID_IMAGE',
    'INVALID_JSON',
    'MANIFEST_INCOMPLETE',
    'MANIFEST_INVALID',
  ]),
  nodeId: z
    .string()
    .regex(/^\d{1,20}:\d{1,20}$/)
    .optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  attempt: z.number().int().min(1).max(3).optional(),
  proxyUsed: z.boolean().optional(),
});
export type SliceDiagnostics = z.infer<typeof sliceDiagnosticSchema>;

/** 原始原因只留内存cause；写日志时重新投影白名单。 */
export class SliceDiagnosticError extends Error {
  constructor(
    public readonly diagnostic: SliceDiagnostics,
    cause?: unknown,
  ) {
    super('切图请求或响应校验失败', { cause });
    this.name = 'SliceDiagnosticError';
  }
}
