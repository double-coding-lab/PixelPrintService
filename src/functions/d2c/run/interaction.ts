import { z } from 'zod';

/** 仅用于业务选择的公开问题；不携带工具参数、凭据或检查点定位。 */
export const userQuestionSchema = z.object({
  questionId: z.string().uuid(),
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(200)).max(6),
  /** 历史问题可缺省；新提问由模型提供可直接采用的建议答案。 */
  recommendedAnswer: z.string().trim().min(1).max(2000).optional(),
});
export type UserQuestion = z.infer<typeof userQuestionSchema>;

/** 原生中断的工具载荷，问题标识由平台在检查点持久化后分配。 */
export const interruptQuestionSchema = userQuestionSchema.omit({ questionId: true }).extend({
  kind: z.literal('user_question'),
});
export type AgentQuestion = z.infer<typeof interruptQuestionSchema> & {
  interruptId: string;
  checkpointId: string;
};

/** 原有JSON字段保存等待与回答状态，模型无法指定线程或恢复位置。 */
export const pendingInteractionSchema = userQuestionSchema.extend({
  state: z.enum(['waiting', 'answered']),
  interruptId: z.string().min(1).max(200),
  checkpointId: z.string().min(1).max(64),
  activeMs: z.number().nonnegative().finite(),
  answer: z.string().min(1).max(65536).optional(),
  clientRequestId: z.string().min(1).max(64).optional(),
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
export type InteractionResume = Pick<PendingInteraction, 'interruptId' | 'checkpointId'> & {
  answer: string;
};

/** 只有当前等待状态才向本人返回问题，私有中断及检查点ID留在服务端。 */
export function publicQuestion(value: unknown): UserQuestion | null {
  const parsed = pendingInteractionSchema.safeParse(value);
  return parsed.success && parsed.data.state === 'waiting'
    ? userQuestionSchema.parse(parsed.data)
    : null;
}
