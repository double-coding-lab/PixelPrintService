import { Buffer } from 'node:buffer';
import path from 'node:path';
import ts from 'typescript';

type Failure = {
  nodeId: string;
  reason: 'missing_image' | 'unresolved_source' | 'wrong_asset';
};
type StaticValue = string | Map<string, StaticValue> | undefined;
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Inspect syntactic RN image references without executing source or reading external modules.
 * Inputs above 512 files or 8 MiB of UTF-8 source fail closed before any parsing.
 * A match is static asset evidence only; it does not prove runtime rendering or visibility.
 */
export function inspectRnImageReferences(
  sources: Array<{ path: string; content: string }>,
  expected: Array<{ nodeId: string; url: string }>,
): Failure[] {
  const overLimit = (): Failure[] =>
    expected.map(({ nodeId }) => ({ nodeId, reason: 'unresolved_source' }));
  if (sources.length > MAX_SOURCE_FILES) return overLimit();
  let sourceBytes = 0;
  for (const source of sources) {
    sourceBytes += Buffer.byteLength(source.content, 'utf8');
    if (sourceBytes > MAX_SOURCE_BYTES) return overLimit();
  }

  const nativePath = '/__rn_inspector__/native.d.ts';
  const fastPath = '/__rn_inspector__/fast.d.ts';
  const files = new Map<string, ts.SourceFile>();
  const normalize = (name: string) => path.posix.resolve('/input', name.replace(/\\/g, '/'));
  for (const source of sources) {
    const name = normalize(source.path);
    files.set(
      name,
      ts.createSourceFile(name, source.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );
  }
  files.set(
    nativePath,
    ts.createSourceFile(
      nativePath,
      'export declare const Image: unique symbol; export declare const ImageBackground: unique symbol; export declare const View: unique symbol;',
      ts.ScriptTarget.Latest,
      true,
    ),
  );
  files.set(
    fastPath,
    ts.createSourceFile(
      fastPath,
      'declare const FastImage: unique symbol; export { FastImage }; export default FastImage;',
      ts.ScriptTarget.Latest,
      true,
    ),
  );
  const host: ts.CompilerHost = {
    getSourceFile: (name) => files.get(name),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/input',
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name)?.text,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containingFile) =>
      names.map((name) => {
        if (name === 'react-native') return { resolvedFileName: nativePath };
        if (name === 'react-native-fast-image') return { resolvedFileName: fastPath };
        if (!name.startsWith('.')) return undefined;
        const base = path.posix.resolve(path.posix.dirname(containingFile), name);
        const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
        const candidates = [
          base,
          ...[
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '.mts',
            '.cts',
            '/index.ts',
            '/index.tsx',
            '/index.js',
            '/index.jsx',
          ].map((ext) => stem + ext),
        ];
        const resolvedFileName = candidates.find((candidate) => files.has(candidate));
        return resolvedFileName ? { resolvedFileName } : undefined;
      }),
  };
  const program = ts.createProgram(
    [...files.keys()],
    {
      noLib: true,
      noResolve: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
    },
    host,
  );
  const checker = program.getTypeChecker();
  const validFiles = new Set(
    [...files.values()].filter((file) => !program.getSyntacticDiagnostics(file).length),
  );
  const mutated = new Set<ts.Symbol>();

  /** Follow value aliases only; type-only imports/exports provide no runtime component. */
  function symbolAt(node: ts.Node): ts.Symbol | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    const seen = new Set<ts.Symbol>();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      if (seen.has(symbol)) return undefined;
      seen.add(symbol);
      if (
        symbol.declarations?.some(
          (declaration) =>
            (ts.isImportSpecifier(declaration) ||
              ts.isImportClause(declaration) ||
              ts.isNamespaceImport(declaration) ||
              ts.isExportSpecifier(declaration)) &&
            ts.isTypeOnlyImportOrExportDeclaration(declaration),
        )
      )
        return undefined;
      symbol = checker.getImmediateAliasedSymbol(symbol);
    }
    return symbol;
  }

  /** Strip only syntax wrappers that cannot change a static value. */
  function unwrap(node: ts.Expression): ts.Expression {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      node = node.expression;
    }
    return node;
  }

  /** Mark explicit assignments/updates to bindings or object members as unknown. */
  function markWrites(node: ts.Node): void {
    let target: ts.Expression | undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = node.left;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = node.operand;
    if (ts.isDeleteExpression(node)) target = node.expression;
    if (target) {
      target = unwrap(target);
      while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
        target = unwrap(target.expression);
      const symbol = symbolAt(target);
      if (symbol) mutated.add(symbol);
    }
    ts.forEachChild(node, markWrites);
  }
  for (const file of files.values()) markWrites(file);

  /** Evaluate a small allowlist: strings, const bindings, plain maps and static member access. */
  function value(node: ts.Expression, seen = new Set<ts.Symbol>(), depth = 0): StaticValue {
    if (depth > 64) return undefined;
    node = unwrap(node);
    const next = (expression: ts.Expression) => value(expression, seen, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (
      ts.isPropertyAccessExpression(node) &&
      checker.getSymbolAtLocation(node.expression) &&
      !symbolAt(node.expression)
    )
      return undefined;
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const symbol = symbolAt(ts.isPropertyAccessExpression(node) ? node.name : node);
      if (symbol) {
        const resolved = bindingValue(symbol, seen, depth);
        if (resolved !== undefined) return resolved;
      }
      if (ts.isIdentifier(node)) return undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (node.questionDotToken) return undefined;
      const object = next(node.expression);
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && next(node.argumentExpression);
      return object instanceof Map && typeof key === 'string' ? object.get(key) : undefined;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const object = new Map<string, StaticValue>();
      for (const member of node.properties) {
        if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member))
          return undefined;
        const name = member.name;
        const key = ts.isComputedPropertyName(name)
          ? next(name.expression)
          : ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
            ? name.text
            : undefined;
        if (typeof key !== 'string') return undefined;
        if (ts.isShorthandPropertyAssignment(member)) {
          let symbol = checker.getShorthandAssignmentValueSymbol(member);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            const declaration = symbol.declarations?.[0];
            symbol =
              declaration && ts.isImportSpecifier(declaration)
                ? symbolAt(declaration.name)
                : undefined;
          }
          object.set(key, symbol ? bindingValue(symbol, seen, depth) : undefined);
        } else object.set(key, next(member.initializer));
      }
      return object;
    }
    return undefined;
  }

  /** Resolve const initializers and static default exports with cycle and mutation guards. */
  function bindingValue(symbol: ts.Symbol, seen: Set<ts.Symbol>, depth: number): StaticValue {
    if (seen.has(symbol) || mutated.has(symbol)) return undefined;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !validFiles.has(declaration.getSourceFile())) return undefined;
    const nested = new Set(seen).add(symbol);
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.initializer
    )
      return value(declaration.initializer, nested, depth + 1);
    if (declaration && ts.isExportAssignment(declaration))
      return value(declaration.expression, nested, depth + 1);
    return undefined;
  }

  /** Recognize actual imported native components, including namespace and named aliases. */
  function component(opening: Opening): 'image' | 'view' | undefined {
    const tag = opening.tagName;
    if (ts.isPropertyAccessExpression(tag) && !symbolAt(tag.expression)) return undefined;
    const symbol = symbolAt(ts.isPropertyAccessExpression(tag) ? tag.name : tag);
    const declaration = symbol?.valueDeclaration;
    const file = declaration?.getSourceFile().fileName;
    if (file === nativePath) {
      if (symbol?.name === 'View') return 'view';
      if (symbol?.name === 'Image' || symbol?.name === 'ImageBackground') return 'image';
    }
    if (file === fastPath && symbol?.name === 'FastImage') return 'image';
    return undefined;
  }

  /** Duplicate attributes or spreads cannot establish a definite prop value. */
  function attribute(opening: Opening, name: string): StaticValue {
    const attributes = opening.attributes.properties;
    if (attributes.some(ts.isJsxSpreadAttribute)) return undefined;
    const matches = attributes.filter(
      (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name,
    );
    if (matches.length !== 1) return undefined;
    const initializer = matches[0].initializer;
    if (!initializer) return undefined;
    if (ts.isStringLiteral(initializer)) return initializer.text;
    return ts.isJsxExpression(initializer) && initializer.expression
      ? value(initializer.expression)
      : undefined;
  }

  const references = new Map<string, Array<string | undefined>>();
  /** Walk JSX ownership only; child expressions are scanned separately, never borrowed by a View. */
  function visit(node: ts.Node, owner?: string): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const hasId = opening.attributes.properties.some(
        (item) => ts.isJsxAttribute(item) && item.name.getText() === 'data-node-id',
      );
      const spread = opening.attributes.properties.some(ts.isJsxSpreadAttribute);
      const id = attribute(opening, 'data-node-id');
      const kind = component(opening);
      const ownId = typeof id === 'string' ? id : undefined;
      if (kind === 'image') {
        const imageId = hasId || spread ? ownId : owner;
        if (imageId) {
          const source = attribute(opening, 'source');
          const uri = source instanceof Map ? source.get('uri') : undefined;
          const list = references.get(imageId) ?? [];
          list.push(typeof uri === 'string' ? uri : undefined);
          references.set(imageId, list);
        }
      }
      const childOwner = hasId || spread ? (kind === 'view' ? ownId : undefined) : owner;
      if (ts.isJsxElement(node)) for (const child of node.children) visit(child, childOwner);
      return;
    }
    if (ts.isJsxExpression(node) && node.expression) {
      const expression = unwrap(node.expression);
      if (
        ts.isJsxElement(expression) ||
        ts.isJsxSelfClosingElement(expression) ||
        ts.isJsxFragment(expression)
      ) {
        visit(expression, owner);
        return;
      }
    }
    if (ts.isJsxFragment(node)) {
      for (const child of node.children) visit(child, owner);
      return;
    }
    ts.forEachChild(node, (child) => visit(child));
  }
  for (const [name, file] of files) {
    if (name === nativePath || name === fastPath || !validFiles.has(file)) continue;
    visit(file);
  }
  return expected.flatMap(({ nodeId, url }): Failure[] => {
    const urls = references.get(nodeId);
    if (urls?.includes(url)) return [];
    return [
      {
        nodeId,
        reason: !urls?.length
          ? 'missing_image'
          : urls.includes(undefined)
            ? 'unresolved_source'
            : 'wrong_asset',
      },
    ];
  });
}
