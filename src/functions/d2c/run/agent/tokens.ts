import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';

let tokenizer: Tiktoken | undefined;

/**
 * 使用随包词表离线估算文本 Token，预留10%余量；Claude等其他模型以网关用量为准。
 * 分段限制超长连续字符串的编码成本，计数不访问网络、不保留用户文本。
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  tokenizer ??= new Tiktoken(ranks);
  let tokens = 0;
  const chunks = new Map<string, number>();
  for (let offset = 0; offset < text.length; offset += 256) {
    const chunk = text.slice(offset, offset + 256);
    let count = chunks.get(chunk);
    if (count === undefined) {
      count = tokenizer.encode(chunk, [], []).length;
      chunks.set(chunk, count);
    }
    tokens += count;
  }
  return Math.ceil(tokens * 1.1);
}
