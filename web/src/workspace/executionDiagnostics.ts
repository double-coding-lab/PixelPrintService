import { z } from 'zod';
import type { ExecutionDiagnostics } from '../../../shared/executionDiagnostics';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const scope = z.object({
  runCount: z.number().int().min(0).max(2000),
  elapsedMs: z.number().finite().nonnegative().nullable(),
  runningCount: z.number().int().min(0).max(2000),
  complete: z.boolean(),
  usage: z.object({
    requests: count,
    reportedRequests: count,
    totalTokens: count,
    usageComplete: z.boolean().nullable(),
  }),
});
const schema = z.object({
  selected: scope,
  recoveryChain: scope,
  session: scope,
  resumeFromRunId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .nullable(),
  interruption: z.enum(['worker', 'lease', 'failure', 'cancelled', 'unknown']).nullable(),
});

/** 新范围元数据独立白名单投影，旧接口或非法结构保持未知，不影响原诊断读取。 */
export function readExecutionDiagnostics(input: unknown): ExecutionDiagnostics | undefined {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
