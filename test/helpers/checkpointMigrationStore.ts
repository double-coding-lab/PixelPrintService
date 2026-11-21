import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { Op, type Sequelize } from 'sequelize';

type Row = Record<string, any>;
type Query = {
  table: string;
  attributes?: string[];
  lock?: string;
  transaction?: Row;
  where?: Row;
};

/** 保留Buffer/Date的数据库快照，禁止使用JSON克隆二进制载荷。 */
function clone<T>(value: T): T {
  return deserialize(serialize(value));
}

/** 只服务第二阶段迁移：ID分页、父会话先锁、独立事务回滚与提交故障。 */
export function checkpointMigrationStore() {
  const tables: Record<string, Row[]> = {
    D2cSession: [],
    D2cAgentCheckpoint: [],
    D2cAgentWrite: [],
  };
  const queries: Query[] = [];
  let depth = 0;
  let updates = 0;
  let commitCountdown = -1;
  let tail = Promise.resolve();
  let onRead: ((query: Query) => void) | undefined;
  let onUpdate: (() => void) | undefined;

  /** 仅支持迁移实际用到的筛选，BIGINT比较始终采用BigInt。 */
  function matches(row: Row, where: Row = {}) {
    return Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === 'object')
        return Reflect.ownKeys(expected).every((operator) => {
          const actual = BigInt(row[key]);
          const target = BigInt(expected[operator as symbol]);
          if (operator === Op.gt) return actual > target;
          if (operator === Op.lte) return actual <= target;
          throw new Error('unsupported migration filter');
        });
      return row[key] === expected;
    });
  }

  /** 模拟投影和稳定ID排序；查询日志只存元数据，不保存载荷内容。 */
  function select(table: string, options: Row) {
    const selected = tables[table].filter((row) => matches(row, options.where));
    if (options.order)
      selected.sort((a, b) => {
        const comparison = BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
        return options.order[0][1] === 'DESC' ? -comparison : comparison;
      });
    return selected.slice(0, options.limit ?? selected.length);
  }

  /** 锁序断言不依赖业务sessionStore，不冒充真实数据库隔离级别。 */
  function read(table: string, options: Row) {
    const query = { table, ...options };
    queries.push(query);
    if (options.lock) {
      assert.equal(depth, 1);
      assert.equal(options.lock, 'UPDATE');
      if (table !== 'D2cSession') assert.equal(options.transaction.locks[0], 'D2cSession');
      options.transaction.locks.push(table);
    }
    onRead?.(query);
  }

  /** 查询只返回分离的数据；迁移必须通过静态update显式保留更新时间。 */
  function instance(table: string, row: Row, options: Row) {
    const data = clone(
      options.attributes
        ? Object.fromEntries(options.attributes.map((key: string) => [key, row[key]]))
        : row,
    );
    return {
      ...data,
      get: () => clone(data),
    };
  }
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => {
      const model: Row = {
        async update(patch: Row, options: Row) {
          assert.equal(depth, 1);
          assert.equal(options.transaction.locks[0], 'D2cSession');
          assert.equal(options.transaction.locks.at(-1), table);
          assert.equal(options.silent, true);
          const expected =
            table === 'D2cAgentCheckpoint'
              ? ['checkpoint', 'checkpointRef', 'metadata', 'metadataRef', 'updatedAt']
              : ['value', 'valueRef', 'updatedAt'];
          assert.ok(Object.keys(patch).every((key) => expected.includes(key)));
          const selected = select(table, options);
          for (const row of selected) {
            assert.deepEqual(patch.updatedAt, row.updatedAt);
            assert.ok(patch.updatedAt instanceof Date);
            Object.assign(row, clone(patch));
            updates++;
            onUpdate?.();
          }
          return [selected.length];
        },
        scope(name: string) {
          assert.equal(name, 'checkpointBody');
          return model;
        },
        async findOne(options: Row) {
          read(table, options);
          const row = select(table, options)[0];
          return row ? instance(table, row, options) : null;
        },
        async findAll(options: Row) {
          read(table, options);
          return select(table, options).map((row) => instance(table, row, options));
        },
      };
      return [table, model];
    }),
  );
  const mysql = {
    models,
    async transaction<T>(
      optionsOrCallback: Row | ((transaction: Row) => Promise<T>),
      callback?: (transaction: Row) => Promise<T>,
    ): Promise<T> {
      const execute = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = clone(tables);
      const transaction = { LOCK: { UPDATE: 'UPDATE' }, locks: [] };
      depth++;
      try {
        const result = await execute(transaction);
        if (commitCountdown === 0) {
          commitCountdown = -1;
          throw new Error('PRIVATE_COMMIT_FAILURE');
        }
        if (commitCountdown > 0) commitCountdown--;
        return result;
      } catch (error) {
        for (const name of Object.keys(tables))
          tables[name].splice(0, tables[name].length, ...before[name]);
        throw error;
      } finally {
        depth--;
        release();
      }
    },
  } as unknown as Sequelize;
  return {
    mysql,
    tables,
    queries,
    depth: () => depth,
    updates: () => updates,
    failCommit: (successfulTransactions = 0) => {
      commitCountdown = successfulTransactions;
    },
    onRead: (callback?: typeof onRead) => {
      onRead = callback;
    },
    onUpdate: (callback?: typeof onUpdate) => {
      onUpdate = callback;
    },
  };
}
