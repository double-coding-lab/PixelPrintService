import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  ToolMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { readToolFeedback } from '../toolFeedback';

const correctableTools = new Set([
  'read_file',
  'list_files',
  'write_file',
  'edit_file',
  'delete_file',
  'check_rules',
  'inspect_preview',
  'build_preview',
  'figma',
  'prepare_slices',
]);
const names = z.array(z.string().min(1)).min(1);
// H5/RN makeReport 的真实字段；全跳过、部分跳过及有警告均不提供收尾依据。
const mergeReport = z.object({
  ok: z.literal(true),
  checked: names,
  passed: names,
  skipped: z.array(z.unknown()).length(0),
  failed: z.array(z.unknown()).length(0),
  violations: z.array(z.unknown()).length(0),
  warnings: z.array(z.unknown()).length(0),
});
const captureReport = z.object({
  ok: z.literal(true),
  previewId: z.string().min(1),
  fileRevision: z.number().int().nonnegative(),
  entryPath: z.string().min(1),
  imageRef: z.string().regex(/^(?:attachment|preview):\/\/[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  errors: z.array(z.unknown()).length(0),
  missingAssets: z.array(z.unknown()).length(0),
  truncated: z.literal(false).optional(),
});

/** 这是下一请求的建议，不是规则/视觉通过凭据，也不改变推理档位或任何验收门禁。 */
export const generationFinishingPrompt =
  '平台收尾提示：当前授权上下文有完整配对的merge通过回执和随后同入口的运行截图，截图后已有一次模型响应机会；这不证明图片已载入或视觉验收通过。请先完成尚未完成的截图视觉比较及其他必要门禁，缺图或图片被拒绝时明确标记未核验。若本次只剩只读说明或进度清单，复用这些回执，不重复全量检查；没有新的具体缺陷证据不要再修改源码。发现缺陷、新修改、工具失败或新增要求时按原流程修复和重新验收，不用旧回执宣称新修订通过。';

/** 仅接受完整工具文本；嵌套文本、图片块和无法解析的回执不猜测为成功。 */
function payload(message: ToolMessage): Record<string, unknown> | undefined {
  if (Array.isArray(message.content) && message.content.length !== 1) return;
  const block = Array.isArray(message.content) ? message.content[0] : message.content;
  const text =
    typeof block === 'string'
      ? block
      : block && typeof block === 'object' && block.type === 'text'
        ? block.text
        : undefined;
  if (typeof text !== 'string') return;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // 普通读取结果可以是文本，但不能充当规则或截图回执。
  }
}

/** 路径必须已经是工具使用的规范相对路径，不推断默认入口或别名。 */
function canonical(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/**
 * 仅为提示寻找当前 admission 的完整证据链。缺边界、摘要、重复/乱序 ID、未知工具、
 * 新 Human 或多工具验收批次均回退。截图取得后第一轮模型继续原策略，后续只读轮才提示。
 * 没有图片物化/网关接收证据，故本 helper 永远不授权自动降档。
 */
export function generationFinishingEvidence(
  messages: readonly BaseMessage[],
  admissionId?: string,
  guidanceApplied: readonly string[] = [],
) {
  if (!admissionId) return;
  const boundaries = messages.filter(
    (message) => HumanMessage.isInstance(message) && message.id === admissionId,
  );
  if (boundaries.length !== 1) return;
  const boundary = messages.indexOf(boundaries[0]);
  if (
    guidanceApplied.some(
      (id) =>
        id !== admissionId &&
        !messages
          .slice(0, boundary)
          .some((message) => HumanMessage.isInstance(message) && message.id === id),
    )
  )
    return;
  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const message of messages) {
    if (AIMessage.isInstance(message))
      for (const call of message.tool_calls ?? [])
        if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
    if (ToolMessage.isInstance(message))
      resultCounts.set(message.tool_call_id, (resultCounts.get(message.tool_call_id) ?? 0) + 1);
  }
  // 跨 admission 的后台任务可能仍在途，旧任务不能由当前回执冒充已收取。
  if (
    messages
      .slice(0, boundary)
      .some(
        (message) =>
          AIMessage.isInstance(message) &&
          message.tool_calls?.some((call) => call.name === 'delegate_agent'),
      )
  )
    return;
  const jobs = new Map<string, { role: string; collected: boolean }>();
  let directory: string | undefined;
  let capture: z.infer<typeof captureReport> | undefined;
  let readAfterCapture = false;
  for (let index = boundary + 1; index < messages.length; index++) {
    const source = messages[index];
    if (
      !AIMessage.isInstance(source) ||
      AIMessageChunk.isInstance(source) ||
      source.invalid_tool_calls?.length
    )
      return;
    const calls = source.tool_calls ?? [];
    if (!calls.length) return;
    const results = new Map<string, ToolMessage>();
    while (ToolMessage.isInstance(messages[index + 1])) {
      const result = messages[++index] as ToolMessage;
      if (ToolMessageChunk.isInstance(result)) return;
      results.set(result.tool_call_id, result);
    }
    if (results.size !== calls.length) return;
    let correctedFailure = false;
    for (const call of calls) {
      const result = call.id && results.get(call.id);
      if (
        !result ||
        callCounts.get(call.id!) !== 1 ||
        resultCounts.get(call.id!) !== 1 ||
        result.name !== call.name
      )
        return;
      const value = payload(result);
      if (
        value?.outcome === 'unknown' ||
        value?.type === 'context_reference' ||
        value?.error !== undefined
      )
        return;
      const feedback = readToolFeedback(result.content);
      if (feedback) {
        // 只有工具合同明确未执行副作用的参数纠错或真实规则失败可以重建证据。
        // 子任务/未知工具、网络/存储及结果未知不由后来的整页检查代为恢复。
        const recoverable =
          (feedback.code === 'RULES_FAILED' && call.name === 'check_rules') ||
          (feedback.code === 'INVALID_ARGUMENT' && correctableTools.has(call.name));
        if (!recoverable) return;
        correctedFailure = true;
        continue;
      }
      if (result.status === 'error') return;
      if (
        value?.ok === false ||
        value?.success === false ||
        value?.error ||
        (Array.isArray(value?.errors) && value.errors.length)
      )
        return;
    }
    if (correctedFailure) {
      directory = undefined;
      capture = undefined;
      readAfterCapture = false;
      // 混合批次可能启动后台副作用；不得因另一项参数错误丢弃任务身份。
      if (calls.some((call) => !correctableTools.has(call.name))) return;
      continue;
    }
    if (calls.every((call) => ['read_file', 'list_files'].includes(call.name))) {
      if (capture) readAfterCapture = true;
      continue;
    }
    // 同批工具执行顺序不提供写入与验收先后证明。
    capture = undefined;
    readAfterCapture = false;
    if (calls.length !== 1) {
      directory = undefined;
      // 不丢失混合批次中的委派任务身份，也不猜测其副作用顺序。
      if (calls.some((call) => !correctableTools.has(call.name))) return;
      continue;
    }
    const call = calls[0];
    const value = payload(results.get(call.id!)!);
    if (call.name === 'delegate_agent') {
      directory = undefined;
      if (
        value?.accepted !== true ||
        typeof value.agentId !== 'string' ||
        !['queued', 'running', 'completed'].includes(String(value.status)) ||
        !['rule_scan', 'ui'].includes(String(call.args.role)) ||
        jobs.has(value.agentId)
      )
        return;
      jobs.set(value.agentId, { role: String(call.args.role), collected: false });
    } else if (call.name === 'wait_subagents') {
      directory = undefined;
      if (call.args.wait !== true || !Array.isArray(value?.agents)) return;
      const seen = new Set<string>();
      for (const agent of value.agents) {
        const job = jobs.get(agent?.agentId);
        if (
          !job ||
          seen.has(agent.agentId) ||
          agent.status !== 'completed' ||
          typeof agent.result !== 'string'
        )
          return;
        seen.add(agent.agentId);
        let delivery;
        try {
          delivery = JSON.parse(agent.result);
        } catch {
          return;
        }
        if (
          delivery?.success !== true ||
          delivery.role !== job.role ||
          !Array.isArray(delivery.files) ||
          !delivery.files.length ||
          !delivery.files.every(canonical) ||
          delivery.failure ||
          delivery.handoff ||
          delivery.reason
        )
          return;
        job.collected = true;
      }
    } else if (call.name === 'check_rules') {
      directory = undefined;
      if ([...jobs.values()].some((job) => !job.collected)) return;
      const report = mergeReport.safeParse(value);
      if (call.args.mode !== 'merge' || !canonical(call.args.path) || !report.success) continue;
      const { checked, passed } = report.data;
      if (
        new Set(checked).size !== checked.length ||
        new Set(passed).size !== passed.length ||
        checked.length !== passed.length ||
        checked.some((rule) => !passed.includes(rule))
      )
        continue;
      directory = call.args.path;
    } else if (call.name === 'inspect_preview') {
      const report = captureReport.safeParse(value);
      if (
        !directory ||
        !report.success ||
        !canonical(call.args.entryPath) ||
        call.args.entryPath !== report.data.entryPath ||
        call.args.entryPath.split('/').slice(0, -1).join('/') !== directory ||
        call.args.focusSelector !== undefined ||
        (call.args.actions !== undefined &&
          (!Array.isArray(call.args.actions) || call.args.actions.length))
      ) {
        directory = undefined;
        continue;
      }
      capture = report.data;
    } else if (correctableTools.has(call.name)) {
      // 所有源码/依赖/资源写入使旧证据失效；须重新 merge 再截图。
      directory = undefined;
    } else return;
  }
  if (capture && readAfterCapture && [...jobs.values()].every((job) => job.collected))
    return {
      entryPath: capture.entryPath,
      fileRevision: capture.fileRevision,
      imageRef: capture.imageRef,
    };
}
