import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { confirmedWrite } from './context';
import { previewInspectionOptionsSchema } from '../../preview/interaction';
import { readToolFeedback } from '../toolFeedback';

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

const inspectionArgs = previewInspectionOptionsSchema.extend({
  entryPath: z.string().max(512).nullish(),
});

export function isInteractionSourceWrite(call: { name: string; args: Record<string, unknown> }) {
  return (
    ['write_file', 'edit_file', 'delete_file'].includes(call.name) &&
    typeof call.args.path === 'string' &&
    /\.(?:[jt]sx?|s?css|sass)$/.test(call.args.path)
  );
}

export const interactionVerificationPrompt =
  '平台交互验收：先用expect记录选中项或滚动位置的初始状态，再执行真实点击和滑动并断言状态变化。点击居中时用centered核对位置。用户要求拖动途中切换时，用同一swipe的during在松手前两处断言同一选中项的不同值。循环要求覆盖双向及重复回环。不再读取或修改源码，本次单独调用inspect_preview验收最新修订。';

const visualSnapshot = z.object({
  entryPath: z.string().max(512),
  focusSelector: z.string().max(256).optional(),
  fileRevision: z.number().int().nonnegative(),
  imageRef: z.string().regex(/^(?:attachment|preview):\/\/[a-f0-9]{64}$/),
});

const deferredEdit = z.object({
  id: z.string().min(1),
  name: z.literal('edit_file'),
  args: z.object({
    path: z.string(),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

/** 删除采用平台的精确回执，其余源码修改沿成功保存合同判断。 */
function confirmedSourceChange(
  call: { name: string; args: Record<string, unknown> },
  result: ToolMessage,
) {
  return (
    isInteractionSourceWrite(call) &&
    (call.name === 'delete_file'
      ? result.status !== 'error' &&
        (!result.name || result.name === call.name) &&
        result.text === `已删除：${String(call.args.path)}`
      : confirmedWrite(result, call.name, call.args.path))
  );
}

/** 成功读取的新资料或新源码版本表示进展；重复回执和参数错误不刷新进展。 */
function progressKey(call: { name: string; args: Record<string, unknown> }, result: ToolMessage) {
  if (result.status === 'error' || readToolFeedback(result.content)) return;
  if (call.name === 'read_file')
    return createHash('sha256')
      .update(JSON.stringify([call.name, call.args.path, call.args.resource, result.text]))
      .digest('hex');
  if (!confirmedSourceChange(call, result)) return;
  if (call.name === 'delete_file')
    return createHash('sha256')
      .update(JSON.stringify([call.args.path, 'deleted']))
      .digest('hex');
  let version: unknown;
  try {
    version = JSON.parse(result.text).sha256;
  } catch {
    // 整文件保存的可信回执没有摘要时，原始写入内容提供版本身份。
  }
  if (typeof version !== 'string') {
    if (call.name !== 'write_file' || typeof call.args.content !== 'string') return;
    version = createHash('sha256').update(call.args.content).digest('hex');
  }
  return createHash('sha256')
    .update(JSON.stringify([call.args.path, version]))
    .digest('hex');
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
  progress: z.array(z.string()).default([]),
  passed: z.boolean().default(false),
  verificationOnly: z.boolean().default(false),
  pendingInspection: inspectionArgs.optional(),
  pendingEdits: z.array(deferredEdit).max(32).optional(),
  pendingEditInspection: inspectionArgs.optional(),
  sourceChanged: z.boolean().default(false),
  baselineAttempted: z.boolean().default(false),
  visualBaseline: visualSnapshot.optional(),
  visualCandidate: visualSnapshot.optional(),
  actionRevision: z.number().int().nonnegative().optional(),
  visualConclusion: z.string().max(300).optional(),
  visualRepairAttempted: z.boolean().default(false),
  stopped: z.boolean().default(false),
  problems: z.array(z.string().max(200)).max(6).default([]),
});
export const incrementalVerificationStateSchema = z.object({
  _pixelprintIncrementalVerification: schema.optional(),
});
type Verification = z.infer<typeof schema>;

function requiresSelectionDuringDrag(text: string) {
  return /(?:滑动|滚动|拖动|拖拽).{0,12}(?:途中|过程中|过程|经过).{0,24}(?:选中|选择|切换)|(?:边滑|边拖).{0,16}(?:选中|选择|切换)/su.test(
    text,
  );
}

function midGestureEvidence(action: any, step: any) {
  if (!Array.isArray(action.during) || !Array.isArray(step?.during)) return false;
  const values = new Map<string, Set<string>>();
  for (const sample of action.during) {
    const expectation = sample.expect;
    const expected = expectation.state === 'text' ? expectation.text : expectation.value;
    const observed = step.during.find(
      (value: { atStep: number }) => value.atStep === sample.atStep,
    );
    if (!observed || typeof expected !== 'string' || observed.observed !== expected) continue;
    const key = JSON.stringify([expectation.selector, expectation.state, expectation.attribute]);
    const seen = values.get(key) ?? new Set<string>();
    seen.add(expected);
    if (seen.size >= 2) return true;
    values.set(key, seen);
  }
  return false;
}

/** 静态截图和未含断言的动作不能证明交互通过；循环任务需双向及重复边界操作。 */
export function satisfiesInteractionPlan(text: string, actions: unknown) {
  if (!Array.isArray(actions) || !actions.length) return false;
  const records = actions.filter((value) => value && typeof value === 'object') as Record<
    string,
    unknown
  >[];
  if (!records.some((value) => value.type === 'expect')) return false;
  if (/点击.{0,35}(?:居中|在中间|到中间|正中)|click.{0,35}center/isu.test(text)) {
    const click = records.findIndex((value) => value.type === 'click');
    if (click < 0) return false;
    const subsequent = records.slice(click + 1);
    const nextAction = subsequent.findIndex((value) => value.type !== 'expect');
    if (
      !subsequent
        .slice(0, nextAction < 0 ? undefined : nextAction)
        .some((value) => value.state === 'centered')
    )
      return false;
  }
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
  let duringDrag = false;
  let moving = false,
    changed = false,
    returned = false;
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (action?.type === 'swipe' && requiresSelectionDuringDrag(text))
      duringDrag ||= midGestureEvidence(action, steps[index]);
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
  return (
    moving &&
    changed &&
    (!requiresSelectionDuringDrag(text) || duringDrag) &&
    (!/循环|无限|loop|infinite/iu.test(text) || returned)
  );
}

/** 模型请求提示和自动截图分支共用同一持久状态。 */
export function incrementalVerification(state: Record<string, unknown>) {
  const parsed = schema.safeParse(state._pixelprintIncrementalVerification);
  return parsed.success && parsed.data.enabled ? parsed.data : undefined;
}

const incomplete = '本次交互验收尚未通过。已保存的文件和进度会保留。';
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
      id: createHash('sha256')
        .update(JSON.stringify([state.admissionId ?? 'resume', state.guidance.at(-1) ?? 'initial']))
        .digest('hex'),
      content: state.passed
        ? [
            passed,
            ...(state.sourceChanged
              ? [state.visualConclusion ?? '外观未完成对比，请核对改动前后的运行预览。']
              : []),
          ].join('\n')
        : [
            incomplete,
            ...new Set([
              ...state.problems,
              ...(state.visualConclusion ? [state.visualConclusion] : []),
            ]),
          ].join('\n'),
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
              !/^(?:平台交付核对|平台交互验收|平台视觉复核|\[平台通知\]|以下是.*(?:图片|截图)|继续[。！!\s]*$|继续(?:当前任务|执行)(?:[。！!\s]|$))/u.test(
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
        if (current.pendingEdits?.length) {
          const issued = new Set(
            state.messages.flatMap((message) =>
              AIMessage.isInstance(message)
                ? (message.tool_calls ?? []).map((call) => call.id)
                : [],
            ),
          );
          if (current.pendingEdits.some((edit) => issued.has(edit.id))) {
            const paired = current.pendingEdits.map(
              (edit) =>
                state.messages.filter(
                  (message) => ToolMessage.isInstance(message) && message.tool_call_id === edit.id,
                ) as ToolMessage[],
            );
            const known = paired.every((results) => results.length === 1);
            const saved = current.pendingEdits.every(
              (edit, index) =>
                paired[index].length === 1 && confirmedSourceChange(edit, paired[index][0]),
            );
            const changed = current.pendingEdits.some(
              (edit, index) =>
                paired[index].length === 1 && confirmedSourceChange(edit, paired[index][0]),
            );
            if (changed) {
              current.sourceChanged = true;
              current.passed = false;
              current.visualCandidate = undefined;
            }
            current.pendingInspection = saved ? current.pendingEditInspection : undefined;
            current.pendingEdits = undefined;
            current.pendingEditInspection = undefined;
            if (!known)
              return {
                _pixelprintIncrementalVerification: { ...current, verificationOnly: false },
                messages: [
                  new HumanMessage({
                    id: createHash('sha256')
                      .update(JSON.stringify([...issued]))
                      .digest('hex'),
                    content:
                      '平台交付核对：此前局部编辑已发出但结果未确认，禁止自动重放。先read_file核对真实源码与版本，再完成剩余修改和验收。',
                  }),
                ],
              };
          }
        }
        let index = state.messages.length - 1;
        const results: ToolMessage[] = [];
        while (index >= 0 && ToolMessage.isInstance(state.messages[index]))
          results.unshift(state.messages[index--] as ToolMessage);
        const source = state.messages[index];
        const mutated =
          source &&
          AIMessage.isInstance(source) &&
          results.some((result) => {
            const call = source.tool_calls?.find((value) => value.id === result.tool_call_id);
            return (
              call &&
              !current.seen.includes(result.tool_call_id) &&
              confirmedSourceChange(call, result)
            );
          });
        if (mutated) {
          current.sourceChanged = true;
          current.passed = false;
          current.visualCandidate = undefined;
        }
        if (source && AIMessage.isInstance(source)) {
          if (source.tool_calls?.some((call) => !current.seen.includes(call.id ?? ''))) {
            if (
              current.pendingEdits?.some((edit) =>
                results.some((result) => result.tool_call_id === edit.id),
              )
            ) {
              current.pendingEdits = undefined;
              current.pendingEditInspection = undefined;
            }
            const edits = z
              .array(deferredEdit)
              .min(1)
              .max(32)
              .safeParse(source.response_metadata.platformDeferredEdits);
            if (edits.success) {
              current.pendingEdits = edits.data;
              const planned = inspectionArgs.safeParse(
                source.response_metadata.platformDeferredEditInspection,
              );
              if (planned.success) current.pendingEditInspection = planned.data;
            }
            const pending = inspectionArgs.safeParse(
              source.response_metadata.platformDeferredInteraction,
            );
            if (pending.success) current.pendingInspection = pending.data;
          }
          for (const result of results) {
            if (current.seen.includes(result.tool_call_id)) continue;
            const call = source.tool_calls?.find((value) => value.id === result.tool_call_id);
            if (!call) continue;
            current.seen = [...current.seen, result.tool_call_id].slice(-128);
            current.sinceInspection++;
            const progress = progressKey(call, result);
            if (progress && !current.progress.includes(progress)) {
              current.progress = [...current.progress, progress].slice(-256);
              current.sinceInspection = 0;
              current.verificationOnly = false;
              current.reminders = 0;
            }
            if (call.name !== 'inspect_preview') continue;
            current.pendingInspection = undefined;
            // Also protect a pre-upgrade checkpoint whose mixed tools already ran.
            if (mutated) {
              const pending = inspectionArgs.safeParse(call.args);
              if (pending.success && pending.data.actions?.length)
                current.pendingInspection = pending.data;
              continue;
            }
            if (!Array.isArray(call.args.actions) || !call.args.actions.length) {
              if (!current.sourceChanged) current.baselineAttempted = true;
              try {
                const report = JSON.parse(result.text);
                const snapshot = visualSnapshot.safeParse({
                  ...report,
                  focusSelector: call.args.focusSelector,
                });
                if (report.ok && !report.missingAssets?.length && snapshot.success) {
                  if (!current.sourceChanged && !current.visualBaseline)
                    current.visualBaseline = snapshot.data;
                  else if (
                    current.passed &&
                    current.actionRevision === snapshot.data.fileRevision &&
                    current.visualBaseline?.entryPath === snapshot.data.entryPath &&
                    current.visualBaseline.focusSelector === snapshot.data.focusSelector
                  )
                    current.visualCandidate = snapshot.data;
                }
              } catch {
                // An unavailable screenshot cannot serve as visual evidence.
              }
              continue;
            }
            current.verificationOnly = false;
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
              if (current.passed && Number.isSafeInteger(report.fileRevision))
                current.actionRevision = report.fileRevision;
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
                          ? '缺少选中状态变化、点击居中、拖动途中切换或双向回环所要求的浏览器证据。'
                          : '当前预览仍有运行错误、缺失图片或不完整的动作结果。',
                  ];
            } catch {
              current.passed = false;
              current.problems = ['无法读取可信的浏览器动作验收结果。'];
            }
          }
        }
        // 同批并行修改和截图不能证明最后保存的源码已通过，要求对新修订单独复验。
        if (mutated && current.pendingInspection) {
          current.problems = ['已保存修改，正在等待最新修订的浏览器检查。'];
        }
        if (current.passed) {
          if (
            current.visualBaseline &&
            current.visualCandidate &&
            current.visualCandidate.fileRevision > current.visualBaseline.fileRevision
          )
            return { _pixelprintIncrementalVerification: current };
          const finishedActions = results.some(
            (result) =>
              source &&
              AIMessage.isInstance(source) &&
              source.tool_calls?.some(
                (call) =>
                  call.id === result.tool_call_id &&
                  call.name === 'inspect_preview' &&
                  Array.isArray(call.args.actions) &&
                  call.args.actions.length,
              ),
          );
          if (finishedActions && current.sourceChanged && current.visualBaseline) {
            current.pendingInspection = {
              entryPath: current.visualBaseline.entryPath,
              focusSelector: current.visualBaseline.focusSelector,
            };
            return { _pixelprintIncrementalVerification: current };
          }
          return terminal(current);
        }
        if (current.inspections >= 3) return terminal(current);
        if (current.sinceInspection >= 8) {
          if (current.verificationOnly && !current.pendingInspection)
            return terminal({
              ...current,
              problems: ['未能生成可执行的浏览器动作计划，未完成交互验收。'],
            });
          current.verificationOnly = true;
        }
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
        if (current.passed) {
          if (current.visualCandidate) {
            const prefix = /^(视觉一致|发现视觉变化|无法对比)[：:](.{1,240})$/u.exec(
              last.text.trim(),
            );
            if (
              prefix?.[1] === '发现视觉变化' &&
              !current.visualRepairAttempted &&
              current.inspections < 3
            ) {
              return {
                _pixelprintIncrementalVerification: {
                  ...current,
                  passed: false,
                  visualCandidate: undefined,
                  visualRepairAttempted: true,
                  visualConclusion: prefix[0],
                  problems: [prefix[0]],
                  reminders: 0,
                },
                messages: [
                  new HumanMessage(
                    '平台视觉复核发现非预期样式变化。对照改前的运行截图，仅修复该差异并保留已实现的交互。保存后重新执行同一动作验收和视觉对比。只补一次修正。' +
                      prefix[0],
                  ),
                ],
                jumpTo: 'model' as const,
              };
            }
            return terminal({
              ...current,
              visualConclusion: prefix ? prefix[0] : '外观对比未得到明确结论。',
            });
          }
          return terminal(current);
        }
        if (current.verificationOnly || current.reminders >= 1)
          return terminal({
            ...current,
            problems: current.problems.length
              ? current.problems
              : ['尚未执行本次交互所需的动作与断言。'],
          });
        return {
          _pixelprintIncrementalVerification: {
            ...current,
            verificationOnly: true,
            reminders: current.reminders + 1,
          },
          messages: [
            new HumanMessage({
              content: interactionVerificationPrompt,
            }),
          ],
          jumpTo: 'model' as const,
        };
      },
    },
  });
}
