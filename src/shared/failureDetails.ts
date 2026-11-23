import { z } from 'zod';

/** 框架固定错误码由服务端分类与前端诊断共用。 */
export const frameworkErrorCodes = [
  'DEEP_ARCHIVE_EXISTS',
  'DEEP_ARCHIVE_FAILED',
  'DEEP_ARCHIVE_INVALID',
  'DEEP_ARCHIVE_LIMIT',
  'DEEP_ARCHIVE_MISSING',
  'DEEP_ARCHIVE_PAGE',
  'DEEP_ARCHIVE_PATH',
  'DEEP_ARCHIVE_UNAVAILABLE',
  'DEEP_BACKGROUND_SUBAGENT_RESULT_MISSING',
  'DEEP_BACKGROUND_SUBAGENT_SCOPE_CHANGED',
  'DEEP_BACKGROUND_SUBAGENT_UNJOINED',
  'DEEP_CHECKPOINTER_REQUIRED',
  'DEEP_CHECKPOINT_INTERRUPT_INVALID',
  'DEEP_CHECKPOINT_RECOVERY_INVALID',
  'DEEP_CHECKPOINT_RESUME_INVALID',
  'DEEP_CHECKPOINT_RESUME_MISSING',
  'DEEP_CHECKPOINT_UNFINISHED',
  'DEEP_CHECKPOINT_USAGE_INVALID',
  'DEEP_CONTEXT_BUDGET',
  'DEEP_MAX_TURNS',
  'DEEP_MESSAGE_ALREADY_APPLIED',
  'DEEP_MESSAGE_TRANSFORM_INVALID',
  'DEEP_MODEL_TOOL_ARGUMENTS_INVALID',
  'DEEP_NEW_MESSAGE_ID_REQUIRED',
  'DEEP_READ_ONLY_PATH',
  'DEEP_SKILL_DISCOVERY_FAILED',
  'DEEP_SUBAGENT_BACKGROUND_CORRUPT',
  'DEEP_SUBAGENT_BACKGROUND_INVALID',
  'DEEP_SUBAGENT_BACKGROUND_MISSING',
  'DEEP_SUBAGENT_CHECKPOINT_DELETE_DENIED',
  'DEEP_SUBAGENT_CHECKPOINT_SCOPE',
  'DEEP_SUBAGENT_MAX_TURNS',
  'DEEP_SUBAGENT_OUTPUT_LIMIT',
  'DEEP_SUBAGENT_PROGRESS_CHANGED',
  'DEEP_SUBAGENT_SAVED_FILE_MISSING',
  'DEEP_SUBAGENT_WRITE_SCOPE',
  'DEEP_SUMMARY_EMPTY',
  'DEEP_SUMMARY_INPUT_BUDGET',
  'DEEP_SUMMARY_INVALID',
  'DEEP_UNREGISTERED_TOOL',
] as const;

/** 公开诊断仅含固定错误类型、系统码和执行阶段，不接受异常正文、源码或堆栈。 */
export const failureDetailsSchema = z.object({
  errorType: z
    .enum([
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'ReferenceError',
      'AggregateError',
      'AbortError',
      'RunExecutionError',
      'SubagentExecutionError',
      'ToolInvocationError',
      'ToolInputParsingException',
      'GraphRecursionError',
      'InvalidUpdateError',
      'APIConnectionTimeoutError',
      'APIConnectionError',
      'APIUserAbortError',
      'StorageOperationError',
      'TextContentError',
      'StorageError',
    ])
    .optional()
    .catch(undefined),
  causeCode: z
    .enum([
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ETIMEDOUT',
      'ABORT_ERR',
      'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      'MODULE_NOT_FOUND',
      'ERR_MODULE_NOT_FOUND',
      'ENOENT',
      'EACCES',
      'ENOSPC',
      'ENOMEM',
    ])
    .optional()
    .catch(undefined),
  frameworkCode: z.enum(frameworkErrorCodes).optional().catch(undefined),
  statusCode: z.number().int().min(100).max(599).optional().catch(undefined),
  subagentPhase: z.enum(['start', 'execute', 'settle', 'observe']).optional().catch(undefined),
});
export type FailureDetails = z.infer<typeof failureDetailsSchema>;

/** 缺少安全诊断时保持未知；不把任意字符串或历史未知原因推测为具体故障。 */
export function readFailureDetails(value: unknown): FailureDetails | undefined {
  const parsed = failureDetailsSchema.safeParse(value);
  if (!parsed.success) return;
  const fields = Object.fromEntries(
    Object.entries(parsed.data).filter(([, item]) => item !== undefined),
  );
  return Object.keys(fields).length ? fields : undefined;
}
