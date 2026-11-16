import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { readToolFeedback } from '../toolFeedback';

export const progressSchema = z.object({
  phase: z.string().min(1).max(200),
  completed: z.array(z.string().max(500)).max(16),
  remaining: z.array(z.string().max(500)).max(16),
  nextStep: z.string().min(1).max(1000),
  analysis: z
    .string()
    .max(8000)
    .nullable()
    .optional()
    .describe('本批已完成的具体规则结论或部分命中数据，不复制规则正文或原始节点JSON'),
});
export type ChildHandoff = {
  contextPath?: string;
  reports?: Array<z.infer<typeof progressSchema>>;
  omittedReports?: number;
  reportedProgress?: z.infer<typeof progressSchema>;
  verifiedTools: Array<{
    tool: string;
    resource?: boolean;
    command?: string;
    detail?: string;
    path?: string;
    offset?: number;
    nextOffset?: number | null;
    nodeId?: string;
  }>;
  omitted: number;
};

/** 仅记录成功工具的读取范围；模型阶段说明独立标记，不作为规则通过证据。 */
export function createChildHandoff(initial?: ChildHandoff) {
  const state: ChildHandoff = structuredClone(initial ?? { verifiedTools: [], omitted: 0 });
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  return {
    state,
    observe(message: BaseMessage) {
      if (AIMessage.isInstance(message))
        for (const call of message.tool_calls ?? [])
          if (call.id) calls.set(call.id, { name: call.name, args: call.args });
      if (!ToolMessage.isInstance(message)) return;
      const call = calls.get(message.tool_call_id);
      calls.delete(message.tool_call_id);
      if (!call || message.status === 'error' || readToolFeedback(message.content)) return;
      let page: Record<string, unknown> = {};
      try {
        page = JSON.parse(String(message.content));
      } catch {
        /** 非JSON结果只记录动作，不推断覆盖范围。 */
      }
      if (page?.ok === false || page?.success === false) return;
      const args = call.args;
      const data = page?.data as Record<string, unknown> | undefined;
      state.verifiedTools.push({
        tool: call.name,
        ...(typeof args.resource === 'boolean' ? { resource: args.resource } : {}),
        ...(typeof args.command === 'string' ? { command: args.command } : {}),
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        ...(typeof page?.offset === 'number' ? { offset: page.offset } : {}),
        ...(page?.nextOffset === null || typeof page?.nextOffset === 'number'
          ? { nextOffset: page.nextOffset as number | null }
          : {}),
        ...(typeof args.nodeId === 'string' ? { nodeId: args.nodeId } : {}),
        ...(args.subtree === true && data
          ? { detail: `子树分页 offset=${data.offset}, nextOffset=${data.nextOffset}` }
          : {}),
      });
      if (state.verifiedTools.length > 64) {
        state.verifiedTools.shift();
        state.omitted++;
      }
    },
    report(value: z.infer<typeof progressSchema>) {
      state.reportedProgress = progressSchema.parse(value);
      (state.reports ??= []).push(structuredClone(state.reportedProgress));
      if (state.reports.length > 32) {
        state.reports.shift();
        state.omittedReports = (state.omittedReports ?? 0) + 1;
      }
    },
  };
}
