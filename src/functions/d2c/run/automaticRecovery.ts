import type { D2cRun } from '@/models/D2cRun';

/** 仅自动恢复基础设施中断与短暂网络故障；人工停止、业务阻塞和预算耗尽保持原状态。 */
export function automaticRecoveryPlan(
  run: Pick<
    D2cRun,
    | 'status'
    | 'stopRequested'
    | 'cancelRequested'
    | 'error'
    | 'checkpoint'
    | 'modelSnapshot'
    | 'usage'
    | 'createdAt'
    | 'updatedAt'
  >,
  now = Date.now(),
) {
  if (run.status !== 'interrupted' || run.stopRequested || run.cancelRequested) return null;
  const failure = run.error?.failure as { code?: string; requiresUser?: boolean } | undefined;
  if (failure?.requiresUser) return null;
  const reason = run.error?.reason;
  const code = failure?.code;
  if (
    !(
      reason === 'LEASE_EXPIRED' ||
      (reason === 'WORKER_INTERRUPTED' &&
        (!code ||
          [
            'WORKER_INTERRUPTED',
            'LEASE_LOST',
            'NETWORK_TIMEOUT',
            'NETWORK_UNAVAILABLE',
            'MODEL_RATE_LIMITED',
          ].includes(code)))
    )
  )
    return null;
  const attempts = run.checkpoint?.automaticRecoveryAttempts ?? 0;
  if (!Number.isSafeInteger(attempts) || (attempts as number) < 0 || (attempts as number) >= 3)
    return null;
  const endedAt = new Date(run.updatedAt).getTime();
  if (!Number.isFinite(endedAt) || now - endedAt < 5000 * 2 ** (attempts as number)) return null;
  const startedAt =
    typeof run.checkpoint?.executionStartedAt === 'string'
      ? Date.parse(run.checkpoint.executionStartedAt)
      : new Date(run.createdAt).getTime();
  const requests = run.usage?.requests ?? 0;
  const maxTurns = run.modelSnapshot?.maxTurns;
  const timeout = run.modelSnapshot?.runTimeoutMs;
  if (
    !Number.isFinite(startedAt) ||
    !Number.isSafeInteger(requests) ||
    (requests as number) < 0 ||
    !Number.isSafeInteger(maxTurns) ||
    !Number.isSafeInteger(timeout)
  )
    return null;
  const remainingMs = (timeout as number) - Math.max(0, endedAt - startedAt);
  const remainingTurns = (maxTurns as number) - (requests as number);
  if (remainingMs <= 0 || remainingTurns <= 0) return null;
  return {
    attempts: (attempts as number) + 1,
    modelSnapshot: { ...run.modelSnapshot, maxTurns: remainingTurns, runTimeoutMs: remainingMs },
  };
}
