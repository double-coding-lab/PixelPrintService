import { createMiddleware } from 'langchain';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import type { SubagentRole } from '../subagent';
import { readToolFeedback } from '../toolFeedback';

export type ReasoningEffort = 'low' | 'high';
const reasonSchema = z.enum([
  'specialist_default',
  'casual_chat',
  'explicit_question',
  'parameter_confirmation',
  'simple_replacement',
  'local_interaction',
  'page_generation',
  'complex_change',
  'ambiguous_task',
  'rules_failed',
]);
const taskSchema = z.enum([
  'rule_scan',
  'ui',
  'design',
  'review',
  'chat',
  'question',
  'confirmation',
  'simple_replacement',
  'local_interaction',
  'page_generation',
  'complex_change',
  'unknown',
]);
export type ReasoningDecision = {
  effort: ReasoningEffort;
  reason: z.infer<typeof reasonSchema>;
  task: z.infer<typeof taskSchema>;
  escalated: boolean;
};
export type ReasoningInput = {
  specialist?: SubagentRole;
  admissionId?: string;
  userText: string;
  hasSourceFiles?: boolean;
  hasDesign?: boolean;
  /** 调用方已确认是已有源码上的局部交互；不从历史摘要推断。 */
  localInteraction?: boolean;
  /** 实时guidance使用其自身正文重算范围，不能沿用最初输入的局部标记。 */
  classifyLocalInteraction?: (text: string) => boolean;
};

const decisionSchema = z
  .object({
    effort: z.enum(['low', 'high']),
    reason: reasonSchema,
    task: taskSchema,
    escalated: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.escalated === (value.reason === 'rules_failed') &&
      (!value.escalated || value.effort === 'high'),
  );
const policySchema = z
  .object({
    scope: z.enum(['root', 'rule_scan', 'ui', 'design', 'review']),
    admissionId: z.string().min(1).max(200).optional(),
    decision: decisionSchema,
    /** 新授权输入之前的工具 ID 不可再次作为本轮升级证据，摘要移除正文后仍有效。 */
    ignoredCallIds: z.array(z.string()).default([]),
  })
  .strict();
type ReasoningPolicyState = z.infer<typeof policySchema>;

/** 选模包装器与策略节点共享状态投影，保持检查点中的决策可见。 */
export const reasoningStateSchema = z.object({
  _pixelprintReasoning: policySchema.optional(),
  guidanceApplied: z.array(z.string()).optional(),
});

/** 仅分类入口授权正文；规则只覆盖明确表达，无法确定的语义保持 high。 */
export function initialReasoningDecision(input: ReasoningInput): ReasoningDecision {
  const decide = (
    effort: ReasoningEffort,
    reason: ReasoningDecision['reason'],
    task: ReasoningDecision['task'],
  ): ReasoningDecision => ({ effort, reason, task, escalated: false });
  if (input.specialist)
    return decide(
      input.specialist === 'rule_scan' ? 'low' : 'high',
      'specialist_default',
      input.specialist,
    );
  const text = input.userText.trim().toLowerCase();
  if (
    /^(?:你好|您好|嗨|哈喽|早上好|晚上好|谢谢|感谢|辛苦了|再见|hi|hello|hey|thanks|thank you)[!！。，,.?？\s]*$/u.test(
      text,
    )
  )
    return decide('low', 'casual_chat', 'chat');
  const followupAction =
    /(?:并且?|然后|同时|\b(?:and(?:\s+then)?|then|also)\b)\s*(?:(?:帮我|请)\s*|(?:please|only|just|help me)\s+)?(?:实现|生成|修改|修复|重构|开发|refactor\b|implement\b|generate\b|create\b|build\b|rewrite\b|fix\b|repair\b|modify\b|update\b)/u.test(
      text,
    );
  const explicitAction =
    /(?:请直接|帮我|给我)\s*(?:实现|生成|修改|修复|重构|开发|refactor\b|implement\b|generate\b|create\b|build\b|rewrite\b|fix\b|repair\b|modify\b|update\b)|\bplease\s+(?:refactor|implement|generate|create|build|rewrite|fix|repair|modify|update)\b|[?？;；。.!！]\s*(?:(?:then|also)\s+|然后)?(?:实现|生成|修改|修复|重构|开发|refactor\b|implement\b|generate\b|create\b|build\b|rewrite\b|fix\b|repair\b|modify\b|update\b)/u.test(
      text,
    );
  /** how/如何类操作方法问答仍是问答，只有另行明确要求执行才覆盖问答档位。 */
  const asksHow = /^(?:请)?(?:如何|怎么|为什么|什么是)|^(?:what|why|how)\b/u.test(text);
  const action = explicitAction || (followupAction && !asksHow);
  const question =
    /^(?:请)?(?:解释|说明|介绍|告诉我|什么是|为什么|怎么|如何|能否解释|请问)|^(?:what|why|how|explain|describe)\b/u.test(
      text,
    ) ||
    (/[?？]$/u.test(text) &&
      !/(?:创建|新建|生成|开发|实现|替换|修改|修复|重构|改成|改为|replace|change|implement|build)/u.test(
        text,
      ));
  if (question && !action) return decide('low', 'explicit_question', 'question');
  if (
    /(?:跨(?:文件|模块|组件)|多个(?:文件|组件|模块)|复杂布局|响应式|重构|布局错乱|修复.*布局|布局.*修复|cross[- ]file|multi[- ]file|responsive|refactor|complex layout)/u.test(
      text,
    )
  )
    return decide('high', 'complex_change', 'complex_change');
  if (
    /(?:创建|新建|新增|生成|制作|开发|实现|搭建|做|还原).{0,32}(?:页面|界面|网站|落地页)|(?:create|generate|build|implement).{0,40}(?:page|website|screen|landing)/u.test(
      text,
    ) ||
    (input.hasDesign && !input.hasSourceFiles && /(?:实现|生成|还原|开发|制作)/u.test(text))
  )
    return decide('high', 'page_generation', 'page_generation');
  if (
    /^(?:确认|确定|就用|选择|采用|同意|好的?[,，]?就用)/u.test(text) &&
    /(?:颜色|配色|色|宽度|高度|尺寸|单位|字号|文案|图片|主题|语言|px|rpx|vw|h5|rn|color|theme|width)/u.test(
      text,
    ) &&
    !/(?:修改|修复|实现|生成|重构|替换|然后|同时)/u.test(text)
  )
    return decide('low', 'parameter_confirmation', 'confirmation');
  /** 仅排除完整的保留布局约束分句，真实布局修改及混合指令仍参与复杂度判断。 */
  const replacementScope = text
    .split(/[，,。；;!！()（）]|并且|同时|然后|并|且/u)
    .filter(
      (part) =>
        !/^(?:(?:保持|保留|维持)(?:现有|原有|原来的|原)?布局(?:不变)?|(?:现有|原有|原来的|原)?布局(?:保持|维持)?不变|(?:不要|无需|不用|不需要|不)(?:修改|改动|改变|调整|改|动)(?:现有|原有|原来的|原)?布局)$/u.test(
          part.trim(),
        ),
    )
    .join(' ');
  /** 限定已有源码上的明确交互，整页、布局及跨模块任务仍走保守档位。 */
  if (
    input.hasSourceFiles &&
    (input.localInteraction ?? input.classifyLocalInteraction?.(input.userText)) === true &&
    /(?:点击|滑动|拖拽|拖动|滚动|轮播|弹窗|页签|click|swipe|drag|scroll|carousel|tab)/u.test(
      text,
    ) &&
    /(?:修复|修改|调整|实现|添加|增加|支持|改为|改成|fix|modify|update|implement|add|enable)/u.test(
      text,
    ) &&
    !/(?:整页|全页|全量|整个|所有|全部|重新|重做|重建|布局|响应式|适配|架构|状态管理|接口|后端|数据库|登录|支付|权限|路由|跨|多个|whole|entire|all\b|layout|responsive|architecture|backend|database|auth|payment|routing|multi[- ]|cross[- ])/u.test(
      replacementScope,
    )
  )
    return decide('low', 'local_interaction', 'local_interaction');
  if (
    input.hasSourceFiles &&
    /(?:仅|只|only|just)/u.test(text) &&
    /(?:图片|颜色|配色|文案|image|colou?r|copy|text)/u.test(text) &&
    /(?:替换|修改|改成|改为|改|更换|换成|换|调整|replace|change|update|swap)/u.test(text) &&
    !/(?:布局|尺寸|大小|宽度|高度|位置|间距|结构|逻辑|交互|动画|功能|新增|添加|布局|layout|logic|animation|resize|spacing)/u.test(
      replacementScope,
    )
  )
    return decide('low', 'simple_replacement', 'simple_replacement');
  return decide('high', 'ambiguous_task', 'unknown');
}

/** 只接受当前上下文完整、唯一且顺序配对的工具消息；字符串、伪角色和嵌套正文不构成证据。 */
export function hasPairedRulesFailure(
  messages: readonly BaseMessage[],
  ignoredIds: readonly string[] = [],
): boolean {
  const ignored = new Set(ignoredIds);
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    if (AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.id) calls.set(call.id, (calls.get(call.id) ?? 0) + 1);
    if (ToolMessage.isInstance(message) && !ToolMessageChunk.isInstance(message))
      results.set(message.tool_call_id, (results.get(message.tool_call_id) ?? 0) + 1);
  }
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (AIMessage.isInstance(message) && !AIMessageChunk.isInstance(message)) {
      pending.clear();
      for (const call of message.tool_calls ?? [])
        if (call.id && calls.get(call.id) === 1 && !ignored.has(call.id))
          pending.set(call.id, call.name);
    } else if (ToolMessage.isInstance(message) && !ToolMessageChunk.isInstance(message)) {
      const name = pending.get(message.tool_call_id);
      pending.delete(message.tool_call_id);
      if (
        name === 'check_rules' &&
        results.get(message.tool_call_id) === 1 &&
        (message.name === undefined || message.name === name) &&
        readToolFeedback(message.content)?.code === 'RULES_FAILED'
      )
        return true;
    } else pending.clear();
  }
  return false;
}

/** 安全读取守卫所需的四个固定决策字段，不返回恢复水位或任意检查点附加数据。 */
export function readReasoningDecision(state: unknown): ReasoningDecision | undefined {
  if (!state || typeof state !== 'object') return;
  const parsed = policySchema.safeParse((state as Record<string, unknown>)._pixelprintReasoning);
  return parsed.success ? parsed.data.decision : undefined;
}

/** 新 admission 隔离旧证据；无 admission 的恢复保留原 scope 的 high 锁存。 */
export function updateReasoningState(input: ReasoningInput, state: unknown): ReasoningPolicyState {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const messages = Array.isArray(value.messages) ? (value.messages as BaseMessage[]) : [];
  const parsed = policySchema.safeParse(value._pixelprintReasoning);
  const previous = parsed.success ? parsed.data : undefined;
  /** 只信任guidance中间件已应用的ID；截图/验收等平台Human消息不构成新授权。 */
  const guidance = Array.isArray(value.guidanceApplied) ? value.guidanceApplied : [];
  const initialBoundary = input.admissionId
    ? messages.findIndex(
        (message) => HumanMessage.isInstance(message) && message.id === input.admissionId,
      )
    : -1;
  if (!input.specialist && (input.admissionId === undefined || initialBoundary >= 0)) {
    for (const id of [...guidance].reverse()) {
      if (typeof id !== 'string') continue;
      const matching = messages.filter(
        (message) => HumanMessage.isInstance(message) && message.id === id,
      );
      if (matching.length !== 1 || messages.indexOf(matching[0]) <= initialBoundary) continue;
      input = {
        ...input,
        admissionId: id,
        userText: matching[0].text,
        localInteraction: input.classifyLocalInteraction?.(matching[0].text) === true,
      };
      break;
    }
  }
  const scope = input.specialist ?? 'root';
  const sameScope = previous?.scope === scope;
  const newAdmission =
    input.admissionId !== undefined && (!sameScope || input.admissionId !== previous?.admissionId);
  let current: ReasoningPolicyState;
  if (sameScope && !newAdmission) current = previous!;
  else {
    const boundary =
      input.admissionId === undefined
        ? -1
        : messages.findIndex(
            (message) => HumanMessage.isInstance(message) && message.id === input.admissionId,
          );
    const old =
      newAdmission || previous ? (boundary < 0 ? messages : messages.slice(0, boundary)) : [];
    const ignoredCallIds = new Set<string>();
    for (const message of old) {
      if (AIMessage.isInstance(message))
        for (const call of message.tool_calls ?? []) if (call.id) ignoredCallIds.add(call.id);
      if (ToolMessage.isInstance(message)) ignoredCallIds.add(message.tool_call_id);
    }
    current = {
      scope,
      ...(input.admissionId === undefined ? {} : { admissionId: input.admissionId }),
      decision: initialReasoningDecision(input),
      ignoredCallIds: [...ignoredCallIds],
    };
  }
  if (current.decision.effort === 'low' && hasPairedRulesFailure(messages, current.ignoredCallIds))
    return {
      ...current,
      decision: { ...current.decision, effort: 'high', reason: 'rules_failed', escalated: true },
    };
  return current;
}

/** 每次模型调用前仅更新可检查点化策略；不改写消息、失败次数、模型或工具执行。 */
export function createReasoningMiddleware(input: ReasoningInput) {
  return createMiddleware({
    name: 'PixelPrintReasoning',
    stateSchema: reasoningStateSchema,
    beforeModel: (state) => ({ _pixelprintReasoning: updateReasoningState(input, state) }),
  });
}
