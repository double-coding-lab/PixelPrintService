import fs from 'node:fs/promises';
import path from 'node:path';

/** 将用户路径规范为会话内相对路径，拒绝目录穿越与跨平台路径别名。 */
export function normalizeRelativePath(value: string): string {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f\\:*?"<>|]/u.test(value)) {
    throw new Error('文件路径无效');
  }
  if (value.startsWith('/') || /%[0-9a-f]{2}/i.test(value)) throw new Error('文件路径无效');
  const relative = value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = relative.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  ) {
    throw new Error('文件路径无效');
  }
  return parts.join('/');
}

/** 逐级检查已存在父目录；并发符号链接替换仍需执行环境隔离与受控写入共同防护。 */
export async function resolveWorkspacePath(root: string, relativePath: string): Promise<string> {
  const relative = normalizeRelativePath(relativePath);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error('文件路径不能包含符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}

/** 下载与作品清单只接受用户产物路径，排除模板、配置与内部缓存。 */
export function assertArtifactPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const parts = normalized.split('/');
  if (
    parts.some((part) => part.startsWith('.')) ||
    parts.some((part) =>
      /^(?:node_modules|SKILL\.md|COMPLETION\.md|pp-d2c(?:\.rn)?\.config\.json)$/i.test(part),
    )
  ) {
    throw new Error('内部资源不能作为下载产物');
  }
  return normalized;
}

/** Skill 执行清单作为内部文档保存；仅开放准确文件名，父目录仍遵守产物路径边界。 */
export function isExecutionDocument(value: string): boolean {
  try {
    if (normalizeRelativePath(value) !== value) return false;
    const parts = value.split('/');
    if (parts.pop() !== '.d2c-tasks.md') return false;
    return !parts.length || assertArtifactPath(parts.join('/')) === parts.join('/');
  } catch {
    return false;
  }
}
