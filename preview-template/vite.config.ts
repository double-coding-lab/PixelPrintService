import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { previewConfig } from './preview.config';
import { createPreviewPostcssPlugins } from './postcss.mjs';
import { createPreviewRpxCompatibility } from './container/rpx.mjs';
import { createPreviewRnAssets } from './container/rn-assets.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = new URL('./src/', import.meta.url);
const aliasRoot =
  String(previewConfig.target) === 'rn' &&
  statSync(srcRoot, { throwIfNoEntry: false })?.isDirectory()
    ? fileURLToPath(srcRoot)
    : root;
const rpx = createPreviewRpxCompatibility(previewConfig.target, aliasRoot);

/** 开发、构建和静态服务使用相同入口，dist 使用相对资源路径以支持独立预览目录。 */
export default defineConfig({
  root,
  base: './',
  plugins: [createPreviewRnAssets(previewConfig.target, root, aliasRoot), rpx.plugin, react()],
  css: {
    postcss: {
      plugins: createPreviewPostcssPlugins(
        previewConfig.target,
        previewConfig.unit.outputUnit,
        previewConfig.unit.outputBase,
      ),
    },
  },
  resolve: {
    alias: [
      ...rpx.alias,
      {
        find: '@preview-entry',
        replacement: fileURLToPath(new URL(previewConfig.entry, import.meta.url)),
      },
      { find: '@', replacement: aliasRoot },
      { find: /^react-native$/, replacement: 'react-native-web' },
    ],
    extensions:
      String(previewConfig.target) === 'rn'
        ? ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json']
        : undefined,
  },
  server: {
    fs: { strict: true, allow: [root] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
