import { assertArtifactPath, normalizeRelativePath } from '../../utils/paths';
import { toolIssue } from '../toolFeedback';

/** 限制同一 Run 的委派并发；排队时即预留精确权限，活动任务沿用共享取消信号。 */
export function createDelegationScheduler(options: { concurrency: number; signal: AbortSignal }) {
  const { concurrency, signal } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('concurrency must be a positive safe integer');
  const reserved = new Set<string>();
  const queue: Array<{ start: () => void; cancel: () => void }> = [];
  const cancellations = new WeakMap<Promise<unknown>, (reason: unknown) => void>();
  let active = 0;

  /** 非法或冲突路径保留可纠正反馈及委派上下文，不改写调用方的授权列表。 */
  function invalid(
    path?: string,
    detail = '路径必须是规范相对路径，且不能与其他任务的授权范围冲突。',
  ): never {
    const feedback = {
      code: 'INVALID_ARGUMENT',
      originalCode: 'INVALID_ARGUMENT',
      ...(path === undefined ? {} : { path: path.slice(0, 1024) }),
    };
    throw toolIssue(
      'INVALID_ARGUMENT',
      'VALIDATION_FAILED',
      { stage: 'tool', tool: 'delegate_agent', feedback },
      { path: feedback.path, detail },
    );
  }

  /** 仅文件级授权；父子路径无法同时作为文件，亦拒绝其权限交叉。 */
  function overlaps(left: string, right: string) {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }

  /** 按接收顺序启动空闲名额内的任务。 */
  function pump() {
    if (signal.aborted) return abortQueued();
    while (active < concurrency && queue.length) queue.shift()!.start();
    if (!queue.length) signal.removeEventListener('abort', abortQueued);
  }

  /** 一个共享监听器取消全部排队委派，避免随队列长度增加 signal 监听器。 */
  function abortQueued() {
    signal.removeEventListener('abort', abortQueued);
    for (const entry of queue.splice(0)) entry.cancel();
  }

  /**
   * 同步校验并预留文件或 UI 互斥目录；预留不授予写权限，角色权限由 childTools 校验。
   * 只读委派同样占并发名额。
   * 排队取消立即拒绝；已启动任务须由 action 监听共享 signal，结束后才释放名额及权限。
   */
  function schedule<T>(writePaths: string[], action: () => Promise<T>): Promise<T> {
    const paths = reserve(writePaths);
    let queuedEntry: (typeof queue)[number];
    let cancelPending!: (reason: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      /** 预留在成功、失败和排队取消后恰好释放一次。 */
      function release() {
        for (const path of paths) reserved.delete(path);
      }
      /** 排队项移除后释放权限，不提前释放活动任务的文件权限。 */
      function cancel() {
        cancelPending(signal.reason);
      }
      cancelPending = (reason: unknown) => {
        const index = queue.indexOf(queuedEntry);
        if (index >= 0) queue.splice(index, 1);
        release();
        reject(reason);
        if (!queue.length) signal.removeEventListener('abort', abortQueued);
      };
      /** 捕获同步抛错与异步拒绝，内部执行 Promise 永不产生未处理拒绝。 */
      async function execute() {
        try {
          signal.throwIfAborted();
          resolve(await action());
        } catch (error) {
          reject(error);
        } finally {
          active--;
          release();
          pump();
        }
      }
      /** 出队后只保留活动名额，取消由 action 的共享信号处理。 */
      function start() {
        active++;
        void execute();
      }
      queuedEntry = { start, cancel };
      queue.push(queuedEntry);
      if (queue.length === 1) signal.addEventListener('abort', abortQueued, { once: true });
      pump();
    });
    cancellations.set(pending, (reason) => {
      if (queue.includes(queuedEntry)) cancelPending(reason);
    });
    return pending;
  }

  /** 父工具仅校验路径与互斥，真实写权限和纠错说明仍由原工具校验；子委派保留产物边界。 */
  function validatePaths(writePaths: string[], parentOperation: boolean): void {
    signal.throwIfAborted();
    if (!Array.isArray(writePaths)) invalid();
    const paths: string[] = [];
    for (const value of writePaths) {
      if (typeof value !== 'string') invalid();
      try {
        if (
          Buffer.byteLength(value) > 1024 ||
          normalizeRelativePath(value) !== value ||
          (!parentOperation && assertArtifactPath(value) !== value)
        )
          invalid(value);
      } catch {
        invalid(value);
      }
      if ([...reserved, ...paths].some((other) => overlaps(value, other)))
        invalid(
          value,
          '该路径仍被子任务或当前并行操作占用。先wait_subagents收取相关任务结果，再编辑或检查同一区块；不要通过换路径绕过互斥。',
        );
      paths.push(value);
    }
  }

  /** 子委派预检查始终沿用严格产物边界，不接受执行清单。 */
  function assertAvailable(paths: string[]): void {
    validatePaths(paths, false);
  }

  /** 全部校验通过后原子预留，避免无效后缀留下部分权限。 */
  function reserve(paths: string[], parentOperation = false): string[] {
    validatePaths(paths, parentOperation);
    const snapshot = [...paths];
    for (const path of snapshot) reserved.add(path);
    return snapshot;
  }

  /** 父工具副作用仅预留路径互斥，含内部执行清单；权限仍由原工具拒绝，不占子 Agent 名额。 */
  function exclusive<T>(writePaths: string[], action: () => Promise<T>): Promise<T> {
    const paths = reserve(writePaths, true);
    return (async () => {
      try {
        signal.throwIfAborted();
        return await action();
      } finally {
        for (const path of paths) reserved.delete(path);
      }
    })();
  }

  return {
    schedule,
    exclusive,
    assertAvailable,
    /** 启动描述落盘失败时撤销尚未运行的委派；活动任务仍等待 action 退出。 */
    cancelQueued(pending: Promise<unknown>, reason: unknown): void {
      cancellations.get(pending)?.(reason);
    },
    /** 保留旧调用的异步拒绝语义；新调用用 schedule 获取同步权限反馈。 */
    async run<T>(paths: string[], action: () => Promise<T>): Promise<T> {
      return schedule(paths, action);
    },
  };
}
