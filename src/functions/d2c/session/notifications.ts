export type TimelineHint = { sessionId: string; seq: number };
export type TimelineTransport = {
  publish(hint: TimelineHint): Promise<void>;
  close(): Promise<void>;
};

/** 只允许无正文的唤醒提示；提示不构成已鉴权事件，也不替代数据库游标。 */
function parseHint(value: unknown): TimelineHint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hint = value as Record<string, unknown>;
  if (
    Object.keys(hint).length !== 2 ||
    typeof hint.sessionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(hint.sessionId) ||
    !Number.isSafeInteger(hint.seq) ||
    Number(hint.seq) < 1 ||
    Number(hint.seq) > 4294967294
  )
    return null;
  return { sessionId: hint.sessionId, seq: Number(hint.seq) };
}

/**
 * 创建会话级唤醒总线：本地广播同步触发，可选辅助传输跨实例发布提示。
 * 内存仅保存活跃连接回调；提示只含 sessionId/seq，事件正文和消费进度均以 MySQL 为准。
 * @returns 启停、提交后发布和订阅接口；辅助连接不可用时保留本地通知与数据库兜底。
 */
export function createTimelineNotifications(
  options: {
    connect?: (
      receive: (value: unknown) => void,
      signal: AbortSignal,
    ) => Promise<TimelineTransport>;
    onUnavailable?: () => void;
  } = {},
) {
  const listeners = new Map<string, Set<(seq: number) => void>>();
  const controller = new AbortController();
  let transport: TimelineTransport | undefined;
  let starting: Promise<void> | undefined;
  let warned = false;

  /** 降级仅上报一次固定警告，不能泄露连接地址、消息或凭据。 */
  function unavailable() {
    if (warned || controller.signal.aborted) return;
    warned = true;
    try {
      options.onUnavailable?.();
    } catch {
      /** 诊断输出不影响已提交业务。 */
    }
  }

  /** 同一会话内广播序号；重复、过期提示由每个订阅的数据库 cursor 忽略。 */
  function receive(value: unknown) {
    if (controller.signal.aborted) return;
    const hint = parseHint(value);
    if (!hint) return;
    for (const wake of listeners.get(hint.sessionId) ?? []) {
      try {
        wake(hint.seq);
      } catch {
        /** 一个失效连接不能阻塞其他订阅。 */
      }
    }
  }

  return {
    /** 通知连接后台建立；服务不因辅助通知不可用而阻塞启动。 */
    start() {
      if (starting || !options.connect || controller.signal.aborted) return;
      starting = Promise.resolve()
        .then(() => options.connect!(receive, controller.signal))
        .then(async (value) => {
          if (controller.signal.aborted) await value.close();
          else transport = value;
        })
        .catch(unavailable);
    },
    /**
     * 事务提交后先本地唤醒，再异步跨实例发布；非法提示或已关闭服务直接忽略。
     * 不等待外部发布成功，失败只报告降级，由订阅端低频数据库补查兜底。
     */
    publish(sessionId: string, seq: number) {
      const hint = parseHint({ sessionId, seq });
      if (!hint || controller.signal.aborted) return;
      receive(hint);
      if (transport)
        void Promise.resolve()
          .then(() => transport!.publish(hint))
          .catch(unavailable);
    },
    /** 仅注册唤醒函数，取消后立即释放会话槽位。 */
    subscribe(sessionId: string, wake: (seq: number) => void) {
      if (controller.signal.aborted) return () => {};
      const group = listeners.get(sessionId) ?? new Set<(seq: number) => void>();
      group.add(wake);
      listeners.set(sessionId, group);
      return () => {
        group.delete(wake);
        if (!group.size) listeners.delete(sessionId);
      };
    },
    /** 关闭由本模块拥有的辅助连接；不触碰应用普通 Redis 客户端。 */
    async close() {
      controller.abort();
      listeners.clear();
      if (transport) await transport.close().catch(() => {});
      transport = undefined;
    },
  };
}

export type TimelineNotifications = ReturnType<typeof createTimelineNotifications>;

/**
 * 为一条 SSE 连接登记唤醒回调，须在首次读库前创建，覆盖补读到等待之间的通知窗口。
 * 仅暂存最大提示序号，不保存正文；每次等待消费提示，数据库 cursor 仍由实际事件推进。
 * @returns 单连接串行使用的 wait/close；取消只释放本连接，不影响后台执行或其他订阅。
 */
export function createTimelineWakeup(
  notifications: TimelineNotifications,
  sessionId: string,
  signal: AbortSignal,
) {
  let hint = 0;
  let closed = false;
  let waiting: { cursor: number; done: (notified: boolean) => void } | undefined;
  const unsubscribe = notifications.subscribe(sessionId, (seq) => {
    /** 未等待时合并提示，正在等待且提示领先 cursor 时立即唤醒并消费该提示。 */
    hint = Math.max(hint, seq);
    if (waiting && seq > waiting.cursor) {
      hint = 0;
      waiting.done(true);
    }
  });
  return {
    /**
     * 等待领先 cursor 的提示或超时；已有提示立即消费，虚高序号也不会永久触发补读。
     * @returns true 表示通知触发，false 表示超时、取消或关闭；两者均不承诺存在新事件。
     */
    wait(cursor: number, ms: number) {
      if (signal.aborted || closed) return Promise.resolve(false);
      const notified = hint > cursor;
      hint = 0;
      if (notified) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        /** 通知、超时、断开均释放当前等待，不保留事件或源码。 */
        const done = (value: boolean) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          waiting = undefined;
          resolve(value);
        };
        /** 断开仅取消本连接等待。 */
        const abort = () => done(false);
        const timer = setTimeout(() => done(false), Math.max(0, ms));
        waiting = { cursor, done };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) done(false);
      });
    },
    /** 请求结束立即移除回调与计时器。 */
    close() {
      closed = true;
      unsubscribe();
      waiting?.done(false);
    },
  };
}

export type TimelineWakeup = ReturnType<typeof createTimelineWakeup>;
