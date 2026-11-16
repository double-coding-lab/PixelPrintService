import type { ModelActivity } from './modelActivity';

/** 合并一次请求生命周期；调用方须在租约事务内按 operationId/阶段去重。 */
export function updateModelUsage(prior: Record<string, unknown> | null, event: ModelActivity) {
  const count = (key: string, fallback = 0): number => {
    const value = prior?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : fallback;
  };
  const started = event.status === 'started';
  const completed = event.status === 'completed';
  const failed = event.status === 'failed' && !event.interrupted;
  const interrupted = event.status === 'failed' && event.interrupted === true;
  const requests = count('requests') + Number(started);
  const legacyCompleted = prior?.trackingVersion === 1 ? 0 : count('requests');
  const completedRequests = count('completedRequests', legacyCompleted) + Number(completed);
  const failedRequests = count('failedRequests') + Number(failed);
  const interruptedRequests = count('interruptedRequests') + Number(interrupted);
  const reportedRequests = count('reportedRequests') + Number(!!event.tokenUsage && !started);
  const pendingRequests = Math.max(
    0,
    requests - completedRequests - failedRequests - interruptedRequests,
  );
  const tokens = !started ? event.tokenUsage : undefined;
  return {
    trackingVersion: 1,
    requests,
    completedRequests,
    failedRequests,
    interruptedRequests,
    pendingRequests,
    reportedRequests,
    unreportedRequests: Math.max(0, requests - pendingRequests - reportedRequests),
    summaryRequests: count('summaryRequests') + Number(started && event.scope === 'summary'),
    /** 有部分供应商计数时仅累计已报告部分；完整性必须同时查看 usageComplete。 */
    inputTokens: reportedRequests ? count('inputTokens') + (tokens?.input_tokens ?? 0) : null,
    outputTokens: reportedRequests ? count('outputTokens') + (tokens?.output_tokens ?? 0) : null,
    totalTokens: reportedRequests ? count('totalTokens') + (tokens?.total_tokens ?? 0) : null,
    usageComplete: requests > 0 && reportedRequests === requests,
  };
}
