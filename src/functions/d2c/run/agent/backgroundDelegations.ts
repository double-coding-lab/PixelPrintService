import { toolIssue } from '../toolFeedback';
import type { createDelegationScheduler } from './delegationScheduler';

export type Job = {
  agentId: string;
  key: string;
  role: string;
  nodeId?: string;
  writePaths: string[];
};
export type Ack = {
  accepted: true;
  agentId: string;
  status: 'queued' | 'running' | 'completed';
};
export type BackgroundDelegationPersistence = {
  started?(): Promise<void>;
  settled(result: string): Promise<void>;
  observed(): Promise<void>;
};
type Entry = {
  job: Job;
  status: Ack['status'];
  result?: string;
  observed: boolean;
  active: boolean;
  observing?: Promise<void>;
  pendingStart?: Promise<Ack>;
  done: Promise<void>;
  persist: BackgroundDelegationPersistence;
};

/** 当前 Run 内的后台委派注册表；不创建 Worker、数据库或额外任务队列。 */
export function createBackgroundDelegations(options: {
  scheduler: ReturnType<typeof createDelegationScheduler>;
  signal: AbortSignal;
  onFatal(error: unknown): void;
}) {
  const { scheduler, signal, onFatal } = options;
  const entries = new Map<string, Entry>();
  const keys = new Map<string, Entry>();
  const pending = new Set<Promise<void>>();
  let failed = false;
  let fatalError: unknown;
  let wakeFatal!: () => void;
  const fatal = new Promise<void>((resolve) => {
    wakeFatal = resolve;
  });

  /** 原样保存首个运行异常；通知本身不能制造未处理的后台拒绝。 */
  function rejectFatal(error: unknown): void {
    if (failed) return;
    failed = true;
    fatalError = error;
    wakeFatal();
    try {
      void Promise.resolve(onFatal(error)).catch(() => {});
    } catch {
      /** 首个运行异常始终优先于通知回调的异常。 */
    }
  }

  /** 所有前台入口复用原始异常，不把 fatal 转成普通子任务结果。 */
  function assertHealthy(): void {
    if (failed) throw fatalError;
    signal.throwIfAborted();
  }

  /** 固定参数反馈用于未知 ID 或重复 agentId，不泄漏任务正文。 */
  function invalid(): never {
    throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
      stage: 'tool',
      tool: 'delegate_agent',
    });
  }

  /** 回执按当前状态生成；仅 settled 已保存后可显示 completed。 */
  function ack(entry: Entry): Ack {
    return { accepted: true, agentId: entry.job.agentId, status: entry.status };
  }

  /** 未观察任务保持幂等；启动落盘期间共享同一个回执 Promise。 */
  function lookup(key: string): Ack | Promise<Ack> | undefined {
    const entry = keys.get(key);
    if (!entry || entry.observed) return;
    return entry.pendingStart ?? ack(entry);
  }

  /**
   * 同步预留权限，再在并发槽外保存启动描述。子任务等待启动落盘 gate，
   * action 与结果落盘全部完成后才释放权限；排队任务也可立即取得启动回执。
   */
  function start(
    job: Job,
    reservations: string[],
    action: () => Promise<string>,
    persist: BackgroundDelegationPersistence,
  ): Promise<Ack> {
    assertHealthy();
    const previous = entries.get(job.agentId);
    if (previous && (previous.active || !previous.observed)) {
      if (previous.job.key !== job.key || previous.observed) invalid();
    }
    const existing = lookup(job.key);
    if (existing) {
      if (keys.get(job.key)!.job.agentId !== job.agentId) invalid();
      return Promise.resolve(existing);
    }
    let open!: () => void;
    let close!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      open = resolve;
      close = reject;
    });
    /** 排队取消可能使 action 永不读取 gate，仍须处理其拒绝。 */
    void gate.catch(() => {});
    let entry!: Entry;
    let running = false;
    const scheduled = scheduler.schedule(reservations, async () => {
      running = true;
      await gate;
      assertHealthy();
      entry.status = 'running';
      const result = await action();
      await persist.settled(result);
      entry.result = result;
      entry.status = 'completed';
    });
    /** 预留成功后才替换已消费的旧尝试；预留冲突时保留原有结果。 */
    if (previous) {
      entries.delete(job.agentId);
      if (keys.get(previous.job.key) === previous) keys.delete(previous.job.key);
    }
    entry = {
      job: { ...job, writePaths: [...job.writePaths] },
      status: running ? 'running' : 'queued',
      observed: false,
      active: true,
      done: Promise.resolve(),
      persist,
    };
    entries.set(job.agentId, entry);
    keys.set(job.key, entry);
    const execution = scheduled.catch(rejectFatal);
    const starting = Promise.resolve().then(async (): Promise<Ack> => {
      try {
        await persist.started?.();
        assertHealthy();
        open();
        return ack(entry);
      } catch (error) {
        rejectFatal(error);
        close(error);
        scheduler.cancelQueued(scheduled, error);
        entries.delete(job.agentId);
        if (keys.get(job.key) === entry) keys.delete(job.key);
        throw error;
      } finally {
        entry.pendingStart = undefined;
      }
    });
    entry.pendingStart = starting;
    const started = starting.then(
      () => {},
      () => {},
    );
    entry.done = Promise.all([execution, started]).then(() => {
      entry.active = false;
      pending.delete(entry.done);
    });
    pending.add(entry.done);
    return starting;
  }

  /** 注册已落盘但尚未被父 Agent 观察的结果，不再执行 action 或 settled。 */
  function restore(job: Job, result: string, persist: BackgroundDelegationPersistence): void {
    assertHealthy();
    if (lookup(job.key)) return;
    if (entries.has(job.agentId)) invalid();
    const entry: Entry = {
      job: { ...job, writePaths: [...job.writePaths] },
      status: 'completed',
      result,
      observed: false,
      active: false,
      done: Promise.resolve(),
      persist,
    };
    entries.set(job.agentId, entry);
    keys.set(job.key, entry);
  }

  /** 并行 wait 共用一次消费保存，保存失败保持未观察并中止 Run。 */
  function observe(entry: Entry): Promise<void> {
    if (entry.observed) return Promise.resolve();
    if (!entry.observing) {
      entry.observing = Promise.resolve()
        .then(() => entry.persist.observed())
        .then(() => {
          entry.observed = true;
        })
        .catch((error) => {
          rejectFatal(error);
          throw error;
        });
    }
    return entry.observing;
  }

  /** 省略或空 ID 列表选择全部；查询不消费，等待在结果与 observed 保存后返回。 */
  async function wait(agentIds?: string[], shouldWait = true) {
    assertHealthy();
    const selected =
      agentIds === undefined || agentIds.length === 0
        ? [...entries.values()]
        : [...new Set(agentIds)].map((id) => entries.get(id) ?? invalid());
    if (shouldWait) {
      await Promise.race([Promise.all(selected.map((entry) => entry.done)), fatal]);
      assertHealthy();
      await Promise.all(selected.map(observe));
      assertHealthy();
    }
    return {
      agents: selected.map((entry) => ({
        agentId: entry.job.agentId,
        status: entry.status,
        ...(entry.status === 'completed' ? { result: entry.result } : {}),
      })),
    };
  }

  return {
    start,
    lookup,
    restore,
    wait,
    rejectFatal,
    assertHealthy,
    /** 包括活动任务以及已完成但未观察的结果。 */
    hasUnobserved: () => [...entries.values()].some((entry) => !entry.observed),
    /** 启动描述和结果保存均属于活动生命周期。 */
    hasActive: () => [...entries.values()].some((entry) => entry.active),
    /** 停止时等待启动保存及所有已接受任务清理，再原样报告异常。 */
    async drain(): Promise<void> {
      await Promise.all([...pending]);
      if (failed) throw fatalError;
    },
  };
}
