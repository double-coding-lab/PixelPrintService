import { setTimeout } from 'node:timers/promises';
import type { Sequelize, Transaction } from 'sequelize';
import { databaseDiagnostics } from './databaseDiagnostics';

export type DeadlockRetry = { retryDeadlocks?: boolean; signal?: AbortSignal };

/**
 * 仅为显式声明可重放的数据库回调重试死锁，每次都建立新事务。
 * 回调不得调用模型、上传文件或修改事务外状态；提交成功后的通知异常不能重放。
 */
export async function deadlockTransaction<T>(
  mysql: Sequelize,
  action: (transaction: Transaction) => Promise<T>,
  options: DeadlockRetry = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let active: Transaction | undefined;
    try {
      return await mysql.transaction(async (transaction) => {
        active = transaction;
        options.signal?.throwIfAborted();
        const result = await action(transaction);
        options.signal?.throwIfAborted();
        return result;
      });
    } catch (error) {
      if (
        !options.retryDeadlocks ||
        attempt >= 2 ||
        (active as (Transaction & { finished?: string }) | undefined)?.finished !== 'rollback' ||
        databaseDiagnostics(error).databaseCode !== 'ER_LOCK_DEADLOCK'
      )
        throw error;
      // 已等待 managed transaction 完成回滚；短退避加入抖动，最多重试两次。
      options.signal?.throwIfAborted();
      await setTimeout(25 * 2 ** attempt + Math.floor(Math.random() * 25), undefined, {
        signal: options.signal,
      });
    }
  }
}
