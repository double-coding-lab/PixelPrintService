import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { summaryEntries } from './recovery';
import { HistoryConversionError } from './history';
import type { HistoryArchive } from './archive';

const path = '/history/compaction_receipt.json';
const receiptSchema = z.object({
  version: z.literal(1),
  covered: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(20000),
  summary: z.string().min(1),
  snapshot: z.string().regex(/^\/history\/snapshot_[a-f0-9]{64}\.json$/),
});

/** 对象键顺序不影响语义，数组顺序与每个工具参数值继续参与覆盖校验。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** 比较业务条目而非图消息分组；无法无损转换的消息保持原历史处理路径。 */
async function hashes(message: BaseMessage, archive: HistoryArchive) {
  try {
    const entries = await summaryEntries(message, archive);
    return entries?.map((entry) =>
      createHash('sha256')
        .update(JSON.stringify(canonical(entry)))
        .digest('hex'),
    );
  } catch (error) {
    if (error instanceof HistoryConversionError) return undefined;
    throw error;
  }
}

/** 完成摘要后先保存回执，后续生成失败或进程重建仍可按完整前缀校验复用。 */
export async function saveSummaryReceipt(
  archive: HistoryArchive,
  messages: BaseMessage[],
  summary: BaseMessage,
  snapshot: string,
) {
  const covered: string[] = [];
  for (const message of messages) {
    const items = await hashes(message, archive);
    if (!items || covered.length + items.length > 20000) return;
    covered.push(...items);
  }
  if (!covered.length || typeof summary.content !== 'string') return;
  await archive.save(
    path,
    JSON.stringify({ version: 1, covered, summary: summary.content, snapshot }),
  );
}

/** 仅复用逐条完全相同且工具已配对的历史前缀；任一差异都保留原始上下文。 */
export async function loadSummaryReceipt(archive: HistoryArchive, messages: BaseMessage[]) {
  const raw = await archive.load(path);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DEEP_ARCHIVE_INVALID');
  }
  const checked = receiptSchema.safeParse(parsed);
  if (!checked.success) throw new Error('DEEP_ARCHIVE_INVALID');
  const receipt = checked.data;
  let offset = 0;
  const pending = new Set<string>();
  for (const [index, message] of messages.entries()) {
    const items = await hashes(message, archive);
    if (!items || items.some((hash, i) => hash !== receipt.covered[offset + i])) return undefined;
    offset += items.length;
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? []) pending.add(call.id!);
    if (ToolMessage.isInstance(message)) pending.delete(message.tool_call_id);
    if (offset === receipt.covered.length) {
      if (pending.size) return undefined;
      // 原始归档须仍可读取；存储异常继续上抛，缺失则沿完整历史重新准备。
      const snapshot = await archive.load(receipt.snapshot);
      if (snapshot === undefined) return undefined;
      if (
        `/history/snapshot_${createHash('sha256').update(snapshot).digest('hex')}.json` !==
        receipt.snapshot
      )
        throw new Error('DEEP_ARCHIVE_INVALID');
      return {
        cutoffIndex: index + 1,
        summaryMessage: new HumanMessage({
          content: receipt.summary,
          additional_kwargs: { lc_source: 'summarization' },
        }),
        filePath: receipt.snapshot,
      };
    }
    if (offset > receipt.covered.length) return undefined;
  }
  return undefined;
}
