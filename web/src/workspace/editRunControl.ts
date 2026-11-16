import { data } from './api';

type RunState = { activeRunId?: string | null; activeRunStatus?: string | null };

/** 等待协作停止真正释放租约；超时保留编辑副本，不越过服务端写入保护。 */
export async function pauseForEdit(
  request: typeof data,
  root: string,
  signal: AbortSignal,
  onWaiting: () => void,
) {
  let session = await request<RunState>(root, { signal });
  const runId = session.activeRunId;
  if (!runId || !['running', 'stopping'].includes(session.activeRunStatus ?? '')) return null;
  const initiated = session.activeRunStatus === 'running';
  onWaiting();
  if (initiated)
    await request(`${root}/stop`, {
      method: 'POST',
      body: JSON.stringify({ runId }),
      signal,
    });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('应用操作已取消');
    session = await request<RunState>(root, { signal });
    if (!session.activeRunId) return null;
    if (session.activeRunId !== runId)
      throw new Error('当前执行轮次已改变，编辑副本已保留，请重试');
    if (session.activeRunStatus === 'interrupted') return initiated ? runId : null;
    if (session.activeRunStatus === 'waiting_input') return null;
    await new Promise<void>((resolve, reject) => {
      /** 请求取消时同步清理等待计时器。 */
      const abort = () => {
        clearTimeout(timer);
        reject(new Error('应用操作已取消'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, 300);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener('abort', abort);
        abort();
      }
    });
  }
  throw new Error('等待 Agent 暂停超时；副本已保留，请稍后重试应用');
}
