import { ChatOpenAICompletions } from '@langchain/openai';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { estimateTokens } from './tokens';
import { observeModelChunk, observeModelResponseHeaders } from './modelActivity';

export type DeepModelConfig = {
  baseURL: string;
  name: string;
  apiKey: string;
  contextBudgetTokens: number;
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

/** 在 SDK 交付分片前记录观测时间；主/子模型及摘要复用同一入口。 */
class ObservedChatCompletions extends ChatOpenAICompletions {
  /** 原生内容块事件路径与普通分片路径共用计时上下文，不读取 provider 原始载荷。 */
  override async *_streamChatModelEvents(
    ...args: Parameters<ChatOpenAICompletions['_streamChatModelEvents']>
  ) {
    for await (const event of super._streamChatModelEvents(...args)) {
      observeNativeChunk(event);
      yield event;
    }
  }

  /** 不缓存或改写流，保留 SDK 的用量、工具、回调及取消行为。 */
  override async *_streamResponseChunks(
    ...args: Parameters<ChatOpenAICompletions['_streamResponseChunks']>
  ) {
    for await (const chunk of super._streamResponseChunks(...args)) {
      observeModelChunk(chunk.message);
      yield chunk;
    }
  }
}

/** 内网网关沿用 Chat Completions 协议，单次输出上限由网关默认值决定。 */
export function createDeepModel(config: DeepModelConfig, effort?: 'low' | 'high') {
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
    timeout: 60_000,
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
