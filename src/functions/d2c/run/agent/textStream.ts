import { randomUUID } from 'node:crypto';

/** 仅供页面展示的累计快照；思考和正式正文分开，完整历史单独保存。 */
export type AgentTextSnapshot = {
  streamId: string;
  text: string;
  status: 'streaming' | 'interrupted' | 'discarded' | 'completed';
  channel?: 'reasoning';
};

/** 保留最长凭据表示的尾部，完整命中先脱敏，跨分片的凭据前缀暂不公开。 */
export function redactPartialText(
  text: string,
  secrets: Iterable<string>,
  redact: (value: string) => string,
) {
  let tail = 0;
  for (const secret of secrets)
    tail = Math.max(
      tail,
      secret.length,
      JSON.stringify(secret).slice(1, -1).length,
      encodeURIComponent(secret).length,
    );
  const safe = redact(text);
  return safe.slice(0, Math.max(0, safe.length - tail));
}

/**
 * 合并主模型文字并限制持久化频率，单个模型请求对应一个稳定展示标识。
 * 思考使用独立通道，不保存工具参数；关闭请求后忽略晚到的流式块。
 */
export function createAgentTextStream(options: {
  emit: (snapshot: AgentTextSnapshot) => Promise<void>;
  sanitize: (text: string) => string;
  channel?: 'reasoning';
  sanitizeFinal?: (text: string) => string;
  intervalMs?: number;
  now?: () => number;
}) {
  const streams = new Map<string, { text: string; visible: string; at: number; closed: boolean }>();
  const now = options.now ?? Date.now;
  let queue = Promise.resolve();
  /** 持久化顺序与消息顺序一致，失败沿原 Promise 返回，不吞掉存储异常。 */
  function send(snapshot: AgentTextSnapshot) {
    queue = queue.then(() =>
      options.emit({ ...snapshot, ...(options.channel ? { channel: options.channel } : {}) }),
    );
    return queue;
  }
  return {
    /** 每个根模型或子模型请求独立创建；摘要不创建展示流。 */
    open(id: string = randomUUID()) {
      streams.set(id, { text: '', visible: '', at: -Infinity, closed: false });
      return id;
    },
    /** 输入必须为框架消息中的文本块；按累计快照发送，补读无需依赖前一个分片。 */
    async append(id: string, text: string) {
      const stream = streams.get(id);
      if (!stream || stream.closed || !text) return;
      stream.text = (stream.text + text).slice(0, 65536);
      if (now() - stream.at < (options.intervalMs ?? 1000)) return;
      const safe = options.sanitize(stream.text).slice(0, 65536);
      if (!safe || safe === stream.visible) return;
      stream.visible = safe;
      stream.at = now();
      await send({ streamId: id, text: safe, status: 'streaming' });
    },
    /** 封口并排空在途快照；无效正文清除，思考保留独立完成或中断快照。 */
    async close(id: string, discarded = false, finalText?: string) {
      const stream = streams.get(id);
      if (!stream || stream.closed) return;
      stream.closed = true;
      if (options.channel === 'reasoning') {
        const text =
          finalText !== undefined
            ? (options.sanitizeFinal ?? options.sanitize)(finalText).slice(0, 65536)
            : stream.visible;
        if (text)
          await send({ streamId: id, text, status: discarded ? 'interrupted' : 'completed' });
      }
      stream.text = '';
      if (!options.channel && discarded && stream.visible)
        await send({ streamId: id, text: '', status: 'discarded' });
      await queue;
    },
    /** 失败或停止时保留已公开部分并结束生成状态，不把半条消息送回模型历史。 */
    async interrupt() {
      for (const [streamId, stream] of streams) {
        if (stream.closed) continue;
        stream.closed = true;
        stream.text = '';
        if (stream.visible) await send({ streamId, text: stream.visible, status: 'interrupted' });
      }
      await queue;
    },
  };
}
