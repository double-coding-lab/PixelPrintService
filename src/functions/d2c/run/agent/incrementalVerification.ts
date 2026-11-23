import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { confirmedWrite } from './context';

/** 已有页面的交互调整采用定点动作验收；明确整页重做和普通讨论沿用各自入口。 */
export function interactionChange(text: string, hasSourceFiles: boolean) {
  return (
    hasSourceFiles &&
    !/^(?:请|帮我)?(?:解释|说明|为什么|如何|怎么|告诉我|请问|介绍)|只(?:讨论|分析)|(?:重新生成|重做|重构|重建).{0,8}(?:整页|页面|布局)|整页(?:验收|检查)|全量(?:验收|检查)/u.test(
      text,
    ) &&
    (/点击|滑动|拖拽|拖动|滚动|轮播|循环|交互|弹窗|click|swipe|drag|scroll|carousel|interaction/iu.test(
      text,
    ) ||
      /(?:展开|收起|切换).{0,12}(?:菜单|面板|列表|页签|标签|选项|按钮|tab)|(?:菜单|面板|列表|页签|标签|选项|按钮|tab).{0,12}(?:展开|收起|切换)/iu.test(
        text,
      ))
  );
}

const schema = z.object({
  admissionId: z.string().optional(),
  guidance: z.array(z.string()).default([]),
  text: z.string(),
  enabled: z.boolean(),
  seen: z.array(z.string()).default([]),
  inspections: z.number().int().nonnegative().default(0),
  reminders: z.number().int().nonnegative().default(0),
  sinceInspection: z.number().int().nonnegative().default(0),
  passed: z.boolean().default(false),
  stopped: z.boolean().default(false),
  problems: z.array(z.string().max(200)).max(6).default([]),
});
export const incrementalVerificationStateSchema = z.object({
  _pixelprintIncrementalVerification: schema.optional(),
});
type Verification = z.infer<typeof schema>;

/** 静态截图和未含断言的动作不能证明交互通过；循环任务需双向及重复边界操作。 */
export function satisfiesInteractionPlan(text: string, actions: unknown) {
  if (!Array.isArray(actions) || !actions.length) return false;
  const records = actions.filter((value) => value && typeof value === 'object') as Record<
    string,
    unknown
  >[];
  if (!records.some((value) => value.type === 'expect')) return false;
  if (/点击|click|tap/iu.test(text) && !records.some((value) => value.type === 'click'))
    return false;
  const swipes = records.filter((value) => value.type === 'swipe');
  if (/滑动|拖拽|拖动|swipe|drag/iu.test(text) && !swipes.length) return false;
  if (/循环|无限|loop|infinite/iu.test(text)) {
    if (
      swipes.length < 3 ||
      !swipes.some((v) => Number(v.deltaX) < 0 || Number(v.deltaY) < 0) ||
      !swipes.some((v) => Number(v.deltaX) > 0 || Number(v.deltaY) > 0)
    )
      return false;
  }
  // 每段动作后必须观察预期状态，避免只在最后断言一个无关元素可见。
  let pending = false;
  for (const value of records) {
    if (['click', 'swipe', 'scroll'].includes(String(value.type))) {
      if (pending) return false;
      pending = true;
    }
    if (value.type === 'expect') pending = false;
  }
  return !pending;
}

/** 对比真实观测：每段动作必须改变同一可观察状态，循环还需出现回环。 */
export function interactionStateEvidence(text: string, actions: unknown, steps: unknown) {
  if (!Array.isArray(actions) || !Array.isArray(steps) || actions.length !== steps.length)
    return false;
  const histories = new Map<string, Array<string | number | boolean>>();
  let moving = false,
    changed = false,
    returned = false;
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (['click', 'swipe', 'scroll'].includes(action?.type)) {
      if (moving && !changed) return false;
      moving = true;
      changed = false;
    }
    if (
      action?.type !== 'expect' ||
      !['text', 'attribute', 'scrollLeft', 'centered'].includes(action.state)
    )
      continue;
    const observed = steps[index]?.observed;
    if (!['string', 'number', 'boolean'].includes(typeof observed)) continue;
    const key = JSON.stringify([action.selector, action.state, action.attribute ?? '']);
    const history = histories.get(key) ?? [];
    if (moving && history.length && history.at(-1) !== observed) {
      changed = true;
      if (history.includes(observed) && history.length >= 2) returned = true;
    }
    history.push(observed);
    histories.set(key, history);
  }
  return moving && changed && (!/循环|无限|loop|infinite/iu.test(text) || returned);
}

/** 模型请求提示和自动截图分支共用同一持久状态。 */
export function incrementalVerification(state: Record<string, unknown>) {
  const parsed = schema.safeParse(state._pixelprintIncrementalVerification);
  return parsed.success && parsed.data.enabled ? parsed.data : undefined;
}

const incomplete =
  '本次交互验收尚未通过，已停止重复自检。已保存的文件和进度会保留；当前结果不能作为交互完成的依据。';
const passed =
  '本次交互修改已完成，并通过当前源码修订的浏览器动作与断言检查。本次验收范围为修改的交互。';

/**
 * 原生检查点保存交互验收预算：一轮检查加最多两轮修复复验。
 * 通过即交付；失败或无进展有界返回明确未通过结论，不制造基础设施中断。
 */
export function createIncrementalVerificationMiddleware(input: {
  admissionId?: string;
  userText: string;
  hasSourceFiles: boolean;
  finish: (message: AIMessage) => Promise<void>;
}) {
  const terminal = async (state: Verification) => {
    const message = new AIMessage({
      id: `interaction-result-${state.admissionId ?? 'resume'}-${state.guidance.at(-1) ?? 'initial'}`,
      content: state.passed
        ? passed
        : [incomplete, ...state.problems.map((problem) => `- ${problem}`)].join('\n'),
    });
    await input.finish(message);
    return {
      _pixelprintIncrementalVerification: { ...state, stopped: true },
      messages: [message],
      jumpTo: 'end' as const,
    };
  };
  return createMiddleware({
    name: 'PixelPrintIncrementalVerification',
    stateSchema: incrementalVerificationStateSchema,
    beforeModel: {
      canJumpTo: ['end'],
      hook: async (state) => {
        const previous = state._pixelprintIncrementalVerification;
        let current = schema.parse(
          previous && (!input.admissionId || previous.admissionId === input.admissionId)
            ? structuredClone(previous)
            : {
                admissionId: input.admissionId,
                text: input.userText,
                enabled: interactionChange(input.userText, input.hasSourceFiles),
                guidance: [],
              },
        );
        // Middleware states are scoped: detect durable HumanMessage IDs rather than another middleware's private watermark.
        const latest = [...state.messages]
          .reverse()
          .find(
            (value) =>
              HumanMessage.isInstance(value) &&
              value.id &&
              value.text.trim() &&
              !/^(?:平台交付核对|平台交互验收|\[平台通知\]|以下是.*(?:图片|截图)|继续(?:当前任务|执行)?[。！!\s]*$)/u.test(
                value.text,
              ),
          );
        if (
          latest?.id &&
          latest.id !== current.admissionId &&
          !current.guidance.includes(latest.id)
        ) {
          current = schema.parse({
            admissionId: current.admissionId,
            text: latest.text,
            enabled: interactionChange(latest.text, input.hasSourceFiles),
            guidance: [...current.guidance, latest.id].slice(-32),
          });
        }
        if (!current.enabled) return { _pixelprintIncrementalVerification: current };
        if (current.stopped) return terminal(current);
        let index = state.messages.length - 1;
        const results: ToolMessage[] = [];
        while (index >= 0 && ToolMessage.isInstance(state.messages[index]))
          results.unshift(state.messages[index--] as ToolMessage);
        const source = state.messages[index];
        let mutated = false;
        if (source && AIMessage.isInstance(source)) {
          for (const result of results) {
            if (current.seen.includes(result.tool_call_id)) continue;
            const call = source.tool_calls?.find((value) => value.id === result.tool_call_id);
            if (!call) continue;
            current.seen = [...current.seen, result.tool_call_id].slice(-128);
            current.sinceInspection++;
            if (
              ['write_file', 'edit_file', 'delete_file'].includes(call.name) &&
              typeof call.args.path === 'string' &&
              /\.(?:[jt]sx?|s?css|sass)$/.test(call.args.path) &&
              confirmedWrite(result, call.name, call.args.path)
            ) {
              mutated = true;
              current.passed = false;
            }
            if (call.name !== 'inspect_preview') continue;
            current.inspections++;
            current.sinceInspection = 0;
            try {
              const report = JSON.parse(result.text);
              current.passed =
                result.status !== 'error' &&
                report.ok === true &&
                report.interaction?.passed === true &&
                report.interaction.steps?.filter((step: { type?: string }) => step.type !== 'focus')
                  .length === call.args.actions?.length &&
                report.interaction.steps.every(
                  (step: { passed?: boolean }) => step.passed === true,
                ) &&
                !report.errors?.some(
                  (error: { code?: string }) =>
                    ![
                      'SCREENSHOT_HEIGHT_LIMIT',
                      'SCREENSHOT_BYTE_LIMIT',
                      'NESTED_SCROLL_CONTAINER_CLIPPED',
                    ].includes(error.code ?? ''),
                ) &&
                !report.missingAssets?.length &&
                satisfiesInteractionPlan(current.text, call.args.actions) &&
                interactionStateEvidence(current.text, call.args.actions, report.interaction.steps);
              current.problems = current.passed
                ? []
                : [
                    report.ok !== true
                      ? '浏览器预览或动作执行不可用，请核对预览诊断。'
                      : report.interaction?.passed !== true
                        ? '实际浏览器动作或预期状态断言未通过，请核对工具返回的失败步骤。'
                        : !satisfiesInteractionPlan(current.text, call.args.actions) ||
                            !interactionStateEvidence(
                              current.text,
                              call.args.actions,
                              report.interaction.steps,
                            )
                          ? '缺少动作前后选中项或滚动位置变化的真实观测，或缺少循环边界回环证据。'
                          : '当前预览仍有运行错误、缺失图片或不完整的动作结果。',
                  ];
            } catch {
              current.passed = false;
              current.problems = ['无法读取可信的浏览器动作验收结果。'];
            }
          }
        }
        // 同批并行修改和截图不能证明最后保存的源码已通过，要求对新修订单独复验。
        if (mutated) {
          current.passed = false;
          current.problems = ['同批源码发生变化，需要对最后保存的修订单独复验。'];
        }
        if (current.passed || current.inspections >= 3 || current.sinceInspection >= 8)
          return terminal(current);
        return { _pixelprintIncrementalVerification: current };
      },
    },
    afterModel: {
      canJumpTo: ['model', 'end'],
      hook: async (state) => {
        const current = state._pixelprintIncrementalVerification;
        const last = state.messages.at(-1);
        if (!current?.enabled || !last || !AIMessage.isInstance(last) || last.tool_calls?.length)
          return;
        if (current.passed) return terminal(current);
        if (current.reminders >= 1)
          return terminal({
            ...current,
            problems: current.problems.length
              ? current.problems
              : ['尚未执行本次交互所需的动作与断言。'],
          });
        return {
          _pixelprintIncrementalVerification: { ...current, reminders: current.reminders + 1 },
          messages: [
            new HumanMessage({
              content:
                '平台交互验收：这次只修改已有页面的交互。请先用expect记录选中项或scrollLeft的初始状态，再用inspect_preview的actions执行真实click/swipe及expect验证同一状态变化；仅断言body或按钮可见不能证明交互生效。循环滑动从首/末项开始，跨边界后核对另一端选中项，覆盖双向及重复回环，每段动作后核对同一选中项或滚动位置。页面底部用focusSelector定位。默认态截图、修改默认选中值不能代替动作测试。不重扫设计稿或整页切图，限定修改范围；最多一轮检查加两轮修复复验。工具不可用或仍未通过时如实交付未完成项，不重复自检或宣称成功。',
            }),
          ],
          jumpTo: 'model' as const,
        };
      },
    },
  });
}
