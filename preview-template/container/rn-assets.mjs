import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const imagePattern = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;

/** 从冻结输入枚举图片，不跟随链接，不扫描依赖或构建目录。 */
async function listImages(root, relative = '') {
  const files = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.isSymbolicLink() || ['node_modules', '.git', 'dist', '__preview'].includes(item.name))
      continue;
    const name = path.posix.join(relative, item.name);
    if (item.isDirectory()) files.push(...(await listImages(root, name)));
    else if (item.isFile() && imagePattern.test(name)) files.push(name);
  }
  return files;
}

/** 对每级目录执行 lstat，拒绝通过符号链接读取输入以外的文件。 */
async function isInputFile(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('RN_ASSET_UNSAFE_PATH');
  }
  return (await lstat(current)).isFile();
}

/** 仅转换 RN 源码中的静态图片 require；不执行用户配置、不补任意模块。 */
export function createPreviewRnAssets(target, root, aliasRoot = root, inputRoot = root) {
  let canonicalRoot;
  return {
    name: 'pixelprint-preview-rn-assets',
    enforce: 'pre',
    async transform(code, id) {
      if (target !== 'rn') return;
      canonicalRoot ??= await realpath(root);
      const filename = id.split('?')[0];
      const relativeSource = path.relative(canonicalRoot, filename).split(path.sep).join('/');
      if (
        target !== 'rn' ||
        !/\.[cm]?[jt]sx?$/.test(filename) ||
        relativeSource.startsWith('../') ||
        path.isAbsolute(relativeSource) ||
        relativeSource.split('/').includes('node_modules')
      )
        return;
      const ast = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
      const calls = [];
      const names = new Set();
      const visit = (node) => {
        if (ts.isIdentifier(node)) names.add(node.text);
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'
        )
          calls.push(node);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      if (!calls.length) return;
      const fail = (node, message, errorCode = 'UNRESOLVED_IMPORT') => {
        const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        this.error({
          code: errorCode,
          message:
            errorCode === 'UNRESOLVED_IMPORT'
              ? `Could not resolve ${JSON.stringify(node.arguments[0].text)}: ${message}`
              : message,
          id: filename,
          loc: { file: filename, line: location.line + 1, column: location.character },
        });
      };
      const edits = [];
      const imports = [];
      let images;
      for (const node of calls) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
          fail(node, 'RN_ASSET_DYNAMIC_REQUIRE', 'UNSUPPORTED_IMPORT');
        const specifier = node.arguments[0].text;
        if (
          !specifier ||
          /[\\:?#\0]/.test(specifier) ||
          specifier.startsWith('/') ||
          (!specifier.startsWith('./') &&
            !specifier.startsWith('../') &&
            specifier.split('/').includes('..'))
        )
          fail(node, 'RN_ASSET_UNSAFE_PATH', 'UNSUPPORTED_IMPORT');
        if (!imagePattern.test(specifier))
          fail(node, 'RN_ASSET_NON_IMAGE_REQUIRE', 'UNSUPPORTED_IMPORT');
        let relative;
        if (specifier.startsWith('@Images/')) relative = `assets/${specifier.slice(8)}`;
        else if (specifier.startsWith('@/'))
          relative = path.posix.join(
            path.relative(root, aliasRoot).split(path.sep).join('/'),
            specifier.slice(2),
          );
        else if (specifier.startsWith('./') || specifier.startsWith('../'))
          relative = path.posix.join(path.posix.dirname(relativeSource), specifier);
        else fail(node, 'RN_ASSET_UNSUPPORTED_PATH', 'UNSUPPORTED_IMPORT');
        if (relative.startsWith('../') || path.isAbsolute(relative))
          fail(node, 'RN_ASSET_UNSAFE_PATH', 'UNSUPPORTED_IMPORT');
        let exists;
        try {
          exists = await isInputFile(inputRoot, relative);
        } catch {
          fail(node, 'RN_ASSET_UNSAFE_PATH', 'UNSUPPORTED_IMPORT');
        }
        if (!exists && specifier.startsWith('@Images/')) {
          images ??= await listImages(inputRoot);
          const parts = specifier.slice(8).split('/');
          let matches = [];
          for (let index = 0; index < parts.length; index++) {
            const suffix = parts.slice(index).join('/');
            matches = images.filter((file) => file === suffix || file.endsWith(`/${suffix}`));
            if (matches.length) break;
          }
          if (matches.length > 1) fail(node, 'RN_ASSET_AMBIGUOUS');
          if (matches.length === 1) {
            relative = matches[0];
            exists = true;
          }
        }
        if (!exists) fail(node, 'RN_ASSET_NOT_FOUND');
        let name = `__pixelprintRnAsset${imports.length}`;
        while (names.has(name)) name += '_';
        names.add(name);
        imports.push(`import ${name} from ${JSON.stringify(path.join(root, relative) + '?url')};`);
        edits.push({ start: node.getStart(ast), end: node.end, text: `({ uri: ${name} })` });
      }
      let output = code;
      for (const edit of edits.reverse())
        output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
      return { code: imports.join('\n') + '\n' + output, map: null };
    },
  };
}
