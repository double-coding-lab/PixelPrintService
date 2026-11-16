import { ChatOpenAICompletions } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { estimateTokens } from './tokens';

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

/** 内网网关沿用 Chat Completions 协议，单次输出上限由网关默认值决定。 */
export function createDeepModel(config: DeepModelConfig, effort?: 'low' | 'high') {
  const model = new ChatOpenAICompletions({
    model: config.name,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseURL.replace(/\/chat\/completions\/?$/, '') },
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
