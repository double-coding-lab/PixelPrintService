import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 并行监听前端构建与后端源码；退出时回收两个监听器及其子进程。 */
export async function runDev(
  commands = [
    ['node_modules/vite/bin/vite.js', 'build', '--watch'],
    ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/index.ts'],
  ],
) {
  const children = new Set();
  let stopping = false;
  let result = 0;
  let deadline;
  let finish;
  const completed = new Promise((resolve) => {
    finish = resolve;
  });

  /** POSIX 进程组包含 tsx 启动的应用；Windows 回收直接子进程。 */
  function signal(child, value) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error('[dev] 无法停止监听进程');
    }
  }

  /** 给应用留出关闭数据库与 Worker 的时间，超时才强制清理。 */
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    result = code;
    for (const child of children) signal(child, 'SIGTERM');
    deadline = setTimeout(() => {
      result = 1;
      for (const child of children) signal(child, 'SIGKILL');
    }, 12000);
    deadline.unref();
    if (!children.size) finish();
  }

  const interrupt = () => stop();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  for (const args of commands) {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    children.add(child);
    child.once('error', () => {
      console.error('[dev] 启动监听器失败');
      stop(1);
    });
    child.once('close', (code) => {
      signal(child, 'SIGTERM');
      children.delete(child);
      if (!stopping) stop(code ?? 1);
      if (!children.size) finish();
    });
  }
  await completed;
  clearTimeout(deadline);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('[dev] 前端保存后自动构建；刷新浏览器即可加载，后端源码继续自动重启。');
  process.exitCode = await runDev();
}
