import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { readToolFeedback } from '../toolFeedback';
import { estimateTokens } from './tokens';

/** 模型单次文本读取的字符保护上限；实际返回仍受Token预算约束。 */
export const maxReadCharacters = 256000;

/** 只压缩后续请求中的已完成写入参数；实际工具输入和持久历史保持原文。 */
export function completedWriteView(messages: BaseMessage[], budget: number) {
  return messages.map((message, index) => {
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) return message;
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
          : call.args.content;
      if (
        !['write_file', 'edit_file'].includes(call.name) ||
        typeof content !== 'string' ||
        estimateTokens(content) <= Math.max(128, budget * 0.1) ||
        !result ||
        result.status === 'error' ||
        readToolFeedback(result.content)
      )
        return call;
      /** unknown/失败结果不作为写入成功证据。 */
      try {
        const value = JSON.parse(result.text);
        if (value?.success === false || value?.ok === false || value?.outcome === 'unknown')
          return call;
      } catch {
        /** 受控写入也可返回“已保存”这样的普通文本。 */
      }
      changed = true;
      return {
        ...call,
        args: {
          ...call.args,
          ...(call.name === 'edit_file'
            ? {
                oldText: '[本局部替换已保存；原片段省略，需要时重新read_file读取。]',
                newText: `[替换正文 ${Buffer.byteLength(content)} 字节已保存；需要时read_file读取 ${String(call.args.path)}。]`,
              }
            : {
                content: `[本工具已完成保存。正文 ${Buffer.byteLength(content)} 字节，SHA-256 ${createHash('sha256').update(content).digest('hex')}；后续需要时用 read_file 读取 ${String(call.args.path)}，不必重写。]`,
              }),
        },
      };
    });
    if (!changed) return message;
    const { tool_calls: _raw, ...additional_kwargs } = message.additional_kwargs;
    return new AIMessage({
      content: message.content,
      id: message.id,
      name: message.name,
      tool_calls: calls,
      additional_kwargs,
    });
  });
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
