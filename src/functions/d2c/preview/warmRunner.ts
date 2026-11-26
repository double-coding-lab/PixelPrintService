import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { previewDiagnostic } from './diagnostics';
import { startPreviewProcess, type LocalPreviewProcess } from './localProcess';
import { previewRuntimeRoot, previewTemplateRoot } from './paths';
import {
  collectPreviewOutput,
  PreviewBuildError,
  runPreviewBuild,
  validatePreviewBuildInput,
} from './runner';

type Input = Parameters<typeof runPreviewBuild>[0];
type Output = Awaited<ReturnType<typeof runPreviewBuild>>;
type Context = {
  root: string;
  source: string;
  output: string;
  control: string;
  process?: LocalPreviewProcess;
  ready: boolean;
  busy: boolean;
  dead: boolean;
  hashes: Map<string, string>;
  disposal?: Promise<void>;
};
type Lane = {
  key: string;
  tail: Promise<void>;
  jobs: Set<AbortController>;
  context?: Context;
  idleTimer?: ReturnType<typeof setTimeout>;
  released: boolean;
};

export type WarmPreviewRunnerOptions = {
  idleMs?: number;
  maxContexts?: number;
  /** 测试可缩短期限；生产默认每次构建（含启动）120秒。 */
  timeoutMs?: number;
  startupMs?: number;
  /** 可信测试注入，不接收用户输入或任意命令。 */
  startProcess?: typeof startPreviewProcess;
  coldRunner?: typeof runPreviewBuild;
};

/** 轮询可中断且不保留监听器，最长25ms，旧任务中止不影响其他任务。 */
function pause(signal: AbortSignal, ms = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new PreviewBuildError('PREVIEW_BUILD_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** 文件必须为无硬链接的普通文件；控制读遇到已被原子替换的旧inode时重试。 */
async function regularFile(filename: string, flags: number, content?: Buffer) {
  const handle = await open(filename, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    /** 原子替换可能在open后解除旧inode链接；仅控制读重试，写入仍要求恰好一个链接。 */
    if (content === undefined && info.isFile() && info.nlink === 0) return;
    if (!info.isFile() || info.nlink !== 1) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
    if (content) {
      await handle.truncate(0);
      await handle.writeFile(content);
      return Buffer.alloc(0);
    }
    if (info.size > 32768) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** 控制文件仅接受有界JSON普通文件；不存在/原子替换间隙继续等待。 */
async function controlJSON(filename: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await regularFile(filename, constants.O_RDONLY);
    if (!content) return;
    const value: unknown = JSON.parse(content.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    /** Worker原子写入；非法协议直接失败，不重试用户编译。 */
    throw error;
  }
}

/** 所有目录只能是本context内普通目录，拒绝软链接与特殊节点。 */
async function directory(filename: string) {
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
  }
}

/** 每轮先移除旧文件和空目录，再只写字节数/SHA-256有变化的源码。 */
async function stage(context: Context, files: Input['files'], signal: AbortSignal) {
  const wanted = new Map(files.map((file) => [file.path, file]));
  await directory(context.root);
  await directory(context.source);
  await directory(context.output);
  await directory(context.control);
  /** 删除前验证整个staging树，避免递归清理跟随链接。 */
  async function clean(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(context.source, relative))) {
      const name = relative ? `${relative}/${entry}` : entry;
      const filename = path.join(context.source, name);
      const info = await lstat(filename);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.isFile() && info.nlink !== 1)
      ) {
        throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
      }
      if (info.isDirectory()) {
        await clean(name);
        if (![...wanted.keys()].some((key) => key.startsWith(`${name}/`))) {
          await rm(filename, { recursive: true });
        }
      } else if (!wanted.has(name)) {
        await rm(filename);
        context.hashes.delete(name);
      }
    }
  }
  await clean('');
  for (const file of files) {
    if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
    const parts = file.path.split('/');
    parts.pop();
    let parent = context.source;
    for (const part of parts) {
      parent = path.join(parent, part);
      await mkdir(parent, { recursive: true });
      await directory(parent);
    }
    const digest = `${file.content.length}:${createHash('sha256').update(file.content).digest('hex')}`;
    const filename = path.join(context.source, file.path);
    let exists = false;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.nlink !== 1) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!exists || context.hashes.get(file.path) !== digest) {
      await regularFile(filename, constants.O_WRONLY | constants.O_CREAT, file.content);
      /** 输入文件保持对编译进程可读。 */
      await chmod(filename, 0o644);
      context.hashes.set(file.path, digest);
    }
  }
}

class StartupFailure extends Error {}

/**
 * 每key串行、跨key有界的本地Node常驻编译器。仅启动失败退回原冷构建；
 * 固定可信模板入口，源码仅作为编译输入，不执行用户配置或shell。
 */
export function createLocalWarmPreviewRunner(options: WarmPreviewRunnerOptions = {}) {
  const idleMs = options.idleMs ?? 120_000;
  const maxContexts = options.maxContexts ?? 2;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startupMs = options.startupMs ?? 15_000;
  if (
    ![idleMs, maxContexts, timeoutMs, startupMs].every(Number.isSafeInteger) ||
    idleMs < 1 ||
    maxContexts < 1 ||
    timeoutMs < 1 ||
    startupMs < 1
  ) {
    throw new PreviewBuildError('PREVIEW_INVALID_INPUT');
  }
  const startProcess = options.startProcess ?? startPreviewProcess;
  const cold = options.coldRunner ?? runPreviewBuild;
  const lanes = new Map<string, Lane>();
  const contexts = new Set<Context>();
  let closed = false;
  let disabledWarm = false;
  let closing: Promise<void> | undefined;
  const draining = new Set<Promise<void>>();
  const releasing = new Map<string, Promise<void>>();
  let gate = Promise.resolve();
  let lastIncremental = false;
  let activeCold = 0;

  /** 池修改串行化，创建资源前即预留槽位，不会超过并发上限。 */
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = gate;
    let unlock!: () => void;
    gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
    }
  }

  /** 幂等停止进程并等待退出后再删目录；停止失败保留目录和容量槽位。 */
  function dispose(context: Context): Promise<void> {
    if (context.disposal) return context.disposal;
    context.dead = true;
    context.disposal = (async () => {
      try {
        if (context.process) {
          await context.process.stop();
          await context.process.exited;
        }
        await rm(context.root, { recursive: true, force: true });
        contexts.delete(context);
      } catch {
        throw new PreviewBuildError('PREVIEW_CLEANUP_FAILED');
      }
    })();
    return context.disposal;
  }

  /** 获取空闲context或回收空闲槽位；全忙时可中止等待，不驱逐运行任务。 */
  async function acquire(lane: Lane, signal: AbortSignal): Promise<Context | undefined> {
    while (true) {
      if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
      const context = await locked(async () => {
        if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
        if (disabledWarm) {
          if (contexts.size + activeCold >= maxContexts) {
            const idle = [...contexts].find((candidate) => !candidate.busy && !candidate.dead);
            if (!idle) return;
            await dispose(idle);
          }
          activeCold++;
          return null;
        }
        if (lane.context && !lane.context.dead) {
          lane.context.busy = true;
          return lane.context;
        }
        if (contexts.size + activeCold >= maxContexts) {
          const idle = [...contexts].find((candidate) => !candidate.busy && !candidate.dead);
          if (!idle) return;
          await dispose(idle);
        }
        const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pixelprint-warm-')));
        const next: Context = {
          root,
          source: path.join(root, 'input'),
          output: path.join(root, 'output'),
          control: path.join(root, 'control'),
          ready: false,
          busy: true,
          dead: false,
          hashes: new Map(),
        };
        lane.context = next;
        contexts.add(next);
        await mkdir(path.join(root, 'work'));
        await mkdir(next.source);
        await mkdir(next.output, { mode: 0o777 });
        await chmod(next.output, 0o777);
        await mkdir(next.control, { mode: 0o777 });
        await chmod(next.control, 0o777);
        return next;
      });
      if (context === null) return;
      if (context) return context;
      await pause(signal);
    }
  }

  /** Detached启动后等待明确ready；退出/启动失败禁用warm，编译期不做cold重试。 */
  async function start(context: Context, signal: AbortSignal) {
    try {
      if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
      context.process = startProcess(path.join(previewTemplateRoot, 'container/warm.mjs'), [], {
        cwd: previewRuntimeRoot,
        env: { PIXELPRINT_PREVIEW_ROOT: context.root },
      });
      const deadline = Date.now() + startupMs;
      while (true) {
        if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
        if (!context.process.running) throw new StartupFailure();
        const ready = await controlJSON(path.join(context.control, 'ready.json'));
        if (ready?.protocol === 1) {
          context.ready = true;
          return;
        }
        if (Date.now() >= deadline) throw new PreviewBuildError('PREVIEW_BUILD_TIMEOUT');
        await pause(signal);
      }
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof PreviewBuildError &&
          ['PREVIEW_BUILD_CANCELLED', 'PREVIEW_BUILD_TIMEOUT'].includes(error.reason))
      )
        throw error;
      throw new StartupFailure();
    }
  }

  /** 请求原子发布，只读取同一UUID的结果，不让上一轮result污染新任务。 */
  async function build(context: Context, input: Input, signal: AbortSignal): Promise<Output> {
    const id = randomUUID();
    const temporary = path.join(context.control, `request-${id}.json`);
    await regularFile(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      Buffer.from(
        JSON.stringify({ id, target: input.target, entryPath: input.entryPath, unit: input.unit }),
      ),
    );
    await chmod(temporary, 0o644);
    if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
    await rename(temporary, path.join(context.control, 'request.json'));
    while (true) {
      if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
      if (!context.process?.running) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
      await directory(context.control);
      const result = await controlJSON(path.join(context.control, 'result.json'));
      if (result?.id === id) {
        if (result.ok === false) {
          const diagnostic = previewDiagnostic(result.diagnostic);
          throw new PreviewBuildError(
            'PREVIEW_BUILD_FAILED',
            diagnostic ?? { code: 'BUILD_FAILED' },
          );
        }
        if (result.ok !== true) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
        lastIncremental = result.incremental === true;
        const output = await collectPreviewOutput(context.output);
        if (signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
        return output;
      }
      await pause(signal);
    }
  }

  /** 单次任务生命周期：超时/中止销毁本context，清理完成后才允许后继任务启动。 */
  async function execute(lane: Lane, input: Input, controller: AbortController): Promise<Output> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let context: Context | undefined;
    let failure: PreviewBuildError | undefined;
    let coldLease = false;
    try {
      if (controller.signal.aborted) throw new PreviewBuildError('PREVIEW_BUILD_CANCELLED');
      context = await acquire(lane, controller.signal);
      if (!context) {
        coldLease = true;
        return await cold({ ...input, signal: controller.signal });
      }
      await stage(context, input.files, controller.signal);
      if (!context.ready) await start(context, controller.signal);
      return await build(context, input, controller.signal);
    } catch (error) {
      failure = new PreviewBuildError(
        controller.signal.aborted
          ? timedOut
            ? 'PREVIEW_BUILD_TIMEOUT'
            : 'PREVIEW_BUILD_CANCELLED'
          : error instanceof PreviewBuildError
            ? error.reason
            : 'PREVIEW_BUILD_FAILED',
        error instanceof PreviewBuildError ? error.diagnostic : undefined,
      );
      if (error instanceof PreviewBuildError) failure.cleanupFailed = error.cleanupFailed;
      if (context || lane.context?.busy) {
        try {
          await dispose(context ?? lane.context!);
        } catch {
          failure.cleanupFailed = true;
        }
      }
      if (error instanceof StartupFailure && !controller.signal.aborted && !failure.cleanupFailed) {
        disabledWarm = true;
        /** 仅尝试一次冷构建，直接传递用户编译或取消错误。 */
        try {
          await acquire(lane, controller.signal);
          coldLease = true;
          return await cold({ ...input, signal: controller.signal });
        } catch (coldError) {
          if (controller.signal.aborted)
            throw new PreviewBuildError(
              timedOut ? 'PREVIEW_BUILD_TIMEOUT' : 'PREVIEW_BUILD_CANCELLED',
            );
          throw coldError;
        }
      }
      throw failure;
    } finally {
      clearTimeout(timer);
      if (coldLease) activeCold--;
      if (context && !context.dead) context.busy = false;
    }
  }

  /** 空闲计时不保留进程；下一次同key调用会清除旧计时器。 */
  function scheduleIdle(lane: Lane) {
    if (lane.released || lane.jobs.size) return;
    lane.idleTimer = setTimeout(() => {
      lane.idleTimer = undefined;
      if (!lane.jobs.size && !lane.context && lanes.get(lane.key) === lane) lanes.delete(lane.key);
      if (!lane.jobs.size && lane.context) {
        /** 清理失败保留到显式release/close报告，避免未处理的Promise拒绝。 */
        void dispose(lane.context).then(
          () => {
            if (!lane.jobs.size && lanes.get(lane.key) === lane) lanes.delete(lane.key);
          },
          () => {},
        );
      }
    }, idleMs);
    lane.idleTimer.unref?.();
  }

  /** 验证并冻结本轮输入；同key队列取消只影响对应controller。 */
  function run(key: string, input: Input): Promise<Output> {
    try {
      if (closed || typeof key !== 'string' || !key)
        throw new PreviewBuildError('PREVIEW_INVALID_INPUT');
      const files = validatePreviewBuildInput(input).map((file) => ({
        path: file.path,
        content: Buffer.from(file.content),
      }));
      input = { ...input, files, unit: { ...input.unit } };
    } catch (error) {
      return Promise.reject(error);
    }
    let lane = lanes.get(key);
    if (!lane) {
      lane = { key, tail: Promise.resolve(), jobs: new Set(), released: false };
      lanes.set(key, lane);
    }
    const current = lane;
    clearTimeout(current.idleTimer);
    const controller = new AbortController();
    current.jobs.add(controller);
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) controller.abort();
    let started = false;
    let rejectQueued!: (error: PreviewBuildError) => void;
    const queuedAbort = new Promise<never>((_, reject) => {
      rejectQueued = reject;
    });
    const onQueuedAbort = () => {
      if (!started) rejectQueued(new PreviewBuildError('PREVIEW_BUILD_CANCELLED'));
    };
    controller.signal.addEventListener('abort', onQueuedAbort, { once: true });
    const work = current.tail
      .then(async () => {
        started = true;
        controller.signal.removeEventListener('abort', onQueuedAbort);
        return await execute(current, input, controller);
      })
      .finally(() => {
        input.signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onQueuedAbort);
        current.jobs.delete(controller);
        scheduleIdle(current);
      });
    current.tail = work.then(
      () => {},
      () => {},
    );
    if (controller.signal.aborted) onQueuedAbort();
    return Promise.race([work, queuedAbort]);
  }

  /** 先撤下旧队列再中止，新的同key队列不接收旧任务的取消。 */
  function release(key: string): Promise<void> {
    const lane = lanes.get(key);
    if (!lane) return releasing.get(key) ?? Promise.resolve();
    lanes.delete(key);
    lane.released = true;
    clearTimeout(lane.idleTimer);
    for (const job of lane.jobs) job.abort();
    const pending = (async () => {
      await lane.tail;
      if (lane.context) await dispose(lane.context);
    })();
    releasing.set(key, pending);
    draining.add(pending);
    const settled = () => {
      draining.delete(pending);
      if (releasing.get(key) === pending) releasing.delete(key);
    };
    void pending.then(settled, settled);
    return pending;
  }

  /** 幂等关闭，等待所有旧队列和进程清理；不再接受新请求。 */
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const releases = [...lanes.keys()].map(release);
      const results = await Promise.allSettled([...new Set([...releases, ...draining])]);
      const cleanup = await Promise.allSettled([...contexts].map(dispose));
      if ([...results, ...cleanup].some((result) => result.status === 'rejected')) {
        throw new PreviewBuildError('PREVIEW_CLEANUP_FAILED');
      }
    })();
    return closing;
  }

  return {
    run,
    release,
    close,
    /** 仅供观测/测试worker是否实际复用缓存，无产品接口。 */
    get lastIncremental() {
      return lastIncremental;
    },
  };
}

/** 在线编辑复用本地 Node 进程与 Rollup 缓存。 */
export function createWarmPreviewRunner(options: WarmPreviewRunnerOptions = {}) {
  return createLocalWarmPreviewRunner(options);
}
