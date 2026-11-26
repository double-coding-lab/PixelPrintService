import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';

/** 同时读取普通流的供应商字段和原生流的标准思考块，供协议回传与私有归档。 */
export function messageReasoningContent(message: BaseMessage): string | undefined {
  if (!AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message)) return undefined;
  const raw = message.additional_kwargs.reasoning_content;
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(message.content)) return undefined;
  const blocks = message.content.filter((block) => block.type === 'reasoning');
  if (!blocks.length) return undefined;
  if (blocks.some((block) => typeof block.reasoning !== 'string')) return undefined;
  return blocks.map((block) => block.reasoning).join('');
}

/** 重建平台助手消息时只保留真实思考，不复制可能已失效的原始工具参数。 */
export function messageReasoningFields(message: BaseMessage) {
  const reasoning = messageReasoningContent(message);
  return reasoning === undefined ? {} : { additional_kwargs: { reasoning_content: reasoning } };
}
