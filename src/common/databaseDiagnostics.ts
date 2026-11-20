const databaseCodes = new Set([
  'ER_OUT_OF_SORTMEMORY',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_CON_COUNT_ERROR',
  'ER_BAD_FIELD_ERROR',
  'ER_NO_SUCH_TABLE',
  'ER_DATA_TOO_LONG',
  'ER_NET_PACKET_TOO_LARGE',
  'ER_DUP_ENTRY',
  'ER_DISK_FULL',
]);

/** 只提取数据库固定错误码，遍历 ORM 的 cause/parent/original，不输出 SQL、绑定值和消息。 */
export function databaseDiagnostics(error: unknown) {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let index = 0; index < pending.length && index < 24; index++) {
    const value = pending[index];
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const item = value as {
      code?: unknown;
      errno?: unknown;
      sqlState?: unknown;
      cause?: unknown;
      parent?: unknown;
      original?: unknown;
    };
    if (typeof item.code === 'string' && databaseCodes.has(item.code))
      return {
        databaseCode: item.code,
        ...(typeof item.errno === 'number' && Number.isSafeInteger(item.errno) && item.errno > 0
          ? { databaseErrno: item.errno }
          : {}),
        ...(typeof item.sqlState === 'string' && /^[A-Z0-9]{5}$/.test(item.sqlState)
          ? { databaseSqlState: item.sqlState }
          : {}),
      };
    pending.push(item.cause, item.parent, item.original);
  }
  return {};
}
