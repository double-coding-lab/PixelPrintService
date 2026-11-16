import ts from 'typescript';

/** 仅改写源码字符串/模板头中的 /static/，使匿名预览资产留在当前 token 前缀。 */
export function relativeStaticUrls() {
  return {
    name: 'pixelprint-relative-static-urls',
    enforce: 'pre',
    transform(source, id) {
      if (!/\.[jt]sx?(?:\?|$)/.test(id) || id.includes('/node_modules/')) return;
      const ast = ts.createSourceFile(
        id,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.[jt]sx(?:\?|$)/.test(id) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const starts = [];
      /** AST 保证不改注释、正则和其他源码 token。 */
      function visit(node) {
        const parent = node.parent;
        const modulePath =
          parent &&
          (((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
            parent.moduleSpecifier === node) ||
            (ts.isCallExpression(parent) &&
              parent.arguments[0] === node &&
              (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                parent.expression.getText(ast) === 'require')));
        if (
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            node.kind === ts.SyntaxKind.TemplateHead) &&
          node.text.startsWith('/static/') &&
          !modulePath &&
          source[node.getStart(ast) + 1] === '/'
        ) {
          starts.push(node.getStart(ast) + 1);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      for (const offset of starts.sort((a, b) => b - a)) {
        source = source.slice(0, offset) + './' + source.slice(offset + 1);
      }
      return starts.length ? { code: source, map: null } : undefined;
    },
  };
}
