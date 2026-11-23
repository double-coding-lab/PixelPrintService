/** 顶部快捷入口只展示有权会话的活动轮次元信息。 */
export type ActiveSessionSummary = {
  sessionId: string;
  workspaceId: string;
  name: string;
  workspaceName: string;
  teamId: string | null;
  target: 'h5' | 'rn';
  runId: string;
  status: 'queued' | 'running' | 'waiting_input' | 'stopping';
  updatedAt: string | null;
};
