import type { FileInfo } from './types';

export type FileNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  file?: FileInfo;
  children?: FileNode[];
};

/** 按真实相对路径构建目录，搜索保留匹配文件及其父目录，目录优先排序。 */
export function buildFileTree(files: FileInfo[], search = ''): FileNode[] {
  const roots: FileNode[] = [];
  const folders = new Map<string, FileNode>();
  const query = search.trim().toLocaleLowerCase();
  for (const file of files) {
    if (query && !file.path.toLocaleLowerCase().includes(query)) continue;
    const parts = file.path.split('/');
    let children = roots;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join('/');
      let node = folders.get(path);
      if (!node) {
        node = { key: `directory:${path}`, title: parts[index], isLeaf: false, children: [] };
        folders.set(path, node);
        children.push(node);
      }
      children = node.children!;
    }
    children.push({ key: file.fileId, title: parts.at(-1)!, isLeaf: true, file });
  }
  /** 每层按名称自然排序，避免依赖数据库 hash 顺序。 */
  function sort(nodes: FileNode[]): FileNode[] {
    nodes.sort(
      (a, b) =>
        Number(a.isLeaf) - Number(b.isLeaf) ||
        a.title.localeCompare(b.title, 'zh-CN', { numeric: true }),
    );
    for (const node of nodes) if (node.children) sort(node.children);
    return nodes;
  }
  return sort(roots);
}

/** 搜索时展开所有匹配目录，清空搜索后恢复用户原来的展开状态。 */
export function directoryKeys(nodes: FileNode[]): string[] {
  return nodes.flatMap((node) =>
    node.children ? [node.key, ...directoryKeys(node.children)] : [],
  );
}

/** 浏览器仅预览受控位图，其他二进制显示元数据。 */
export function isPreviewImage(file?: FileInfo) {
  return !!file && /\.(png|jpe?g|gif|webp)$/i.test(file.path);
}

/** 文件大小统一展示，避免长字节数字挤占文件列表。 */
export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
