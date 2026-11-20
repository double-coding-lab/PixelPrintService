import path from 'node:path';

/** 只返回工作区相对定位，不暴露构建主机路径、源码片段或异常堆栈。 */
function sourcePath(value, root) {
  if (typeof value !== 'string') return;
  const file = value.split('?')[0];
  const absolute = path.posix.isAbsolute(file) ? file : path.posix.resolve(process.cwd(), file);
  const relative = path.posix.relative(root, absolute);
  if (!relative || relative.startsWith('../') || relative.startsWith('/') || relative.length > 512)
    return;
  if (!/^[\p{L}\p{N}_@./-]+$/u.test(relative)) return;
  return relative;
}

/** 将编译器异常收敛为固定分类及有限定位；具体源码和原始错误保留在编译进程。 */
export function formatCompilerDiagnostic(error, root = path.resolve(process.env.PIXELPRINT_PREVIEW_ROOT ?? '.runtime/preview-build', 'work')) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const errorCode = error?.pluginCode ?? error?.code;
  const location = error?.loc ?? error?.errors?.[0]?.location;
  const importer = message.match(/\(imported by ([^)]+)\)/)?.[1];
  const file = sourcePath(location?.file ?? error?.id ?? importer, root);
  const missing =
    message.match(/(?:Could not resolve|Failed to resolve import)\s+["']([^"']+)["']/i)?.[1] ??
    message.match(/Could not load ([^\s(]+)/i)?.[1];
  const module = missing?.startsWith(root + '/') ? sourcePath(missing, root) : missing;
  const safeModule =
    typeof module === 'string' &&
    module.length <= 256 &&
    !path.posix.isAbsolute(module) &&
    !module.split('/').includes('..') &&
    /^[\p{L}\p{N}_@./-]+$/u.test(module) &&
    !/^(?:https?|file):|figd_|sk-|token|secret/i.test(module)
      ? module
      : undefined;
  const code =
    errorCode === 'SASS_UNDEFINED_VARIABLE'
      ? 'STYLE_UNDEFINED_VARIABLE'
      : errorCode === 'UNSUPPORTED_IMPORT'
        ? 'UNSUPPORTED_IMPORT'
        : missing || errorCode === 'UNRESOLVED_IMPORT'
          ? 'MODULE_NOT_FOUND'
          : /PREVIEW_MODULE_BOUNDARY/.test(message)
            ? 'MODULE_NOT_ALLOWED'
            : location ||
                errorCode === 'PARSE_ERROR' ||
                /Transform failed|Unexpected token|SyntaxError/i.test(message)
              ? 'SYNTAX_ERROR'
              : 'BUILD_FAILED';
  const line = Number.isInteger(location?.line) && location.line > 0 ? location.line : undefined;
  const column =
    Number.isInteger(location?.column) && location.column >= 0 ? location.column + 1 : undefined;
  return {
    code,
    ...(file ? { file } : {}),
    ...(safeModule ? { module: safeModule } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
  };
}
