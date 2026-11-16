import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRelativePath } from './paths';

/** 归一化只读相对路径，允许冗余分隔符及根内回退，任何一步都不能越过虚拟根。 */
export function normalizeReadPath(value: string): string {
  if (!value || value !== value.trim() || value.startsWith('/')) throw new Error('文件路径无效');
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new Error('文件路径无效');
      parts.pop();
    } else {
      normalizeRelativePath(segment);
      parts.push(segment);
    }
  }
  return normalizeRelativePath(parts.join('/'));
}

/** 检查原始路径经过的全部目录，避免归一化消掉符号链接后绕过读取边界。 */
export async function resolveWorkspaceReadPath(root: string, value: string): Promise<string> {
  const relative = normalizeReadPath(value);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error('文件路径不能包含符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path.join(realRoot, relative);
}
