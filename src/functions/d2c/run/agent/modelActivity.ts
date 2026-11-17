import type { ModelRetryPlan } from './modelRetry';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { diagnoseGatewayFailure } from '../gatewayDiagnostics';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

/** 仅接受供应商明确返回的完整计数，缺失或非法值不估算为零。 */
const tokenUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** 请求编号只允许短标识，拒绝 URL、控制字符和常见凭据前缀。 */
export const gatewayRequestIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
  .refine((value) => !/^(?:sk-|figd_|bearer|token|api[-_]?key)/i.test(value));

/** 客户端观测耗时，不包含可直接测量的网关内部排队指标。 */
const durationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** 只记录模型调用元数据，摘要、工具参数和供应商正文均不进入诊断事件。 */
export const modelActivitySchema = z.object({
  operationId: z.string().uuid(),
  scope: z.enum(['generation', 'summary', 'design', 'review', 'rule_scan', 'ui']),
  status: z.enum(['started', 'completed', 'failed']),
  requestedReasoningEffort: z.enum(['low', 'high']).optional(),
  reasoningEscalated: z.boolean().optional(),
  durationMs: durationSchema.optional(),
  gatewayRequestId: gatewayRequestIdSchema.optional(),
  firstChunkMs: durationSchema.optional(),
  afterFirstChunkMs: durationSchema.optional(),
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

/** 异步请求各自隔离，仅保留单调时钟与安全编号，不保存任何分片正文。 */
const requestTiming = new AsyncLocalStorage<{
  started: number;
  firstChunkAt?: number;
  gatewayRequestId?: string;
  closed?: boolean;
}>();

/** 仅投影已知响应编号头；响应头和响应体均不进入事件或上下文。 */
export function observeModelResponseHeaders(headers: Headers): void {
  const timing = requestTiming.getStore();
  if (!timing || timing.closed || timing.gatewayRequestId) return;
  for (const name of ['x-request-id', 'request-id', 'x-ms-request-id']) {
    const id = gatewayRequestIdSchema.safeParse(headers.get(name));
    if (id.success) {
      timing.gatewayRequestId = id.data;
      return;
    }
  }
}

/**
 * SDK 产出分片时调用；空角色块、结束块和纯用量块不算实际模型输出。
 * 正文、思考或工具名称/参数的首个非空分片均计时，不读取最终聚合消息猜首包。
 */
export function observeModelChunk(message: {
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
  tool_call_chunks?: { name?: string; args?: string }[];
}): void {
  const timing = requestTiming.getStore();
  if (!timing || timing.closed || timing.firstChunkAt !== undefined) return;
  const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0;
  if (
    nonempty(message.content) ||
    nonempty(message.additional_kwargs?.reasoning_content) ||
    message.tool_call_chunks?.some((chunk) => nonempty(chunk.name) || nonempty(chunk.args))
  )
    timing.firstChunkAt = performance.now();
}

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
  const timing: NonNullable<ReturnType<typeof requestTiming.getStore>> = { started };
  /** 在持久化和重试分类前固定终点，诊断存储耗时不计入模型耗时。 */
  const finishTiming = () => {
    timing.closed = true;
    const ended = performance.now();
    return {
      durationMs: Math.round(ended - started),
      ...(timing.gatewayRequestId ? { gatewayRequestId: timing.gatewayRequestId } : {}),
      ...(timing.firstChunkAt !== undefined
        ? {
            firstChunkMs: Math.round(timing.firstChunkAt - started),
            afterFirstChunkMs:
              Math.round(ended - started) - Math.round(timing.firstChunkAt - started),
          }
        : {}),
    };
  };
  let result: T;
  try {
    result = await requestTiming.run(timing, action);
  } catch (error) {
    const measured = finishTiming();
    const failedRequestId = gatewayRequestIdSchema.safeParse(
      diagnoseGatewayFailure(error).gatewayRequestId,
    );
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
      ...measured,
      ...(!measured.gatewayRequestId && failedRequestId.success
        ? { gatewayRequestId: failedRequestId.data }
        : {}),
      ...(signal?.aborted ? { interrupted: true } : {}),
    }).catch((publishError) => {
      /** 允许重试的请求必须先保存失败/等待状态，存储失败不能被重试吞掉。 */
      if (plan && !signal?.aborted) throw publishError;
    });
    throw error;
  }
  const measured = finishTiming();
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
    ...measured,
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
