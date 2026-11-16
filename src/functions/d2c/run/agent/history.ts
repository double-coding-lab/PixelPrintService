import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { isDeepStrictEqual } from 'node:util';
import type { StoredAgentMessage } from '../types';
import type { AgentRecord } from '../types';

/** 固定错误不包含原文、参数或供应商元数据，调用方可映射到执行器 HISTORY_INVALID。 */
export class HistoryConversionError extends Error {
  readonly code = 'HISTORY_INVALID';

  /** 只接受适配器内部固定说明，避免错误路径泄露历史正文。 */
  constructor(reason: string) {
    super(`历史转换失败：${reason}`);
    this.name = 'HistoryConversionError';
  }
}

/** 拒绝无法无损表示的消息；本模块不修复、不重排或重新执行工具。 */
function invalid(reason: string): never {
  throw new HistoryConversionError(reason);
}

/** 校验配对标识，与旧持久化历史的长度及控制字符约束一致。 */
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid('无效工具标识');
  return value;
}

/** 只接受普通对象，拒绝数组、类实例及空值。 */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    invalid('不支持的对象结构');
  return value as Record<string, unknown>;
}

/** 校验并复制纯 JSON 参数；禁止 JSON.stringify 静默吞掉 undefined 或非 JSON 值。 */
function jsonObject(value: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  /** 参数只保留 JSON 数据，拒绝循环、原型对象和非有限数字。 */
  function check(entry: unknown): void {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || !entry || seen.has(entry)) invalid('工具参数不是纯 JSON');
    seen.add(entry);
    if (!Array.isArray(entry)) object(entry);
    for (const child of Object.values(entry)) check(child);
    seen.delete(entry);
  }
  object(value);
  check(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** JSON 解析失败使用固定错误，不能将引擎错误中的原文带出。 */
function argumentsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') invalid('工具参数必须是 JSON 字符串');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid('工具参数 JSON 无效');
  }
  return jsonObject(parsed);
}

/** 仅连接纯文本块；图片、推理、引用等结构必须显式拒绝，不能过滤后丢失。 */
function textContent(value: unknown, types: readonly string[]): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('不支持的消息内容');
  return value
    .map((part) => {
      const block = object(part);
      if (!types.includes(String(block.type)) || typeof block.text !== 'string')
        invalid('仅支持纯文本消息');
      if (
        Object.keys(block).some(
          (key) =>
            !['type', 'text', 'providerData'].includes(key) &&
            !(key === 'annotations' && Array.isArray(block[key]) && block[key].length === 0),
        )
      )
        invalid('不支持的文本附加结构');
      return block.text;
    })
    .join('');
}

/** 同步转换只产生内部 URI 标记；主 Agent 必须在请求边界解析为瞬时 data URI。 */
function userContent(value: unknown): HumanMessage['content'] {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('不支持的用户消息内容');
  if (!value.some((part) => object(part).type === 'input_image'))
    return textContent(value, ['input_text']);
  return value.map((part) => {
    const block = object(part);
    if (block.type === 'input_text')
      return { type: 'text', text: textContent([block], ['input_text']) };
    if (block.type !== 'input_image') invalid('不支持的用户消息块');
    const kind = block.attachmentId != null ? 'attachment' : 'capture';
    const id = block.attachmentId ?? block.captureId;
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ||
      (block.attachmentId != null && block.captureId != null) ||
      Object.keys(block).some(
        (key) => !['type', 'attachmentId', 'captureId', 'sessionId'].includes(key),
      ) ||
      (block.sessionId != null &&
        (typeof block.sessionId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(block.sessionId)))
    )
      invalid('无效图片引用');
    return { type: 'image_url', image_url: { url: `${kind}://${id}` } };
  });
}

/** 工具失败正文是事实源；completed 仅表示结果记录齐全，unknown 绝不提升为成功。 */
function failedOutput(text: string): boolean {
  try {
    const value = JSON.parse(text);
    return value?.success === false || value?.outcome === 'unknown';
  } catch {
    return false;
  }
}

/**
 * 将旧 replayHistory 已配好序的完整 StoredAgentMessage[] 转为独立的 LangChain 消息。
 * 连续 function_call 合并为一条 AIMessage，结果逐项保留 callId、名称、正文及失败语义。
 * 不接受未完成配对或跨普通消息结果；补记重排仍由旧 replayHistory 负责。
 * 只投影正文和工具字段，不复制 providerData、模型配置或凭据元数据。
 * 正文/参数中的敏感文本仍须由既有 persistence.redact 处理。本转换不是 checkpointer。
 */
export function storedHistoryToMessages(history: readonly StoredAgentMessage[]): BaseMessage[] {
  const messages: BaseMessage[] = [];
  const calls = new Map<string, string>();
  const pending = new Set<string>();
  let callGroup: AIMessage | undefined;
  for (const raw of history) {
    const item = object(raw);
    if (item.type === 'function_call') {
      const id = identifier(item.callId);
      const name = identifier(item.name);
      if (calls.has(id)) invalid('重复工具调用');
      if (item.namespace != null || (item.caller && object(item.caller).type !== 'direct'))
        invalid('不支持的工具调用结构');
      if (item.status != null && item.status !== 'completed') invalid('工具调用未完成');
      if (!callGroup) {
        if (pending.size) invalid('上一工具批次未完成');
        callGroup = new AIMessage({ content: '', tool_calls: [] });
        messages.push(callGroup);
      }
      callGroup.tool_calls!.push({
        id,
        name,
        args: argumentsObject(item.arguments),
        type: 'tool_call',
      });
      calls.set(id, name);
      pending.add(id);
    } else if (item.type === 'function_call_result') {
      callGroup = undefined;
      const id = identifier(item.callId);
      const name = calls.get(id);
      if (!name || !pending.has(id)) invalid('孤立或重复工具结果');
      if (item.name != null && item.name !== name) invalid('工具名称不匹配');
      if (item.status !== 'completed') invalid('工具结果未完成');
      if (item.namespace != null || (item.caller && object(item.caller).type !== 'direct'))
        invalid('不支持的工具结果结构');
      const output =
        typeof item.output === 'string'
          ? item.output
          : Array.isArray(item.output)
            ? textContent(item.output, ['input_text'])
            : textContent([item.output], ['text']);
      messages.push(
        new ToolMessage({
          content: output,
          tool_call_id: id,
          name,
          status: failedOutput(output) ? 'error' : 'success',
        }),
      );
      pending.delete(id);
    } else {
      callGroup = undefined;
      if (pending.size) invalid('工具批次被普通消息打断');
      if (item.type != null && item.type !== 'message') invalid('不支持的历史条目');
      if (item.status != null && item.status !== 'completed') invalid('消息未完成');
      if (item.role === 'user')
        messages.push(
          new HumanMessage({
            content: userContent(item.content),
            ...(item.id == null ? {} : { id: identifier(item.id) }),
          }),
        );
      else if (item.role === 'assistant')
        messages.push(new AIMessage(textContent(item.content, ['output_text'])));
      else invalid('不支持的消息角色');
    }
  }
  if (pending.size) invalid('工具结果缺失');
  return messages;
}

/**
 * 将一条新增完整 AIMessage/ToolMessage 投影为旧持久化回调记录，不保存 LC 原始对象。
 * AI 正文先于其调用写入，callId 沿用 tool_call.id；ToolMessage 名称可由已核实的调用提供。
 * error 状态若正文尚无失败标记，封装为 {success:false,message:原文}，防止兼容投影丢失失败。
 * 不接收流式 chunk、无效工具调用、图片或 artifact；元数据/用量不进入 sdkItem。
 * 单条流式落盘不判断完整配对；完整历史校验由 storedHistoryToMessages 或旧回放负责。
 */
export function messageToAgentRecords(message: BaseMessage, toolName?: string): AgentRecord[] {
  if (AIMessageChunk.isInstance(message) || ToolMessageChunk.isInstance(message))
    invalid('不能持久化消息分片');
  const text = textContent(message.content, ['text']);
  if (ToolMessage.isInstance(message)) {
    const callId = identifier(message.tool_call_id);
    const name = identifier(message.name ?? toolName);
    if (toolName != null && toolName !== name) invalid('工具名称不匹配');
    if (message.artifact != null) invalid('不支持工具 artifact');
    if (message.status != null && !['success', 'error'].includes(message.status))
      invalid('无效工具状态');
    const output =
      message.status === 'error' && !failedOutput(text)
        ? JSON.stringify({ success: false, message: text })
        : text;
    return [
      {
        kind: 'tool_result',
        callId,
        name,
        sdkItem: {
          type: 'function_call_result',
          callId,
          name,
          status: 'completed',
          output: { type: 'text', text: output },
        },
      },
    ];
  }
  if (!AIMessage.isInstance(message)) invalid('仅支持新增助手消息或工具结果');
  if (message.invalid_tool_calls?.length) invalid('存在无效工具调用');
  if (message.additional_kwargs?.function_call != null) invalid('不支持旧式 function_call');
  /** 部分供应商同时提供原始和标准调用；仅在内容一致时舍弃原始供应商副本。 */
  const rawCalls = message.additional_kwargs?.tool_calls;
  if (rawCalls != null) {
    if (!Array.isArray(rawCalls) || rawCalls.length !== (message.tool_calls?.length ?? 0))
      invalid('原始与标准工具调用不一致');
    for (const [index, raw] of rawCalls.entries()) {
      const normalized = message.tool_calls![index];
      const fn = object(raw.function);
      /** Chat Completions 的无参调用可返回空字符串，客户端会标准化为 {}。 */
      const rawArguments = fn.arguments === '' ? {} : argumentsObject(fn.arguments);
      if (
        raw.type !== 'function' ||
        raw.id !== normalized.id ||
        fn.name !== normalized.name ||
        !isDeepStrictEqual(rawArguments, jsonObject(normalized.args))
      )
        invalid('原始与标准工具调用不一致');
    }
  }
  const records: AgentRecord[] = [];
  if (text || !message.tool_calls?.length)
    records.push({
      kind: 'message',
      text,
      sdkItem: {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    });
  const ids = new Set<string>();
  for (const call of message.tool_calls ?? []) {
    const callId = identifier(call.id);
    const name = identifier(call.name);
    if (ids.has(callId)) invalid('重复工具调用');
    ids.add(callId);
    records.push({
      kind: 'tool_call',
      callId,
      name,
      sdkItem: {
        type: 'function_call',
        callId,
        name,
        arguments: JSON.stringify(jsonObject(call.args)),
      },
    });
  }
  return records;
}
