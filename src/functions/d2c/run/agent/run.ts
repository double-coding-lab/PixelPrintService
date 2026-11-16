import { createSubagentProgress } from './subagentCheckpoint';
import type { GuidanceReader } from './guidance';
import type { ImageResolver } from './images';
import type { ModelActivity } from './modelActivity';
import type { InteractionResume } from '../interaction';
import type { AgentTextSnapshot } from './textStream';
import {
  HumanMessage,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StoredAgentMessage, StoredTextBlock, StoredImageBlock } from '../types';
import { runAgent } from './agent';
import { createDeepModel, createDeepReasoningModels, type DeepModelConfig } from './model';
import { storedHistoryToMessages, messageToAgentRecords, HistoryConversionError } from './history';
import type { D2cMySQLCheckpointSaver } from './checkpoint';
import type { ResourceBundle } from '../../workspace/resources';
import type { PixelPrintTarget } from '../../utils/targets';
import type { GenerationTools, AgentRecord } from '../types';
import type { SubagentEvent } from '../subagent';
import { RunExecutionError, SubagentExecutionError, executionError } from '../errors';
import { BaseError as SequelizeError } from 'sequelize';
import { initialReasoningDecision } from './reasoning';
import type { DeliverySnapshot } from './delivery';

/** 只转换可信固定错误及数值 HTTP 状态，框架异常原文保留在服务端 cause。 */
export function deepGenerationFailure(error: unknown, signal: AbortSignal) {
  if (signal.aborted)
    return executionError(signal.reason, 'WORKER_INTERRUPTED', { stage: 'worker' });
  let current = error;
  let genericFailure: RunExecutionError | undefined;
  const seen = new Set<unknown>();
  /** 先检查整条可信分类链，避免外层框架标记覆盖深层存储或失租原因。 */
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof RunExecutionError &&
      !['TOOL_FAILED', 'MODEL_REQUEST_FAILED', 'SUBAGENT_FAILED', 'EXECUTION_FAILED'].includes(
        current.code,
      )
    )
      return current;
    current = 'cause' in current ? current.cause : undefined;
  }
  current = error;
  seen.clear();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    /** 框架可能以普通对象恢复 Error；仅识别既有固定说明，不透传其正文或任意 code。 */
    const message =
      'message' in current && typeof current.message === 'string' ? current.message : '';
    if (current instanceof RunExecutionError) {
      /** 工具中间件可能再包一层通用错误，继续查找原始存储/租约/预算分类。 */
      if (
        !['TOOL_FAILED', 'MODEL_REQUEST_FAILED', 'SUBAGENT_FAILED', 'EXECUTION_FAILED'].includes(
          current.code,
        )
      )
        return current;
      genericFailure ??= current;
    }
    if (current instanceof SubagentExecutionError) {
      genericFailure =
        current.context.phase === 'execute'
          ? new RunExecutionError(
              'SUBAGENT_FAILED',
              { stage: 'tool', tool: 'delegate_agent' },
              error,
            )
          : new RunExecutionError(
              'STORAGE_FAILED',
              { stage: 'storage', tool: 'wait_subagents' },
              error,
            );
    }
    if (current instanceof SequelizeError)
      return new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }, error);
    if (
      current instanceof HistoryConversionError ||
      /^DEEP_(?:CHECKPOINT|NEW_MESSAGE|MESSAGE_ALREADY)/.test(message)
    )
      return new RunExecutionError('HISTORY_INVALID', { stage: 'prepare' }, error);
    if (message === 'DEEP_MAX_TURNS')
      return new RunExecutionError('MODEL_REQUEST_LIMIT', { stage: 'model' }, error);
    if (/^DEEP_(?:CONTEXT|SUMMARY_INPUT|SUMMARY_INVALID)/.test(message))
      return new RunExecutionError('CONTEXT_LIMIT', { stage: 'model' }, error);
    if (/^DEEP_ARCHIVE_/.test(message))
      return new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }, error);
    if (message === 'DEEP_MODEL_TOOL_ARGUMENTS_INVALID')
      return new RunExecutionError('MODEL_RESPONSE_INVALID', { stage: 'model' }, error);
    if (/^DEEP_SUBAGENT_(?:PROGRESS_CHANGED|BACKGROUND_(?:INVALID|MISSING|CORRUPT))$/.test(message))
      return new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }, error);
    if (/^DEEP_BACKGROUND_SUBAGENT_(?:SCOPE_CHANGED|RESULT_MISSING|UNJOINED)$/.test(message))
      return new RunExecutionError(
        'SUBAGENT_FAILED',
        { stage: 'tool', tool: 'wait_subagents' },
        error,
      );
    const status = 'status' in current ? current.status : undefined;
    if (status === 401 || status === 403)
      return new RunExecutionError('MODEL_AUTH_FAILED', { stage: 'model' }, error);
    if (status === 429)
      return new RunExecutionError('MODEL_RATE_LIMITED', { stage: 'model' }, error);
    if (typeof status === 'number' && status >= 400 && status <= 599)
      genericFailure ??= new RunExecutionError('MODEL_REQUEST_FAILED', { stage: 'model' }, error);
    current = 'cause' in current ? current.cause : undefined;
  }
  return genericFailure ?? new RunExecutionError('EXECUTION_FAILED', { stage: 'worker' }, error);
}

/** 把正式业务输入接入 Deep Agents；已有上下文由 Checkpointer 恢复，数据库中的既有历史仅首次导入。 */
export async function runDeepGeneration(input: {
  model: DeepModelConfig;
  readGuidance?: GuidanceReader;
  resolveImage?: ImageResolver;
  history: StoredAgentMessage[];
  resume?: InteractionResume;
  userDecisions?: string;
  priorUsage?: Record<string, unknown>;
  continueWork?: boolean;
  subagentIdentity?: string;
  message: { id: string; content: string | Array<StoredTextBlock | StoredImageBlock> };
  instructions: string;
  maxTurns: number;
  signal: AbortSignal;
  tools: GenerationTools;
  record: (entry: AgentRecord) => Promise<void>;
  onText?: (snapshot: AgentTextSnapshot) => Promise<void>;
  onModelActivity?: (event: ModelActivity) => Promise<void>;
  sanitizePartialText?: (text: string) => string;
  recordSubagent?: (entry: SubagentEvent) => Promise<void>;
  assertLease: () => Promise<void>;
  redact: (value: string) => string;
  checkpoint: D2cMySQLCheckpointSaver;
  resources: { bundle: ResourceBundle; bundleHash: string; target: PixelPrintTarget };
  testModel?: BaseChatModel;
  reasoningContext?: { hasSourceFiles: boolean; hasDesign: boolean };
  inspectDelivery?: (required: boolean) => Promise<DeliverySnapshot>;
}) {
  /** 在进入图、归档和展示前统一脱敏，保留真实消息类型及工具调用标识。 */
  function sanitize(message: BaseMessage) {
    return mapStoredMessagesToChatMessages([
      JSON.parse(input.redact(JSON.stringify(message.toDict()))),
    ])[0];
  }
  try {
    const last = input.history.at(-1) as { role?: string; content?: unknown } | undefined;
    if (
      !input.resume &&
      (last?.role !== 'user' ||
        JSON.stringify(last.content) !== JSON.stringify(input.message.content))
    )
      throw new RunExecutionError('HISTORY_INVALID', { stage: 'prepare' });
    let previous;
    try {
      previous = await input.checkpoint.getTuple(input.checkpoint.config());
    } catch (error) {
      throw executionError(error, 'STORAGE_FAILED', { stage: 'storage' });
    }
    const bootstrapHistory = previous
      ? []
      : storedHistoryToMessages(input.history.slice(0, -1)).map(sanitize);
    const continuation =
      input.continueWork ??
      (Boolean(input.resume) ||
        (typeof input.message.content === 'string' &&
          /^(?:继续[。！!]?|继续执行[。！!]?|继续当前任务。先核对已保存文件和工具结果，保留既有产物，不重复执行结果未知的副作用；按当前会话上下文继续。)$/.test(
            input.message.content.trim(),
          )));
    const subagentProgress = await createSubagentProgress(input.checkpoint, {
      continuation,
      messageId: input.message.id,
      identity: input.subagentIdentity ?? input.resources.bundleHash,
    });
    const overview = continuation ? await subagentProgress.overview(input.tools) : '';
    const reasoningModels = input.testModel ? undefined : createDeepReasoningModels(input.model);
    const reasoningUserText =
      typeof input.message.content === 'string'
        ? input.message.content
        : input.message.content
            .flatMap((block) => (block.type === 'input_text' ? [block.text] : []))
            .join('\n');
    const discussionOnly =
      /(?:暂不|先不|不要|无需)(?:执行|进行)?(?:生成|出码|写代码)|只(?:讨论|解释|分析)/u.test(
        reasoningUserText,
      );
    const generationRequired =
      !discussionOnly &&
      (initialReasoningDecision({
        userText: reasoningUserText,
        ...input.reasoningContext,
      }).task === 'page_generation' ||
        (continuation && !input.resume && Boolean(input.reasoningContext?.hasSourceFiles)) ||
        (Boolean(input.reasoningContext?.hasDesign) &&
          !input.reasoningContext?.hasSourceFiles &&
          /^(?:开始吧?|开始实现|开始生成)[。！!\s]*$/.test(reasoningUserText.trim())));
    const inspectDelivery = input.inspectDelivery
      ? () => input.inspectDelivery!(generationRequired)
      : undefined;
    const result = await runAgent({
      subagentProgress,
      userDecisions: input.userDecisions,
      model: input.testModel ?? reasoningModels?.low ?? createDeepModel(input.model),
      reasoningModels,
      reasoningContext: input.reasoningContext,
      reasoningUserText,
      reasoningAdmissionId: continuation ? undefined : input.message.id,
      resolveImage: input.resolveImage,
      readGuidance: input.readGuidance,
      onText: input.onText,
      onModelActivity: input.onModelActivity,
      sanitizePartialText: input.sanitizePartialText,
      messages: input.resume
        ? []
        : storedHistoryToMessages([
            { role: 'user', id: input.message.id, content: input.message.content },
          ]).map((message) => sanitize(new HumanMessage({ ...message, id: input.message.id }))),
      resume: input.resume,
      priorUsage: input.priorUsage,
      bootstrapHistory,
      instructions: [
        input.instructions,
        continuation
          ? '本轮为继续原任务。先复用历史中已完成的工具结果、固定资源读取和现有产物，再处理未完成项；不要把继续当成重新初始化或整页重扫。资料变化、结果未知或确实缺少必要细节时才重新核查。未完成子任务优先按原角色、节点和写入范围继续委派，平台会恢复原子会话。'
          : '',
        overview,
      ]
        .filter(Boolean)
        .join('\n'),
      maxTurns: input.maxTurns,
      signal: input.signal,
      tools: input.tools,
      assertLease: input.assertLease,
      contextBudgetTokens: input.model.contextBudgetTokens,
      inspectDelivery,
      deliveryAdmissionId: input.message.id,
      checkpoint: input.checkpoint,
      resources: input.resources,
      transformMessage: sanitize,
      recordSubagent: input.recordSubagent
        ? async (entry) => {
            try {
              await input.recordSubagent!(entry);
            } catch (error) {
              throw executionError(error, 'STORAGE_FAILED', { stage: 'storage' });
            }
          }
        : undefined,
      recoverHistory: async () => storedHistoryToMessages(input.history.slice(0, -1)).map(sanitize),
      previousUserTexts: input.history
        .slice(0, -1)
        .filter((item) => 'role' in item && item.role === 'user')
        .flatMap((item) =>
          storedHistoryToMessages([item]).map((message) => sanitize(message).text),
        ),
      onMessage: async (message, streamId) => {
        for (const entry of messageToAgentRecords(message)) {
          try {
            await input.record({
              ...entry,
              ...(entry.kind === 'message' && streamId ? { streamId } : {}),
            });
          } catch (error) {
            throw executionError(error, 'STORAGE_FAILED', { stage: 'storage' });
          }
        }
      },
    });
    if (!result.waiting && inspectDelivery && (await inspectDelivery()).problems.length)
      throw new RunExecutionError('DELIVERY_INCOMPLETE', { stage: 'validation' });
    return result;
  } catch (error) {
    throw deepGenerationFailure(error, input.signal);
  }
}
