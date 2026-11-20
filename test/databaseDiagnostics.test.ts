import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { databaseDiagnostics } from '../src/common/databaseDiagnostics';
import { registerAccessLog } from '../src/hooks/http/accessLog';

test('数据库诊断遍历 ORM 分支和循环引用，未知码及任意错误正文均不输出', () => {
  const error = Object.assign(new Error('private SQL'), {
    code: 'private-code',
    parent: { code: 'ER_OUT_OF_SORTMEMORY', errno: 1038, sqlState: 'HY001', sql: 'private SQL' },
    cause: undefined as unknown,
  });
  error.cause = error;
  assert.deepEqual(databaseDiagnostics(error), {
    databaseCode: 'ER_OUT_OF_SORTMEMORY',
    databaseErrno: 1038,
    databaseSqlState: 'HY001',
  });
  assert.deepEqual(databaseDiagnostics({ code: 'private-code', errno: 1038 }), {});
});

test('私有接口错误日志保留固定数据库码，仍省略 SQL、绑定值及错误堆栈', async () => {
  const hooks = new Map<string, Function>();
  const logs: unknown[] = [];
  registerAccessLog({
    addHook: (name: string, hook: Function) => hooks.set(name, hook),
    logging: { error: (data: unknown) => logs.push(data) },
  } as unknown as FastifyInstance);
  await hooks.get('onError')!(
    { routeOptions: { config: { privatePayload: true } } },
    {},
    Object.assign(new Error('private query'), {
      parent: { code: 'ER_OUT_OF_SORTMEMORY', errno: 1038, sql: 'private source' },
    }),
  );
  assert.deepEqual(logs, [
    {
      message: 'HTTP request failed',
      errorName: 'Error',
      databaseCode: 'ER_OUT_OF_SORTMEMORY',
      databaseErrno: 1038,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private|sql|stack/i);
});
