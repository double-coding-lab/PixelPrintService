import { GraphRecursionError } from '@langchain/langgraph';

/** 图节点调度预算独立于模型请求次数；模型、摘要与子任务仍共享原请求预算。 */
export const graphExecutionLimits = { steps: 2048, recoveries: 2 } as const;

/** 图步数耗尽保留原始异常，供子任务交接识别，而非当作模型网关异常。 */
export class GraphStepLimitError extends Error {
  constructor(cause: GraphRecursionError) {
    super('DEEP_GRAPH_STEP_LIMIT', { cause });
    this.name = 'GraphStepLimitError';
  }
}

/** 只在检查点存在且有持久交付进展时继续图，续作不重新提交输入或调用已完成工具。 */
export async function runGraphWithRecovery(input: {
  execute: (resume: boolean, steps: number) => Promise<void>;
  inspect: () => Promise<{ signature: string; complete: boolean }>;
  finish: () => Promise<void>;
  guard: () => Promise<void>;
  checkpoint: boolean;
  onLimit?: () => Promise<void>;
  steps?: number;
  recoveries?: number;
}) {
  const steps = input.steps ?? graphExecutionLimits.steps;
  const recoveries = input.recoveries ?? graphExecutionLimits.recoveries;
  let previous = await input.inspect();
  for (let attempt = 0; ; attempt++) {
    await input.guard();
    try {
      await input.execute(attempt > 0, steps);
      return;
    } catch (error) {
      if (!(error instanceof GraphRecursionError)) throw error;
      await input.guard();
      await input.onLimit?.();
      const current = await input.inspect();
      await input.guard();
      if (current.complete && input.checkpoint) {
        await input.finish();
        return;
      }
      if (!input.checkpoint || attempt >= recoveries || current.signature === previous.signature)
        throw new GraphStepLimitError(error);
      previous = current;
    }
  }
}
