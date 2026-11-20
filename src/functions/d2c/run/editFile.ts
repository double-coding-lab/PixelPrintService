import { createHash } from 'node:crypto';
import { toolIssue } from './toolFeedback';

/** 字段级纠错只反馈类型和长度，不回传摘要、源码或替换片段。 */
export function editArgumentDetail(args: Record<string, unknown>): string | undefined {
  if (typeof args.expectedSha256 !== 'string')
    return 'expectedSha256 必须是64位小写十六进制字符串，请重新read_file取得原值。';
  if (!/^[a-f0-9]{64}$/.test(args.expectedSha256))
    return `expectedSha256 要求64位小写十六进制；当前长度为${args.expectedSha256.length}。请重新read_file复制完整sha256，不要截短或猜测。`;
  if (typeof args.oldText !== 'string' || !args.oldText.length)
    return 'oldText 必须是已读取文件中非空且唯一的原片段。';
  if (typeof args.newText !== 'string') return 'newText 必须是字符串；删除片段时使用空字符串。';
  if (args.oldText === args.newText) return 'oldText 与 newText 相同，无需执行写入。';
  return undefined;
}

/** 精确替换一个已读片段；摘要过期或匹配不唯一时不写入，交回模型重新读取定位。 */
export function editFileText(
  path: string,
  current: string,
  oldText: string,
  newText: string,
  expectedSha256: string,
) {
  const reject = (
    code: 'EDIT_REVISION_CONFLICT' | 'EDIT_MATCH_INVALID' | 'INVALID_ARGUMENT',
  ): never => {
    throw toolIssue(
      code,
      'VALIDATION_FAILED',
      { stage: 'tool', tool: 'edit_file' },
      {
        path: path.slice(0, 1024),
        ...(code === 'INVALID_ARGUMENT'
          ? { detail: editArgumentDetail({ oldText, newText, expectedSha256 }) }
          : {}),
      },
    );
  };
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !oldText || oldText === newText)
    reject('INVALID_ARGUMENT');
  if (createHash('sha256').update(current).digest('hex') !== expectedSha256)
    reject('EDIT_REVISION_CONFLICT');
  const position = current.indexOf(oldText);
  if (position < 0 || current.indexOf(oldText, position + 1) >= 0) reject('EDIT_MATCH_INVALID');
  return current.slice(0, position) + newText + current.slice(position + oldText.length);
}
