import assert from 'node:assert/strict';
import { Op, type Sequelize } from 'sequelize';

type Row = Record<string, any>;
/** 运维迁移专用行存储替身：验证单行锁/CAS和事务回滚；应用业务锁序由原集成测试覆盖。 */
export function contentMigrationStore() {
  const tables: Record<string, Row[]> = Object.fromEntries(
    ['D2cFile', 'D2cVersionFile', 'D2cSavedWorkFile', 'D2cPreview', 'D2cTimeline'].map((name) => [
      name,
      [],
    ]),
  );
  let active: any;
  let failCommit = false;
  const locked = new Set<string>();
  const models: Record<string, any> = {};
  function same(a: any, b: any) {
    return a === b;
  }
  function matches(row: Row, where: Row = {}) {
    return Object.entries(where).every(([field, value]) => {
      const actual = row[field];
      if (!value || typeof value !== 'object')
        return field === 'id' ? String(actual) === String(value) : same(actual, value);
      return Reflect.ownKeys(value).every((operator) => {
        const expected = value[operator as any];
        const a = field === 'id' ? BigInt(actual) : actual;
        const b = field === 'id' ? BigInt(expected) : expected;
        if (operator === Op.gt) return a > b;
        if (operator === Op.lte) return a <= b;
        throw new Error('Unsupported migration predicate');
      });
    });
  }
  for (const name of Object.keys(tables)) {
    function selected(options: any) {
      const rows = tables[name].filter((row) => matches(row, options.where));
      if (options.order?.length)
        rows.sort((a, b) => {
          const [field, direction] = options.order[0];
          const left = field === 'id' ? BigInt(a[field]) : a[field];
          const right = field === 'id' ? BigInt(b[field]) : b[field];
          return (left < right ? -1 : left > right ? 1 : 0) * (direction === 'DESC' ? -1 : 1);
        });
      return rows.slice(0, options.limit ?? rows.length).map((row) => {
        if (options.lock) {
          assert.equal(options.transaction, active);
          locked.add(name + ':' + row.id);
        }
        const fields = options.attributes
          ? Object.fromEntries(options.attributes.map((key: string) => [key, row[key]]))
          : row;
        return {
          ...structuredClone(fields),
          get: () => structuredClone(fields),
          update: async (patch: Row, settings: any) => {
            assert.equal(settings.transaction, active);
            assert.ok(locked.has(name + ':' + row.id));
            Object.assign(row, structuredClone(patch));
          },
        };
      });
    }
    models[name] = {
      scope: () => models[name],
      findAll: async (options: any) => selected(options),
      findOne: async (options: any) => selected({ ...options, limit: 1 })[0] ?? null,
    };
  }
  const mysql = {
    models,
    transaction: async (callback: (transaction: any) => Promise<unknown>) => {
      assert.equal(active, undefined);
      const before = structuredClone(tables);
      locked.clear();
      active = { LOCK: { UPDATE: 'UPDATE' } };
      try {
        const result = await callback(active);
        if (failCommit) {
          failCommit = false;
          throw new Error('private DB commit');
        }
        return result;
      } catch (error) {
        for (const [name, rows] of Object.entries(before)) tables[name] = rows;
        throw error;
      } finally {
        active = undefined;
        locked.clear();
      }
    },
  } as unknown as Sequelize;
  return {
    mysql,
    tables,
    failCommit: () => {
      failCommit = true;
    },
  };
}
