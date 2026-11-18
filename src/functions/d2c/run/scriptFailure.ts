import {
  executionError,
  ScriptFailureError,
  type FailureContext,
  type ScriptDiagnostics,
} from './errors';
import { toolIssue, type ToolFeedbackCode } from './toolFeedback';

/** 只接收可信网络前置产生的状态，不从上游错误正文推断鉴权或重试。 */
export type ScriptNetworkFailure = {
  statusCode?: number;
  code?: string;
  retryAfterMs?: number;
  phase?: string;
};

/**
 * 将固定 Figma CLI 的失败信封与网络诊断转换为现有工具反馈。
 * 旧脚本只返回 error 字符串，因此仅精确匹配固定模板；未知正文留在 cause 中。
 */
export function throwFigmaScriptFailure(input: {
  args: string[];
  output: string;
  context: FailureContext;
  network?: ScriptNetworkFailure;
  cause?: unknown;
}): never {
  const { args, context, network, cause } = input;
  const nodeId = /^\d{1,20}:\d{1,20}$/.test(args[2] ?? '') ? args[2] : undefined;
  const diagnostics: ScriptDiagnostics = {
    scriptReason: 'PROCESS_FAILED',
    scriptPhase: 'process',
    ...(nodeId ? { nodeId } : {}),
  };
  const status = network?.statusCode;
  if (Number.isInteger(status) && status! >= 100 && status! <= 599) diagnostics.statusCode = status;
  /** 所有反馈和终态使用同一条脱敏诊断链，原始命令及输出不会公开。 */
  function issue(code: ToolFeedbackCode): never {
    throw toolIssue(
      code,
      'FIGMA_REQUEST_FAILED',
      context,
      {
        ...(code === 'RATE_LIMITED'
          ? { retryAfterMs: Math.min(300000, Math.max(0, network?.retryAfterMs ?? 0)) }
          : {}),
        ...(nodeId && ['FIGMA_NODE_NOT_FOUND', 'FIGMA_IMAGE_NOT_FOUND'].includes(code)
          ? { detail: `节点：${nodeId}。` }
          : {}),
      },
      new ScriptFailureError(diagnostics, cause),
    );
  }
  if (network && (status !== undefined || network.code)) {
    diagnostics.scriptReason = network.code ? 'NETWORK_ERROR' : 'HTTP_ERROR';
    diagnostics.scriptPhase =
      network.phase === 'body' ? 'body' : status !== undefined ? 'response' : 'request';
    if (status === 401 || status === 403) {
      throw toolIssue(
        'ACCESS_REQUIRED',
        'CREDENTIAL_UNAVAILABLE',
        context,
        {},
        new ScriptFailureError(diagnostics, cause),
      );
    }
    if (status === 404) issue('RESOURCE_UNAVAILABLE');
    if (status === 400 || status === 422) issue('INVALID_ARGUMENT');
    if (status === 429)
      issue((network.retryAfterMs ?? 0) > 300000 ? 'RATE_LIMIT_WAIT' : 'RATE_LIMITED');
    if (typeof status === 'number' && status >= 500) {
      throw toolIssue(
        'NETWORK_RETRY',
        'NETWORK_UNAVAILABLE',
        context,
        {},
        new ScriptFailureError(diagnostics, cause),
      );
    }
    if (
      [
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
      ].includes(network.code ?? '')
    ) {
      diagnostics.causeCode = network.code as ScriptDiagnostics['causeCode'];
      throw toolIssue(
        'NETWORK_RETRY',
        'NETWORK_TIMEOUT',
        context,
        {},
        new ScriptFailureError(diagnostics, cause),
      );
    }
    if (
      [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'ERR_TLS_CERT_ALTNAME_INVALID',
      ].includes(network.code ?? '')
    ) {
      diagnostics.causeCode = network.code as ScriptDiagnostics['causeCode'];
      throw toolIssue(
        'TLS_REQUIRED',
        'TLS_CERTIFICATE_FAILED',
        context,
        {},
        new ScriptFailureError(diagnostics, cause),
      );
    }
    const policy = {
      HOST_NOT_ALLOWED: ['HOST_NOT_ALLOWED', 'request'],
      RESPONSE_TOO_LARGE: ['RESPONSE_TOO_LARGE', 'body'],
      REDIRECT_BLOCKED: ['REDIRECT_BLOCKED', 'response'],
      INVALID_JSON: ['INVALID_JSON', 'body'],
    } as const;
    const selected = policy[network.code as keyof typeof policy];
    if (selected) {
      diagnostics.scriptReason = selected[0];
      diagnostics.scriptPhase = selected[1];
      throw executionError(
        new ScriptFailureError(diagnostics, cause),
        'FIGMA_REQUEST_FAILED',
        context,
      );
    }
    throw executionError(
      new ScriptFailureError(diagnostics, cause),
      'FIGMA_REQUEST_FAILED',
      context,
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(input.output);
  } catch {
    /* 无效输出按固定类别记录。 */
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !('ok' in envelope) ||
    envelope.ok !== false ||
    !('error' in envelope) ||
    typeof envelope.error !== 'string'
  ) {
    diagnostics.scriptReason = 'INVALID_OUTPUT';
    diagnostics.scriptPhase = 'output';
    throw executionError(
      new ScriptFailureError(diagnostics, cause),
      'SCRIPT_OUTPUT_INVALID',
      context,
    );
  }
  const message = envelope.error;
  diagnostics.scriptReason = 'REPORTED_ERROR';
  diagnostics.scriptPhase = 'output';
  if (
    args[0] === 'fetch-node' &&
    nodeId &&
    message === `节点 ${nodeId} 在文件 ${args[1]} 中未找到`
  ) {
    diagnostics.scriptReason = 'NODE_NOT_FOUND';
    diagnostics.scriptPhase = 'node_lookup';
    issue('FIGMA_NODE_NOT_FOUND');
  }
  if (
    nodeId &&
    ((args[0] === 'export-image' && message === `Figma /v1/images 未返回 ${nodeId} 的 URL`) ||
      (args[0] === 'screenshot' && message === `Figma /v1/images 未返回 ${nodeId} 的截图 URL`))
  ) {
    diagnostics.scriptReason = 'IMAGE_NOT_FOUND';
    diagnostics.scriptPhase = 'node_lookup';
    issue('FIGMA_IMAGE_NOT_FOUND');
  }
  if (message === 'FIGMA_TOKEN 未配置 (请在项目根 .env 写 FIGMA_TOKEN=xxx)') {
    diagnostics.scriptReason = 'CREDENTIAL_MISSING';
    diagnostics.scriptPhase = 'request';
    throw toolIssue(
      'ACCESS_REQUIRED',
      'CREDENTIAL_UNAVAILABLE',
      context,
      {},
      new ScriptFailureError(diagnostics, cause),
    );
  }
  if (
    message === '缺少 --filename=<name>' ||
    message === `用法: figma ${args[0]} <fileKey> <nodeId> [--depth=N]`
  ) {
    diagnostics.scriptReason = 'INVALID_ARGUMENT';
    diagnostics.scriptPhase = 'request';
    issue('INVALID_ARGUMENT');
  }
  /** 文件系统标准前缀仅细化终态日志；不会触发重试或放宽存储保护。 */
  const filesystem = message.match(
    /^(ENOENT|EACCES|EPERM|ENOSPC|EROFS|EMFILE): [^\n]*, (?:mkdir|open|write|scandir|read)\b/,
  );
  if (filesystem) {
    diagnostics.scriptReason = 'FILE_SYSTEM_ERROR';
    diagnostics.scriptPhase = 'cache';
    diagnostics.causeCode = filesystem[1] as ScriptDiagnostics['causeCode'];
  }
  throw executionError(new ScriptFailureError(diagnostics, cause), 'FIGMA_REQUEST_FAILED', context);
}
