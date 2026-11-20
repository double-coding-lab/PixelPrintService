import { createHash } from 'node:crypto';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { z } from 'zod';

const scopeSchema = z.object({
  signature: z.string(),
  unchanged: z.number().int().nonnegative(),
  violations: z.array(z.object({ rule: z.string(), nodeId: z.string() })),
});
const stateSchema = z.object({
  admissionId: z.string().optional(),
  seen: z.array(z.string()),
  scopes: z.record(z.string(), scopeSchema),
});
export type RuleRepairState = z.infer<typeof stateSchema>;

/** 比较真实违规内容，排除行号、片段及顺序等报告噪声。 */
export function ruleRepairReport(content: unknown) {
  try {
    let report = typeof content === 'string' ? JSON.parse(content) : content;
    if (report?.type === 'tool_feedback') {
      if (report.code !== 'RULES_FAILED' || typeof report.report !== 'string') return;
      report = JSON.parse(report.report);
    }
    if (!report || !Array.isArray(report.violations)) return;
    if (report.ok === true && report.violations.length === 0) return { passed: true } as const;
    if (report.ok !== false || !report.violations.length) return;
    const violations = report.violations.map((value: Record<string, unknown>) => {
      if (!value || typeof value.rule !== 'string') throw new Error('INVALID_REPORT');
      return {
        rule: value.rule,
        nodeId: typeof value.nodeId === 'string' ? value.nodeId : '',
        file: typeof value.file === 'string' ? value.file : '',
        expected: value.expected ?? null,
        actual: value.actual ?? value.message ?? null,
      };
    });
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, canonical(item)]),
            )
          : value;
    const entries = violations.map((value: unknown) => JSON.stringify(canonical(value))).sort();
    return {
      passed: false,
      signature: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      violations: violations
        .sort((a: { rule: string; nodeId: string }, b: { rule: string; nodeId: string }) =>
          JSON.stringify([a.rule, a.nodeId]).localeCompare(JSON.stringify([b.rule, b.nodeId])),
        )
        .slice(0, 16)
        .map(({ rule, nodeId }: { rule: string; nodeId: string }) => ({ rule, nodeId })),
    } as const;
  } catch {
    // 未知/损坏报告交由原检查门禁处理，不推断已通过或无进展。
  }
}

/** 两次连续无改善后交回父级；状态随原生检查点保存，不因恢复或清单写入重置。 */
export function createRuleRepairMiddleware(input: {
  admissionId?: string;
  reset?: boolean;
  observe: (value: RuleRepairState, stalled: string[]) => void;
}) {
  let reset = input.reset === true;
  return createMiddleware({
    name: 'PixelPrintRuleRepair',
    stateSchema: z.object({ _pixelprintRuleRepair: stateSchema.optional() }),
    beforeModel: {
      canJumpTo: ['end'],
      hook: async (state) => {
        const previous = state._pixelprintRuleRepair;
        const current: RuleRepairState =
          !reset && previous && previous.admissionId === input.admissionId
            ? structuredClone(previous)
            : { admissionId: input.admissionId, seen: [], scopes: {} };
        reset = false;
        // 仅消费最新完整工具批次；恢复和摘要不会把历史检查再次计入次数。
        let index = state.messages.length - 1;
        const results: ToolMessage[] = [];
        while (index >= 0 && ToolMessage.isInstance(state.messages[index])) {
          results.unshift(state.messages[index] as ToolMessage);
          index--;
        }
        const source = state.messages[index];
        if (source && AIMessage.isInstance(source)) {
          for (const result of results) {
            if (current.seen.includes(result.tool_call_id) || result.status === 'error') continue;
            const call = source.tool_calls?.find((item) => item.id === result.tool_call_id);
            if (
              call?.name !== 'check_rules' ||
              call.args.mode !== 'block' ||
              typeof call.args.path !== 'string'
            )
              continue;
            const report = ruleRepairReport(result.content);
            if (!report) continue;
            current.seen = [...current.seen, result.tool_call_id].slice(-64);
            const scope = call.args.path;
            if (report.passed) delete current.scopes[scope];
            else {
              const prior = current.scopes[scope];
              current.scopes[scope] = {
                signature: report.signature,
                unchanged: prior?.signature === report.signature ? prior.unchanged + 1 : 0,
                violations: report.violations,
              };
            }
          }
        }
        const stalled = Object.keys(current.scopes).filter(
          (scope) => current.scopes[scope].unchanged >= 2,
        );
        input.observe(current, stalled);
        return {
          _pixelprintRuleRepair: current,
          ...(stalled.length ? { jumpTo: 'end' as const } : {}),
        };
      },
    },
  });
}
