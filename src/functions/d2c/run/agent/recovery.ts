import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { isDeepStrictEqual } from 'node:util';
import { messageToAgentRecords } from './history';
import type { HistoryArchive } from './archive';

/** 大工具结果在图中是归档引用，在业务历史中是原文；先还原再比较，不能直接比较消息 ID。 */
export async function summaryEntries(message: BaseMessage, archive?: HistoryArchive) {
  if (message.type === 'human')
    return [
      {
        type: 'human',
        content:
          Array.isArray(message.content) && message.content.some((block) => block.type !== 'text')
            ? message.content
            : message.text,
      },
    ];
  if (ToolMessage.isInstance(message) && typeof message.content === 'string') {
    let reference;
    try {
      reference = JSON.parse(message.content);
    } catch {
      reference = undefined;
    }
    if (reference?.archived === true && typeof reference.path === 'string') {
      if (!archive) return undefined;
      const raw = await archive.load(reference.path);
      if (!raw) return undefined;
      const original = JSON.parse(raw);
      if (
        original.callId !== message.tool_call_id ||
        original.name !== message.name ||
        typeof original.content !== 'string'
      )
        return undefined;
      message = new ToolMessage({ ...message, content: original.content });
    }
  }
  if (!AIMessage.isInstance(message) && !ToolMessage.isInstance(message)) return undefined;
  return messageToAgentRecords(message).map(({ sdkItem }) => {
    const entry = sdkItem as Record<string, unknown>;
    return entry.type === 'function_call'
      ? { ...entry, arguments: JSON.parse(entry.arguments as string) }
      : entry;
  });
}

/** 检查点与数据库回放对助手正文/工具调用的分组不同，以内容条目对齐摘要覆盖范围。 */
export async function restoreSummary<
  T extends { cutoffIndex: number; summaryMessage: BaseMessage },
>(
  event: T | undefined,
  saved: BaseMessage[],
  stable: BaseMessage[],
  archive?: HistoryArchive,
): Promise<T | undefined> {
  if (
    !event ||
    !Number.isInteger(event.cutoffIndex) ||
    event.cutoffIndex < 1 ||
    event.cutoffIndex > saved.length
  )
    return undefined;
  const covered: unknown[] = [];
  for (const message of saved.slice(0, event.cutoffIndex)) {
    const items = await summaryEntries(message, archive);
    if (!items) return undefined;
    covered.push(...items);
  }
  let offset = 0;
  const pending = new Set<string>();
  for (const [index, message] of stable.entries()) {
    const items = await summaryEntries(message, archive);
    if (!items || !isDeepStrictEqual(items, covered.slice(offset, offset + items.length)))
      return undefined;
    offset += items.length;
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? []) pending.add(call.id!);
    if (ToolMessage.isInstance(message)) pending.delete(message.tool_call_id);
    if (offset === covered.length)
      return pending.size ? undefined : { ...event, cutoffIndex: index + 1 };
    if (offset > covered.length) return undefined;
  }
  return undefined;
}
