import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  ConnectionAcquireTimeoutError,
  ConnectionError,
  DatabaseError,
  Sequelize,
  TimeoutError,
  Transaction,
} from 'sequelize';
import {
  annotateDatabaseError,
  databaseDiagnostics,
  withDatabaseOperation,
} from '../src/common/databaseDiagnostics';
import { deadlockTransaction } from '../src/common/deadlockTransaction';
import { databaseFailureSchema, readFailureDetails } from '../src/shared/failureDetails';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { SessionError } from '../src/functions/d2c/session/access';
import { sessionStore } from './helpers/sessionStore';

const operations = [
  'lease.lookup_run',
  'lease.lookup_session',
  'lease.lock_admission',
  'lease.count_active',
  'lease.lock_workspace',
  'lease.lock_session',
  'lease.lock_run',
  'lease.clock',
  'lease.renew',
  'lease.write',
] as const;
const phases = ['begin', 'action', 'commit'] as const;

/** 使用真实 Sequelize 错误类型和虚构驱动字段；不创建连接，不包含真实 SQL/凭据。 */
function driverError(code = 'ER_LOCK_DEADLOCK') {
  return new DatabaseError(
    Object.assign(new Error('PRIVATE_QUERY_AND_BINDING'), {
      code,
      errno: code === 'ER_LOCK_DEADLOCK' ? 1213 : 1146,
      sqlState: '40001',
      sql: 'PRIVATE_QUERY',
      parameters: ['PRIVATE_BINDING'],
    }),
  );
}

/** 返回真实抛出值，便于同时断言错误身份、类型和诊断。 */
async function rejected(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

/** 继承既有事务回滚与锁序 fixture；仅播种一个有效租约，不启动入队、模型或 Worker。 */
function leaseFixture() {
  const f = sessionStore();
  const time = 1700000000000;
  const lease = { runId: 'context-run', sessionId: 'context-session', owner: 'offline-worker' };
  f.tables.D2cSession.push({
    sessionId: lease.sessionId,
    workspaceId: 'workspace-a',
    activeRunId: lease.runId,
    timelineSeq: 0,
    fileRevision: 0,
  });
  f.tables.D2cRun.push({
    ...lease,
    leaseOwner: lease.owner,
    status: 'running',
    heartbeatAt: new Date(time - 1000),
    leaseExpiresAt: new Date(time + 60000),
    stopRequested: false,
    cancelRequested: false,
  });
  return { ...f, time, lease };
}

/** 使用已安装 Sequelize 的 managed transaction/commit/finally；只拦截连接与 SQL 边界。 */
function sequelizeFixture(t: TestContext) {
  const mysql = new Sequelize('offline', 'offline', 'offline', {
    dialect: 'mysql',
    logging: false,
    retry: { max: 0 },
  });
  t.after(() => mysql.close());
  const statements: string[] = [];
  let acquired = 0,
    destroyed = 0;
  t.mock.method(mysql.connectionManager, 'getConnection', async () => {
    acquired++;
    return {};
  });
  t.mock.method(mysql.connectionManager, 'releaseConnection', async () => {});
  t.mock.method(mysql.connectionManager, 'destroyConnection', async () => {
    destroyed++;
  });
  t.mock.method(mysql, 'query', async (sql: unknown) => {
    statements.push(String(sql));
    return [];
  });
  // Expected Sequelize cleanup warnings contain the synthetic error message; keep them local.
  t.mock.method(console, 'warn', () => {});
  return {
    mysql,
    queryInterface: mysql.getQueryInterface(),
    statements,
    acquired: () => acquired,
    destroyed: () => destroyed,
  };
}

test('driver errno and SQLSTATE survive independently of an allowlisted code and Sequelize type', () => {
  assert.deepEqual(databaseDiagnostics({ errno: 1038 }), { databaseErrno: 1038 });
  assert.deepEqual(databaseDiagnostics({ sqlState: 'HY001' }), { databaseSqlState: 'HY001' });
  assert.deepEqual(databaseDiagnostics({ code: 'PRIVATE_CODE', errno: 1038, sqlState: 'HY001' }), {
    databaseErrno: 1038,
    databaseSqlState: 'HY001',
  });
  assert.deepEqual(databaseDiagnostics(driverError()), {
    databaseCode: 'ER_LOCK_DEADLOCK',
    databaseErrno: 1213,
    databaseSqlState: '40001',
    databaseErrorType: 'SequelizeDatabaseError',
  });
  for (const error of [
    new ConnectionError(new Error('PRIVATE_CONNECTION')),
    new ConnectionAcquireTimeoutError(new Error('PRIVATE_POOL')),
    new TimeoutError(Object.assign(new Error('PRIVATE_TIMEOUT'), { sql: 'PRIVATE_QUERY' })),
  ])
    assert.equal(databaseDiagnostics(error).databaseErrorType, error.name);
});

test('network codes require Sequelize or explicit database-operation scope', async () => {
  const unscoped = new Error('PRIVATE_MODEL_OR_FIGMA', {
    cause: Object.assign(new Error('PRIVATE_NETWORK'), { code: 'ECONNRESET' }),
  });
  assert.deepEqual(databaseDiagnostics(unscoped), {});
  assert.equal(databaseDiagnostics(unscoped).databaseCode, undefined);
  const connection = new ConnectionError(
    Object.assign(new Error('PRIVATE_DATABASE_NETWORK'), {
      code: 'ECONNRESET',
    }),
  );
  assert.deepEqual(databaseDiagnostics(connection), {
    databaseErrorType: 'SequelizeConnectionError',
    databaseCode: 'ECONNRESET',
  });
  const actual = await rejected(() =>
    withDatabaseOperation('lease.clock', async () => {
      throw unscoped;
    }),
  );
  assert.equal(actual, unscoped);
  assert.deepEqual(databaseDiagnostics(actual), {
    databaseOperation: 'lease.clock',
    databaseCode: 'ECONNRESET',
  });
});

test('the first explicit ER driver code selects its own errno and SQLSTATE over unrelated outer metadata', () => {
  const error = Object.assign(new Error('PRIVATE_OUTER'), {
    code: 'PRIVATE_CODE',
    errno: 777,
    sqlState: 'HY001',
    parent: { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001', sql: 'PRIVATE_QUERY' },
    original: { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' },
  });
  assert.deepEqual(databaseDiagnostics(error), {
    databaseCode: 'ER_LOCK_DEADLOCK',
    databaseErrno: 1213,
    databaseSqlState: '40001',
  });
  assert.deepEqual(databaseDiagnostics({ cause: { errno: 1038 }, parent: { sqlState: 'HY001' } }), {
    databaseErrno: 1038,
    databaseSqlState: 'HY001',
  });
});

test('cause, parent, original and cyclic AggregateError graphs retain useful diagnostics without leaking fields', () => {
  const cause = annotateDatabaseError(new Error('PRIVATE_OUTER'), {
    databaseOperation: 'lease.lock_workspace',
    databaseTransactionPhase: 'action',
    databaseAttempt: 2,
  });
  const aggregate = new AggregateError([], 'PRIVATE_AGGREGATE', { cause });
  const branch = { parent: { original: driverError() }, cause: aggregate };
  aggregate.errors.push(aggregate, branch, branch);
  assert.deepEqual(databaseDiagnostics(aggregate), {
    databaseCode: 'ER_LOCK_DEADLOCK',
    databaseErrno: 1213,
    databaseSqlState: '40001',
    databaseErrorType: 'SequelizeDatabaseError',
    databaseOperation: 'lease.lock_workspace',
    databaseTransactionPhase: 'action',
    databaseAttempt: 2,
  });
  assert.doesNotMatch(
    JSON.stringify(databaseDiagnostics(aggregate)),
    /PRIVATE|message|stack|parameters|original|parent/,
  );
});

test('aggregate traversal is bounded and never serializes private error properties', () => {
  let visits = 0;
  const errors = Array.from({ length: 10000 }, () =>
    Object.defineProperty({}, 'cause', {
      get() {
        visits++;
        return null;
      },
    }),
  );
  const root = new AggregateError(errors, 'PRIVATE_AGGREGATE');
  for (const key of ['message', 'sql', 'parameters', 'stack', 'toJSON'])
    Object.defineProperty(root, key, {
      get() {
        assert.fail(`private field read: ${key}`);
      },
    });
  assert.deepEqual(databaseDiagnostics(root), {});
  assert.ok(visits > 0, 'must inspect AggregateError branches');
  assert.ok(visits <= 128, 'must stop before scanning the full aggregate');
  const cycle: { cause?: unknown; parent?: unknown; original?: unknown } = {};
  cycle.cause = cycle;
  cycle.parent = cycle;
  cycle.original = cycle;
  assert.deepEqual(databaseDiagnostics(cycle), {});
});

test('malicious diagnostics and context values are dropped; valid errno/SQLSTATE remain independently', () => {
  for (const errno of [-1, 0, 1.5, 65536, Infinity, '1213'])
    assert.deepEqual(databaseDiagnostics({ errno }), {});
  for (const sqlState of ['hy001', 'HY00', 'HY001\nSQL', 'PRIVATE_QUERY', 40001])
    assert.deepEqual(databaseDiagnostics({ sqlState }), {});
  const error = Object.assign(new Error('PRIVATE_MESSAGE'), {
    name: 'SequelizePRIVATE_QUERY',
    code: 'PRIVATE_CODE',
    errno: 1213,
    sqlState: '40001',
    sql: 'PRIVATE_QUERY',
    parameters: ['PRIVATE_BINDING'],
    databaseOperation: 'PRIVATE_QUERY',
  });
  annotateDatabaseError(error, {
    databaseOperation: 'PRIVATE_QUERY',
    databaseTransactionPhase: 'PRIVATE_QUERY',
    databaseAttempt: 99,
  } as unknown as Parameters<typeof annotateDatabaseError>[1]);
  assert.deepEqual(databaseDiagnostics(error), { databaseErrno: 1213, databaseSqlState: '40001' });
  assert.doesNotMatch(JSON.stringify(databaseDiagnostics(error)), /PRIVATE/);
});

test('operation wrappers preserve successful values and rejection identity, including frozen errors', async () => {
  const value = { unchanged: true };
  assert.equal(await withDatabaseOperation('lease.lookup_run', async () => value), value);
  for (const operation of operations) {
    const error = Object.freeze(driverError('ER_NO_SUCH_TABLE'));
    const actual = await rejected(() =>
      withDatabaseOperation(operation, async () => {
        throw error;
      }),
    );
    assert.equal(actual, error);
    assert.ok(actual instanceof DatabaseError);
    assert.equal(databaseDiagnostics(actual).databaseOperation, operation);
    assert.equal(databaseDiagnostics(actual).databaseCode, 'ER_NO_SUCH_TABLE');
  }
});

test('annotation returns the original error and every allowed context survives the shared schema', () => {
  for (const databaseTransactionPhase of phases)
    for (const databaseAttempt of [1, 2, 3]) {
      const error = driverError();
      const context = {
        databaseTransactionPhase,
        databaseAttempt,
        databaseOperation: 'lease.write' as const,
      };
      assert.equal(annotateDatabaseError(error, context), error);
      const projected = databaseDiagnostics(error);
      assert.deepEqual(projected, {
        databaseCode: 'ER_LOCK_DEADLOCK',
        databaseErrno: 1213,
        databaseSqlState: '40001',
        databaseErrorType: 'SequelizeDatabaseError',
        ...context,
      });
      assert.deepEqual(databaseFailureSchema.parse(projected), projected);
      assert.deepEqual(readFailureDetails(projected), projected);
    }
  const reused = driverError();
  annotateDatabaseError(reused, { databaseAttempt: 3 });
  assert.equal(databaseDiagnostics(reused).databaseAttempt, 3);
  assert.equal(annotateDatabaseError(reused, { databaseAttempt: 1 }), reused);
  assert.equal(databaseDiagnostics(reused).databaseAttempt, 1);
  const primitive = annotateDatabaseError('PRIVATE_QUERY', { databaseOperation: 'lease.clock' });
  assert.ok(primitive instanceof Error);
  assert.doesNotMatch(primitive.message, /PRIVATE_QUERY/);
  assert.deepEqual(databaseDiagnostics(primitive), { databaseOperation: 'lease.clock' });
});

test('rollback-confirmed action deadlocks exhaust at attempt 3 with fresh transactions and unchanged state', async () => {
  const f = sessionStore();
  const before = structuredClone(f.tables);
  const transactions = new Set<Transaction>();
  const errors: unknown[] = [];
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async (tx) => {
        transactions.add(tx);
        f.tables.D2cTimeline.push({ seq: errors.length + 1 });
        const error = driverError();
        errors.push(error);
        throw error;
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(errors.length, 3);
  assert.equal(transactions.size, 3);
  assert.equal(actual, errors[2]);
  assert.deepEqual(f.tables, before);
  assert.deepEqual(databaseDiagnostics(actual), {
    databaseCode: 'ER_LOCK_DEADLOCK',
    databaseErrno: 1213,
    databaseSqlState: '40001',
    databaseErrorType: 'SequelizeDatabaseError',
    databaseTransactionPhase: 'action',
    databaseAttempt: 3,
  });
  assert.deepEqual(
    errors.map((error) => databaseDiagnostics(error).databaseAttempt),
    [1, 2, 3],
  );
});

test('default actions and non-deadlock errors keep the existing single-attempt policy', async () => {
  for (const [code, retryDeadlocks] of [
    ['ER_LOCK_DEADLOCK', false],
    ['ER_LOCK_WAIT_TIMEOUT', true],
    ['ER_NO_SUCH_TABLE', true],
  ] as const) {
    const f = sessionStore();
    const error = driverError(code);
    let actions = 0;
    const actual = await rejected(() =>
      deadlockTransaction(
        f.mysql,
        async () => {
          actions++;
          throw error;
        },
        { retryDeadlocks },
      ),
    );
    assert.equal(actual, error);
    assert.equal(actions, 1);
    assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
    assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'action');
  }
});

test('errno 1213 and SQLSTATE 40001 alone never imply a retryable deadlock', async () => {
  for (const code of [undefined, 'PRIVATE_DRIVER_CODE']) {
    const f = sessionStore();
    let actions = 0;
    const error = new DatabaseError(
      Object.assign(new Error('PRIVATE_DRIVER'), {
        code,
        errno: 1213,
        sqlState: '40001',
        sql: 'PRIVATE_QUERY',
      }),
    );
    const actual = await rejected(() =>
      deadlockTransaction(
        f.mysql,
        async () => {
          actions++;
          throw error;
        },
        { retryDeadlocks: true },
      ),
    );
    assert.equal(actual, error);
    assert.equal(actions, 1);
    const diagnostics = databaseDiagnostics(actual);
    assert.equal(diagnostics.databaseCode, undefined);
    assert.equal(diagnostics.databaseErrno, 1213);
    assert.equal(diagnostics.databaseSqlState, '40001');
    assert.equal(diagnostics.databaseAttempt, 1);
    assert.equal(diagnostics.databaseTransactionPhase, 'action');
  }
});

test('begin failures never invoke or replay the callback', async (t) => {
  const f = sessionStore();
  const error = driverError();
  let begins = 0,
    actions = 0;
  t.mock.method(f.mysql, 'transaction', async () => {
    begins++;
    throw error;
  });
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async () => {
        actions++;
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(actual, error);
  assert.equal(begins, 1);
  assert.equal(actions, 0);
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'begin');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});

test('real Sequelize failed COMMIT executes afterCommit hooks but remains commit phase and is never replayed', async (t) => {
  const f = sequelizeFixture(t);
  const error = driverError();
  let actions = 0,
    commits = 0,
    hooks = 0;
  const transactions: Transaction[] = [];
  t.mock.method(f.queryInterface, 'commitTransaction', async () => {
    commits++;
    throw error;
  });
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async (tx) => {
        actions++;
        transactions.push(tx);
        tx.afterCommit(() => {
          hooks++;
        });
        return 'saved';
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(actual, error);
  assert.equal(actions, 1);
  assert.equal(commits, 1);
  assert.equal(hooks, 1, 'installed Sequelize runs afterCommit in finally even on COMMIT failure');
  assert.ok(transactions[0] instanceof Transaction);
  assert.equal((transactions[0] as unknown as { finished: string }).finished, 'commit');
  assert.equal(f.acquired(), 1);
  assert.equal(f.destroyed(), 1);
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'commit');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});

test('real Sequelize afterCommit failures keep the original error and never replay the action or notification', async (t) => {
  const f = sequelizeFixture(t);
  const error = driverError();
  let actions = 0,
    notifications = 0,
    commits = 0;
  const commit = f.queryInterface.commitTransaction.bind(f.queryInterface);
  t.mock.method(
    f.queryInterface,
    'commitTransaction',
    async (...args: Parameters<typeof commit>) => {
      commits++;
      return commit(...args);
    },
  );
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async (tx) => {
        actions++;
        tx.afterCommit(async () => {
          notifications++;
          throw error;
        });
        return 'saved';
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(actual, error);
  assert.equal(actions, 1);
  assert.equal(notifications, 1);
  assert.equal(commits, 1);
  assert.equal(f.acquired(), 1);
  assert.equal(f.destroyed(), 0);
  assert.ok(f.statements.some((sql) => /^COMMIT/i.test(sql)));
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'commit');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});

test('real Sequelize begin failures report begin and do not invoke the action', async (t) => {
  const f = sequelizeFixture(t);
  const error = driverError();
  let actions = 0,
    begins = 0;
  t.mock.method(f.queryInterface, 'startTransaction', async () => {
    begins++;
    throw error;
  });
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async () => {
        actions++;
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(actual, error);
  assert.equal(actions, 0);
  assert.equal(begins, 1);
  assert.equal(f.acquired(), 1);
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'begin');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});

test('failed managed rollback preserves the action error, reports action and does not claim a confirmed rollback', async (t) => {
  const f = sequelizeFixture(t);
  const error = driverError();
  let actions = 0,
    rollbacks = 0;
  t.mock.method(f.queryInterface, 'rollbackTransaction', async () => {
    rollbacks++;
    throw driverError('ER_NO_SUCH_TABLE');
  });
  const actual = await rejected(() =>
    deadlockTransaction(
      f.mysql,
      async () => {
        actions++;
        throw error;
      },
      { retryDeadlocks: true },
    ),
  );
  assert.equal(actual, error);
  assert.equal(actions, 1);
  assert.equal(rollbacks, 1);
  assert.equal(f.acquired(), 1);
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'action');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});

test('real lease workspace lock failures preserve the driver error, operation and transaction phase', async (t) => {
  const f = leaseFixture();
  const error = driverError('ER_NO_SUCH_TABLE');
  const model = f.mysql.models.D2cWorkspace;
  const find = model.findOne.bind(model);
  let locks = 0;
  t.mock.method(model, 'findOne', async (options: any) => {
    if (options.lock) {
      locks++;
      throw error;
    }
    return find(options);
  });
  let writes = 0;
  const before = structuredClone(f.tables);
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => f.time });
  const actual = await rejected(() =>
    leases.commit(f.lease, async () => {
      writes++;
    }),
  );
  assert.equal(actual, error);
  assert.equal(writes, 0);
  assert.equal(locks, 1);
  assert.deepEqual(f.tables, before);
  assert.deepEqual(databaseDiagnostics(actual), {
    databaseCode: 'ER_NO_SUCH_TABLE',
    databaseErrno: 1146,
    databaseSqlState: '40001',
    databaseErrorType: 'SequelizeDatabaseError',
    databaseOperation: 'lease.lock_workspace',
    databaseTransactionPhase: 'action',
    databaseAttempt: 1,
  });
});

test('real lease clock failure keeps CLOCK_UNAVAILABLE and its original database cause', async () => {
  const f = leaseFixture();
  const error = driverError('ER_NO_SUCH_TABLE');
  let clocks = 0,
    writes = 0;
  Object.assign(f.mysql, {
    query: async () => {
      clocks++;
      throw error;
    },
  });
  const before = structuredClone(f.tables);
  const leases = createRunLeases(f.mysql, { leaseMs: 60000 });
  const actual = await rejected(() =>
    leases.commit(
      f.lease,
      async () => {
        writes++;
      },
      { retryDeadlocks: true },
    ),
  );
  assert.ok(actual instanceof SessionError);
  assert.equal(actual.reason, 'CLOCK_UNAVAILABLE');
  assert.equal(actual.statusCode, 503);
  assert.equal(actual.cause, error);
  assert.equal(clocks, 1);
  assert.equal(writes, 0);
  assert.deepEqual(f.tables, before);
  assert.deepEqual(databaseDiagnostics(actual), {
    databaseCode: 'ER_NO_SUCH_TABLE',
    databaseErrno: 1146,
    databaseSqlState: '40001',
    databaseErrorType: 'SequelizeDatabaseError',
    databaseOperation: 'lease.clock',
    databaseTransactionPhase: 'action',
    databaseAttempt: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(databaseDiagnostics(actual)),
    /PRIVATE_QUERY|PRIVATE_BINDING|message|stack/,
  );
});

test('real lease write failures roll back changes while preserving the narrow operation context', async () => {
  const f = leaseFixture();
  const error = driverError('ER_NO_SUCH_TABLE');
  const before = structuredClone(f.tables);
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => f.time });
  const actual = await rejected(() =>
    leases.commit(f.lease, async (session, tx) => {
      await session.update({ fileRevision: 1 }, { transaction: tx });
      throw error;
    }),
  );
  assert.equal(actual, error);
  assert.deepEqual(f.tables, before);
  assert.equal(databaseDiagnostics(actual).databaseOperation, 'lease.write');
  assert.equal(databaseDiagnostics(actual).databaseTransactionPhase, 'action');
  assert.equal(databaseDiagnostics(actual).databaseAttempt, 1);
});
