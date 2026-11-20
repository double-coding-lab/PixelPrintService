// 产物装载(改写自 h5 的 lib/loadProduct.mjs)——rn 侧样式文件识别从后缀名改为双条件:
// 文件名匹配 styles.ts|styles.js|*.styles.ts|*.styles.js 且内容含 StyleSheet.create
// (避免把业务 .ts 误收为样式文件)。返回结构 { jsx, style } 字段名与 h5 一致,规则层无感。
import fs from 'node:fs';
import path from 'node:path';
import { dependencies } from './sourceDependencies.mjs';

const JSX_EXTS = ['.jsx', '.tsx'];
const STYLE_NAME_RE = /(?:^|\.)styles\.(?:ts|js)$/;

export function loadProduct(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) {
    return { error: `product dir not found: ${absDir}`, jsx: [], style: [] };
  }
  const jsx = [];
  const style = [];
  const root = fs.realpathSync(absDir);
  walk(root, root, jsx, style);
  return { root, jsx, style, assetSources: reachableSources(root, jsx, style) };
}

/** 图片规则只消费静态入口依赖，不让目录内留存的旧块提供引用或清单证据。 */
function reachableSources(root, jsx, style) {
  const sources = new Map([...jsx, ...style].map((f) => [f.file, f]));
  const entries = jsx.filter((f) => /^index\.(jsx|tsx)$/.test(f.rel));
  const reached = new Set();
  if (entries.length === 1) visit(entries[0]);
  else for (const file of [...jsx, ...style]) {
    if (path.dirname(file.file) === root) reached.add(file.file);
  }
  return {
    jsx: jsx.filter((f) => reached.has(f.file)),
    style: style.filter((f) => reached.has(f.file)),
  };

  function visit(file) {
    if (reached.has(file.file)) return;
    reached.add(file.file);
    for (const ref of dependencies(file.content, false).values) {
      if (!ref.startsWith('.') || /[$#]\{|\\/.test(ref)) continue;
      const base = path.resolve(path.dirname(file.file), ref.replace(/[?#].*$/, ''));
      const exts = ['.tsx', '.jsx', '.ts', '.js'];
      const candidates = [base, ...exts.map((ext) => base + ext),
        ...exts.map((ext) => path.join(base, `index${ext}`))];
      const next = candidates.map((candidate) => sources.get(candidate)).find(Boolean);
      if (next) visit(next);
    }
  }
}

function walk(root, dir, jsx, style) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(root, full, jsx, style);
      continue;
    }
    const ext = getExt(e.name);
    const rel = path.relative(root, full);
    if (!JSX_EXTS.includes(ext) && !STYLE_NAME_RE.test(e.name)) continue;
    // 不读取经文件符号链接跳出检查根的源码。
    const real = fs.realpathSync(full);
    const realRel = path.relative(root, real);
    if (real !== full || realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) continue;
    if (JSX_EXTS.includes(ext)) {
      jsx.push({ file: full, rel, content: fs.readFileSync(full, 'utf8') });
    } else if (STYLE_NAME_RE.test(e.name)) {
      const content = fs.readFileSync(full, 'utf8');
      if (content.includes('StyleSheet.create')) {
        style.push({ file: full, rel, content });
      }
    }
  }
}

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i);
}
