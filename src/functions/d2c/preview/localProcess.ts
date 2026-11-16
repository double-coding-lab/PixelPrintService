import { spawn } from 'node:child_process';

export type LocalPreviewProcess = {
  readonly running: boolean;
  exited: Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>;
  stop(): Promise<void>;
};

/** 子进程仅继承运行工具需要的环境，不传递业务密钥、代理或 Node 注入参数。 */
export function previewProcessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'LANG',
    'LC_ALL',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

/** 启动固定脚本，限制日志与 Node 堆；停止时回收整个进程组并等待退出。 */
export function startPreviewProcess(
  script: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): LocalPreviewProcess {
  const child = spawn(process.execPath, ['--max-old-space-size=512', script, ...args], {
    cwd: options.cwd,
    env: previewProcessEnv(options.env),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let running = true;
  let stdout = '';
  let stderr = '';
  let error: Error | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-32768);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-32768);
  });
  child.on('error', (value) => {
    error = value;
  });
  /** POSIX 负 pid 指向整组，确保 esbuild 等后代也会被停止。 */
  const kill = () => {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (value) {
      if ((value as NodeJS.ErrnoException).code !== 'ESRCH') throw value;
    }
  };
  const parentExit = () => {
    try {
      kill();
    } catch {}
  };
  process.once('exit', parentExit);
  /** 主入口退出时立刻终止同组后代，避免后代持有管道使 close 一直等待。 */
  child.once('exit', () => {
    running = false;
    parentExit();
  });
  const exited: LocalPreviewProcess['exited'] = new Promise((resolve) => {
    child.once('close', (code) => {
      running = false;
      process.removeListener('exit', parentExit);
      /** 清除可能在编译入口退出后仍存活的辅助进程。 */
      parentExit();
      resolve({ code, stdout, stderr, ...(error ? { error } : {}) });
    });
  });
  return {
    get running() {
      return running;
    },
    exited,
    async stop() {
      kill();
      await exited;
    },
  };
}
