import { estimateTokens } from './tokens';
import { createHash } from 'node:crypto';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';

type Page = {
  index: number;
  id: string;
  key: string;
  path: string;
  offset: number;
  end: number;
  content: string;
  raw: string;
};

/** 只在当前可见消息内用真实版本和逐字重叠证明覆盖；不记跨摘要的“已经读过”。 */
export function coveredReadView(messages: BaseMessage[]) {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.id) calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
    if (ToolMessage.isInstance(message))
      results.set(message.tool_call_id, (results.get(message.tool_call_id) ?? 0) + 1);
  }
  const pages: Page[] = [];
  for (let index = 0; index < messages.length; index++) {
    const request = messages[index];
    if (!AIMessage.isInstance(request) || AIMessageChunk.isInstance(request)) continue;
    const paired = new Map((request.tool_calls ?? []).map((call) => [call.id, call]));
    for (
      let next = index + 1;
      next < messages.length && ToolMessage.isInstance(messages[next]);
      next++
    ) {
      const result = messages[next] as ToolMessage;
      const call = paired.get(result.tool_call_id);
      if (
        !call ||
        call.name !== 'read_file' ||
        !call.id ||
        calls.get(call.id) !== 1 ||
        results.get(call.id) !== 1 ||
        ToolMessageChunk.isInstance(result) ||
        result.status === 'error' ||
        (result.name && result.name !== 'read_file') ||
        typeof call.args.path !== 'string' ||
        typeof result.content !== 'string' ||
        result.content.length < 1024
      )
        continue;
      let value;
      try {
        value = JSON.parse(result.content);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) =>
            !['path', 'sha256', 'offset', 'content', 'totalCharacters', 'nextOffset'].includes(key),
        ) ||
        (value.path !== undefined && value.path !== call.args.path) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        typeof value.content !== 'string' ||
        !value.content ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < 0 ||
        !Number.isSafeInteger(value.totalCharacters) ||
        value.totalCharacters < value.offset + value.content.length ||
        (value.nextOffset === null
          ? value.totalCharacters !== value.offset + value.content.length
          : value.nextOffset !== value.offset + value.content.length)
      )
        continue;
      pages.push({
        index: next,
        id: call.id,
        path: call.args.path,
        key: JSON.stringify([
          call.args.path,
          call.args.resource === true,
          value.sha256,
          value.totalCharacters,
        ]),
        offset: value.offset,
        end: value.offset + value.content.length,
        content: value.content,
        raw: result.content,
      });
    }
  }
  // 不信任自报摘要而忽略冲突；同版本重叠文本矛盾时整个分组都保留原文。
  const groups = new Map<string, Page[]>();
  for (const page of pages) {
    const group = groups.get(page.key) ?? [];
    group.push(page);
    groups.set(page.key, group);
  }
  const replacements = new Map<number, ToolMessage>();
  for (const group of groups.values()) {
    if (group.length > 128) continue; // 异常超大组保守直通，避免二次方比对拖慢准备。
    if (
      group.some((a, index) =>
        group.slice(index + 1).some((b) => {
          const start = Math.max(a.offset, b.offset),
            end = Math.min(a.end, b.end);
          return (
            start < end &&
            a.content.slice(start - a.offset, end - a.offset) !==
              b.content.slice(start - b.offset, end - b.offset)
          );
        }),
      )
    )
      continue;
    const kept: Page[] = [];
    for (const page of [...group].reverse()) {
      let cursor = page.offset;
      const covering: Page[] = [];
      for (const newer of [...kept].sort((a, b) => a.offset - b.offset || b.end - a.end)) {
        if (newer.offset > cursor) break;
        if (newer.end <= cursor) continue;
        covering.push(newer);
        cursor = newer.end;
        if (cursor >= page.end) break;
      }
      const content = JSON.stringify({
        type: 'context_reference',
        path: page.path,
        coveredBy: covering.map(({ id, offset, end }) => ({ toolCallId: id, offset, end })),
        offset: page.offset,
        end: page.end,
        resultSha256: createHash('sha256').update(page.raw).digest('hex'),
        message:
          '本页正文已逐字核对，由本次上下文中较新的同版本完整读取回执覆盖，按coveredBy复用；原始回执仍完整保存。只折叠重复正文，不表示检查通过。若摘要或恢复后覆盖回执不在上下文中，按原路径定点重读所需区间。',
      });
      if (
        cursor < page.end ||
        covering.length > 16 ||
        content.length + 256 >= page.raw.length ||
        estimateTokens(content) + 64 >= estimateTokens(page.raw)
      ) {
        kept.push(page);
        continue;
      }
      const original = messages[page.index] as ToolMessage;
      replacements.set(
        page.index,
        new ToolMessage({
          content,
          id: original.id,
          name: original.name,
          tool_call_id: original.tool_call_id,
          status: original.status,
          artifact: original.artifact,
          metadata: original.metadata,
          additional_kwargs: original.additional_kwargs,
          response_metadata: original.response_metadata,
        }),
      );
    }
  }
  return replacements.size
    ? messages.map((message, index) => replacements.get(index) ?? message)
    : messages;
}
