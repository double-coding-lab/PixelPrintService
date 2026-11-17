import assert from 'node:assert/strict';
import { deserialize, serialize } from 'node:v8';
import { Op, type Sequelize } from 'sequelize';
import { matchesSqlExpression } from './sqlExpression';

type Row = Record<string, any>;

/** V8 克隆保留 Date 和 Buffer，避免检查点 serde 收到 Uint8Array。 */
function clone<T>(value: T): T {
  return deserialize(serialize(value));
}

/** 串行事务替身验证锁序、唯一约束和回滚；不冒充真实 MySQL 隔离级别测试。 */
export function sessionStore() {
  const tables: Record<string, Row[]> = {
    D2cTeam: [],
    D2cTeamMember: [],
    D2cWorkspace: [
      {
        workspaceId: 'workspace-a',
        teamId: null,
        createdUserId: 'employee-a',
        status: 'ready',
        activeResourceRevisionId: 'resource-a',
      },
      {
        workspaceId: 'workspace-b',
        teamId: null,
        createdUserId: 'employee-b',
        status: 'ready',
        activeResourceRevisionId: 'resource-b',
      },
    ],
    D2cSession: [],
    D2cWorkspaceRevision: [],
    D2cCredential: [],
    D2cFile: [],
    D2cVersion: [],
    D2cPreview: [],
    D2cVersionFile: [],
    D2cRun: [],
    D2cTimeline: [],
    D2cAgentCheckpoint: [],
    D2cAgentWrite: [],
    D2cMessageAttachment: [],
  };
  let tail = Promise.resolve(),
    failure = '';
  let failureWhen: ((values: Row) => boolean) | undefined;
  const locks: string[] = [];
  const queries: Array<{ table: string; operation: string }> = [];

  /** SQL 标量比较支持日期和二进制值，不依赖克隆前后的对象引用。 */
  function equal(left: any, right: any): boolean {
    if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
    if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
    return left === right;
  }
  /** 同一字段的多个操作符共同生效；递归处理分页条件的 and/or。 */
  function matchesValue(actual: any, expected: any): boolean {
    if (
      expected === null ||
      typeof expected !== 'object' ||
      expected instanceof Date ||
      Buffer.isBuffer(expected)
    )
      return equal(actual, expected);
    if (Array.isArray(expected)) return expected.some((value) => equal(actual, value));
    return Reflect.ownKeys(expected).every((operator) => {
      const value = expected[operator as string];
      if (operator === Op.and) return value.every((part: any) => matchesValue(actual, part));
      if (operator === Op.or) return value.some((part: any) => matchesValue(actual, part));
      if (operator === Op.not) return !matchesValue(actual, value);
      if (operator === Op.eq || operator === Op.is) return equal(actual, value);
      if (operator === Op.ne)
        return value === null ? actual != null : actual != null && !equal(actual, value);
      if (operator === Op.in) return value.some((part: any) => equal(actual, part));
      if (operator === Op.notIn)
        return actual != null && !value.some((part: any) => equal(actual, part));
      if (actual == null || value == null) return false;
      if (operator === Op.gt) return actual > value;
      if (operator === Op.gte) return actual >= value;
      if (operator === Op.lt) return actual < value;
      if (operator === Op.lte) return actual <= value;
      throw new Error(`Unsupported sessionStore operator: ${String(operator)}`);
    });
  }
  /** 支持检查点的复合游标和原有工作区状态查询。 */
  function matches(row: Row, where: Row = {}): boolean {
    const expression = matchesSqlExpression(row, where);
    if (expression !== undefined) return expression;
    return Reflect.ownKeys(where).every((key) => {
      const value = where[key as string];
      if (key === Op.and || key === Op.or) {
        const parts = Array.isArray(value)
          ? value
          : Reflect.ownKeys(value).map((part) => ({ [part]: value[part] }));
        return key === Op.and
          ? parts.every((part: Row) => matches(row, part))
          : parts.some((part: Row) => matches(row, part));
      }
      if (key === Op.not) return !matches(row, value);
      const actual =
        typeof key === 'string' && key.includes('.')
          ? key.split('.').reduce((part, field) => part?.[field], row)
          : row[key as string];
      return matchesValue(actual, value);
    });
  }
  /** 事务写入必须先锁工作区；会话派生写入还必须持有会话锁。 */
  function checkWrite(table: string, options: Row, values: Row = {}) {
    assert.ok(options.transaction);
    if (table === 'D2cTeamMember') {
      assert.ok(locks.includes('D2cTeam'), '成员写入须持有团队锁');
    } else if (table === 'D2cTeam') {
      // 团队创建没有既有工作区；插入后即持有新团队行，随后才能写 owner 成员。
    } else if (table === 'D2cPreview') {
      assert.ok(locks.includes('D2cPreview') || locks.includes('D2cVersion'));
    } else assert.ok(locks.includes('D2cWorkspace'));
    assert.equal(options.transaction.sequelize, mysql);
    assert.equal(options.transaction.finished, undefined);
    if (
      [
        'D2cFile',
        'D2cTimeline',
        'D2cRun',
        'D2cAgentCheckpoint',
        'D2cAgentWrite',
        'D2cMessageAttachment',
        'D2cVersion',
        'D2cVersionFile',
      ].includes(table)
    )
      assert.ok(locks.includes('D2cSession'));
    if (table === 'D2cVersionFile') assert.ok(locks.includes('D2cVersion'));
    if (failure === table && (!failureWhen || failureWhen(values))) {
      failure = '';
      failureWhen = undefined;
      throw new Error('injected confidential DB detail');
    }
  }
  /** 实例与存储分离，避免未调用 update 的对象修改绕过事务。 */
  function instance(table: string, row: Row, values = row) {
    return Object.assign(clone(values), {
      async update(values: Row, options: Row) {
        checkWrite(table, options, values);
        if (table === 'D2cSession') assert.ok(locks.includes('D2cSession'));
        if (table === 'D2cVersion') assert.ok(locks.includes('D2cVersion'));
        assertUnique(table, { ...row, ...values }, row);
        Object.assign(row, clone(values));
        Object.assign(this, clone(values));
        return this;
      },
      async destroy(options: Row) {
        checkWrite(table, options);
        if (['D2cWorkspace', 'D2cSession'].includes(table)) {
          row.deletedAt = new Date();
        } else tables[table].splice(tables[table].indexOf(row), 1);
      },
    });
  }
  /** 仅模拟预览轻量投影使用的固定 JSON 表达式，不执行任意 SQL。 */
  function projectedField(row: Row, field: any) {
    if (typeof field === 'string') return row[field];
    if (field?.fn === 'JSON_OBJECT') {
      assert.equal(field.args[0]?.val, "'entryPath'");
      assert.equal(field.args[1]?.fn, 'JSON_EXTRACT');
      assert.equal(field.args[1]?.args[0]?.col, 'buildManifest');
      assert.equal(field.args[1]?.args[1]?.val, "'$.entryPath'");
      return { entryPath: row.buildManifest?.entryPath ?? null };
    }
    assert.equal(field?.fn, 'JSON_REMOVE');
    assert.equal(field.args[0]?.col, 'buildManifest');
    const value = clone(row.buildManifest);
    for (const argument of field.args.slice(1)) {
      const match = /^'\$\.(snapshot|files|tickets)'$/.exec(argument?.val ?? '');
      assert.ok(match, '投影只移除预览内部大字段');
      delete value[match[1]];
    }
    return value;
  }
  /** 按 attributes 投影，raw 结果始终为无实例方法的独立数据。 */
  function project(table: string, row: Row, options: Row) {
    let values = row;
    if (Array.isArray(options.attributes))
      values = Object.fromEntries(
        options.attributes.map((attribute: string | [string, string]) => {
          const [field, alias] = typeof attribute === 'string' ? [attribute, attribute] : attribute;
          return [alias, projectedField(row, field)];
        }),
      );
    else if (options.attributes) {
      values = { ...row };
      for (const field of options.attributes.exclude ?? []) delete values[field];
      for (const attribute of options.attributes.include ?? []) {
        const [field, alias] = typeof attribute === 'string' ? [attribute, attribute] : attribute;
        values[alias] = projectedField(row, field);
      }
    }
    return options.raw ? clone(values) : instance(table, row, values);
  }
  /** 检查点采用独立复合唯一键，不以缺省 entryId 判重。 */
  function assertUnique(table: string, values: Row, current?: Row) {
    const checkpointKey = ['sessionId', 'namespaceHash', 'checkpointId'];
    const keys =
      table === 'D2cTeam'
        ? [['teamId']]
        : table === 'D2cTeamMember'
          ? [['teamId', 'userId']]
          : table === 'D2cPreview'
            ? [['previewId']]
            : table === 'D2cVersion'
              ? [['versionId'], ['sessionId', 'clientRequestId']]
              : table === 'D2cVersionFile'
                ? [['versionId', 'pathHash']]
                : table === 'D2cAgentCheckpoint'
                  ? [checkpointKey]
                  : table === 'D2cAgentWrite'
                    ? [[...checkpointKey, 'taskHash', 'idx']]
                    : [
                        [
                          table === 'D2cMessageAttachment'
                            ? 'attachmentId'
                            : table === 'D2cSession'
                              ? 'sessionId'
                              : table === 'D2cFile'
                                ? 'fileId'
                                : table === 'D2cRun'
                                  ? 'runId'
                                  : 'entryId',
                        ],
                      ];
    if (table === 'D2cFile') keys.push(['sessionId', 'pathHash']);
    if (table === 'D2cTimeline') keys.push(['sessionId', 'seq']);
    if (table === 'D2cRun') keys.push(['sessionId', 'clientRequestId']);
    if (
      ['D2cAgentCheckpoint', 'D2cAgentWrite', 'D2cVersion', 'D2cVersionFile'].includes(table) &&
      values.id !== undefined
    )
      keys.push(['id']);
    for (const fields of keys)
      assert.equal(
        tables[table].some(
          (row) => row !== current && fields.every((key) => equal(row[key], values[key])),
        ),
        false,
      );
  }
  /** 查询按确定顺序分页；排序与筛选在字段投影之前执行。 */
  function rows(table: string, options: Row) {
    const result = tables[table].filter(
      (row) =>
        matches(row, options.where) &&
        (options.paranoid === false ||
          !['D2cWorkspace', 'D2cSession'].includes(table) ||
          row.deletedAt == null),
    );
    if (options.order)
      result.sort((a, b) => {
        for (const [key, direction] of options.order) {
          if (a[key] < b[key]) return direction === 'DESC' ? 1 : -1;
          if (a[key] > b[key]) return direction === 'DESC' ? -1 : 1;
        }
        return 0;
      });
    return result;
  }
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => [
      table,
      {
        async update(values: Row, options: Row) {
          checkWrite(table, options, values);
          if (table === 'D2cSession') assert.ok(locks.includes('D2cSession'));
          if (table === 'D2cVersion') assert.ok(locks.includes('D2cVersion'));
          const selected = rows(table, options);
          for (const row of selected) {
            assertUnique(table, { ...row, ...values }, row);
            Object.assign(row, clone(values));
          }
          return [selected.length];
        },
        async destroy(options: Row) {
          const selected = rows(table, options);
          for (const row of selected) await instance(table, row).destroy(options);
          return selected.length;
        },
        async create(values: Row, options: Row) {
          checkWrite(table, options, values);
          assertUnique(table, values);
          const row = {
            createdAt: new Date(),
            updatedAt: new Date(),
            ...(table === 'D2cWorkspace' ? { teamId: null } : {}),
            ...clone(values),
          };
          tables[table].push(row);
          if (['D2cTeam', 'D2cVersion'].includes(table)) locks.push(table);
          return instance(table, row);
        },
        async findOne(options: Row) {
          queries.push({ table, operation: 'findOne' });
          if (
            options.transaction &&
            !(
              table === 'D2cRun' &&
              options.transaction.readSnapshot &&
              !options.lock &&
              JSON.stringify(options.attributes) ===
                JSON.stringify(['status', 'pendingInteraction'])
            ) &&
            ['D2cFile', 'D2cRun', 'D2cVersion', 'D2cVersionFile'].includes(table)
          )
            assert.equal(options.lock, 'UPDATE');
          if (options.lock) {
            assert.equal(options.lock, 'UPDATE');
            if (table === 'D2cTeamMember')
              assert.ok(locks.includes('D2cTeam'), '成员锁之前须先取得团队锁');
            if (table === 'D2cTeam' && locks.includes('D2cSession'))
              assert.ok(locks.includes('D2cTeam'), '首次团队锁应在会话锁之前取得');
            if (table === 'D2cSession') assert.ok(locks.includes('D2cWorkspace'));
            if (table === 'D2cVersion' && options.where?.status === 'ready')
              locks.push('D2cReadyVersion');
            if (
              ['D2cVersion', 'D2cVersionFile'].includes(table) &&
              !locks.includes('D2cReadyVersion')
            ) {
              assert.ok(options.transaction);
              assert.ok(locks.includes('D2cWorkspace'));
              assert.ok(locks.includes('D2cSession'));
              if (table === 'D2cVersionFile') assert.ok(locks.includes('D2cVersion'));
            }
            locks.push(table);
          }
          const row = rows(table, options)[0];
          return row ? project(table, row, options) : null;
        },
        async findAll(options: Row) {
          queries.push({ table, operation: 'findAll' });
          if (options.lock && table === 'D2cPreview') locks.push(table);
          if (options.transaction && ['D2cFile', 'D2cVersion', 'D2cVersionFile'].includes(table)) {
            assert.equal(options.lock, 'UPDATE');
            if (table !== 'D2cFile') {
              assert.ok(locks.includes('D2cWorkspace'));
              assert.ok(locks.includes('D2cSession'));
              if (table === 'D2cVersionFile') assert.ok(locks.includes('D2cVersion'));
              locks.push(table);
            }
          }
          return rows(table, options)
            .slice(
              options.offset ?? 0,
              options.limit !== undefined ? (options.offset ?? 0) + options.limit : undefined,
            )
            .map((row) => project(table, row, options));
        },
        async findAndCountAll(options: Row) {
          return {
            rows: rows(table, options)
              .slice(options.offset, options.offset + options.limit)
              .map((row) => project(table, row, options)),
            count: rows(table, options).length,
          };
        },
        async count(options: Row) {
          return rows(table, options).length;
        },
      },
    ]),
  );
  const mysql = {
    models,
    async transaction<T>(
      optionsOrCallback: Row | ((transaction: Row) => Promise<T>),
      callback?: (transaction: Row) => Promise<T>,
    ) {
      const fn = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
      assert.equal(typeof fn, 'function');
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      locks.splice(0);
      const snapshot = clone(tables);
      const committed: Array<() => void | Promise<void>> = [];
      const transaction: Row = {
        sequelize: mysql,
        readSnapshot:
          typeof optionsOrCallback === 'object' &&
          optionsOrCallback.isolationLevel === 'REPEATABLE READ',
        finished: undefined,
        LOCK: { UPDATE: 'UPDATE' },
        afterCommit: (callback: () => void | Promise<void>) => committed.push(callback),
      };
      try {
        const result = await fn!(transaction);
        transaction.finished = 'commit';
        for (const callback of committed) await callback();
        return result;
      } catch (error) {
        if (transaction.finished !== 'commit') {
          for (const key of Object.keys(tables)) tables[key] = snapshot[key];
          transaction.finished = 'rollback';
        }
        throw error;
      } finally {
        locks.splice(0);
        release();
      }
    },
  } as unknown as Sequelize;
  return {
    mysql,
    tables,
    queries,
    failNext: (table: string, when?: (values: Row) => boolean) => {
      failure = table;
      failureWhen = when;
    },
  };
}
