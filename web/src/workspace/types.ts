import type { MessageAttachment } from './attachments';
import type { AgentDiagnostics } from '../../../shared/agentDiagnostics';

export type Target = 'h5' | 'rn';

export type Team = {
  isPublic?: boolean;
  teamId: string;
  name: string;
  createdUserId: string | null;
  creatorName: string | null;
  isOwner: boolean;
  memberCount: number;
};
export type TeamDetail = Team & { members: { userId: string; role: 'owner' | 'member' }[] };
export type WorkspaceScope = 'all' | 'personal' | `team:${string}`;

export type Workspace = {
  workspaceId: string;
  name: string;
  status: string;
  configRevision: number;
  resource: { sourceVersion: string; sourceCommit: string; revision: number } | null;
  teamId?: string | null;
  createdUserId?: string | null;
  creatorName?: string | null;
  isOwner?: boolean;
};

export type PendingQuestion = {
  questionId: string;
  question: string;
  options: string[];
  recommendedAnswer?: string;
};

export type Session = {
  sessionId: string;
  workspaceId: string;
  name: string;
  createdUserId?: string | null;
  creatorName?: string | null;
  target: Target;
  figmaUrl?: string | null;
  fileRevision: number;
  timelineSeq: number;
  activeRunId: string | null;
  activeRunStatus?: string | null;
  pendingQuestion?: PendingQuestion | null;
  validationState: Record<string, unknown> | null;
};

export type FileInfo = {
  fileId: string;
  path: string;
  kind: 'source' | 'asset' | 'attachment' | 'internal';
  size: number;
  revision: number;
  mimeType?: string | null;
  url?: string | null;
};

export type TextFile = FileInfo & { content: string };
export type WebpFile = FileInfo & { sourceFileId: string };
export type FileList = { fileRevision: number; files: FileInfo[]; webpFiles?: WebpFile[] };
/** 版本为冻结快照；保存状态与规则检查状态分别展示。 */
export type VersionMetadata = {
  versionId: string;
  clientRequestId?: string;
  name: string;
  status: 'saving' | 'ready' | 'failed';
  target: Target;
  sourceFileRevision: number;
  validationSummary: { status?: string; [key: string]: unknown } | null;
  createdAt: string;
  error?: { message: string } | null;
};
export type VersionPage = {
  rows: VersionMetadata[];
  total: number;
  page: number;
  pageSize: number;
};
export type VersionSaveRequest = {
  clientRequestId: string;
  name: string;
  baseFileRevision?: number;
};
export type Credential = { configured: boolean; credentialId?: string; revision?: number };
export type FailureStage = 'prepare' | 'model' | 'tool' | 'validation' | 'storage' | 'worker';
export type FailureCode =
  | 'EXECUTION_FAILED'
  | 'PREPARATION_FAILED'
  | 'HISTORY_INVALID'
  | 'RESOURCE_RESTORE_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_REQUEST_FAILED'
  | 'MODEL_RESPONSE_INVALID'
  | 'SUBAGENT_FAILED'
  | 'SUBAGENT_REQUEST_LIMIT'
  | 'SUBAGENT_OUTPUT_LIMIT'
  | 'MODEL_EMPTY_RESPONSE'
  | 'MODEL_OUTPUT_LIMIT'
  | 'MODEL_REQUEST_LIMIT'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_RATE_LIMITED'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_UNAVAILABLE'
  | 'TLS_CERTIFICATE_FAILED'
  | 'CONTEXT_LIMIT'
  | 'TOOL_FAILED'
  | 'SCRIPT_OUTPUT_INVALID'
  | 'SCRIPT_FAILED'
  | 'SCRIPT_TIMEOUT'
  | 'FIGMA_REQUEST_FAILED'
  | 'FIGMA_ADDRESS_MISSING'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'CONFIRMATION_REQUIRED'
  | 'STORAGE_FAILED'
  | 'LEASE_LOST'
  | 'RUN_TIMEOUT'
  | 'WORKER_INTERRUPTED';
/** 公开诊断仅用于展示；历史接口数据仍须经过运行时字段校验。 */
export type RunFailure = {
  requiresUser?: boolean;
  databaseCode?: string;
  databaseErrno?: number;
  databaseSqlState?: string;
  errorId: string;
  stage: FailureStage;
  code: FailureCode;
  message: string;
  suggestion: string;
  tool?:
    | 'prepare_slices'
    | 'list_files'
    | 'read_file'
    | 'write_file'
    | 'edit_file'
    | 'delete_file'
    | 'figma'
    | 'check_rules'
    | 'delegate_agent'
    | 'wait_subagents';
  command?: 'verify-token' | 'cache-check' | 'fetch-node' | 'export-image' | 'screenshot';
  statusCode?: number;
};
export type TimelineEntry = {
  entryId: string;
  sessionId: string;
  seq: number;
  kind: string;
  runId?: string | null;
  at: string;
  data: {
    validation?: {
      status: 'passed' | 'failed' | 'not_checked' | 'stale';
      sourceFiles?: number;
      reportPath?: string;
    };
    questionId?: string;
    question?: string;
    options?: string[];
    action?: string;
    automatic?: boolean;
    path?: string;
    fileId?: string;
    revision?: number;
    role?: string;
    authorUserId?: string;
    text?: string;
    attachments?: MessageAttachment[];
    /** 同轮助手正文的累计快照与最终消息共用标识。 */
    streamId?: string;
    status?: string;
    reasoning?: {
      streamId: string;
      text: string;
      status: 'streaming' | 'completed' | 'interrupted';
    };
    stage?: string;
    /** 公开 stage=slices 事件的真实阶段和数量，与 sliceProgressSchema 一致。 */
    phase?: 'starting' | 'fetching' | 'exporting' | 'saving';
    total?: number;
    completed?: number;
    failed?: number;
    reused?: number;
    agentId?: string | null;
    message?: { role: 'user' | 'assistant'; text: string };
    tool?: 'list_files' | 'read_file' | 'write_file' | 'edit_file' | 'figma';
    reason?: string;
    name?: string;
    detail?: string;
    feedback?: {
      action: 'adjust' | 'retry' | 'user';
      code: string;
      message: string;
      retryAfterMs?: number;
    };
    operationId?: string;
    scope?: 'generation' | 'summary' | 'design' | 'review' | 'rule_scan' | 'ui';
    durationMs?: number;
    interrupted?: boolean;
    retryAfterMs?: number;
    retryAttempt?: number;
    rateLimited?: boolean;
    callId?: string;
    failure?: RunFailure;
  };
};
export type TimelinePage = {
  entries: TimelineEntry[];
  nextSeq: number;
  previousSeq?: number;
  hasMore: boolean;
};

/** 仅含服务端公开元数据；不承载输入、工具参数或检查点正文。 */
export type DiagnosticsStep = {
  id: string;
  type: 'model' | 'tool' | 'summary' | 'subagent';
  name: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  /** 服务端仅投影可信工具反馈枚举，不包含路径或原始反馈。 */
  feedbackCode?: string;
  /** 提交给网关的思考参数，不保证网关采纳。 */
  requestedReasoningEffort?: 'low' | 'high';
  reasoningEscalated?: boolean;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};
export type SessionDiagnostics = {
  execution?: import('../../../shared/executionDiagnostics').ExecutionDiagnostics;
  agentDiagnostics?: AgentDiagnostics;
  sessionElapsedMs?: number | null;
  sessionRunningCount?: number;
  sessionId: string;
  timelineSeq: number;
  observedAt: string;
  runId: string | null;
  status: string | null;
  modelName: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  lease: { expiresAt: string | null; expired: boolean };
  runs: { runId: string; status: string; createdAt: string | null }[];
  current: { type: DiagnosticsStep['type']; name: string; startedAt: string | null } | null;
  steps: DiagnosticsStep[];
  hasMore: boolean;
  checkpoint: {
    available: boolean;
    savedAt: string | null;
    scope: 'session';
    continuation: 'answer' | 'resume' | 'none';
  };
  usage: {
    requests: number | null;
    reportedRequests: number | null;
    completedRequests?: number | null;
    failedRequests?: number | null;
    interruptedRequests?: number | null;
    pendingRequests?: number | null;
    unreportedRequests?: number | null;
    usageComplete?: boolean | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  failure: RunFailure | null;
};
