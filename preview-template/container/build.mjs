import { formatCompilerDiagnostic } from './diagnostics.mjs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { boundedSass } from './sass.mjs';
import { createPreviewPostcssPlugins } from '../postcss.mjs';
import { relativeStaticUrls } from './static-urls.mjs';
import { createPreviewRpxCompatibility } from './rpx.mjs';
import { createPreviewRnAssets } from './rn-assets.mjs';

const templateRoot = fileURLToPath(new URL('../', import.meta.url));
const executionRoot = path.resolve(process.env.PIXELPRINT_PREVIEW_ROOT ?? '.runtime/preview-build');
const root = path.join(executionRoot, 'work');
const inputRoot = path.join(executionRoot, 'input');
const outputRoot = path.join(executionRoot, 'output');
const dependencies = path.join(templateRoot, 'node_modules');
const SOURCE = /\.(?:tsx?|jsx?|css|scss|sass|json)$/i;
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const RESERVED = /^(?:node_modules|internal|__preview|config|configs|dist|build|coverage)$/i;
const CONFIG =
  /^(?:package(?:-lock)?\.json|(?:npm|pnpm|yarn|bun).*lock.*|(?:vite|postcss|babel|webpack|rollup|eslint|prettier|tailwind|next|metro|preview|tsconfig|jsconfig)(?:[.-].*)?|.*\.config\.[^.]+)$/i;
let initialized = false;
let previousFiles = new Map();

/** 与宿主 runner 保持相同的受控相对路径规则。 */
export function validPreviewPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (/[\\\x00-\x1f\x7f:%?#]/.test(value) || path.posix.isAbsolute(value)) return false;
  return value
    .split('/')
    .every((part) => part && !part.startsWith('.') && !RESERVED.test(part) && !CONFIG.test(part));
}

/** 编译入口只接受已支持的目标、源码入口和有限正数单位基准。 */
export function validatePreviewOptions({ target, entry, unit, rawBase }) {
  if (
    !['h5', 'rn'].includes(target) ||
    !validPreviewPath(entry) ||
    !/\.[jt]sx?$/.test(entry) ||
    !['px', 'vw'].includes(unit) ||
    !Number.isFinite(rawBase) ||
    rawBase <= 0
  )
    throw new Error('PREVIEW_INVALID_INPUT');
}

/** 完整检查快照后再同步；不跟随链接，不复制配置或依赖，保留未改变文件的时间戳。 */
export async function syncPreviewInput(entry) {
  try {
    await syncSnapshot(entry);
  } catch (error) {
    /** A failed write may leave a partial mirror: the next valid snapshot reinitializes it. */
    initialized = false;
    previousFiles = new Map();
    throw error;
  }
}

/** 校验并应用一个完整输入快照。 */
async function syncSnapshot(entry) {
  const files = new Map();
  const names = new Set();
  let bytes = 0;
  let count = 0;
  let nodes = 0;
  if (!(await lstat(inputRoot)).isDirectory()) throw new Error('PREVIEW_INVALID_INPUT');
  /** 仅遍历固定输入根，限制目录深度、条目数量、文件数量及总字节。 */
  async function walk(relative = '', depth = 0) {
    if (depth > 64) throw new Error('PREVIEW_INVALID_INPUT');
    for (const item of await readdir(path.join(inputRoot, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, item.name);
      if (++nodes > 4000 || !validPreviewPath(name)) throw new Error('PREVIEW_INVALID_INPUT');
      const info = await lstat(path.join(inputRoot, name));
      if (info.isDirectory()) {
        await walk(name, depth + 1);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) throw new Error('PREVIEW_INVALID_INPUT');
      bytes += info.size;
      if (++count > 2000 || bytes > 64 * 1024 * 1024 || names.has(name.toLowerCase()))
        throw new Error('PREVIEW_INVALID_INPUT');
      names.add(name.toLowerCase());
      if (
        (SOURCE.test(name) || ASSET.test(name)) &&
        (!name.startsWith('public/') || ASSET.test(name))
      ) {
        files.set(name, await readFile(path.join(inputRoot, name)));
      }
    }
  }
  await walk();
  if (!files.has(entry)) throw new Error('PREVIEW_INVALID_INPUT');
  /** Explicit public assets take precedence over mirrored source assets, as in cold builds. */
  const desired = new Map(files);
  for (const [name, content] of files) {
    if (!ASSET.test(name)) continue;
    const mirror = name.startsWith('public/') ? name.slice(7) : `public/${name}`;
    if (!desired.has(mirror)) desired.set(mirror, content);
  }
  if (!initialized) {
    await rm(root, { recursive: true, force: true });
    await mkdir(`${root}/__preview`, { recursive: true });
    await cp(path.join(templateRoot, 'src/main.tsx'), `${root}/__preview/main.tsx`);
    const html = await readFile(path.join(templateRoot, 'index.html'), 'utf8');
    await writeFile(`${root}/index.html`, html.replace('/src/main.tsx', '/__preview/main.tsx'));
    await symlink(dependencies, `${root}/node_modules`);
    initialized = true;
  }
  for (const name of previousFiles.keys()) {
    if (!desired.has(name)) await rm(path.join(root, name), { force: true });
  }
  /** Remove empty input directories too (including src), and allow file/directory replacements. */
  /** 清除受控目录中已空的目录，不进入可信依赖或入口。 */
  async function prune(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory() && item.name !== '__preview') {
        const child = path.join(directory, item.name);
        await prune(child);
        if (!(await readdir(child)).length) await rm(child, { recursive: true });
      }
    }
  }
  await prune(root);
  for (const [name, content] of desired) {
    if (previousFiles.get(name)?.equals(content)) continue;
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  previousFiles = desired;
}

/** 配置/插件仅从可信模板载入；增量构建仅 watch 一轮并在返回前关闭 watcher。 */
export async function buildPreview({ target, entry, unit, rawBase, cache, incremental = false }) {
  validatePreviewOptions({ target, entry, unit, rawBase });
  await syncPreviewInput(entry);
  const aliasRoot = await stat(`${root}/src`).then(
    (entry) => (entry.isDirectory() ? `${root}/src` : root),
    () => root,
  );
  const rpx = createPreviewRpxCompatibility(target, aliasRoot);
  const result = await build({
    configFile: false,
    envFile: false,
    root,
    base: './',
    logLevel: 'silent',
    plugins: [
      {
        name: 'pixelprint-module-boundary',
        enforce: 'pre',
        /** Re-run workspace transforms: Sass imports and RN asset lookups have implicit inputs. */
        shouldTransformCachedModule({ id }) {
          if (id.startsWith(`${root}/`) && !id.includes('/node_modules/')) return true;
        },
        load(id) {
          if (id.startsWith('\0')) return;
          const filename = id.split('?')[0];
          if (
            path.isAbsolute(filename) &&
            !filename.startsWith(`${root}/`) &&
            !filename.startsWith(`${dependencies}/`)
          )
            throw new Error('PREVIEW_MODULE_BOUNDARY');
        },
      },
      relativeStaticUrls(),
      createPreviewRnAssets(target, root, aliasRoot, inputRoot),
      rpx.plugin,
      boundedSass(root),
      react({ babel: { babelrc: false, configFile: false } }),
    ],
    resolve: {
      alias: [
        ...rpx.alias,
        { find: '@preview-entry', replacement: path.join(root, entry) },
        { find: /^react-native$/, replacement: 'react-native-web' },
        { find: '@', replacement: aliasRoot },
      ],
      dedupe: ['react', 'react-dom'],
      extensions:
        target === 'rn'
          ? ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json']
          : undefined,
    },
    define: { __DEV__: 'false', 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } } },
    css: { postcss: { plugins: createPreviewPostcssPlugins(target, unit, Number(rawBase)) } },
    build: {
      outDir: outputRoot,
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 0,
      ...(incremental
        ? {
            minify: false,
            reportCompressedSize: false,
            watch: { chokidar: { usePolling: true, interval: 1000 }, exclude: ['**/*'] },
            rollupOptions: { cache },
          }
        : {}),
    },
  });
  if (!incremental) return;
  try {
    return await new Promise((resolve, reject) => {
      result.on('event', (event) => {
        if (event.code === 'BUNDLE_END') resolve(event.result.cache);
        else if (event.code === 'ERROR') reject(event.error);
      });
    });
  } finally {
    await result.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const [target, entry, unit, rawBase] = process.argv.slice(2);
  buildPreview({ target, entry, unit, rawBase: Number(rawBase) }).catch((error) => {
    process.stderr.write(
      'PIXELPRINT_PREVIEW_DIAGNOSTIC:' +
        JSON.stringify(formatCompilerDiagnostic(error, root)) +
        '\n',
    );
    process.exitCode = 1;
  });
}
