import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/cl100k_base';
import { createHash } from 'node:crypto';

let tokenizer: Tiktoken | undefined;
// 固定词表/算法随进程部署；只缓存精确输入的 SHA256 和原始计数，不持有用户文本。
const maxCachedCounts = 8192;
const counts = new Map<string, number>();

/** UTF-16 保留孤立代理字符身份，避免不同 JS 字符串经 UTF-8 替换后共享键。 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf16le').digest('hex');
}

/** 有界 LRU；完整输入与 256 字符片段使用相同的原始编码计数。 */
function cached(key: string): number | undefined {
  const count = counts.get(key);
  if (count !== undefined) {
    counts.delete(key);
    counts.set(key, count);
  }
  return count;
}

/** 只保存数字和固定长度摘要，逐次淘汰最旧计数。 */
function remember(key: string, count: number): number {
  counts.delete(key);
  counts.set(key, count);
  while (counts.size > maxCachedCounts) counts.delete(counts.keys().next().value!);
  return count;
}

/**
 * 使用随包词表离线估算文本 Token，预留10%余量；Claude等其他模型以网关用量为准。
 * 保持原有 256 字符分段及一次性 10% 余量；重复输入按摘要复用精确计数。
 * 计数不访问网络、不保留用户文本，缓存不影响请求预算和真实用量计量。
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const key = fingerprint(text);
  const prior = cached(key);
  if (prior !== undefined) return Math.ceil(prior * 1.1);
  tokenizer ??= new Tiktoken(ranks);
  let tokens = 0;
  for (let offset = 0; offset < text.length; offset += 256) {
    const chunk = text.slice(offset, offset + 256);
    const chunkKey = text.length <= 256 ? key : fingerprint(chunk);
    let count = cached(chunkKey);
    if (count === undefined) {
      count = tokenizer.encode(chunk, [], []).length;
      remember(chunkKey, count);
    }
    tokens += count;
  }
  remember(key, tokens);
  return Math.ceil(tokens * 1.1);
}
