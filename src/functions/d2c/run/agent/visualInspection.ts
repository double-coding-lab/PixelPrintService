import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { confirmedWrite } from './context';
import { readToolFeedback } from '../toolFeedback';

const progressSchema = z.object({
  hasCapture: z.boolean(),
  dirty: z.boolean(),
  mutations: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
});
const inspectionSchema = progressSchema.extend({
  seen: z.array(z.string()),
  entryPath: z.string().optional(),
  scopes: z.record(z.string(), progressSchema).default({}),
});
type InspectionState = z.infer<typeof inspectionSchema>;
export const visualInspectionStateSchema = z.object({
  _pixelprintVisualInspection: inspectionSchema.optional(),
});

/** 只消费完整调用配对，计数有界；旧检查点首次接入可从已有真实工具历史建立基线。 */
function consume(current: InspectionState, source: AIMessage, results: ToolMessage[]) {
  let advanced = false;
  let attempted = false;
  for (const result of results) {
    if (current.seen.includes(result.tool_call_id)) continue;
    const call = source.tool_calls?.find((item) => item.id === result.tool_call_id);
    if (!call) continue;
    current.seen = [...current.seen, result.tool_call_id].slice(-128);
    advanced = true;
    if (
      ['build_preview', 'inspect_preview'].includes(call.name) &&
      result.status !== 'error' &&
      !readToolFeedback(result.content) &&
      typeof call.args.entryPath === 'string' &&
      call.args.entryPath !== current.entryPath
    ) {
      if (current.entryPath) {
        current.scopes[current.entryPath] = progressSchema.parse(current);
        while (Object.keys(current.scopes).length > 16)
          delete current.scopes[Object.keys(current.scopes)[0]];
      }
      Object.assign(
        current,
        current.scopes[call.args.entryPath] ?? {
          hasCapture: current.hasCapture,
          dirty: false,
          mutations: 0,
          steps: 0,
        },
        { entryPath: call.args.entryPath },
      );
    }
    if (call.name === 'inspect_preview') {
      attempted = true;
      current.dirty = false;
      current.mutations = 0;
      current.steps = 0;
      try {
        const value = JSON.parse(result.text);
        if (
          result.status !== 'error' &&
          value?.ok === true &&
          typeof value.imageRef === 'string' &&
          typeof value.entryPath === 'string'
        ) {
          current.hasCapture = true;
          current.entryPath = value.entryPath;
        }
      } catch {
        // 未知结果不能证明已有可比较截图。
      }
    } else if (
      ['write_file', 'edit_file'].includes(call.name) &&
      typeof call.args.path === 'string' &&
      /\.(?:[jt]sx?|s?css|sass)$/.test(call.args.path) &&
      confirmedWrite(result, call.name, call.args.path) &&
      !readToolFeedback(result.content)
    ) {
      current.dirty = true;
      current.mutations = Math.min(3, current.mutations + 1);
    }
  }
  // 失败的真实截图尝试也结清当前批次，后续修改才重触发，避免环境故障死循环。
  if (advanced && current.dirty && !attempted) current.steps = Math.min(3, current.steps + 1);
}

/** 没有原生计数的旧图只回读现有消息元数据，不重新执行任何工具。 */
function bootstrap(current: InspectionState, messages: BaseMessage[]) {
  for (let index = 0; index < messages.length; index++) {
    const source = messages[index];
    if (!AIMessage.isInstance(source)) continue;
    const results: ToolMessage[] = [];
    while (ToolMessage.isInstance(messages[index + 1]))
      results.push(messages[++index] as ToolMessage);
    consume(current, source, results);
  }
}

/** 修复期的截图欠账随原生检查点保存，摘要或发布恢复不重新计算旧工具副作用。 */
export function createVisualInspectionMiddleware() {
  return createMiddleware({
    name: 'PixelPrintVisualInspection',
    stateSchema: visualInspectionStateSchema,
    beforeModel: async (state) => {
      const current: InspectionState = inspectionSchema.parse(
        structuredClone(
          state._pixelprintVisualInspection ?? {
            seen: [],
            hasCapture: false,
            dirty: false,
            mutations: 0,
            steps: 0,
            scopes: {},
          },
        ),
      );
      if (!state._pixelprintVisualInspection) {
        bootstrap(current, state.messages);
        return { _pixelprintVisualInspection: current };
      }
      let index = state.messages.length - 1;
      const results: ToolMessage[] = [];
      while (index >= 0 && ToolMessage.isInstance(state.messages[index])) {
        results.unshift(state.messages[index] as ToolMessage);
        index--;
      }
      const source = state.messages[index];
      if (!source || !AIMessage.isInstance(source)) return;
      consume(current, source, results);
      return { _pixelprintVisualInspection: current };
    },
  });
}

/** 已有真实截图后，一批三次源码修改或修改后三步即复验；首次生成沿用交付前检查。 */
export function pendingVisualInspection(state: Record<string, unknown>, final = false) {
  const parsed = inspectionSchema.safeParse(state._pixelprintVisualInspection);
  if (!parsed.success) return;
  const value = parsed.data;
  if (value.hasCapture && value.dirty && (final || value.mutations >= 3 || value.steps >= 3))
    return { entryPath: value.entryPath ?? null };
}
