import { findOrderedRows } from '../utils/orderedRead';
import { createMessageService } from '../session/messages';
import { automaticRecoveryPlan } from './automaticRecovery';
import type { D2cRun } from '@/models/D2cRun';
import type { D2cSession } from '@/models/D2cSession';
import { Op } from 'sequelize';
import { createMessageQueueService } from '../session/queue';
import type { PreviewService } from '../preview/service';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import type { D2cRuntimeConfig } from '@/config/d2c';
import type { StorageFileClient } from '@/hooks/tools/storage';
import type { ResourceBundleStore } from '../workspace/resources';
import { createRunLeases } from './leases';
import { executeGenerationRun } from './execute';
import { diagnoseRunFailure, RunExecutionError, type RunFailureReport } from './errors';

/**
 * 创建后台消费者，周期扫描 MySQL 排队轮次并执行已取得租约的任务。
 * 内存 Map 仅跟踪本实例取消句柄和完成 Promise；全实例并发资格由数据库事务裁定。
 *
 * @param options 配置读取、租约存储、执行依赖及固定错误报告回调。
 * @returns 可幂等启动与关闭的 Worker；创建时不会立即扫描。
 */
export function createGenerationWorker(options: {
  mysql: Sequelize;
  preview?: PreviewService;
  readConfig: () => D2cRuntimeConfig;
  store: Pick<ResourceBundleStore, 'load'>;
  binary: StorageFileClient;
  proxyUrl: string;
  notify: (id: string, seq: number) => void;
  report: (message: string, details?: RunFailureReport) => void;
  execute?: typeof executeGenerationRun;
}) {
  const id = randomUUID();
  const messageQueue = createMessageQueueService(options.mysql, options);
  const messages = createMessageService(options.mysql, options);
  let recoveryCursor = '';
  let lastAutomaticRecovery = 0;
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closed = false,
    started = false,
    warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickTask: Promise<void> = Promise.resolve();
  let lastRecovery = 0;

  /** 空闲扫描异常限频报告；只传固定分类和白名单元数据，不记录原始异常。 */
  function report(error?: unknown) {
    if (!warned) {
      warned = true;
      log('D2C 后台扫描失败', diagnoseRunFailure(error, 'PREPARATION_FAILED'));
    }
  }
  /** 日志失败不影响任务结算；每个执行失败都独立上报，不受扫描限频标记影响。 */
  function log(message: string, details: RunFailureReport) {
    try {
      options.report(message, details);
    } catch {
      /** 日志后端不可用时，已持久化的公开诊断仍能通过时间线读取。 */
    }
  }
  /** 分页查找基础设施中断；资格在继续事务内重新校验，旧owner不能写入新轮次。 */
  async function recoverAutomatically() {
    const rows = await findOrderedRows(options.mysql.models.D2cRun as typeof D2cRun, 'runId', {
      where: {
        status: 'interrupted',
        stopRequested: false,
        cancelRequested: false,
        ...(recoveryCursor ? { runId: { [Op.gt]: recoveryCursor } } : {}),
      },
      order: [['runId', 'ASC']],
      limit: 20,
    });
    recoveryCursor = rows.length === 20 ? rows.at(-1)!.runId! : '';
    for (const run of rows) {
      if (closed || !run.runId || !run.sessionId || !automaticRecoveryPlan(run)) continue;
      const session = await (options.mysql.models.D2cSession as typeof D2cSession).findOne({
        where: { sessionId: run.sessionId },
      });
      if (!session || session.activeRunId !== run.runId) continue;
      const userId = run.requestedUserId ?? session.createdUserId;
      if (!userId) continue;
      try {
        await messages.automaticallyResume(userId, run.sessionId, run.runId);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status !== 404 && status !== 409 && status !== 403) report(error);
      }
    }
  }

  /**
   * 每轮读取当前配置，按租期节流回收过期任务，再按本地空槽扫描有限候选。
   * 扫描及领取串行进行，已领取任务异步并行运行；下次扫描等本次扫描收尾后安排。
   */
  async function tick() {
    let delay = 5000;
    try {
      const config = options.readConfig();
      delay = config.d2c.execution.pollIntervalMs;
      const leases = createRunLeases(options.mysql, {
        leaseMs: config.d2c.execution.leaseMs,
        concurrency: config.d2c.execution.concurrency,
        notify: options.notify,
      });
      if (Date.now() - lastRecovery >= config.d2c.execution.leaseMs) {
        lastRecovery = Date.now();
        try {
          await leases.recoverExpired(20, (runId, error) =>
            log('D2C 过期轮次回收遇到数据库锁', {
              ...diagnoseRunFailure(error, 'STORAGE_FAILED', { stage: 'storage' }),
              runId,
            }),
          );
        } catch (error) {
          /** 回收故障独立节流；本轮仍可领取其他已排队且通过准入检查的任务。 */
          report(error);
        }
      }
      if (closed) return;
      if (Date.now() - lastAutomaticRecovery >= 5000) {
        lastAutomaticRecovery = Date.now();
        try {
          await recoverAutomatically();
        } catch (error) {
          report(error);
        }
      }
      try {
        await messageQueue.promote();
      } catch (error) {
        /** Queue discovery failure must not block already durable Runs in other sessions. */
        report(error);
      }
      /** 本地空槽只缩小扫描量；候选可能被其他实例领取，claim 仍须校验全局配额。 */
      const slots = config.d2c.execution.concurrency - active.size;
      if (slots <= 0) return;
      for (const runId of await leases.pending(Math.min(100, slots * 2))) {
        if (closed || active.size >= config.d2c.execution.concurrency) break;
        if (active.has(runId)) continue;
        const lease = await leases.claim(runId, id);
        if (!lease) continue;
        const controller = new AbortController();
        if (closed) controller.abort();
        /** 不等待单轮执行完成，以便填满并发槽；失败结算也失败时交给租约过期恢复。 */
        const done = Promise.resolve()
          .then(() =>
            (options.execute ?? executeGenerationRun)({
              mysql: options.mysql,
              preview: options.preview,
              leases,
              lease,
              config,
              store: options.store,
              binary: options.binary,
              proxyUrl: options.proxyUrl,
              signal: controller.signal,
              notify: options.notify,
            }),
          )
          .catch(async (error: unknown) => {
            const original = diagnoseRunFailure(error);
            /** 单轮时限仍终止执行；保留超时分类，等待用户沿既有恢复流程继续。 */
            const timedOut = original.failure.code === 'RUN_TIMEOUT';
            const interrupted =
              timedOut ||
              original.failure.code === 'MODEL_REQUEST_LIMIT' ||
              original.failure.code === 'DELIVERY_INCOMPLETE' ||
              controller.signal.aborted ||
              original.failure.code === 'WORKER_INTERRUPTED' ||
              ['NETWORK_TIMEOUT', 'NETWORK_UNAVAILABLE', 'MODEL_RATE_LIMITED'].includes(
                original.failure.code,
              );
            const details =
              controller.signal.aborted && !timedOut
                ? diagnoseRunFailure(
                    new RunExecutionError('WORKER_INTERRUPTED', { stage: 'worker' }, error),
                  )
                : original;
            details.runId = lease.runId;
            details.sessionId = lease.sessionId;
            if (timedOut) log('D2C 后台执行超时中断', details);
            if (original.failure.code === 'MODEL_REQUEST_LIMIT')
              log('D2C 本轮模型请求达到上限', details);
            if (!interrupted) log('D2C 后台执行失败', details);
            try {
              await leases.settle(lease, interrupted ? 'interrupted' : 'failed', details.failure);
            } catch (settlementError) {
              const failed = diagnoseRunFailure(settlementError, 'STORAGE_FAILED', {
                stage: 'storage',
              });
              log('D2C 失败状态保存失败', {
                ...failed,
                runId: lease.runId,
                sessionId: lease.sessionId,
              });
            }
          })
          .finally(() => active.delete(runId));
        active.set(runId, { controller, done });
      }
    } catch (error) {
      report(error);
    } finally {
      if (!closed)
        timer = setTimeout(() => {
          tickTask = tick();
        }, delay);
    }
  }
  return {
    /** 启动不等待模型完成，HTTP 和浏览器断开不控制后台生命周期。 */
    start() {
      if (started || closed) return;
      started = true;
      tickTask = tick();
    },
    /** 先停止领取，再中止 SDK 与脚本，等待当前执行释放临时目录和数据库租约。 */
    async close() {
      closed = true;
      clearTimeout(timer);
      for (const run of active.values()) run.controller.abort();
      /** 扫描可能正在领取，等待其退出后再中止一次，覆盖关闭期间才加入 Map 的任务。 */
      await tickTask;
      for (const run of active.values()) run.controller.abort();
      await Promise.allSettled([...active.values()].map((run) => run.done));
    },
  };
}
