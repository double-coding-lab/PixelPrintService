import { databaseDiagnostics } from '@/common/databaseDiagnostics';
import { StorageError } from '@/hooks/tools/storage';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { diagnoseGatewayFailure, type GatewayDiagnostics } from './gatewayDiagnostics';

/** 对外只使用固定原因与建议，原始异常通过 Error.cause 留在服务端内存。 */
const reasons = {
  EXECUTION_FAILED: ['任务执行失败', '请提供排查编号，由服务端日志定位失败阶段。'],
  PREPARATION_FAILED: ['执行上下文准备失败', '请检查会话配置、资源副本与历史记录。'],
  HISTORY_INVALID: ['对话工具历史不完整，无法继续执行', '请核对上轮中断记录，暂勿反复发送继续。'],
  RESOURCE_RESTORE_FAILED: ['固定资源或会话文件恢复失败', '请检查对象存储、资源摘要及执行目录。'],
  MODEL_UNAVAILABLE: ['本轮固定模型当前不可用', '请核对 RuntimeConfig 中的模型名称及接口地址。'],
  MODEL_REQUEST_FAILED: ['模型请求失败', '请检查模型网关和服务端模型配置。'],
  MODEL_RESPONSE_INVALID: [
    '模型返回的工具调用格式无效',
    '模型多次未能给出有效工具参数，已保存产物保留，请核对工具契约后继续。',
  ],
  SUBAGENT_FAILED: [
    '子任务执行或结果交接失败',
    '已保存文件和扫描报告保留，请结合排查编号检查子任务执行与结果交接。',
  ],
  MODEL_EMPTY_RESPONSE: [
    '模型连续返回空回复，任务未完成',
    '已保存文件和工具结果保留，可继续当前任务；请核对模型网关的可见输出及输出长度限制。',
  ],
  MODEL_OUTPUT_LIMIT: [
    '模型输出被长度上限截断',
    '请拆分本轮生成内容，或联系模型网关维护者核对默认输出限制；截断的工具参数不会执行。',
  ],
  MODEL_REQUEST_LIMIT: [
    '本轮模型请求次数已达到上限，执行已中断',
    '已保存文件和对话仍会保留，可继续当前任务；复杂任务可提高 RuntimeConfig d2c.execution.maxTurns，主任务、子任务及摘要共享此限额。',
  ],
  MODEL_AUTH_FAILED: ['模型网关鉴权失败', '请检查 RuntimeConfig 中的模型调用凭据。'],
  MODEL_RATE_LIMITED: ['模型网关请求受限', '请核对模型配额，稍后再试。'],
  NETWORK_TIMEOUT: ['目标服务连接或响应超时', '请检查目标服务、代理连接和执行超时配置。'],
  NETWORK_UNAVAILABLE: ['无法连接目标服务', '请检查域名解析、目标服务和外网代理连接。'],
  TLS_CERTIFICATE_FAILED: [
    'HTTPS 证书校验失败',
    '请核对部署可信 CA 与 Node 系统证书配置，不要关闭 TLS 校验。',
  ],
  CONTEXT_LIMIT: [
    '当前模型请求超过上下文预算或摘要未能收敛',
    '已接入自动摘要；请检查单条输入、固定提示及摘要结果是否超过本轮预算。',
  ],
  TOOL_FAILED: ['受控工具执行失败', '请结合工具名称和排查编号检查服务端日志。'],
  SCRIPT_OUTPUT_INVALID: [
    '固定脚本输出不完整或格式无效',
    '请检查脚本输出是否完整且符合 JSON 契约；无需重复确认切图。',
  ],
  SCRIPT_FAILED: ['固定脚本执行失败', '请核对脚本依赖、外网代理及设计稿访问权限。'],
  SCRIPT_TIMEOUT: ['固定脚本执行超时', '请检查代理和外网连接，再核对任务执行限额。'],
  FIGMA_REQUEST_FAILED: ['Figma 请求或响应校验失败', '请检查设计稿权限、Figma 凭据与代理连接。'],
  FIGMA_ADDRESS_MISSING: ['会话尚未绑定有效 Figma 地址', '请在会话中配置有效设计稿地址。'],
  CREDENTIAL_UNAVAILABLE: ['Figma 凭据不可用', '请检查本人凭据配置及服务端加密材料。'],
  VALIDATION_FAILED: ['生成产物未通过规则检查', '请检查源码、前置切图证据和规则报告。'],
  DELIVERY_INCOMPLETE: [
    '页面生成尚未完成，已保留当前进度',
    '已在原上下文尝试补齐缺失文件；可继续当前任务，已保存的扫描、切图和源码仍会保留。',
  ],
  CONFIRMATION_REQUIRED: ['生成流程需要人工确认', '请核对切图或业务问题；完整确认恢复仍待接入。'],
  STORAGE_FAILED: ['执行数据保存或读取失败', '请检查数据库、对象存储及文件修订状态。'],
  LEASE_LOST: ['本轮执行资格已失效', '请检查租约、服务重启或并发状态。'],
  RUN_TIMEOUT: ['任务达到执行时间限制，已中断', '已保存文件仍会保留，可继续当前任务。'],
  WORKER_INTERRUPTED: ['后台任务已中断', '请核对服务退出或停止操作，已保存文件仍会保留。'],
} as const;

export type FailureCode = keyof typeof reasons;
export type FailureStage = 'prepare' | 'model' | 'tool' | 'validation' | 'storage' | 'worker';
export type FailureTool =
  | 'prepare_slices'
  | 'list_files'
  | 'report_progress'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'figma'
  | 'ask_user'
  | 'delegate_agent'
  | 'wait_subagents'
  | 'check_rules'
  | 'build_preview'
  | 'inspect_preview';
export type FailureCommand =
  | 'verify-token'
  | 'cache-check'
  | 'fetch-node'
  | 'inspect-node'
  | 'export-image'
  | 'screenshot';
export type FailureContext = {
  stage: FailureStage;
  tool?: FailureTool;
  command?: FailureCommand;
  requiresUser?: boolean;
  /** 仅供服务端诊断；公开失败投影不包含文件路径或原始参数。 */
  feedback?: {
    code: string;
    originalCode: string;
    path?: string;
    resource?: boolean;
  };
};

const contextSchema = z.object({
  requiresUser: z.boolean().optional(),
  stage: z.enum(['prepare', 'model', 'tool', 'validation', 'storage', 'worker']),
  tool: z
    .enum([
      'prepare_slices',
      'list_files',
      'report_progress',
      'read_file',
      'write_file',
      'edit_file',
      'delete_file',
      'figma',
      'delegate_agent',
      'wait_subagents',
      'ask_user',
      'check_rules',
      'build_preview',
      'inspect_preview',
    ])
    .optional(),
  command: z
    .enum([
      'verify-token',
      'cache-check',
      'fetch-node',
      'inspect-node',
      'export-image',
      'screenshot',
    ])
    .optional(),
});

/** 公开字段只接受已知枚举，说明文字始终从固定原因表重建。 */
export const runFailureSchema = contextSchema
  .extend({
    errorId: z.string().uuid(),
    code: z.enum(Object.keys(reasons) as [FailureCode, ...FailureCode[]]),
    statusCode: z.number().int().min(100).max(599).optional(),
  })
  .transform((value) => ({
    ...value,
    message: reasons[value.code][0],
    suggestion: reasons[value.code][1],
  }));

export type RunFailure = z.output<typeof runFailureSchema>;

/** 只记录平台已定义的完整常量；新常量须显式加入，不按 DEEP_ 前缀放行。 */
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
export type FrameworkCode = (typeof frameworkErrorCodes)[number];
const frameworkCodeSchema = z.enum(frameworkErrorCodes);
const errorTypeSchema = z.enum([
  'APIConnectionTimeoutError',
  'APIConnectionError',
  'APIUserAbortError',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'RunExecutionError',
  'StorageOperationError',
  'SubagentExecutionError',
  'StorageError',
  'HistoryConversionError',
  'ToolInvocationError',
  'ToolInputParsingException',
  'GraphRecursionError',
  'InvalidUpdateError',
  'GraphInterrupt',
  'NodeInterrupt',
]);
export type DiagnosticErrorType = z.infer<typeof errorTypeSchema>;
const subagentContextSchema = z.object({
  agentId: z.string().uuid(),
  role: z.enum(['design', 'review', 'rule_scan', 'ui']),
  phase: z.enum(['start', 'execute', 'settle', 'observe']),
});
export type SubagentExecutionContext = z.infer<typeof subagentContextSchema>;

/** 子任务上下文只进入后台日志；固定消息与原始 cause 不包含委派参数。 */
export class SubagentExecutionError extends Error {
  constructor(
    public readonly context: SubagentExecutionContext,
    cause: unknown,
  ) {
    super('子任务执行或结果交接失败', { cause });
    this.name = 'SubagentExecutionError';
  }
}

const scriptDiagnosticSchema = z.object({
  scriptReason: z.enum([
    'NODE_NOT_FOUND',
    'IMAGE_NOT_FOUND',
    'INVALID_ARGUMENT',
    'CREDENTIAL_MISSING',
    'HTTP_ERROR',
    'NETWORK_ERROR',
    'HOST_NOT_ALLOWED',
    'RESPONSE_TOO_LARGE',
    'REDIRECT_BLOCKED',
    'INVALID_JSON',
    'FILE_SYSTEM_ERROR',
    'REPORTED_ERROR',
    'INVALID_OUTPUT',
    'PROCESS_FAILED',
  ]),
  scriptPhase: z.enum(['request', 'response', 'body', 'node_lookup', 'cache', 'output', 'process']),
  nodeId: z
    .string()
    .regex(/^\d{1,20}:\d{1,20}$/)
    .optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  causeCode: z
    .enum([
      'ENOENT',
      'EACCES',
      'EPERM',
      'ENOSPC',
      'EROFS',
      'EMFILE',
      'AbortError',
      'TimeoutError',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ])
    .optional(),
});
export type ScriptDiagnostics = z.infer<typeof scriptDiagnosticSchema>;

/** 固定脚本失败仅投影枚举、状态和节点编号，原始输出留在私有 cause 链。 */
export class ScriptFailureError extends Error {
  readonly diagnostics: ScriptDiagnostics;
  constructor(diagnostics: ScriptDiagnostics, cause?: unknown) {
    super('固定脚本失败诊断', { cause });
    this.diagnostics = scriptDiagnosticSchema.parse(diagnostics);
  }
}

export type RunFailureReport = {
  failure: RunFailure;
  runId?: string;
  sessionId?: string;
  diagnostics: GatewayDiagnostics &
    Partial<Omit<ScriptDiagnostics, 'causeCode'>> & {
      frameworkCode?: FrameworkCode;
      errorType?: DiagnosticErrorType;
      subagentId?: string;
      subagentRole?: SubagentExecutionContext['role'];
      subagentPhase?: SubagentExecutionContext['phase'];
      causeCode?: string;
      databaseCode?: string;
      databaseErrno?: number;
      databaseSqlState?: string;
      statusCode?: number;
      exitCode?: number;
      location?: string;
      storageOperation?: 'upload' | 'write_binary' | 'write_text';
      artifactPath?: string;
      bytes?: number;
      storageStage?: string;
      storageReason?: string;
      storageCode?: number;
      feedbackCode?: string;
      originalFeedbackCode?: string;
      readPath?: string;
      resource?: boolean;
    };
};

/** 存储调用上下文仅供后台日志诊断，不进入公开失败事件。 */
export class StorageOperationError extends Error {
  constructor(
    public readonly operation: 'upload' | 'write_binary' | 'write_text',
    public readonly artifactPath: string,
    public readonly bytes: number,
    cause: unknown,
  ) {
    super('存储操作失败', { cause });
  }
}

/** 仅允许平台自己定义的固定原因，拒绝任意异常正文与上游响应。 */
const storageReasons = new Set([
  'Storage 文件服务环境无效',
  'Storage 响应超过大小限制',
  'Storage 响应为空',
  'Storage 文件所属环境不匹配',
  'Storage 文件标识无效',
  'Storage 文件下载地址无效',
  'Storage 文件配置读取失败',
  'RuntimeConfig d2c.storage 或 limits.uploadBytes 配置无效',
  '文件为空或超过 RuntimeConfig/简单上传大小限制',
  '文件名或类型无效',
  'Storage 文件令牌请求失败',
  'Storage 文件令牌返回无效',
  'Storage 文件上传失败',
  'Storage 文件上传返回无效',
  'Storage 文件令牌请求或解析失败',
  'Storage 文件上传请求或解析失败',
  'Storage 文件下载失败',
  'Storage 文件大小或摘要不一致',
  'Storage 文件定位、请求或内容无效',
]);

/** 保存可信错误分类与上下文，禁止把 cause 的消息、正文或命令参数当成公开说明。 */
export class RunExecutionError extends Error {
  constructor(
    public readonly code: FailureCode,
    public readonly context: FailureContext,
    cause?: unknown,
  ) {
    super(reasons[code][0], { cause });
    this.name = 'RunExecutionError';
  }
}

/** 添加外层上下文但保留内层已知失败分类，供工具、SDK 与执行器逐层传递。 */
export function executionError(error: unknown, code: FailureCode, context: FailureContext) {
  return error instanceof RunExecutionError
    ? new RunExecutionError(error.code, { ...context, ...error.context }, error)
    : new RunExecutionError(code, context, error);
}

/** 从有限 cause 链选取可安全记录的数值和网络码，不序列化原始 Error 或任意字符串。 */
export function diagnoseRunFailure(
  error: unknown,
  code: FailureCode = 'EXECUTION_FAILED',
  context: FailureContext = { stage: 'worker' },
): RunFailureReport {
  let current = error;
  let classified: RunExecutionError | undefined;
  const seen = new Set<unknown>();
  const diagnostics: RunFailureReport['diagnostics'] = databaseDiagnostics(error);
  const genericCodes = new Set<FailureCode>([
    'EXECUTION_FAILED',
    'MODEL_REQUEST_FAILED',
    'TOOL_FAILED',
    'SUBAGENT_FAILED',
  ]);
  const priorityCodes = new Set<FailureCode>([
    'STORAGE_FAILED',
    'LEASE_LOST',
    'RUN_TIMEOUT',
    'WORKER_INTERRUPTED',
    'NETWORK_TIMEOUT',
    'NETWORK_UNAVAILABLE',
    'TLS_CERTIFICATE_FAILED',
  ]);
  const allowedCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
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
  ]);
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (
      current instanceof RunExecutionError &&
      (!classified ||
        (!priorityCodes.has(classified.code) && priorityCodes.has(current.code)) ||
        (genericCodes.has(classified.code) && !genericCodes.has(current.code)))
    )
      classified = current;
    if (current instanceof SubagentExecutionError && diagnostics.subagentId === undefined) {
      const parsed = subagentContextSchema.safeParse(current.context);
      if (parsed.success) {
        diagnostics.subagentId = parsed.data.agentId;
        diagnostics.subagentRole = parsed.data.role;
        diagnostics.subagentPhase = parsed.data.phase;
      }
    }
    if (current instanceof RunExecutionError && current.context.feedback) {
      const feedback = current.context.feedback;
      const allowedFeedback =
        /^(?:FILE_NOT_FOUND|NON_TEXT_FILE|FILE_DELETE_NOT_ALLOWED|FIGMA_CACHE_INCOMPLETE|FIGMA_NODE_NOT_FOUND|FIGMA_IMAGE_NOT_FOUND|INVALID_ARGUMENT|RULES_FAILED|NETWORK_RETRY|RATE_LIMITED|RATE_LIMIT_WAIT|ACCESS_REQUIRED|RESOURCE_UNAVAILABLE|TLS_REQUIRED|CONFIRMATION_REQUIRED|RETRY_EXHAUSTED|ADJUSTMENT_EXHAUSTED)$/;
      if (allowedFeedback.test(feedback.code)) diagnostics.feedbackCode ??= feedback.code;
      if (allowedFeedback.test(feedback.originalCode))
        diagnostics.originalFeedbackCode ??= feedback.originalCode;
      const relative = feedback.path?.replace(/^\/(?:resources|history)\//, '');
      if (
        current.context.tool === 'read_file' &&
        relative &&
        relative.length <= 1024 &&
        !/[:\\\x00-\x1f\x7f?#%]/.test(relative) &&
        !relative.startsWith('/') &&
        !relative.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        diagnostics.readPath ??= feedback.path;
        if (typeof feedback.resource === 'boolean') diagnostics.resource ??= feedback.resource;
      }
    }
    if (current instanceof ScriptFailureError) {
      const parsed = scriptDiagnosticSchema.safeParse(current.diagnostics);
      if (parsed.success) Object.assign(diagnostics, parsed.data);
    }
    if (current instanceof StorageOperationError) {
      diagnostics.storageOperation ??= current.operation;
      const relative = current.artifactPath;
      if (
        relative.length <= 1024 &&
        !/[:\\\x00-\x1f\x7f?#]/.test(relative) &&
        !relative.startsWith('/') &&
        !relative.split('/').some((part) => part === '..')
      )
        diagnostics.artifactPath ??= relative;
      if (Number.isSafeInteger(current.bytes) && current.bytes >= 0)
        diagnostics.bytes ??= current.bytes;
    }
    if (current instanceof StorageError) {
      if (current.networkCode && allowedCodes.has(current.networkCode))
        diagnostics.causeCode ??= current.networkCode;
      if (['config', 'token', 'upload', 'download'].includes(current.stage))
        diagnostics.storageStage ??= current.stage;
      if (storageReasons.has(current.message)) diagnostics.storageReason ??= current.message;
      if (Number.isSafeInteger(current.code) && current.code! >= 0 && current.code! <= 2147483647)
        diagnostics.storageCode ??= current.code;
    }

    const value = current as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      stack?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const framework = frameworkCodeSchema.safeParse(value.message);
    const frameworkCode = framework.success ? framework : frameworkCodeSchema.safeParse(value.code);
    if (frameworkCode.success) diagnostics.frameworkCode = frameworkCode.data;
    const errorType = errorTypeSchema.safeParse(
      current instanceof StorageOperationError
        ? 'StorageOperationError'
        : current instanceof Error &&
            ['APIConnectionTimeoutError', 'APIConnectionError', 'APIUserAbortError'].includes(
              current.constructor.name,
            )
          ? current.constructor.name
          : value.name,
    );
    if (errorType.success) diagnostics.errorType = errorType.data;
    const status = value.statusCode ?? value.status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
      diagnostics.statusCode ??= status;
    if (typeof value.code === 'string' && allowedCodes.has(value.code))
      diagnostics.causeCode ??= value.code;
    if (
      typeof value.code === 'number' &&
      Number.isInteger(value.code) &&
      value.code >= 0 &&
      value.code <= 255
    )
      diagnostics.exitCode ??= value.code;
    /** 只保留已知源码文件名与行列号，不记录原始堆栈、绝对路径或异常消息。 */
    if (typeof value.stack === 'string') {
      const location = value.stack
        .slice(0, 65536)
        .split('\n')
        .slice(1)
        .join('\n')
        .match(
          /(?:src\/functions\/d2c\/(?:run\/(?:agent\/[A-Za-z][A-Za-z0-9_-]{0,63}|agent|execute|tools|worker|workspace|persistence|leases|history)|session\/(?:messages|service|access))\.ts|dist\/index\.js):\d{1,8}:\d{1,8}(?!\d)/,
        );
      if (location) diagnostics.location = location[0];
    }
    current = value.cause;
  }
  let selectedCode = classified?.code ?? code;
  const selectedContext = { ...context, ...classified?.context };
  if (selectedContext.stage === 'model') Object.assign(diagnostics, diagnoseGatewayFailure(error));
  /** 网络码和 HTTP 状态只在相应请求阶段细化固定原因，不根据上游正文猜测错误。 */
  if (
    !priorityCodes.has(selectedCode) &&
    (selectedContext.stage === 'model' || selectedContext.stage === 'tool')
  ) {
    if (diagnostics.causeCode?.includes('TIMEOUT') || diagnostics.causeCode === 'ETIMEDOUT')
      selectedCode = 'NETWORK_TIMEOUT';
    else if (diagnostics.causeCode && /CERT|SIGNATURE/.test(diagnostics.causeCode))
      selectedCode = 'TLS_CERTIFICATE_FAILED';
    else if (
      diagnostics.causeCode &&
      ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(
        diagnostics.causeCode,
      )
    )
      selectedCode = 'NETWORK_UNAVAILABLE';
    else if (selectedContext.stage === 'model' && [401, 403].includes(diagnostics.statusCode ?? 0))
      selectedCode = 'MODEL_AUTH_FAILED';
    else if (selectedContext.stage === 'model' && diagnostics.statusCode === 429)
      selectedCode = 'MODEL_RATE_LIMITED';
  }
  const failure = runFailureSchema.parse({
    errorId: randomUUID(),
    code: selectedCode,
    ...selectedContext,
    ...(diagnostics.statusCode ? { statusCode: diagnostics.statusCode } : {}),
  });
  return { failure, diagnostics };
}
