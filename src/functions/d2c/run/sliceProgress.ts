import { z } from 'zod';

export const sliceProgressSchema = z.object({
  stage: z.literal('slices'),
  phase: z.enum(['starting', 'fetching', 'exporting', 'saving']),
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative().optional(),
});
export type SliceProgress = z.infer<typeof sliceProgressSchema>;

/** 只识别固定脚本的阶段和计数，不公开日志中的路径、节点名或上游错误正文。 */
export function parseSliceProgress(line: string, previous: SliceProgress): SliceProgress | null {
  const total = line.match(/(?:自扫切图清单|基线切图清单)[:：](\d+) 项/);
  if (total) return { ...previous, phase: 'exporting', total: Number(total[1]) };
  if (/^\s*· (?:hit|share)\s/.test(line)) return { ...previous, completed: previous.completed + 1 };
  if (/^\s*[×?] (?:err|miss)\s/.test(line)) return { ...previous, failed: previous.failed + 1 };
  if (/\[pp-d2c-reskin\] === theme:/.test(line)) return { ...previous, phase: 'fetching' };
  return null;
}
