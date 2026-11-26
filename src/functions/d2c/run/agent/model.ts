import {
  ChatOpenAICompletions,
  convertMessagesToCompletionsMessageParams,
} from '@langchain/openai';
import type OpenAI from 'openai';
import type { BaseMessage } from '@langchain/core/messages';
import { messageReasoningContent } from './reasoningContent';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { estimateTokens } from './tokens';
import { observeModelChunk, observeModelResponseHeaders } from './modelActivity';

export type DeepModelConfig = {
  baseURL: string;
  name: string;
  apiKey: string;
  contextBudgetTokens: number;
  requestTimeoutMs?: number;
  reasoningPolicy?: 'adaptive' | 'provider-default';
};

/** 仅明确支持的 DeepSeek Flash/V4 Pro 调整思考强度，其他型号沿用供应商默认。 */
function supportsAdaptiveReasoning(config: DeepModelConfig): boolean {
  return (
    /^deepseek-(?:flash|v4-pro)$/i.test(config.name) &&
    config.reasoningPolicy !== 'provider-default'
  );
}

/** 原生流仅以非空正文、思考和工具名称/参数标记首块，忽略角色与用量事件。 */
function observeNativeChunk(event: ChatModelStreamEvent): void {
  if (event.event === 'content-block-delta') {
    if (event.delta.type === 'text-delta') observeModelChunk({ content: event.delta.text });
    if (event.delta.type === 'reasoning-delta')
      observeModelChunk({ content: event.delta.reasoning });
    if (event.delta.type === 'block-delta')
      observeNativeChunk({
        event: 'content-block-start',
        index: event.index,
        content: event.delta.fields,
      });
  }
  if (event.event !== 'content-block-start') return;
  const block = event.content;
  if (block.type === 'text') observeModelChunk({ content: block.text });
  if (block.type === 'reasoning') observeModelChunk({ content: block.reasoning });
  if (block.type === 'tool_call_chunk')
    observeModelChunk({
      tool_call_chunks: [
        {
          name: typeof block.name === 'string' ? block.name : undefined,
          args: typeof block.args === 'string' ? block.args : undefined,
        },
      ],
    });
}

const requestMessages = Symbol('pixelprint.requestMessages');

/** 在 SDK 交付分片前记录观测时间；主/子模型及摘要复用同一入口。 */
class ObservedChatCompletions extends ChatOpenAICompletions {
  /** 请求私有元数据随调用选项传递，避免并发主/子请求串用历史。 */
  override _generate(...args: Parameters<ChatOpenAICompletions['_generate']>) {
    args[1] = Object.assign({}, args[1], { [requestMessages]: args[0] });
    args[1].options = Object.assign({}, args[1].options, { [requestMessages]: args[0] });
    return super._generate(...args);
  }

  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: OpenAI.RequestOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: OpenAI.RequestOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  /** SDK 转换遗漏供应商思考字段；仅回传模型真实返回的字符串，不构造思考正文。 */
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    options?: OpenAI.RequestOptions & { [requestMessages]?: BaseMessage[] },
  ) {
    const { [requestMessages]: messages, ...sdkOptions } = options ?? {};
    if (messages?.some((message) => messageReasoningContent(message) !== undefined)) {
      request = {
        ...request,
        messages: messages.flatMap((message) => {
          const converted = convertMessagesToCompletionsMessageParams({
            messages: [message],
            model: this.model,
          });
          const reasoning = messageReasoningContent(message);
          if (reasoning !== undefined)
            for (const item of converted)
              if (item.role === 'assistant') Object.assign(item, { reasoning_content: reasoning });
          return converted;
        }),
      };
    }
    /** DeepSeek 工具协议要求每条助手消息都有字符串；旧历史和平台消息仅补空值。 */
    if (request.tools?.length && /^(?:deepseek\/)?deepseek(?:-|$)/i.test(this.model)) {
      request = {
        ...request,
        messages: request.messages.map((item) =>
          item.role === 'assistant' &&
          typeof (item as { reasoning_content?: unknown }).reasoning_content !== 'string'
            ? { ...item, reasoning_content: '' }
            : item,
        ),
      };
    }
    return request.stream
      ? super.completionWithRetry(request, sdkOptions)
      : super.completionWithRetry(
          request as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          sdkOptions,
        );
  }

  /** 原生内容块事件路径与普通分片路径共用计时上下文，不读取 provider 原始载荷。 */
  override async *_streamChatModelEvents(
    ...args: Parameters<ChatOpenAICompletions['_streamChatModelEvents']>
  ) {
    args[1] = Object.assign({}, args[1], { [requestMessages]: args[0] });
    for await (const event of super._streamChatModelEvents(...args)) {
      observeNativeChunk(event);
      yield event;
    }
  }

  /** 不缓存或改写流，保留 SDK 的用量、工具、回调及取消行为。 */
  override async *_streamResponseChunks(
    ...args: Parameters<ChatOpenAICompletions['_streamResponseChunks']>
  ) {
    args[1] = Object.assign({}, args[1], { [requestMessages]: args[0] });
    for await (const chunk of super._streamResponseChunks(...args)) {
      observeModelChunk(chunk.message);
      yield chunk;
    }
  }
}

/** 内网网关沿用 Chat Completions 协议，单次输出上限由网关默认值决定。 */
export function createDeepModel(config: DeepModelConfig, effort?: 'low' | 'high') {
  const requestTimeoutMs = config.requestTimeoutMs === undefined ? 180000 : config.requestTimeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000)
    throw new RangeError('requestTimeoutMs must be an integer between 1000 and 600000');
  const model = new ObservedChatCompletions({
    model: config.name,
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseURL.replace(/\/chat\/completions\/?$/, ''),
      /** fetch 收到 HTTP 响应即可保存编号，流失败或取消时仍能使用。 */
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        observeModelResponseHeaders(response.headers);
        return response;
      },
    },
    streaming: true,
    streamUsage: true,
    maxRetries: 0,
    timeout: requestTimeoutMs,
    callbacks: [],
    ...(effort && supportsAdaptiveReasoning(config)
      ? { modelKwargs: { reasoning_effort: effort } }
      : {}),
  });
  /** 框架内部和平台预算使用同一离线估算，真实用量仍由网关报告。 */
  model.getNumTokens = async (content) => estimateTokens(content);
  return model;
}

/** 同配置构造低/高思考模型，不发起请求；未知模型或供应商默认策略不创建变体。 */
export function createDeepReasoningModels(
  config: DeepModelConfig,
): { low: BaseChatModel; high: BaseChatModel } | undefined {
  if (!supportsAdaptiveReasoning(config)) return undefined;
  return { low: createDeepModel(config, 'low'), high: createDeepModel(config, 'high') };
}
