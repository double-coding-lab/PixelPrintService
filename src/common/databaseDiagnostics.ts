import {
  databaseErrorCodes,
  databaseErrorTypes,
  databaseOperations,
  type FailureDetails,
} from '../shared/failureDetails';

const databaseCodes = new Set<string>(databaseErrorCodes);
const databaseTypes = new Set<string>(databaseErrorTypes);
const operations = new Set<string>(databaseOperations);
type DatabaseDetails = Pick<
  FailureDetails,
  | 'databaseCode'
  | 'databaseErrno'
  | 'databaseSqlState'
  | 'databaseErrorType'
  | 'databaseOperation'
  | 'databaseTransactionPhase'
  | 'databaseAttempt'
>;
type DatabaseContext = Pick<
  DatabaseDetails,
  'databaseOperation' | 'databaseTransactionPhase' | 'databaseAttempt'
>;
const contexts = new WeakMap<object, DatabaseContext>();

/** 上下文留在内存弱引用中，保留驱动异常身份与 cause，不修改第三方 Error 对象。 */
export function annotateDatabaseError(error: unknown, context: DatabaseContext): unknown {
  const target =
    error && typeof error === 'object' ? error : new Error('数据库操作失败', { cause: error });
  const previous = contexts.get(target);
  contexts.set(target, {
    ...previous,
    ...context,
    // 外层提交回调不能覆盖内层具体查询；尝试次数采用当前事务实际标记。
    ...(previous?.databaseOperation ? { databaseOperation: previous.databaseOperation } : {}),
  });
  return target;
}

/** 只为实际执行的固定数据库步骤加定位，错误原样传播，重试策略保持原调用方控制。 */
export async function withDatabaseOperation<T>(
  operation: NonNullable<DatabaseDetails['databaseOperation']>,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw annotateDatabaseError(error, { databaseOperation: operation });
  }
}

/** 错误对象可能包含 getter 或代理；读取失败本身不能覆盖原来的业务异常。 */
function field(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** 只提取白名单元数据，有界遍历 ORM/cause/AggregateError 分支，不输出正文、SQL、绑定值。 */
export function databaseDiagnostics(error: unknown): DatabaseDetails {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const result: DatabaseDetails = {};
  let databaseScoped = false;
  let networkCode: DatabaseDetails['databaseCode'];
  for (let index = 0; index < pending.length && index < 24; index++) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const context = contexts.get(value);
    databaseScoped ||= !!(context?.databaseOperation || context?.databaseTransactionPhase);
    if (
      context?.databaseOperation &&
      operations.has(context.databaseOperation) &&
      (!result.databaseOperation || result.databaseOperation === 'lease.write')
    )
      result.databaseOperation = context.databaseOperation;
    if (
      context?.databaseTransactionPhase &&
      ['begin', 'action', 'commit'].includes(context.databaseTransactionPhase)
    )
      result.databaseTransactionPhase ??= context.databaseTransactionPhase;
    const attempt = context?.databaseAttempt;
    if (
      typeof attempt === 'number' &&
      Number.isSafeInteger(attempt) &&
      attempt >= 1 &&
      attempt <= 3
    )
      result.databaseAttempt ??= attempt;
    const code = field(value, 'code');
    if (
      typeof code === 'string' &&
      databaseCodes.has(code) &&
      code.startsWith('ER_') &&
      !result.databaseCode
    ) {
      result.databaseCode = code as DatabaseDetails['databaseCode'];
      // 明确驱动码优先采用同一错误节点的编号，避免拼接无关外层错误的元数据。
      delete result.databaseErrno;
      delete result.databaseSqlState;
    }
    if (typeof code === 'string' && databaseCodes.has(code) && !code.startsWith('ER_'))
      networkCode ??= code as DatabaseDetails['databaseCode'];
    const name = field(value, 'name');
    if (typeof name === 'string' && databaseTypes.has(name)) {
      result.databaseErrorType ??= name as DatabaseDetails['databaseErrorType'];
      databaseScoped = true;
    }
    const errno = field(value, 'errno');
    if (typeof errno === 'number' && Number.isSafeInteger(errno) && errno > 0 && errno <= 65535)
      result.databaseErrno ??= errno;
    const sqlState = field(value, 'sqlState');
    if (typeof sqlState === 'string' && /^[A-Z0-9]{5}$/.test(sqlState))
      result.databaseSqlState ??= sqlState;
    // 队列与聚合分支均有界，循环及任意多错误不会放大日志处理开销。
    const children = [field(value, 'cause'), field(value, 'parent'), field(value, 'original')];
    const errors = field(value, 'errors');
    try {
      if (Array.isArray(errors))
        for (let i = 0; i < Math.min(8, errors.length); i++)
          children.push(field(errors, String(i)));
    } catch {
      // 损坏的代理或数组 getter 不影响原错误的其余安全诊断。
    }
    for (const child of children)
      if (
        child &&
        typeof child === 'object' &&
        !seen.has(child) &&
        !pending.includes(child) &&
        pending.length < 96
      )
        pending.push(child);
  }
  // 同一个网络码也会出现在模型、Figma、对象存储中，须有数据库类型或操作证据才归属数据库。
  if (!result.databaseCode && databaseScoped && networkCode) result.databaseCode = networkCode;
  return result;
}
