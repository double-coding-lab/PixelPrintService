import { useCallback, useEffect, useRef, useState } from 'react';
import { data, errorMessage, id } from './api';

export type QueuedMessage = {
  queueId: string;
  clientRequestId: string;
  content: string;
  attachmentIds?: string[];
  createdAt: string;
  status: 'queued' | 'guidance_pending';
};
export type QueueInput = { clientRequestId: string; content: string; attachmentIds?: string[] };

/** 队列由服务端持久化；首次进入及事件通知后补读，旧会话响应不写回新会话。 */
export function useMessageQueue(sessionId: string, revision: number) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const current = useRef(sessionId);
  current.current = sessionId;
  const mutation = useRef(false);
  const path = `/sessions/${id(sessionId)}/message-queue`;
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    setItems([]);
    setError('');
    setPending(false);
    mutation.current = false;
  }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    data<{ items: QueuedMessage[] }>(path, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setItems(result.items);
        setError('');
      },
      (reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [path, revision, reload]);

  /** 写入操作串行，失败保留输入；无论响应是否确定都重新补读服务端真值。 */
  async function write(url: string, init: RequestInit) {
    if (mutation.current) throw new Error('消息队列正在更新，请稍后重试');
    mutation.current = true;
    setPending(true);
    setError('');
    try {
      await data(url, init);
    } catch (reason) {
      if (current.current === sessionId) setError(errorMessage(reason));
      throw reason;
    } finally {
      if (current.current === sessionId) {
        mutation.current = false;
        setPending(false);
        refresh();
      }
    }
  }
  return {
    items,
    pending,
    error,
    refresh,
    submit: (input: QueueInput, mode: 'queue' | 'guidance') =>
      write(path, { method: 'POST', body: JSON.stringify({ ...input, mode }) }),
    remove: (queueId: string) => write(`${path}/${id(queueId)}`, { method: 'DELETE' }),
    sendNow: (queueId: string) =>
      write(`${path}/${id(queueId)}/send-now`, { method: 'POST', body: '{}' }),
  };
}
