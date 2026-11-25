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
  failureDetails?: import('../src/shared/failureDetails').FailureDetails;
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
export type DiagnosticErrorCounts = {
  total: number;
  executionErrors: number;
  toolCorrections: number;
  ruleFailures: number;
};
/** 各维度应用其他筛选条件后的数量；包括单列的规则未通过记录。 */
export type DiagnosticErrorFacets = {
  categories: Partial<Record<DiagnosticErrorCategory, number>>;
  scopes: Partial<Record<DiagnosticError['scope'], number>>;
  runs: Record<string, number>;
  allCategories: number;
  allScopes: number;
  allRuns: number;
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
  /** 新接口返回，旧服务缺失时筛选统计保持未知。 */
  filteredCounts?: DiagnosticErrorCounts;
  facets?: DiagnosticErrorFacets;
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
