import type { Alias, Plugin } from 'vite';

/** 为 RN 预览返回精确 helper 别名与可信虚拟模块，H5 不启用。 */
export function createPreviewRpxCompatibility(
  target: string,
  aliasRoot: string,
): { alias: Alias[]; plugin: Plugin };
