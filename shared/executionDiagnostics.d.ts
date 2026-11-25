/** 只读诊断范围；恢复链只采用持久化 resumeFromRunId，不按相邻时间猜测。 */
export type ExecutionUsage = {
  requests: number | null;
  reportedRequests: number | null;
  totalTokens: number | null;
  usageComplete: boolean | null;
};
export type ExecutionScope = {
  runCount: number;
  elapsedMs: number | null;
  runningCount: number;
  complete: boolean;
  usage: ExecutionUsage;
};
export type ExecutionDiagnostics = {
  selected: ExecutionScope;
  recoveryChain: ExecutionScope;
  session: ExecutionScope;
  resumeFromRunId: string | null;
  interruption: 'worker' | 'lease' | 'failure' | 'cancelled' | 'unknown' | null;
};
