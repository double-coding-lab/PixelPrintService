import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const duration = z.number().int().nonnegative().max(86_400_000);
/** 固定字段、有界数值，不保存消息、路径或供应商正文；缺测字段保持缺失。 */
export const modelPreparationSchema = z.object({
  totalMs: duration,
  promptMs: duration.optional(),
  contextMs: duration.optional(),
  backgroundMs: duration.optional(),
  visualMs: duration.optional(),
  previewMs: duration.optional(),
  guardMs: duration.optional(),
  contextViewMs: duration.optional(),
  tokenCountMs: duration.optional(),
  imagesMs: duration.optional(),
});
export type ModelPreparation = z.infer<typeof modelPreparationSchema>;
type Phase = Exclude<keyof ModelPreparation, 'totalMs'>;

/** 每次装配独立单调时钟；phase 是串行边界的墙钟区间，区间内的并行工作不累加。 */
export function createModelPreparation(clock: () => number = performance.now.bind(performance)) {
  const start = clock();
  let boundary = start;
  const phases: Partial<ModelPreparation> = {};
  const elapsed = (from: number, to: number) =>
    Math.min(86_400_000, Math.max(0, Math.round(to - from)));
  return {
    mark(phase: Phase) {
      const now = clock();
      phases[phase] = elapsed(boundary, now);
      boundary = now;
    },
    snapshot(): ModelPreparation {
      return { ...phases, totalMs: elapsed(start, clock()) };
    },
  };
}
