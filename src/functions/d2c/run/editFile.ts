import { createHash } from 'node:crypto';
import { toolIssue } from './toolFeedback';

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
      { path: path.slice(0, 1024) },
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
