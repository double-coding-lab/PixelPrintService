import { createMiddleware } from 'langchain';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** 交付只认已持久化文件和真实检查；描述文字不构成进度。 */
export type DeliverySnapshot = { signature: string; problems: string[] };
const recoverySchema = z.object({
  admissionId: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  signature: z.string(),
  stopped: z.boolean(),
});
export type DeliveryRecovery = z.infer<typeof recoverySchema>;

/** 在原生图内补交缺口，计数随检查点保存；不重建子会话或重放工具。 */
export function createDeliveryMiddleware(input: {
  admissionId?: string;
  inspect: () => Promise<DeliverySnapshot>;
  observe?: (value: DeliveryRecovery) => void;
  root?: boolean;
}) {
  return createMiddleware({
    name: 'PixelPrintDelivery',
    stateSchema: z.object({ _pixelprintDelivery: recoverySchema.optional() }),
    beforeModel: {
      canJumpTo: ['end'],
      hook: async (state) => {
        const recovery = state._pixelprintDelivery;
        if (recovery && recovery.admissionId !== input.admissionId)
          return {
            _pixelprintDelivery: {
              admissionId: input.admissionId,
              attempts: 0,
              signature: '',
              stopped: false,
            },
          };
        if (!recovery?.stopped) return;
        const current = await input.inspect();
        if (current.problems.length && recovery.signature === current.signature) {
          input.observe?.(recovery);
          return { jumpTo: 'end' };
        }
      },
    },
    afterModel: {
      canJumpTo: ['model', 'end'],
      hook: async (state) => {
        const last = state.messages.at(-1);
        if (!last || !AIMessage.isInstance(last) || last.tool_calls?.length) return;
        const current = await input.inspect();
        if (!current.problems.length) return;
        const previous = state._pixelprintDelivery;
        const attempts = (previous?.attempts ?? 0) + 1;
        const stopped =
          attempts > 2 || (previous !== undefined && previous.signature === current.signature);
        const recovery = {
          admissionId: input.admissionId,
          attempts,
          signature: current.signature,
          stopped,
        };
        input.observe?.(recovery);
        if (stopped) return { _pixelprintDelivery: recovery, jumpTo: 'end' };
        const truncated = last.response_metadata.pixelprintOutputLimit === true;
        return {
          _pixelprintDelivery: recovery,
          messages: [
            new HumanMessage({
              id: randomUUID(),
              content: [
                input.root
                  ? '平台交付核对：用户已要求完成页面生成，原任务仍未完成。这是同一任务的交付反馈，不是新的用户问题。继续当前上下文，仅补以下实际缺口：'
                  : '平台交付核对：当前子任务尚未完成，继续本上下文，仅补以下缺口：',
                ...current.problems.map((problem) => `- ${problem}`),
                truncated
                  ? '上一回复已截断，该批工具未执行。缩小输出，一次保存一个小文件或一批累计扫描结果。'
                  : '不要只口头宣称完成或重复长篇报告，请用工具保存实际交付。',
                input.root
                  ? '保留已完成的扫描、切图和源码，不从头重扫。逐文件补齐源码和本地依赖，再按原任务检查；不能因自己未完成而要求用户重复授权。确需业务决策时单独调用 ask_user。'
                  : '沿用已读规则、真实节点和已保存文件，不从头重扫。扫描分批write_file(merge=true,complete=false)，最后一批complete=true；平台合并保留前批命中。普通源码逐文件保存，之后完成授权区块检查。',
              ].join('\n'),
            }),
          ],
          jumpTo: 'model',
        };
      },
    },
  });
}
