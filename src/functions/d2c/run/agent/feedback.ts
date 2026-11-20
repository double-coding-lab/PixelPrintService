import { setTimeout as delay } from 'node:timers/promises';
import {
  executionError,
  RunExecutionError,
  type FailureCommand,
  type FailureTool,
} from '../errors';
import { ToolIssue, readToolFeedback, toolFeedback } from '../toolFeedback';

const knownCommands: readonly FailureCommand[] = [
  'verify-token',
  'cache-check',
  'fetch-node',
  'inspect-node',
  'export-image',
  'screenshot',
];

/**
 * 创建每轮独立的工具反馈执行层，不依赖模型框架，也不自行重放工具操作。
 * schema 校验问题可由调用方在 action 中显式抛出 INVALID_ARGUMENT ToolIssue。
 * 调用方必须在接受最终答复前调用 assertUnblocked，不能以普通答复绕过用户阻塞。
 */
export function createDeepToolFeedback(input: {
  signal: AbortSignal;
  assertLease: () => Promise<void>;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const retries = new Map<string, number>();
  const adjustments = new Map<string, number>();
  let userBlock: RunExecutionError | undefined;
  let terminalError: RunExecutionError | undefined;

  /** 检查执行资格；保留存储等已有分类，原始异常仅留在 cause 中。 */
  async function assertLease() {
    signal.throwIfAborted();
    try {
      await input.assertLease();
    } catch (error) {
      throw executionError(error, 'LEASE_LOST', { stage: 'worker' });
    }
    signal.throwIfAborted();
  }

  /** 共享预算与用户阻塞覆盖返回反馈和显式 ToolIssue；保留可信工具的完整报告。 */
  async function respondToIssue(
    name: FailureTool,
    issue: ToolIssue,
    command?: FailureCommand,
    original?: string,
  ) {
    let feedback = issue.feedback;
    const counts = feedback.action === 'retry' ? retries : adjustments;
    // 纠错按调用方可信命令分组；临时故障仍共享工具级重试预算。
    const key =
      feedback.action === 'retry'
        ? name
        : JSON.stringify([
            name,
            command ?? '',
            feedback.code,
            feedback.path ?? '',
            feedback.resource ?? null,
          ]);
    if (feedback.action !== 'user' && feedback.code !== 'RULES_FAILED') {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > (feedback.action === 'retry' ? 2 : 10))
        feedback = toolFeedback(
          feedback.action === 'retry' ? 'RETRY_EXHAUSTED' : 'ADJUSTMENT_EXHAUSTED',
          { path: feedback.path, resource: feedback.resource },
        );
    }
    if (feedback.action === 'user') {
      /** 仅保留结构化工具反馈，原路径经日志白名单过滤；不记录工具正文。 */
      issue.failure.context.feedback = {
        code: feedback.code,
        originalCode: issue.feedback.code,
        path: feedback.path,
        resource: feedback.resource,
      };
      userBlock ??= issue.failure;
    }
    if (feedback.action === 'retry' && feedback.retryAfterMs)
      await delay(feedback.retryAfterMs, undefined, { signal });
    await assertLease();
    return original !== undefined && feedback === issue.feedback
      ? original
      : JSON.stringify(feedback);
  }

  /**
   * 执行一次受控工具；可纠正问题返回字符串，严重错误固定分类后抛出并锁住本轮。
   * retry 反馈只等待，不自动执行 action，后续重试由模型发起并共用本实例预算。
   */
  async function run<T>(
    name: FailureTool,
    action: () => Promise<T>,
    command?: FailureCommand,
  ): Promise<T | string> {
    // schema校验前也可能进入反馈层；未知命令共用一个分组，不能用任意字符串刷新预算。
    if (name !== 'figma' || command === undefined || !knownCommands.includes(command))
      command = undefined;
    try {
      signal.throwIfAborted();
      if (userBlock && name !== 'read_file' && name !== 'list_files') throw userBlock;
      await assertLease();
      let value: T;
      try {
        value = await action();
      } catch (error) {
        if (!(error instanceof ToolIssue)) throw error;
        error.failure.context.tool ??= name;
        if (command) error.failure.context.command = command;
        return await respondToIssue(name, error, command);
      }
      signal.throwIfAborted();
      const feedback = readToolFeedback(value);
      if (feedback)
        return await respondToIssue(
          name,
          new ToolIssue(
            feedback,
            new RunExecutionError(
              feedback.code === 'CONFIRMATION_REQUIRED' ? 'CONFIRMATION_REQUIRED' : 'TOOL_FAILED',
              { stage: 'tool', tool: name, ...(command ? { command } : {}), requiresUser: true },
            ),
          ),
          command,
          typeof value === 'string' ? value : undefined,
        );
      await assertLease();
      return value;
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      terminalError ??=
        reason === userBlock && userBlock
          ? userBlock
          : executionError(reason, 'TOOL_FAILED', {
              stage: 'tool',
              tool: name,
              ...(command ? { command } : {}),
            });
      controller.abort(terminalError);
      throw terminalError;
    }
  }

  /** 最终答复的必经门禁：读文件或普通答复不能清除原始用户阻塞及终态故障。 */
  function assertUnblocked(): void {
    if (terminalError) throw terminalError;
    if (signal.aborted) throw executionError(signal.reason, 'TOOL_FAILED', { stage: 'tool' });
    if (userBlock) throw userBlock;
  }

  return { run, assertUnblocked };
}
