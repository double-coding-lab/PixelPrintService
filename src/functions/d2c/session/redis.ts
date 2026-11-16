import { createClient } from 'redis';
import { projectConfig } from '@/config/project';
import type { TimelineHint, TimelineTransport } from './notifications';

/** 发布/订阅只传游标提示，正文和补读仍以数据库为准。 */
export async function connectTimelineRedis(
  receive: (value: unknown) => void,
  signal: AbortSignal,
): Promise<TimelineTransport> {
  const publisher = createClient({
    url: projectConfig.redis.url,
    socket: { connectTimeout: 3000 },
  });
  const subscriber = publisher.duplicate();
  publisher.on('error', () => {});
  subscriber.on('error', () => {});
  const channel = 'pixelprint:d2c:timeline';
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', stop);
    for (const client of [publisher, subscriber]) {
      if (client.isOpen) client.destroy();
    }
  }
  function stop() {
    void close();
  }
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw new Error('订阅已关闭');
    await Promise.all([publisher.connect(), subscriber.connect()]);
    if (closed) throw new Error('订阅已关闭');
    await subscriber.subscribe(channel, (message) => {
      if (message.length > 256 || closed) return;
      try {
        receive(JSON.parse(message));
      } catch {
        /* 非法提示由数据库补读兜底。 */
      }
    });
    return {
      async publish(hint: TimelineHint) {
        if (!closed) await publisher.publish(channel, JSON.stringify(hint));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
