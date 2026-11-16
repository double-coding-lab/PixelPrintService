import type { Plugin } from 'vite';

/** 仅对 RN 静态图片 require 提供安全的预览转换。 */
export function createPreviewRnAssets(
  target: string,
  root: string,
  aliasRoot?: string,
  inputRoot?: string,
): Plugin;
