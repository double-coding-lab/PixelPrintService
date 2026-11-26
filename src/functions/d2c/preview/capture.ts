import {
  previewInspectionOptionsSchema,
  previewInteractionResultSchema,
  previewCoverageSchema,
  type PreviewInspectionOptions,
  type PreviewInteractionResult,
  type PreviewCoverage,
} from './interaction';
import { previewAssetBase } from './assetPolicy';
import { previewBrowserRoot } from './paths';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const BROWSER_ROOT = previewBrowserRoot;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_PROTOCOL = 20 * 1024 * 1024;
const TIMEOUT = 75_000;
const MAX_HEIGHT = 12_000;

const MAX_ASSETS = 2000;

export interface PreviewCaptureResult {
  image: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  errors: Array<{ code: string; message?: string }>;
  missingAssets: string[];
  truncated: boolean;
  interaction?: PreviewInteractionResult;
  coverage?: PreviewCoverage;
}

/** Fixed safe failures never expose stderr, generated code or host configuration. */
export class PreviewCaptureError extends Error {
  cleanupFailed = false;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'PreviewCaptureError';
  }
}

/** Run trusted Node in a POSIX process group; every exit kills surviving browser descendants. */
function captureProcess(input: string, signal: AbortSignal) {
  return new Promise<Buffer>((resolveOutput, reject) => {
    if (signal.aborted) return reject(new PreviewCaptureError('PREVIEW_CAPTURE_CANCELLED'));
    if (process.platform === 'win32')
      return reject(new PreviewCaptureError('PREVIEW_CAPTURE_PROCESS_UNAVAILABLE'));
    const child = spawn(process.execPath, [resolve(BROWSER_ROOT, 'capture.mjs')], {
      cwd: BROWSER_ROOT,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      /** Deliberate values only: no business secrets, NODE_OPTIONS, proxies or host profiles. */
      env: {
        PATH: '/usr/bin:/bin',
        HOME: tmpdir(),
        TMPDIR: tmpdir(),
        LANG: 'en_US.UTF-8',
        PLAYWRIGHT_BROWSERS_PATH: resolve(BROWSER_ROOT, '.browsers'),
      },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    let cleanupFailed = false;
    let cleaned = false;
    /** Playwright detaches Chromium into its own group: snapshot descendants before killing Node. */
    const cleanup = () => {
      if (!child.pid || cleaned) return;
      cleaned = true;
      /** Freeze the launcher before enumerating: it cannot detach a new browser after the snapshot. */
      try {
        process.kill(child.pid, 'SIGSTOP');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true;
      }
      const descendants = new Set<number>([child.pid]);
      try {
        const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], {
          encoding: 'utf8',
          timeout: 1000,
          maxBuffer: 4 * 1024 * 1024,
          env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        })
          .trim()
          .split('\n')
          .map((row) => row.trim().split(/\s+/).map(Number));
        for (let changed = true; changed; ) {
          changed = false;
          for (const [pid, parent] of rows)
            if (descendants.has(parent) && !descendants.has(pid)) {
              descendants.add(pid);
              changed = true;
            }
        }
      } catch {
        cleanupFailed = true;
      }
      for (const pid of [...descendants].reverse()) {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupFailed = true;
          }
        }
      }
    };
    const stop = (reason: string) => {
      failure ??= reason;
      cleanup();
    };
    const timer = setTimeout(() => stop('PREVIEW_CAPTURE_TIMEOUT'), TIMEOUT);
    const abort = () => stop('PREVIEW_CAPTURE_CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PROTOCOL) stop('PREVIEW_CAPTURE_OUTPUT_LIMIT');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => {
      failure ??= 'PREVIEW_CAPTURE_PROCESS_UNAVAILABLE';
      cleanup();
    });
    /** Exit precedes close: reap descendants even when they still hold inherited pipe FDs. */
    child.once('exit', cleanup);
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      cleanup();
      const reason =
        failure ??
        (code === 124
          ? 'PREVIEW_CAPTURE_TIMEOUT'
          : code !== 0
            ? 'PREVIEW_CAPTURE_FAILED'
            : undefined);
      if (reason || cleanupFailed) {
        const error = new PreviewCaptureError(reason ?? 'PREVIEW_CAPTURE_CLEANUP_FAILED');
        error.cleanupFailed = cleanupFailed;
        reject(error);
      } else resolveOutput(Buffer.concat(chunks));
    });
    if (signal.aborted) abort();
    child.stdin.end(input);
  });
}

/** Accept only canonical dist paths; no filesystem paths, aliases or URL encodings. */
function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\\x00-\x1f\x7f:%?#]/.test(value) &&
    value.split('/').every((part) => part && !part.startsWith('.'))
  );
}

/** 只预取配置的公开服务来源中的图片字面量，不执行源码或跟随重定向。 */
function enumerateCdn(files: Array<{ content: Buffer; mimeType: string }>) {
  const publicBase = previewAssetBase();
  const publicOrigin = new URL(publicBase).origin;
  const urls = new Set<string>();
  let limited = false;
  for (const file of files) {
    if (!/^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/.test(file.mimeType))
      continue;
    const text = file.content.toString('utf8').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    for (const match of text.matchAll(/https?:\/\/[^\s"'`<>()\\]+/g)) {
      const literal = match[0];
      /** 仅接受配置的服务来源，拒绝凭据及其他外部地址。 */
      if (!literal.startsWith(publicBase) || literal.length > 2048 || literal.includes('${'))
        continue;
      try {
        const url = new URL(literal);
        if (
          url.origin !== publicOrigin ||
          !url.href.startsWith(publicBase) ||
          /%(?:2e|2f|5c|25)/i.test(url.pathname) ||
          url.username ||
          url.password
        )
          continue;
        url.hash = '';
        if (urls.size >= MAX_ASSETS && !urls.has(url.href)) {
          limited = true;
          continue;
        }
        urls.add(url.href);
      } catch {
        /** Malformed literals cannot become network requests. */
      }
    }
  }
  return { urls: [...urls], limited };
}

/**
 * Prefetch only enumerated allowlisted URLs, without redirects, cookies or credentials.
 * Four workers share a 64MiB streamed budget; individual images are at most 10MiB.
 * Failures remain explicit missing assets, never trigger a browser/host network fallback.
 */
async function prefetchCdn(
  files: Array<{ content: Buffer; mimeType: string }>,
  signal: AbortSignal,
) {
  const { urls, limited } = enumerateCdn(files);
  const assets: Array<{ url: string; content: string; mimeType: string }> = [];
  const missingAssets: string[] = [];
  const errors = new Set<string>(limited ? ['CDN_ENUMERATION_LIMIT'] : []);
  let index = 0;
  let total = 0;
  const budget = AbortSignal.timeout(30_000);
  /** Bound each fetch and cancel unread response bodies, including invalid headers and redirects. */
  async function worker() {
    while (index < urls.length) {
      const url = urls[index++];
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let code = 'CDN_ASSET_FETCH_FAILED';
      try {
        if (signal.aborted) throw new PreviewCaptureError('PREVIEW_CAPTURE_CANCELLED');
        if (budget.aborted) {
          code = 'CDN_PREFETCH_TIMEOUT';
          throw new Error();
        }
        if (total >= 64 * 1024 * 1024) {
          code = 'CDN_TOTAL_LIMIT';
          throw new Error();
        }
        response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'image/*' },
          signal: AbortSignal.any([signal, budget, AbortSignal.timeout(8000)]),
        });
        if (!response.ok || response.redirected || (response.url && response.url !== url))
          throw new Error();
        const mimeType = (response.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!/^image\/[a-z0-9.+-]+$/.test(mimeType)) {
          code = 'CDN_ASSET_MIME_INVALID';
          throw new Error();
        }
        const length = Number(response.headers.get('content-length'));
        if (length > MAX_IMAGE) {
          code = 'CDN_ASSET_SIZE_LIMIT';
          throw new Error();
        }
        if (length > 64 * 1024 * 1024 - total) {
          code = 'CDN_TOTAL_LIMIT';
          throw new Error();
        }
        if (!response.body) throw new Error();
        reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE) {
            code = 'CDN_ASSET_SIZE_LIMIT';
            throw new Error();
          }
          if (total + value.byteLength > 64 * 1024 * 1024) {
            code = 'CDN_TOTAL_LIMIT';
            throw new Error();
          }
          total += value.byteLength;
          chunks.push(Buffer.from(value));
        }
        if (!size) throw new Error();
        assets.push({ url, mimeType, content: Buffer.concat(chunks).toString('base64') });
      } catch {
        missingAssets.push(url);
        errors.add(code);
      } finally {
        try {
          if (reader) await reader.cancel();
          else await response?.body?.cancel();
        } catch {
          /** Already aborted. */
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
  return { assets, missingAssets, errors };
}

/** Validate the bounded, trusted browser protocol before exposing the original PNG bytes. */
function decode(output: Buffer, width: number): PreviewCaptureResult {
  const fail = () => new PreviewCaptureError('PREVIEW_CAPTURE_INVALID_OUTPUT');
  let value;
  try {
    value = JSON.parse(output.toString('utf8'));
  } catch {
    throw fail();
  }
  if (value?.error && typeof value.error === 'string') {
    throw new PreviewCaptureError(
      [
        'PREVIEW_CAPTURE_UNSUPPORTED',
        'PREVIEW_CAPTURE_TIMEOUT',
        'PREVIEW_CAPTURE_DEPENDENCY_UNAVAILABLE',
        'PREVIEW_CAPTURE_BROWSER_NOT_INSTALLED',
        'PREVIEW_CAPTURE_BROWSER_LAUNCH_FAILED',
      ].includes(value.error)
        ? value.error
        : 'PREVIEW_CAPTURE_FAILED',
    );
  }
  if (
    !value ||
    typeof value.image !== 'string' ||
    value.width !== width ||
    !Number.isInteger(value.height) ||
    value.height < 1 ||
    value.height > MAX_HEIGHT ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.errors) ||
    value.errors.length > 100 ||
    !value.errors.every(
      (item: { code?: unknown }) =>
        item && typeof item.code === 'string' && /^[A-Z_]{1,80}$/.test(item.code),
    ) ||
    !Array.isArray(value.missingAssets) ||
    value.missingAssets.length > MAX_ASSETS ||
    !value.missingAssets.every((item: unknown) => typeof item === 'string' && item.length <= 2048)
  )
    throw fail();
  const interaction =
    value.interaction === undefined
      ? undefined
      : previewInteractionResultSchema.safeParse(value.interaction);
  const coverage =
    value.coverage === undefined ? undefined : previewCoverageSchema.safeParse(value.coverage);
  if (
    (interaction && !interaction.success) ||
    (coverage &&
      (!coverage.success || coverage.data.width !== width || coverage.data.height !== value.height))
  )
    throw fail();
  const image = Buffer.from(value.image, 'base64');
  if (image.length > MAX_IMAGE) throw new PreviewCaptureError('PREVIEW_CAPTURE_OUTPUT_LIMIT');
  if (
    image.length < 33 ||
    image.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
    image.toString('ascii', 12, 16) !== 'IHDR' ||
    image.readUInt32BE(16) !== width ||
    image.readUInt32BE(20) !== value.height
  )
    throw fail();
  return {
    image,
    mimeType: 'image/png',
    width,
    height: value.height,
    truncated: value.truncated,
    ...(interaction?.success ? { interaction: interaction.data } : {}),
    ...(coverage?.success ? { coverage: coverage.data } : {}),
    errors: value.errors.map((item: { code: string }) => ({ code: item.code })),
    missingAssets: value.missingAssets,
  };
}

export interface PreviewCaptureInput {
  files: Array<{ path: string; content: Buffer; mimeType: string }>;
  target: 'h5' | 'rn';
  signal: AbortSignal;
  width?: number;
  inspection?: PreviewInspectionOptions;
}

type CaptureTransport = (input: string, signal: AbortSignal) => Promise<Buffer>;

/** Validate and capture dist with shared CDN, deadline, diagnostics and PNG protocol rules. */
async function runCapture(
  input: PreviewCaptureInput,
  transport: CaptureTransport,
): Promise<PreviewCaptureResult> {
  const invalid = () => new PreviewCaptureError('PREVIEW_CAPTURE_INVALID_INPUT');
  const width = input?.width ?? 375;
  const inspection = previewInspectionOptionsSchema.safeParse(
    input?.inspection === undefined ? {} : input.inspection,
  );
  if (!inspection.success) throw invalid();
  if (
    !input ||
    !['h5', 'rn'].includes(input.target) ||
    !(input.signal instanceof AbortSignal) ||
    !Number.isInteger(width) ||
    width < 320 ||
    width > 1440 ||
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > 2000
  )
    throw invalid();
  const names = new Set<string>();
  let total = 0;
  for (const file of input.files) {
    if (
      !file ||
      !validPath(file.path) ||
      !Buffer.isBuffer(file.content) ||
      typeof file.mimeType !== 'string' ||
      file.mimeType.length > 100 ||
      !/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(file.mimeType) ||
      names.has(file.path.toLowerCase())
    )
      throw invalid();
    names.add(file.path.toLowerCase());
    total += file.content.length;
    if (total > 64 * 1024 * 1024) throw invalid();
  }
  if (
    !input.files.some((file) => file.path === 'index.html' && file.mimeType.startsWith('text/html'))
  )
    throw invalid();
  if (input.signal.aborted) throw new PreviewCaptureError('PREVIEW_CAPTURE_CANCELLED');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT);
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    const cdn = await prefetchCdn(input.files, controller.signal);
    if (controller.signal.aborted) throw new PreviewCaptureError('PREVIEW_CAPTURE_CANCELLED');
    const payload = JSON.stringify({
      assets: cdn.assets,
      ...(input.inspection === undefined ? {} : { inspection: inspection.data }),
      assetBase: previewAssetBase(),
      width,
      target: input.target,
      files: input.files.map((file) => ({
        path: file.path,
        mimeType: file.mimeType,
        content: file.content.toString('base64'),
      })),
    });
    const output = await transport(payload, controller.signal);
    if (controller.signal.aborted) throw new PreviewCaptureError('PREVIEW_CAPTURE_CANCELLED');
    const result = decode(output, width);
    if (input.inspection !== undefined) {
      const actions = inspection.data.actions ?? [];
      if (
        !result.interaction ||
        !result.coverage ||
        result.interaction.steps.length !== actions.length ||
        result.interaction.steps.some(
          (step, index) => step.step !== index + 1 || step.type !== actions[index].type,
        ) ||
        Boolean(result.interaction.focus) !== Boolean(inspection.data.focusSelector)
      )
        throw new PreviewCaptureError('PREVIEW_CAPTURE_INVALID_OUTPUT');
    }
    result.errors = [...new Set([...cdn.errors, ...result.errors.map((item) => item.code)])]
      .slice(0, 100)
      .map((code) => ({ code }));
    result.missingAssets = [...new Set([...cdn.missingAssets, ...result.missingAssets])].slice(
      0,
      MAX_ASSETS,
    );
    return result;
  } catch (error) {
    const failure = new PreviewCaptureError(
      input.signal.aborted
        ? 'PREVIEW_CAPTURE_CANCELLED'
        : timedOut
          ? 'PREVIEW_CAPTURE_TIMEOUT'
          : error instanceof PreviewCaptureError
            ? error.reason
            : 'PREVIEW_CAPTURE_FAILED',
    );
    if (error instanceof PreviewCaptureError) failure.cleanupFailed = error.cleanupFailed;
    throw failure;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
  }
}

/** Capture directly with the pinned local browser, independent of the configured engine. */
export function runLocalPreviewCapture(input: PreviewCaptureInput): Promise<PreviewCaptureResult> {
  return runCapture(input, captureProcess);
}

/** 截图固定使用本地 Chromium，保留构建与审查调用 API。 */
export function runPreviewCapture(input: PreviewCaptureInput): Promise<PreviewCaptureResult> {
  return runLocalPreviewCapture(input);
}
