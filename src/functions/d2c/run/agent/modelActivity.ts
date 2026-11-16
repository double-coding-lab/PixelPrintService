import type { ModelRetryPlan } from './modelRetry';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

/** 仅接受供应商明确返回的完整计数，缺失或非法值不估算为零。 */
const tokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** 只记录模型调用元数据，摘要、工具参数和供应商正文均不进入诊断事件。 */
export const modelActivitySchema = z.object({
  operationId: z.string().uuid(),
  scope: z.enum(['generation', 'summary', 'design', 'review', 'rule_scan', 'ui']),
  status: z.enum(['started', 'completed', 'failed']),
  requestedReasoningEffort: z.enum(['low', 'high']).optional(),
  reasoningEscalated: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().max(86400000).optional(),
  interrupted: z.boolean().optional(),
  retryAfterMs: z.number().int().min(0).max(60000).optional(),
  retryAttempt: z.number().int().min(1).max(2).optional(),
  rateLimited: z.boolean().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  finishReason: z.string().max(40).optional(),
  outputTextBytes: z.number().int().nonnegative().optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
});
export type ModelActivity = z.infer<typeof modelActivitySchema>;
/** 提交给网关的请求参数，不表示供应商已采纳或实际使用的思考强度。 */
export type ModelRequestMetadata = Pick<
  ModelActivity,
  'requestedReasoningEffort' | 'reasoningEscalated'
>;

/**
 * 包裹一次实际模型请求，用单调时钟测量耗时；记录失败不能被当作模型成功。
 * metadata 仅投影请求思考参数，起止及失败事件共用同一快照，不记录实际推理内容。
 */
export async function observeModelRequest<T>(
  scope: ModelActivity['scope'],
  action: () => T | Promise<T>,
  publish?: (event: ModelActivity) => Promise<void>,
  signal?: AbortSignal,
  retry?: (error: unknown) => ModelRetryPlan | undefined,
  metadata?: ModelRequestMetadata,
): Promise<T> {
  if (!publish) return action();
  const requestMetadata = modelActivitySchema
    .pick({ requestedReasoningEffort: true, reasoningEscalated: true })
    .parse(metadata ?? {});
  const operationId = randomUUID();
  await publish({ operationId, scope, status: 'started', ...requestMetadata });
  const started = performance.now();
  let result: T;
  try {
    result = await action();
  } catch (error) {
    /** 原始模型/取消错误优先，失效租约不绕过事务补写失败事件。 */
    const plan = signal?.aborted ? undefined : retry?.(error);
    await publish({
      operationId,
      scope,
      status: 'failed',
      ...requestMetadata,
      ...(plan
        ? { retryAfterMs: plan.delayMs, retryAttempt: plan.attempt, rateLimited: plan.rateLimited }
        : {}),
      durationMs: Math.round(performance.now() - started),
      ...(signal?.aborted ? { interrupted: true } : {}),
    }).catch((publishError) => {
      /** 允许重试的请求必须先保存失败/等待状态，存储失败不能被重试吞掉。 */
      if (plan && !signal?.aborted) throw publishError;
    });
    throw error;
  }
  const usage = tokenUsageSchema.safeParse(
    result && typeof result === 'object' && 'usage_metadata' in result
      ? result.usage_metadata
      : undefined,
  );
  /** 只保存长度和结束分类，识别空响应或截断，不保存正文或内部推理。 */
  const message = result as {
    text?: unknown;
    tool_calls?: unknown[];
    response_metadata?: { finish_reason?: unknown };
  } | null;
  const finishReason = message?.response_metadata?.finish_reason;
  await publish({
    operationId,
    scope,
    status: 'completed',
    ...requestMetadata,
    durationMs: Math.round(performance.now() - started),
    ...(usage.success ? { tokenUsage: usage.data } : {}),
    ...(['stop', 'length', 'tool_calls', 'content_filter'].includes(String(finishReason))
      ? { finishReason: String(finishReason) }
      : {}),
    ...(typeof message?.text === 'string'
      ? { outputTextBytes: Buffer.byteLength(message.text) }
      : {}),
    ...(Array.isArray(message?.tool_calls) ? { toolCallCount: message.tool_calls.length } : {}),
  });
  return result;
}
