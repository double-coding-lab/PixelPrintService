import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { readToolFeedback } from '../toolFeedback';
import { estimateTokens } from './tokens';

/** 模型单次文本读取的字符保护上限；实际返回仍受Token预算约束。 */
export const maxReadCharacters = 256000;

/** 仅接受平台成功合同；空白、未知文案与仅未抛错都不能证明正文已保存。 */
export function confirmedWrite(result: ToolMessage, name: string, path: unknown) {
  if (result.status === 'error' || (result.name && result.name !== name)) return false;
  const text = result.text.trim();
  if (
    name === 'write_file' &&
    typeof path === 'string' &&
    (text === '已保存' || text === `已保存：${path}` || text === `已核对累计报告：${path}`)
  )
    return true;
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.ok === false ||
      value.success === false ||
      (value.error !== undefined && value.error !== null) ||
      (value.status !== undefined &&
        !['success', 'succeeded', 'saved', 'completed'].includes(value.status)) ||
      (value.outcome !== undefined && !['applied', 'saved', 'success'].includes(value.outcome))
    )
      return false;
    return value.ok === true || value.success === true;
  } catch {
    return false;
  }
}

/** 只压缩后续请求中的已完成写入参数；实际工具输入和持久历史保持原文。 */
export function completedWriteView(messages: BaseMessage[], budget: number) {
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const message of messages) {
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    if (ToolMessage.isInstance(message))
      resultCounts.set(message.tool_call_id, (resultCounts.get(message.tool_call_id) ?? 0) + 1);
  }
  return messages.map((message, index) => {
    if (
      !AIMessage.isInstance(message) ||
      AIMessageChunk.isInstance(message) ||
      !message.tool_calls?.length
    )
      return message;
    const results = new Map<string, ToolMessage>();
    for (let i = index + 1; i < messages.length && ToolMessage.isInstance(messages[i]); i++) {
      const value = messages[i] as ToolMessage;
      results.set(value.tool_call_id, value);
    }
    let changed = false;
    const calls = message.tool_calls.map((call) => {
      const result = results.get(call.id ?? '');
      const content =
        call.name === 'edit_file'
          ? `${call.args.oldText ?? ''}${call.args.newText ?? ''}`
          : call.name === 'write_file' && call.args.content && typeof call.args.content === 'object'
            ? JSON.stringify(call.args.content)
            : call.args.content;
      if (
        !['write_file', 'edit_file'].includes(call.name) ||
        !call.id ||
        callCounts.get(call.id) !== 1 ||
        resultCounts.get(call.id) !== 1 ||
        typeof content !== 'string' ||
        content.startsWith('{"type":"historical_source_reference",') ||
        content.startsWith('[仅模型视图') ||
        estimateTokens(content) <= Math.max(128, Math.min(2048, budget * 0.1)) ||
        !result ||
        ToolMessageChunk.isInstance(result) ||
        typeof result.content !== 'string' ||
        !confirmedWrite(result, call.name, call.args.path) ||
        readToolFeedback(result.content)
      )
        return call;
      changed = true;
      return {
        ...call,
        args: {
          ...call.args,
          ...(call.name === 'edit_file'
            ? {
                oldText:
                  '[仅模型视图省略已保存的原片段，真实文件及原始参数未改写；需要时read_file读取。]',
                newText: `[仅模型视图省略已保存正文 ${Buffer.byteLength(content)} 字节，未将此说明写入真实文件；需要时read_file读取 ${String(call.args.path)}。]`,
              }
            : {
                content: `[仅模型视图省略已保存正文，真实文件及原始参数未改写，未写入此占位说明。正文 ${Buffer.byteLength(content)} 字节，SHA-256 ${createHash('sha256').update(content).digest('hex')}；需要时read_file读取 ${String(call.args.path)}，不必重写。]`,
              }),
        },
      };
    });
    if (!changed) return message;
    const { tool_calls: _raw, ...additional_kwargs } = message.additional_kwargs;
    return new AIMessage({
      id: message.id,
      name: message.name,
      content: message.content,
      response_metadata: message.response_metadata,
      usage_metadata: message.usage_metadata,
      invalid_tool_calls: message.invalid_tool_calls,
      tool_calls: calls,
      additional_kwargs,
    });
  });
}

/**
 * 每次请求重新计算只读结果视图：相同读取保留最近完整回执，旧回执仍保留工具配对和定位。
 * 不缓存“模型已经看过”的状态；摘要、恢复或单独查看一段历史时，唯一原文仍会保留。
 */
export function repeatedReadView(messages: BaseMessage[]) {
  const candidates: Array<{ index: number; key: string; id: string; path?: string; text: string }> =
    [];
  const ids = new Map<string, number>();
  for (const message of messages)
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.id) ids.set(call.id, (ids.get(call.id) ?? 0) + 1);
  for (let index = 0; index < messages.length; index++) {
    const request = messages[index];
    if (!AIMessage.isInstance(request)) continue;
    const calls = new Map(
      (request.tool_calls ?? [])
        .filter((call) => call.id && ids.get(call.id) === 1)
        .map((call) => [call.id, call]),
    );
    const results = new Map<string, number>();
    for (
      let next = index + 1;
      next < messages.length && ToolMessage.isInstance(messages[next]);
      next++
    ) {
      const message = messages[next] as ToolMessage;
      results.set(message.tool_call_id, (results.get(message.tool_call_id) ?? 0) + 1);
    }
    for (
      let next = index + 1;
      next < messages.length && ToolMessage.isInstance(messages[next]);
      next++
    ) {
      const message = messages[next] as ToolMessage;
      const call = calls.get(message.tool_call_id);
      if (!call || results.get(message.tool_call_id) !== 1 || message.status === 'error') continue;
      if (message.name && message.name !== call.name) continue;
      if (
        call.name !== 'read_file' &&
        !(call.name === 'figma' && call.args.command === 'inspect-node')
      )
        continue;
      const single =
        typeof message.content === 'string'
          ? message.content
          : message.content.length === 1 && message.content[0].type === 'text'
            ? message.content[0].text
            : undefined;
      if (typeof single !== 'string' || single.length < 1024 || readToolFeedback(single)) continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(single);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.ok === false ||
        value.success === false ||
        value.outcome === 'unknown' ||
        value.error ||
        value.imageRef ||
        value.type === 'context_reference'
      )
        continue;
      if (
        call.name === 'read_file' &&
        (typeof value.content !== 'string' ||
          typeof value.offset !== 'number' ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0 ||
          typeof value.totalCharacters !== 'number' ||
          !Number.isSafeInteger(value.totalCharacters) ||
          value.totalCharacters < value.offset + value.content.length)
      )
        continue;
      const identity =
        call.name === 'read_file'
          ? [call.name, call.args.path, call.args.resource === true]
          : [call.name, call.args];
      const key = createHash('sha256')
        .update(JSON.stringify([identity, single]))
        .digest('hex');
      candidates.push({
        index: next,
        key,
        id: message.tool_call_id,
        ...(typeof call.args.path === 'string' ? { path: call.args.path } : {}),
        text: single,
      });
    }
  }
  const latest = new Map<string, (typeof candidates)[number]>();
  const replacements = new Map<number, ToolMessage>();
  for (const candidate of candidates.reverse()) {
    const current = latest.get(candidate.key);
    if (!current) {
      latest.set(candidate.key, candidate);
      continue;
    }
    const content = JSON.stringify({
      type: 'context_reference',
      duplicateOfToolCallId: current.id,
      ...(candidate.path ? { path: candidate.path } : {}),
      characters: candidate.text.length,
      resultSha256: createHash('sha256').update(candidate.text).digest('hex'),
      message:
        '相同读取结果已保留在本次上下文中较新的完整工具回执，请直接复用。此处仅省略重复正文，不表示文件变化或检查通过；若后续摘要未保留原文，可按原路径和分页重新读取。',
    });
    if (content.length + 256 >= candidate.text.length) continue;
    replacements.set(
      candidate.index,
      new ToolMessage({
        content,
        id: messages[candidate.index].id,
        name: messages[candidate.index].name,
        tool_call_id: (messages[candidate.index] as ToolMessage).tool_call_id,
        status: (messages[candidate.index] as ToolMessage).status,
        artifact: (messages[candidate.index] as ToolMessage).artifact,
        metadata: (messages[candidate.index] as ToolMessage).metadata,
        additional_kwargs: messages[candidate.index].additional_kwargs,
        response_metadata: messages[candidate.index].response_metadata,
      }),
    );
  }
  return replacements.size
    ? messages.map((message, index) => replacements.get(index) ?? message)
    : messages;
}

/** 生成与摘要共用相同的无损定位视图，完整历史及真正工具输入继续原样保存。 */
export function modelContextView(messages: BaseMessage[], budget: number) {
  return repeatedReadView(completedWriteView(messages, budget));
}

/** 读取工具直接返回可消费正文；按剩余Token预算缩小一页并重算nextOffset。 */
export function fitReadPage(output: string, budget: number) {
  let page: Record<string, unknown>;
  try {
    page = JSON.parse(output);
  } catch {
    return output;
  }
  if (!page || typeof page !== 'object') return output;
  if (
    typeof page.content !== 'string' ||
    typeof page.offset !== 'number' ||
    typeof page.totalCharacters !== 'number'
  )
    return output;
  if (estimateTokens(output) <= budget) return output;
  let low = 0,
    high = page.content.length;
  /** 将分页元数据和转义字符一起计入Token预算。 */
  function encode(length: number) {
    return JSON.stringify({
      ...page,
      content: (page.content as string).slice(0, length),
      nextOffset:
        (page.offset as number) + length < (page.totalCharacters as number)
          ? (page.offset as number) + length
          : null,
    });
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(encode(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  if (!low) throw new Error('DEEP_CONTEXT_BUDGET');
  /** 分页不能拆开UTF-16代理对。 */
  if (low < page.content.length && /[\uD800-\uDBFF]/.test(page.content[low - 1])) low--;
  if (!low) throw new Error('DEEP_CONTEXT_BUDGET');
  return encode(low);
}
