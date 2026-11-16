import { diagnosticFromStderr, type PreviewDiagnostic } from './diagnostics';
import { startPreviewProcess, type LocalPreviewProcess } from './localProcess';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BUILD_TIMEOUT_MS = 120_000;
const MAX_FILES = 2_000;
const MAX_BYTES = 64 * 1024 * 1024;
const SOURCE = /\.(?:tsx?|jsx?|css|scss|sass|json)$/i;
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const RESERVED = /^(?:node_modules|internal|__preview|config|configs|dist|build|coverage)$/i;
const CONFIG =
  /^(?:package(?:-lock)?\.json|(?:npm|pnpm|yarn|bun).*lock.*|(?:vite|postcss|babel|webpack|rollup|eslint|prettier|tailwind|next|metro|preview|tsconfig|jsconfig)(?:[.-].*)?|.*\.config\.[^.]+)$/i;

export type PreviewBuildErrorReason =
  | 'PREVIEW_INVALID_INPUT'
  | 'PREVIEW_BUILD_FAILED'
  | 'PREVIEW_BUILD_CANCELLED'
  | 'PREVIEW_BUILD_TIMEOUT'
  | 'PREVIEW_CLEANUP_FAILED';

/** 只暴露固定失败原因，只允许固定分类与工作区相对定位，不向服务日志输出原始进程参数或源码。 */
export class PreviewBuildError extends Error {
  cleanupFailed = false;
  constructor(
    public readonly reason: PreviewBuildErrorReason,
    public readonly diagnostic?: PreviewDiagnostic,
  ) {
    super(reason);
    this.name = 'PreviewBuildError';
  }
}

/** 约束规范 POSIX 相对路径，并保留输入目录结构；不接受配置、内部文件或脚本入口。 */
function validPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (/[\\\x00-\x1f\x7f:%?#]/.test(value) || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every(
    (part) => part && !part.startsWith('.') && !RESERVED.test(part) && !CONFIG.test(part),
  );
}

/** 读取常规构建文件，拒绝符号链接/特殊文件并限制输出量，返回标准静态 MIME。 */
export async function collectPreviewOutput(root: string) {
  const output: Array<{ path: string; content: Buffer; mimeType: string }> = [];
  let total = 0;
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  /** 逐层检查目录条目，避免跟随生成的链接读取主机文件。 */
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const filename = path.join(root, name);
        total += (await stat(filename)).size;
        if (total > MAX_BYTES || output.length >= MAX_FILES) {
          throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
        }
        output.push({
          path: name,
          content: await readFile(filename),
          mimeType: mime[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        });
      } else throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
    }
  }
  await walk('');
  if (!output.some((file) => file.path === 'index.html')) {
    throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
  }
  return output;
}

/** 固定模板在本地子进程编译；取消或超时停止进程组，输出读取后回收临时目录。 */
export async function runLocalPreviewBuild(input: {
  files: Array<{ path: string; content: Buffer }>;
  target: 'h5' | 'rn';
  entryPath: string;
  unit: { outputUnit: 'px' | 'vw'; outputBase: number };
  signal: AbortSignal;
}): Promise<Array<{ path: string; content: Buffer; mimeType: string }>> {
  const buildFiles = validatePreviewBuildInput(input);
  let temporary: string | undefined;
  let worker: LocalPreviewProcess | undefined;
  let failure: PreviewBuildError | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const stop = () => {
    void worker?.stop().catch(() => {});
  };
  const onAbort = () => {
    controller.abort();
    stop();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    onAbort();
  }, BUILD_TIMEOUT_MS);
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  try {
    temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'pixelprint-preview-')));
    const source = path.join(temporary, 'input');
    const output = path.join(temporary, 'output');
    await mkdir(source);
    await mkdir(output);
    for (const file of buildFiles) {
      controller.signal.throwIfAborted();
      const destination = path.join(source, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
    controller.signal.throwIfAborted();
    worker = startPreviewProcess(
      path.resolve('preview-template/container/build.mjs'),
      [input.target, input.entryPath, input.unit.outputUnit, String(input.unit.outputBase)],
      { cwd: process.cwd(), env: { PIXELPRINT_PREVIEW_ROOT: temporary } },
    );
    const result = await worker.exited;
    controller.signal.throwIfAborted();
    if (result.code !== 0 || result.error) {
      throw new PreviewBuildError(
        'PREVIEW_BUILD_FAILED',
        diagnosticFromStderr(result.stderr) ?? { code: 'BUILD_FAILED' },
      );
    }
    const built = await collectPreviewOutput(output);
    controller.signal.throwIfAborted();
    return built;
  } catch (error) {
    failure = new PreviewBuildError(
      input.signal.aborted
        ? 'PREVIEW_BUILD_CANCELLED'
        : timedOut
          ? 'PREVIEW_BUILD_TIMEOUT'
          : error instanceof PreviewBuildError
            ? error.reason
            : 'PREVIEW_BUILD_FAILED',
      error instanceof PreviewBuildError ? error.diagnostic : undefined,
    );
    throw failure;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onAbort);
    try {
      await worker?.stop();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } catch {
      if (failure) failure.cleanupFailed = true;
      else throw new PreviewBuildError('PREVIEW_CLEANUP_FAILED');
    }
  }
}

/** 使用固定本地 Node/Vite 模板构建，保留原有调用 API。 */
export function runPreviewBuild(
  input: Parameters<typeof runLocalPreviewBuild>[0],
): Promise<Array<{ path: string; content: Buffer; mimeType: string }>> {
  return runLocalPreviewBuild(input);
}

/** 冷构建与温热构建共用相同输入守卫，不扩大可编译文件或配置范围。 */
export function validatePreviewBuildInput(input: Parameters<typeof runPreviewBuild>[0]) {
  const invalid = () => new PreviewBuildError('PREVIEW_INVALID_INPUT');
  if (
    !input ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > MAX_FILES ||
    !['h5', 'rn'].includes(input.target) ||
    !validPath(input.entryPath) ||
    !/\.[jt]sx?$/.test(input.entryPath) ||
    !input.unit ||
    !['px', 'vw'].includes(input.unit.outputUnit) ||
    !Number.isFinite(input.unit.outputBase) ||
    input.unit.outputBase <= 0 ||
    !(input.signal instanceof AbortSignal)
  )
    throw invalid();
  const names = new Set<string>();
  const buildFiles: Array<{ path: string; content: Buffer }> = [];
  let total = 0;
  for (const file of input.files) {
    if (
      !file ||
      !validPath(file.path) ||
      !Buffer.isBuffer(file.content) ||
      names.has(file.path.toLowerCase())
    )
      throw invalid();
    names.add(file.path.toLowerCase());
    total += file.content.length;
    if (total > MAX_BYTES) throw invalid();
    if (
      (SOURCE.test(file.path) || ASSET.test(file.path)) &&
      (!file.path.startsWith('public/') || ASSET.test(file.path))
    )
      buildFiles.push(file);
  }
  if (!buildFiles.some((file) => file.path === input.entryPath)) throw invalid();
  for (const file of input.files) {
    const parts = file.path.toLowerCase().split('/');
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join('/'))) throw invalid();
      parts.pop();
    }
  }
  if (input.signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
  return buildFiles;
}
