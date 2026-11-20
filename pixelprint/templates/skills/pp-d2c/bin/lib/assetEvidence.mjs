import fs from 'node:fs';
import path from 'node:path';

/** 清单只匹配完整原始 Figma ID，不扩大到数字相近节点或复合实例 ID 的子串。 */
export function containsNodeId(text, nodeId) {
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w:;-])${escaped}(?![\\w:;-])`).test(text);
}

/**
 * 只聚合当前静态源码依赖所属区块的清单，不解释自由文本中的 nodeId→文件名关系。
 * R02 的实际引用仍由原引用判定负责；R03 保留原有清单或产物引用的切图判定。
 */
export function loadAssetEvidence(product) {
  const root = realpath(product.root);
  if (!root) return { product: { ...product, jsx: [], style: [] }, hasNode: () => false };
  const logicalRoot = path.resolve(product.root);
  const sources = product.assetSources || product;
  const safe = (file) => {
    if (!file.file) return [];
    const absolute = path.resolve(file.file);
    // loader 可能返回逻辑路径或 realpath；只允许根目录本身的合法别名。
    const base = inside(logicalRoot, absolute) ? logicalRoot : root;
    if (!inside(base, absolute)) return [];
    const relative = path.relative(base, absolute);
    const real = realpath(file.file);
    if (!real || !inside(root, real) || real !== path.join(root, relative)) return [];
    return [{ ...file, file: real, rel: path.relative(root, real) }];
  };
  const scoped = { ...product, jsx: (sources.jsx || []).flatMap(safe),
    style: (sources.style || []).flatMap(safe) };
  const owners = new Set([root]);
  for (const file of [...scoped.jsx, ...scoped.style]) {
    const parts = path.relative(root, file.file).split(path.sep);
    const i = parts.lastIndexOf('blocks');
    // 最近的 blocks/<owner> 持有清单；直接引用内层块不读取未引用的外层清单。
    if (i >= 0 && i + 2 < parts.length) owners.add(path.join(root, ...parts.slice(0, i + 2)));
  }
  const texts = [];
  for (const owner of owners) {
    const file = path.join(owner, 'assets.txt');
    const real = realpath(file);
    // 连到旧块/其他目录的 assets.txt 也不能充当本块证据。
    if (!real || real !== file || !inside(root, real)) continue;
    try {
      if (fs.statSync(real).isFile()) texts.push(fs.readFileSync(real, 'utf8'));
    } catch { /* 不可读的清单不能提供放行证据。 */ }
  }
  return { product: scoped, hasNode: (nodeId) => texts.some((text) => containsNodeId(text, nodeId)) };
}

/** 按 realpath 判断读取对象，缺失/不可访问时不提供证据。 */
function realpath(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

/** 包含根本身，拒绝同名前缀目录和跨根路径。 */
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
