import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DeliverySnapshot } from './agent/delivery';

const code = /\.(?:[cm]?[jt]sx?)$/i;
const extensions = [
  '',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.sass',
];

/** 仅解析静态本地依赖，不执行源码；包导入和类型声明不构成交付文件缺口。 */
function dependencies(filename: string, content: string) {
  const tree = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  function visit(node: ts.Node) {
    if (
      ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && !node.isTypeOnly)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...imports].filter((value) => value.startsWith('./') || value.startsWith('../'));
}

/** 校对已保存源码与本地依赖；规则违规和预览环境故障仍由各自流程报告。 */
export function inspectGenerationDelivery(
  files: ReadonlyArray<{ path: string; content?: string; sha256: string }>,
  required: boolean,
  changed: ReadonlySet<string>,
): DeliverySnapshot {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const sources = files.filter((file) => code.test(file.path) && !/\.d\.[cm]?ts$/.test(file.path));
  const problems: string[] = [];
  if (required && !sources.length)
    problems.push('尚未保存页面源码；请用 write_file 保存实际页面代码。');
  const pending = required ? sources.map((file) => file.path) : [...changed];
  const visited = new Set<string>();
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const file = byPath.get(filename);
    if (!file || !code.test(filename) || file.content === undefined) continue;
    if (!file.content.trim()) problems.push(`源码为空：${filename}`);
    for (const specifier of dependencies(filename, file.content)) {
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(filename), specifier.split(/[?#]/)[0]),
      );
      const resolved = [
        ...extensions.map((ext) => relative + ext),
        ...extensions.slice(1).map((ext) => `${relative}/index${ext}`),
      ].find((candidate) => byPath.has(candidate));
      if (!resolved)
        problems.push(`${filename} 引用 ${specifier}，但尚未保存对应文件；请补齐文件或修正引用。`);
      else pending.push(resolved);
    }
  }
  return {
    signature: createHash('sha256')
      .update(JSON.stringify(files.map((file) => [file.path, file.sha256]).sort()))
      .digest('hex'),
    problems: [...new Set(problems)].slice(0, 20),
  };
}
