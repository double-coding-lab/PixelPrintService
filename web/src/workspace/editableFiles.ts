import { buildFileTree, type FileNode } from './fileTree';

export type EditableFile = { path: string; content: string };

const languages: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
};

/** 返回 Monaco 语言标识；未知后缀只回退纯文本，不因此获得可编辑资格。 */
export function editableFileLanguage(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return Object.hasOwn(languages, extension) ? languages[extension] : 'plaintext';
}

/** 校验 draft 中的原始相对路径，不规范化别名，不开放内部资源或二进制后缀。 */
export function isEditableFilePath(path: string): boolean {
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith('/') ||
    /[\u0000-\u001f\u007f\\:*?"<>|]/u.test(path) ||
    /%[0-9a-f]{2}/i.test(path)
  )
    return false;
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith('.') ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) ||
        /^(?:node_modules|design-reference|cache|caches|__pycache__|templates?|preview-template)$/i.test(
          part,
        ) ||
        /^(?:SKILL\.md|COMPLETION\.md|pp-d2c(?:\.rn)?\.config\.json)$/i.test(part),
    )
  )
    return false;
  return editableFileLanguage(path) !== 'plaintext';
}

/** 只筛选调用方提供的 draft 文本，不推断其他 kind、不改写路径或正文。 */
export function filterEditableFiles<T extends EditableFile>(files: readonly T[]): T[] {
  return files.filter((file) => isEditableFilePath(file.path) && !file.content.includes('\0'));
}

/** 借用资源树的自然排序和路径搜索，fileId 仅作为 draft 内的路径标识。 */
export function buildEditableFileTree(files: readonly EditableFile[], search = ''): FileNode[] {
  return buildFileTree(
    filterEditableFiles(files).map((file) => ({
      fileId: file.path,
      path: file.path,
      kind: 'source',
      size: 0,
      revision: 0,
    })),
    search,
  );
}
