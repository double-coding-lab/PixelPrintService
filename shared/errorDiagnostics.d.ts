/** 诊断接口仅含安全元数据；可选编号缺失时保持null。 */
export type DiagnosticErrorCategory =
  | 'model'
  | 'tool'
  | 'subagent'
  | 'storage'
  | 'preview'
  | 'database'
  | 'execution'
  | 'rule';
export type DiagnosticError = {
  id: string;
  seq: number | null;
  at: string | null;
  runId: string;
  category: DiagnosticErrorCategory;
  scope: 'main' | 'subagent' | 'unknown';
  code: string;
  message: string;
  stage: string | null;
  tool: string | null;
  command: string | null;
  agentId: string | null;
  agentRole: string | null;
  errorId: string | null;
  requestId: string | null;
  attempt: number | null;
  recovery: 'retrying' | 'subsequent_success' | 'unresolved' | 'unknown';
};
export type ErrorDiagnosticsQuery = {
  runId?: string;
  category?: DiagnosticErrorCategory;
  scope?: 'main' | 'subagent' | 'unknown';
  before?: number;
  snapshotSeq?: number;
  snapshotToken?: string;
  pageSize?: number;
};
export type ErrorDiagnostics = {
  sessionId: string;
  observedAt: string;
  snapshotSeq: number;
  snapshotToken: string;
  total: number;
  executionErrors: number;
  toolCorrections: number;
  ruleFailures: number;
  filteredTotal: number;
  items: DiagnosticError[];
  nextBefore: number | null;
  hasMore: boolean;
  coverage: {
    complete: boolean;
    scannedEvents: number;
    limit: number;
    historical: 'saved_events_only';
  };
};
