/** 仅包含可公开的诊断元数据；缺少历史记录时使用null，不猜测模型消耗。 */
export type AgentUsage = {
  requests: number | null;
  reportedRequests: number | null;
  completedRequests: number | null;
  failedRequests: number | null;
  interruptedRequests: number | null;
  pendingRequests: number | null;
  retryRequests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageComplete: boolean | null;
  modelDurationMs: number | null;
  durationRequests: number;
  firstChunkMs: number | null;
  firstChunkRequests: number;
  summaryRequests: number | null;
};
export type AgentRuleCheck = {
  seq: number;
  at: string | null;
  path: string | null;
  passed: boolean | null;
  count: number | null;
  unchanged: boolean | null;
  violations: Array<{ rule: string; nodeId: string }>;
  omittedViolations: number;
};
export type AgentToolDiagnostic = {
  id: string;
  name: string;
  detail?: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};
export type SubagentDiagnostic = {
  agentId: string;
  role: 'design' | 'review' | 'rule_scan' | 'ui';
  nodeId: string | null;
  task: string | null;
  writePaths: string[];
  files: string[];
  missingFiles: string[];
  status:
    | 'queued'
    | 'running'
    | 'waiting_model'
    | 'completed'
    | 'handed_off'
    | 'failed'
    | 'interrupted'
    | 'unknown';
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  elapsedMs: number | null;
  runningSince: string | null;
  queueDurationMs: number | null;
  toolDurationMs: number | null;
  toolCalls: number;
  toolFailures: number;
  tools?: AgentToolDiagnostic[];
  toolsTruncated?: boolean;
  modelName: string | null;
  usage: AgentUsage;
  delivery: { success: boolean | null; reason: string | null };
  checks: AgentRuleCheck[];
  checksTruncated: boolean;
};
export type AgentDiagnostics = {
  complete: boolean;
  historicalAttribution: boolean;
  main: AgentUsage;
  unassigned: AgentUsage;
  agents: SubagentDiagnostic[];
};
