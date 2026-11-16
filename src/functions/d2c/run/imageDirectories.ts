import path from 'node:path';
import { imageObjectDirectory, isImageFileName } from '../utils/imageObjectName';
import { normalizeRelativePath } from '../utils/paths';
import type { ExecutionFile } from './workspace';

export const imageDirectoriesPath = '.d2c-cache/image-directories.json';
const directoryPattern = /^\d{14}_[1-9]\d{3}$/;

/** 一个主题只分配一次上传目录；主题内子目录原样保留，避免同名文件相互覆盖。 */
export function createImageDirectories(input: {
  files: ExecutionFile[];
  assetsDir: string;
  save: (content: string) => Promise<void>;
}) {
  const root = normalizeRelativePath(input.assetsDir.replace(/^\//, '').replace(/\/$/, ''));
  const directories = new Map<string, string>();
  const saved = input.files.find((file) => file.path === imageDirectoriesPath);
  if (saved) {
    if (saved.kind !== 'internal' || typeof saved.content !== 'string')
      throw new Error('图片目录映射无效');
    const value = JSON.parse(saved.content);
    if (value?.format !== 1 || !Array.isArray(value.directories))
      throw new Error('图片目录映射无效');
    for (const entry of value.directories) {
      if (
        !entry ||
        typeof entry.scope !== 'string' ||
        (entry.scope !== '.' && normalizeRelativePath(entry.scope) !== entry.scope) ||
        typeof entry.directory !== 'string' ||
        !directoryPattern.test(entry.directory) ||
        directories.has(entry.scope) ||
        [...directories.values()].includes(entry.directory)
      )
        throw new Error('图片目录映射无效');
      directories.set(entry.scope, entry.directory);
    }
  }

  /** 配置图片根下的首层目录是主题；设计基线等其他图片按自身父目录隔离。 */
  function locate(relative: string) {
    const normalized = normalizeRelativePath(relative);
    if (normalized !== relative || !isImageFileName(normalized)) throw new Error('图片路径无效');
    const within = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : '';
    const scope = within.includes('/')
      ? `${root}/${within.split('/')[0]}`
      : within
        ? root
        : path.posix.dirname(normalized);
    return { scope, name: scope === '.' ? normalized : normalized.slice(scope.length + 1) };
  }

  /** 存量逐图目录选择该主题最早的时间戳目录，已有对象与历史链接保持原样。 */
  const candidates = input.files
    .filter((file) => file.kind === 'asset' && isImageFileName(file.path))
    .map((file) => ({ file, directory: String(file.objectLocator?.fileName ?? '').split('/')[2] }))
    .filter(({ directory }) => directoryPattern.test(directory ?? ''))
    .sort((left, right) => left.directory.localeCompare(right.directory));
  let inferred = false;
  for (const { file, directory } of candidates) {
    const { scope } = locate(file.path);
    if (!directories.has(scope) && ![...directories.values()].includes(directory)) {
      directories.set(scope, directory);
      inferred = true;
    }
  }
  let persisted = Boolean(saved) && !inferred;
  let queue = Promise.resolve();

  return {
    /** 目录先经租约保存再发起上传；并行图片、重试和跨轮恢复取得同一主题前缀。 */
    name(relative: string): Promise<string> {
      const { scope, name } = locate(relative);
      const result = queue.then(async () => {
        let directory = directories.get(scope);
        const next = new Map(directories);
        if (!directory) {
          do {
            directory = imageObjectDirectory();
          } while ([...next.values()].includes(directory));
          next.set(scope, directory);
        }
        if (!persisted || !directories.has(scope)) {
          await input.save(
            JSON.stringify({
              format: 1,
              directories: [...next].map(([scope, directory]) => ({ scope, directory })),
            }),
          );
          directories.set(scope, directory);
          persisted = true;
        }
        return `${directory}/${name}`;
      });
      queue = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
