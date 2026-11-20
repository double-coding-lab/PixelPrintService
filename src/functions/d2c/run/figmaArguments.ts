import type { FailureCommand } from './errors';
import type { GenerationTools } from './types';
import { toolIssue } from './toolFeedback';

type FigmaArguments = Parameters<GenerationTools['figma']>[1];

/** 仅清理无操作含义的默认值；分页冲突交给模型明确选择读取范围。 */
export function normalizeFigmaArguments(command: string, input: FigmaArguments): FigmaArguments {
  const args: FigmaArguments = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value != null),
  );
  function conflict(detail: string): never {
    throw toolIssue(
      'FIGMA_ARGUMENT_CONFLICT',
      'TOOL_ARGUMENT_INVALID',
      { stage: 'tool', tool: 'figma', command: command as FailureCommand },
      { detail },
    );
  }
  if (args.subtree !== undefined && typeof args.subtree !== 'boolean')
    conflict('subtree 必须为布尔值；不使用时省略或传 null。');
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0))
    conflict('offset 必须为大于等于 0 的安全整数。');
  if (
    args.limit !== undefined &&
    (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)
  )
    conflict('limit 必须为 1 到 100 的整数。');
  if (command !== 'inspect-node') {
    if (args.subtree === false) delete args.subtree;
    if (args.offset === 0) delete args.offset;
    if (args.subtree === true || args.offset !== undefined || args.limit !== undefined)
      conflict('subtree、offset、limit 仅用于 inspect-node 的子树分页；当前命令请删除这些参数。');
  } else if ((args.offset !== undefined || args.limit !== undefined) && args.subtree !== true) {
    conflict(
      'inspect-node 的 offset/limit 要求 subtree=true；浅层读取请删除 offset 和 limit，使用 depth。平台不会自动扩大读取范围。',
    );
  }
  return args;
}
