import type { FastifyReply } from 'fastify';
import type { SessionService } from './service';
import type { TimelineWakeup } from './notifications';

export type TimelineTiming = { fallbackMs: number; heartbeatMs: number; lifetimeMs: number };

/**
 * 写入一个 SSE 块；触发背压时等待 drain 或订阅取消，避免持续向缓冲区堆积。
 * 调用方通过响应 close 中止 signal，使断开连接也能释放 drain 监听和等待。
 */
async function write(reply: FastifyReply, chunk: string, signal: AbortSignal) {
  if (signal.aborted || reply.raw.destroyed) return;
  if (reply.raw.write(chunk)) return;
  await new Promise<void>((resolve) => {
    /** 流排空或连接关闭后释放全部监听。 */
    const done = () => {
      reply.raw.off('drain', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    reply.raw.once('drain', done);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/**
 * 将已鉴权首页及后续数据库事件按 seq 输出为 SSE，通知仅用于提前唤醒补读。
 * 追赶分页不等待通知；追平后按通知或低频兜底读库，独立心跳保持连接活跃。
 * @param first 由调用方鉴权并取得的首页，wakeup 须在该次查询前注册以覆盖通知窗口。
 * @param controller 仅控制本条订阅，断开或寿命到期不会中止后台 Agent。
 * @param timing 数据库兜底、SSE 心跳及连接寿命间隔，单位均为毫秒。
 * @returns 连接关闭并释放唤醒句柄后完成；读取异常只发送固定 stream_error。
 */
export async function followTimeline(
  reply: FastifyReply,
  service: SessionService,
  userId: string,
  sessionId: string,
  first: Awaited<ReturnType<SessionService['timeline']>>,
  controller: AbortController,
  wakeup: TimelineWakeup,
  timing: TimelineTiming = { fallbackMs: 15000, heartbeatMs: 15000, lifetimeMs: 60000 },
) {
  const { signal } = controller;
  /** 响应关闭只终止本订阅，永远不把该 signal 传给 Agent。 */
  const close = () => controller.abort();
  reply.raw.once('close', close);
  /** 接管原始响应前保留既有头，关闭代理缓冲及缓存，使事件可及时送达浏览器。 */
  const headers = reply.getHeaders();
  reply.hijack();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      reply.raw.setHeader(name, Array.isArray(value) ? value : String(value));
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  /** 首屏有事件时从首条之前开始，空页沿用 nextSeq；后续 cursor 随已写入事件推进。 */
  let page = first,
    cursor = first.entries[0]?.seq ? first.entries[0].seq - 1 : first.nextSeq;
  const started = Date.now();
  let heartbeatAt = started;
  let readAt = started;
  try {
    await write(reply, ': connected\n\n', signal);
    while (!signal.aborted && Date.now() - started < timing.lifetimeMs) {
      for (const entry of page.entries) {
        if (signal.aborted) break;
        const kind =
          typeof entry.kind === 'string' && /^[a-z_]{1,64}$/.test(entry.kind)
            ? entry.kind
            : 'message';
        await write(
          reply,
          `id: ${entry.seq}\nevent: ${kind}\ndata: ${JSON.stringify(entry)}\n\n`,
          signal,
        );
        cursor = entry.seq;
      }
      if (signal.aborted) break;
      if (!page.hasMore) {
        /** 等待最近的兜底读库、心跳或连接截止时间；通知到达可提前结束等待。 */
        const delay =
          Math.min(
            readAt + timing.fallbackMs,
            heartbeatAt + timing.heartbeatMs,
            started + timing.lifetimeMs,
          ) - Date.now();
        const notified = await wakeup.wait(cursor!, delay);
        if (signal.aborted || Date.now() - started >= timing.lifetimeMs) break;
        if (Date.now() - heartbeatAt >= timing.heartbeatMs) {
          await write(reply, ': heartbeat\n\n', signal);
          heartbeatAt = Date.now();
        }
        /** 仅心跳到点时不额外查询数据库，避免心跳频率变成轮询频率。 */
        if (!notified && Date.now() - readAt < timing.fallbackMs) {
          page = { entries: [], nextSeq: cursor!, hasMore: false };
          continue;
        }
      }
      /** 补读始终经过会话服务归属检查，提示中的 seq 不能直接推进消费游标。 */
      page = await service.timeline(userId, sessionId, cursor!, 100);
      readAt = Date.now();
    }
  } catch {
    if (!signal.aborted)
      await write(
        reply,
        'event: stream_error\ndata: {"reason":"TIMELINE_UNAVAILABLE"}\n\n',
        signal,
      );
  } finally {
    controller.abort();
    wakeup.close();
    reply.raw.off('close', close);
    if (!reply.raw.destroyed) reply.raw.end();
  }
}
