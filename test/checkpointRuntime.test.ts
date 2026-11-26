import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Sequelize, type Model, type ModelStatic } from 'sequelize';
import { initD2cAgentCheckpoint } from '../src/models/D2cAgentCheckpoint';
import { initD2cAgentWrite } from '../src/models/D2cAgentWrite';
import {
  checkpointAttributes,
  checkpointContentPolicy,
  checkpointModel,
  checkpointPayloadScope,
  checkpointStorageSchema,
  installCheckpointContentRuntime,
  prepareCheckpointPayload,
  resolveCheckpointPayload,
} from '../src/functions/d2c/content/checkpointRuntime';
import { TextContentError } from '../src/functions/d2c/content/store';
import { enableCheckpointStorage } from './helpers/checkpointStorage';

const base = {
  sessionId: '12345678-1234-1234-1234-123456789abc',
  namespaceHash: createHash('sha256').update('').digest('hex'),
  checkpointId: 'checkpoint-one',
  kind: 'checkpoint' as const,
  type: 'v8',
};
const scope = checkpointPayloadScope(base);
const bytes = Buffer.from([0, 255, 128, 1, 13, 10, 0]);
const fake = () => ({ models: {} }) as unknown as Sequelize;

/** 真实Sequelize SQL离线截获，确认旧库不依赖新增列，且typed BLOB列名映射保留。 */
test('旧schema默认投影/INSERT不含新列，显式scope仅在开关就绪后加入引用', async (t) => {
  const mysql = new Sequelize('mysql://unused:unused@127.0.0.1/offline', { logging: false });
  t.after(() => mysql.close());
  const models: ModelStatic<Model>[] = [initD2cAgentCheckpoint(mysql), initD2cAgentWrite(mysql)];
  const sql: string[] = [];
  mysql.query = (async (input: unknown) => {
    sql.push(typeof input === 'string' ? input : (input as { query: string }).query);
    return [];
  }) as unknown as typeof mysql.query;
  for (const model of models) {
    await checkpointModel(mysql, model).findAll();
    assert.doesNotMatch(sql.at(-1)!, /checkpointRef|metadataRef|writeRef/);
  }
  const storage = enableCheckpointStorage(mysql);
  for (const model of models) await checkpointModel(mysql, model).findAll();
  assert.match(sql.at(-2)!, /checkpointRef.*metadataRef/);
  assert.match(sql.at(-1)!, /writeRef/);
  assert.deepEqual(checkpointAttributes(mysql, ['metadata'], ['metadataRef']), [
    'metadata',
    'metadataRef',
  ]);
  storage.configure({ mode: 'inline' });
  mysql.query = (async (input: unknown) => {
    sql.push(typeof input === 'string' ? input : (input as { query: string }).query);
    throw new Error('SQL_CAPTURED');
  }) as unknown as typeof mysql.query;
  for (const model of models) {
    await assert.rejects(model.create({ checkpoint: bytes, value: bytes }), /SQL_CAPTURED/);
    assert.doesNotMatch(sql.at(-1)!, /checkpointRef|metadataRef|writeRef/);
  }
});

test('历史BLOB可读，所有旧写模式均统一文件写入，未配置文件存储时拒绝写入', async () => {
  const mysql = fake();
  await assert.rejects(prepareCheckpointPayload(mysql, scope, bytes), TextContentError);
  assert.deepEqual(await resolveCheckpointPayload(mysql, { payload: bytes }, scope), bytes);
  assert.deepEqual(checkpointAttributes(mysql, ['metadata'], ['metadataRef']), ['metadata']);
  const memory = enableCheckpointStorage(mysql, 'shadow');
  const shadow = await prepareCheckpointPayload(mysql, scope, bytes);
  assert.equal(shadow.payload, null);
  assert.ok(shadow.reference);
  memory.configure({ mode: 'external' });
  const external = await prepareCheckpointPayload(mysql, scope, bytes);
  assert.equal(external.payload, null);
  assert.ok(external.reference);
  assert.deepEqual(await resolveCheckpointPayload(mysql, external, scope), bytes);
  memory.configure({ mode: 'inline' });
  assert.deepEqual(await resolveCheckpointPayload(mysql, external, scope), bytes);
  const puts = memory.operations.filter((x) => x === 'put').length;
  const afterLegacyMode = await prepareCheckpointPayload(mysql, scope, bytes);
  assert.equal(afterLegacyMode.payload, null);
  assert.ok(afterLegacyMode.reference);
  assert.equal(memory.operations.filter((x) => x === 'put').length, puts + 1);
  assert.equal('encryption' in checkpointContentPolicy(mysql), false);
});

test('旧writer的BLOB优先，空载荷合法，失效/跨行引用不能变成空检查点', async () => {
  const mysql = fake();
  enableCheckpointStorage(mysql);
  const stored = await prepareCheckpointPayload(mysql, scope, bytes);
  assert.deepEqual(
    await resolveCheckpointPayload(
      mysql,
      { payload: Buffer.alloc(0), reference: stored.reference },
      scope,
    ),
    Buffer.alloc(0),
  );
  assert.deepEqual(
    await resolveCheckpointPayload(mysql, { payload: bytes, reference: { invalid: true } }, scope),
    bytes,
  );
  await assert.rejects(
    resolveCheckpointPayload(mysql, { payload: null, reference: {} }, scope),
    TextContentError,
  );
  await assert.rejects(
    resolveCheckpointPayload(mysql, stored, checkpointPayloadScope({ ...base, type: 'json' })),
    TextContentError,
  );
  assert.equal(await resolveCheckpointPayload(mysql, { payload: null }, scope), null);
});

test('小正文也外置，超出逻辑总限额明确失败，取消不上传，schemaReady变更要求重启', async () => {
  const mysql = fake();
  const memory = enableCheckpointStorage(mysql, 'external', 8);
  const small = await prepareCheckpointPayload(mysql, scope, bytes);
  assert.equal(small.payload, null);
  assert.ok(small.reference);
  assert.ok(memory.operations.length > 0);
  const oversized = Buffer.alloc(2097153);
  const operations = memory.operations.length;
  await assert.rejects(prepareCheckpointPayload(mysql, scope, oversized), TextContentError);
  assert.equal(memory.operations.length, operations);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareCheckpointPayload(mysql, scope, bytes, controller.signal), {
    name: 'AbortError',
  });
  await assert.rejects(
    resolveCheckpointPayload(mysql, { payload: bytes }, scope, controller.signal),
    { name: 'AbortError' },
  );
  memory.configure({ mode: 'inline', schemaReady: false });
  assert.throws(() => checkpointContentPolicy(mysql), TextContentError);
});

test('scope绑定namespace/checkpoint/serde/任务及负序号，非法身份不进入上游日志', () => {
  const variants = [
    { ...base, kind: 'metadata' as const },
    { ...base, type: 'json' },
    { ...base, checkpointId: 'other' },
    { ...base, namespaceHash: '1'.repeat(64) },
    { ...base, kind: 'write' as const, taskHash: '2'.repeat(64), idx: -1 },
    { ...base, kind: 'write' as const, taskHash: '2'.repeat(64), idx: -2 },
  ];
  assert.equal(new Set([scope, ...variants.map(checkpointPayloadScope)]).size, variants.length + 1);
  assert.throws(() => checkpointPayloadScope({ ...base, kind: 'write' }), TextContentError);
  assert.throws(
    () => checkpointPayloadScope({ ...base, namespaceHash: 'private-raw-namespace' }),
    TextContentError,
  );
  assert.throws(() => checkpointStorageSchema.parse({ mode: 'external', schemaReady: false }));
  assert.throws(
    () =>
      installCheckpointContentRuntime(fake(), {
        readSettings: () => checkpointStorageSchema.parse({}),
        maxBytes: 0,
        store: () => {
          throw new Error();
        },
      }),
    TextContentError,
  );
});
