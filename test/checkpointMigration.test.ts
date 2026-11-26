import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Sequelize, type Model, type ModelStatic } from 'sequelize';
import { initD2cAgentCheckpoint } from '../src/models/D2cAgentCheckpoint';
import { initD2cAgentWrite } from '../src/models/D2cAgentWrite';
import { checkpointMigrationStore } from './helpers/checkpointMigrationStore';
import { enableCheckpointStorage } from './helpers/checkpointStorage';
import { migrateCheckpointBatch } from '../src/functions/d2c/content/checkpointMigration';
import { checkpointPayloadScope } from '../src/functions/d2c/content/checkpointRuntime';
import {
  parseCheckpointMigrationArgs,
  runCheckpointMigrationCli,
} from '../scripts/migrate-checkpoint-content';

const sessionId = '11111111-1111-4111-8111-111111111111';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const payload = Buffer.from([0, 255, 128, 192, 13, 10, 0]);
const metadata = Buffer.from([254, 0, 128, 13]);

/** 专用数据库加真实二进制协议；所有对象只存在内存。 */
function fixture(mode: 'inline' | 'shadow' | 'external' = 'shadow', count = 1) {
  const db = checkpointMigrationStore();
  const storage = enableCheckpointStorage(db.mysql, mode);
  db.tables.D2cSession.push({ sessionId, activeRunId: null });
  for (let id = 1; id <= count; id++) {
    const identity = {
      id: String(id),
      sessionId,
      threadId: `d2c:${sessionId}`,
      namespaceHash: digest(''),
      checkpointNs: '',
      checkpointId: 'checkpoint-' + id,
      updatedAt: new Date('2020-01-02T03:04:05.123Z'),
    };
    db.tables.D2cAgentCheckpoint.push({
      ...identity,
      parentCheckpointId: null,
      checkpointType: 'msgpack',
      checkpoint: Buffer.from(payload),
      metadataType: 'json',
      metadata: Buffer.from(metadata),
      checkpointRef: null,
      metadataRef: null,
    });
    db.tables.D2cAgentWrite.push({
      ...identity,
      taskHash: digest('task'),
      taskId: 'task',
      taskPath: 'path',
      idx: -1,
      channel: 'channel',
      valueType: 'msgpack',
      value: Buffer.from(payload),
      valueRef: null,
    });
  }
  return {
    ...db,
    storage,
    checkpoint: () => db.tables.D2cAgentCheckpoint[0],
    write: () => db.tables.D2cAgentWrite[0],
  };
}

/** 固定code断言，不把原始上游正文写入测试输出。 */
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected;

test('默认dry-run零存储IO/零写入，ID-only分页、固定上界和BIGINT字符串续迁', async () => {
  const f = fixture('shadow', 3);
  const before = structuredClone(f.checkpoint());
  const first = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', batchSize: 2 });
  assert.equal(first.dryRun, true);
  assert.equal(first.eligible, 2);
  assert.equal(first.written, 0);
  assert.equal(first.nextAfterId, '2');
  assert.equal(first.untilId, '3');
  assert.equal(first.hasMore, true);
  assert.equal(f.updates(), 0);
  assert.equal(f.queries.filter((query) => query.lock).length, 0);
  assert.equal(f.storage.operations.length, 0);
  assert.deepEqual(structuredClone(f.checkpoint()), before);
  assert.ok(
    f.queries
      .filter(
        (q) =>
          !q.where || (q.where.id && !q.where.sessionId && !q.lock && q.attributes?.length === 1),
      )
      .every((q) => q.attributes?.join(',') === 'id'),
  );
  f.tables.D2cAgentCheckpoint.push({ ...f.checkpoint(), id: '4' });
  const next = await migrateCheckpointBatch(f.mysql, {
    table: 'checkpoints',
    afterId: first.nextAfterId,
    untilId: first.untilId,
  });
  assert.equal(next.scanned, 1);
  assert.equal(next.nextAfterId, '3');
  assert.equal(next.hasMore, false);
  f.tables.D2cAgentCheckpoint.splice(
    0,
    4,
    ...['9007199254740993', '9007199254740994'].map((id) => ({ ...f.checkpoint(), id })),
  );
  const big = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', batchSize: 1 });
  assert.equal(big.nextAfterId, '9007199254740993');
  assert.equal(big.untilId, '9007199254740994');
});

test('dry-run严格校验ref格式及scope，坏ref不伪装成可直接外置且不获取写锁', async () => {
  for (const patch of [
    { format: 'invalid' },
    { storedSize: 0 },
    { locator: [] },
    { scope: 'checkpoint:foreign' },
  ]) {
    const f = fixture();
    await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
    Object.assign(f.checkpoint().metadataRef, patch);
    f.storage.configure({ mode: 'external' });
    const operations = f.storage.operations.length;
    const updates = f.updates();
    f.queries.splice(0);
    const result = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints' });
    assert.equal(result.error?.code, 'INVALID_REFERENCE');
    assert.equal(result.nextAfterId, '0');
    assert.equal(result.written, 0);
    assert.equal(f.storage.operations.length, operations);
    assert.equal(f.updates(), updates);
    assert.equal(f.queries.filter((query) => query.lock).length, 0);
  }
});

test('两个checkpoint载荷同提交，全量文件写入幂等，显式restore保持原始二进制和refs', async () => {
  const f = fixture();
  for (const method of ['put', 'get'] as const) {
    const original = f.storage.backend[method];
    (f.storage.backend as any)[method] = async (...args: unknown[]) => {
      assert.equal(f.depth(), 0);
      return Reflect.apply(original, f.storage.backend, args);
    };
  }
  assert.equal(
    (await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false })).written,
    1,
  );
  assert.equal(f.checkpoint().checkpoint, null);
  assert.equal(f.checkpoint().metadata, null);
  const refs = structuredClone([f.checkpoint().checkpointRef, f.checkpoint().metadataRef]);
  const puts = f.storage.operations.filter((operation) => operation === 'put').length;
  const gets = f.storage.operations.filter((operation) => operation === 'get').length;
  assert.equal(
    (await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false })).written,
    0,
  );
  assert.equal(f.storage.operations.filter((operation) => operation === 'put').length, puts);
  assert.equal(f.storage.operations.filter((operation) => operation === 'get').length, gets);
  f.storage.configure({ mode: 'external' });
  assert.equal(
    (await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false })).written,
    0,
  );
  assert.equal(f.checkpoint().checkpoint, null);
  assert.equal(f.checkpoint().metadata, null);
  const objectCount = f.storage.objects.size;
  f.storage.configure({ mode: 'inline' });
  assert.equal(
    (
      await migrateCheckpointBatch(f.mysql, {
        table: 'checkpoints',
        dryRun: false,
        action: 'restore',
      })
    ).written,
    1,
  );
  assert.deepEqual(f.checkpoint().checkpoint, payload);
  assert.deepEqual(f.checkpoint().metadata, metadata);
  assert.deepEqual([f.checkpoint().checkpointRef, f.checkpoint().metadataRef], refs);
  assert.equal(f.storage.objects.size, objectCount);
  f.storage.objects.clear();
  assert.equal(
    (
      await migrateCheckpointBatch(f.mysql, {
        table: 'checkpoints',
        dryRun: false,
        action: 'restore',
      })
    ).written,
    0,
    'inline BLOB wins over unavailable reference',
  );
});

test('writes使用valueRef并绑定taskHash/idx/type，旧BLOB修改后不复用过期引用', async () => {
  const f = fixture();
  await migrateCheckpointBatch(f.mysql, { table: 'writes', dryRun: false });
  const row = f.write();
  assert.equal(
    row.valueRef.scope,
    checkpointPayloadScope({
      sessionId,
      namespaceHash: row.namespaceHash,
      checkpointId: row.checkpointId,
      type: row.valueType,
      kind: 'write',
      taskHash: row.taskHash,
      idx: row.idx,
    }),
  );
  const priorObject = row.valueRef.objectId;
  row.value = Buffer.from([255, 1, 0, 128]);
  f.storage.configure({ mode: 'external' });
  assert.equal(
    (await migrateCheckpointBatch(f.mysql, { table: 'writes', dryRun: false })).written,
    1,
  );
  assert.notEqual(f.write().valueRef.objectId, priorObject);
  assert.equal(f.write().value, null);
  assert.equal('writeRef' in f.write(), false);
  f.storage.configure({ mode: 'inline' });
  await migrateCheckpointBatch(f.mysql, { table: 'writes', dryRun: false, action: 'restore' });
  assert.deepEqual(f.write().value, Buffer.from([255, 1, 0, 128]));
  assert.equal(f.write().channel, 'channel');
  assert.equal(f.write().taskPath, 'path');
  f.write().value = null;
  f.write().valueRef = null;
  const operations = f.storage.operations.length;
  assert.equal(
    (await migrateCheckpointBatch(f.mysql, { table: 'writes', action: 'restore', dryRun: false }))
      .written,
    0,
  );
  assert.equal(f.storage.operations.length, operations);
});

test('第二载荷失败和最终提交失败均不部分更新，失败对象不清理且游标不动', async () => {
  for (const phase of ['metadata', 'commit']) {
    const f = fixture();
    if (phase === 'commit') f.failCommit(1);
    else {
      const put = f.storage.backend.put;
      let count = 0;
      f.storage.backend.put = async (input) => {
        if (++count === 2) throw new Error('PRIVATE_STORAGE_PAYLOAD');
        return put(input);
      };
    }
    const result = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
    assert.equal(result.written, 0);
    assert.equal(result.nextAfterId, '0');
    assert.equal(result.hasMore, true);
    assert.equal(result.error?.code, phase === 'metadata' ? 'UPLOAD_FAILED' : 'MIGRATION_FAILED');
    assert.equal(f.checkpoint().checkpointRef, null);
    assert.equal(f.checkpoint().metadataRef, null);
    assert.deepEqual(f.checkpoint().checkpoint, payload);
    assert.ok(f.storage.objects.size > 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('完整身份/载荷/ref变动均被CAS拒绝，冲突不推进游标且可原点续迁', async () => {
  for (const table of ['checkpoints', 'writes'] as const) {
    const fields =
      table === 'checkpoints'
        ? [
            'threadId',
            'namespaceHash',
            'checkpointNs',
            'checkpointId',
            'parentCheckpointId',
            'checkpointType',
            'metadataType',
            'checkpoint',
            'metadata',
            'checkpointRef',
            'metadataRef',
          ]
        : ['taskHash', 'taskId', 'taskPath', 'idx', 'channel', 'valueType', 'value', 'valueRef'];
    for (const field of fields) {
      const f = fixture();
      const put = f.storage.backend.put;
      let changed = false;
      f.storage.backend.put = async (input) => {
        if (!changed) {
          changed = true;
          const row = table === 'checkpoints' ? f.checkpoint() : f.write();
          row[field] = Buffer.isBuffer(row[field])
            ? Buffer.from([1])
            : field === 'idx'
              ? 4
              : 'changed';
        }
        return put(input);
      };
      const result = await migrateCheckpointBatch(f.mysql, { table, dryRun: false });
      assert.equal(result.error?.code, 'REVISION_CONFLICT', field);
      assert.equal(result.conflicts, 1);
      assert.equal(result.nextAfterId, '0');
      assert.equal(result.written, 0);
      assert.equal(f.updates(), 0);
    }
  }
});

test('父session先锁；活动/不存在的会话在准备前及提交前均拦截，租约不变', async () => {
  for (const late of [false, true]) {
    for (const missing of [false, true]) {
      const f = fixture();
      const change = () => {
        if (missing) f.tables.D2cSession.splice(0);
        else f.tables.D2cSession[0].activeRunId = 'active-run';
      };
      if (late) {
        const put = f.storage.backend.put;
        f.storage.backend.put = async (input) => {
          change();
          return put(input);
        };
      } else change();
      const result = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
      assert.equal(result.error?.code, missing ? 'SESSION_NOT_FOUND' : 'SESSION_ACTIVE');
      assert.equal(result.nextAfterId, '0');
      assert.equal(result.written, 0);
      assert.equal(f.checkpoint().checkpointRef, null);
      if (!late) assert.equal(f.storage.operations.length, 0);
      assert.equal(f.queries.filter((q) => q.lock)[0].table, 'D2cSession');
    }
  }
});

test('thread/namespace/task原文摘要脏行在任何上传前固定失败', async () => {
  for (const field of [
    'threadId',
    'checkpointNs',
    'namespaceHash',
    'taskId',
    'taskHash',
    'sessionId',
    'checkpointId',
    'valueType',
    'idx',
  ]) {
    const f = fixture();
    f.write()[field] =
      field === 'idx'
        ? 2147483648
        : field === 'checkpointId'
          ? 'invalid/checkpoint'
          : field === 'valueType'
            ? ''
            : 'PRIVATE_DIRTY_VALUE';
    const result = await migrateCheckpointBatch(f.mysql, { table: 'writes', dryRun: false });
    assert.equal(
      result.error?.code,
      field === 'sessionId' ? 'SESSION_NOT_FOUND' : 'INVALID_REFERENCE',
      field,
    );
    assert.equal(result.nextAfterId, '0');
    assert.equal(f.storage.operations.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('取消贯穿上传、restore/reuse读取、锁后与update后，数据库原值全部保留', async () => {
  for (const phase of ['put', 'restore', 'reuse', 'lock', 'update']) {
    const f = fixture();
    if (phase === 'restore' || phase === 'reuse') {
      await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
      if (phase === 'reuse') {
        f.checkpoint().checkpoint = Buffer.from(payload);
        f.checkpoint().metadata = Buffer.from(metadata);
      }
      if (phase === 'restore') {
        f.storage.configure({ mode: 'external' });
        await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
        f.storage.configure({ mode: 'inline' });
      }
    }
    const before = structuredClone(f.checkpoint());
    const controller = new AbortController();
    if (phase === 'put') {
      const put = f.storage.backend.put;
      f.storage.backend.put = async (input) => {
        assert.equal(input.signal, controller.signal);
        controller.abort();
        return put(input);
      };
    } else if (phase === 'restore' || phase === 'reuse') {
      const get = f.storage.backend.get;
      f.storage.backend.get = async (locator, input) => {
        assert.equal(input.signal, controller.signal);
        const value = await get(locator, input);
        controller.abort();
        return value;
      };
    } else if (phase === 'lock') {
      let locks = 0;
      f.onRead((query) => {
        if (query.table === 'D2cAgentCheckpoint' && query.lock && ++locks === 2) controller.abort();
      });
    } else f.onUpdate(() => controller.abort());
    await assert.rejects(
      migrateCheckpointBatch(f.mysql, {
        table: 'checkpoints',
        dryRun: false,
        action: phase === 'restore' ? 'restore' : 'externalize',
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.deepEqual(structuredClone(f.checkpoint()), before, phase);
    assert.equal(f.depth(), 0);
  }
});

test('中途失败保留最后已提交ID，后续批次沿同上界从失败行重试', async () => {
  const f = fixture('shadow', 2);
  const put = f.storage.backend.put;
  let count = 0;
  f.storage.backend.put = async (input) => {
    if (++count === 3) throw new Error('PRIVATE_PROVIDER');
    return put(input);
  };
  const first = await migrateCheckpointBatch(f.mysql, { table: 'checkpoints', dryRun: false });
  assert.equal(first.written, 1);
  assert.equal(first.nextAfterId, '1');
  assert.equal(first.error?.id, '2');
  f.storage.backend.put = put;
  const resumed = await migrateCheckpointBatch(f.mysql, {
    table: 'checkpoints',
    dryRun: false,
    afterId: first.nextAfterId,
    untilId: first.untilId,
  });
  assert.equal(resumed.written, 1);
  assert.equal(resumed.nextAfterId, '2');
});

test('CLI只接受显式参数，help/坏参数不连接，参数和顶层数据库错误固定投影', async () => {
  let opens = 0;
  const open = async () => {
    opens++;
    throw new Error('PRIVATE_CONNECTION');
  };
  assert.equal(await runCheckpointMigrationCli(['--help'], open, () => {}), 0);
  assert.equal(await runCheckpointMigrationCli([], open, () => {}), 0);
  for (const args of [
    ['--apply'],
    ['--apply', '--dry-run', '--table', 'checkpoints'],
    ['--apply', '--table', 'files'],
    ['--apply', '--table', 'writes', '--after-id', '18446744073709551616'],
    ['--apply', '--table', 'writes', '--batch-size', '1e2'],
  ])
    await assert.rejects(runCheckpointMigrationCli(args, open, () => {}));
  assert.equal(opens, 0);
  assert.equal(
    parseCheckpointMigrationArgs([
      '--dry-run',
      '--table',
      'writes',
      '--after-id',
      '9007199254740993',
    ])?.afterId,
    '9007199254740993',
  );
  const f = fixture();
  await assert.rejects(
    migrateCheckpointBatch(f.mysql, { table: 'writes', afterId: '-1' }),
    code('INVALID_REFERENCE'),
  );
  f.mysql.models.D2cAgentWrite.findOne = async () => {
    throw new Error('PRIVATE_SQL');
  };
  await assert.rejects(
    migrateCheckpointBatch(f.mysql, { table: 'writes' }),
    code('MIGRATION_FAILED'),
  );
});

test('CLI原子0600游标、resume/跨动作拒绝、external确认及冲突退出1', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'checkpoint-migration-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const state = path.join(folder, 'state.json');
  const f = fixture('shadow', 2);
  let closes = 0;
  const open = async () => ({
    mysql: f.mysql,
    close: async () => {
      closes++;
    },
  });
  const output: string[] = [];
  const args = [
    '--apply',
    '--confirm-external',
    '--table',
    'checkpoints',
    '--state-file',
    state,
    '--batch-size',
    '1',
  ];
  assert.equal(await runCheckpointMigrationCli(args, open, (value) => output.push(value)), 0);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '1');
  assert.equal((await stat(state)).mode & 0o077, 0);
  assert.equal(
    await runCheckpointMigrationCli([...args, '--resume'], open, (value) => output.push(value)),
    0,
  );
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '2');
  await assert.rejects(
    runCheckpointMigrationCli([...args, '--resume', '--restore'], open, () => {}),
    /STATE_MISMATCH/,
  );
  f.storage.configure({ mode: 'external' });
  await assert.rejects(
    runCheckpointMigrationCli(
      args.filter((arg) => arg !== '--confirm-external'),
      open,
      () => {},
    ),
    /EXTERNAL_CONFIRMATION_REQUIRED/,
  );
  assert.equal(await runCheckpointMigrationCli(args, open, () => {}), 0);
  assert.equal(f.checkpoint().checkpoint, null);
  assert.doesNotMatch(
    output.join('') + (await readFile(state, 'utf8')),
    /PRIVATE|reference|locator|checkpointRef|metadataRef|checkpoint-test/,
  );
  assert.equal(closes, 4);
  const conflict = fixture();
  const put = conflict.storage.backend.put;
  let changed = false;
  conflict.storage.backend.put = async (input) => {
    if (!changed) {
      changed = true;
      conflict.checkpoint().parentCheckpointId = 'parent';
    }
    return put(input);
  };
  const openConflict = async () => ({ mysql: conflict.mysql, close: async () => {} });
  assert.equal(await runCheckpointMigrationCli(args, openConflict, () => {}), 1);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '0');
  conflict.storage.backend.put = put;
  assert.equal(await runCheckpointMigrationCli([...args, '--resume'], openConflict, () => {}), 0);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '1');
  await writeFile(
    state,
    JSON.stringify({
      version: 1,
      table: 'writes',
      action: 'restore',
      dryRun: true,
      nextAfterId: '0',
      untilId: '1',
    }),
  );
  await assert.rejects(
    runCheckpointMigrationCli([...args, '--resume'], openConflict, () => {}),
    /STATE_MISMATCH/,
  );
});

test('CLI SIGINT取消当前对象操作并关闭连接，不推进未提交正文', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'checkpoint-migration-cancel-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const f = fixture();
  let closed = false;
  const put = f.storage.backend.put;
  f.storage.backend.put = async (input) => {
    process.emit('SIGINT');
    assert.equal(input.signal?.aborted, true);
    return put(input);
  };
  await assert.rejects(
    runCheckpointMigrationCli(
      [
        '--apply',
        '--confirm-external',
        '--table',
        'checkpoints',
        '--state-file',
        path.join(folder, 'state.json'),
      ],
      async () => ({
        mysql: f.mysql,
        close: async () => {
          closed = true;
        },
      }),
      () => {},
    ),
    { name: 'AbortError' },
  );
  assert.equal(closed, true);
  assert.equal(f.checkpoint().checkpointRef, null);
});

test('安装版Sequelize静态UPDATE真实SQL显式保留datachange_lasttime原值', async (t) => {
  const mysql = new Sequelize('mysql://offline:offline@127.0.0.1/offline', {
    logging: false,
    timezone: '+00:00',
  });
  t.after(() => mysql.close());
  const statements: Array<{ sql: string; bind: unknown }> = [];
  // 截断在驱动执行之前：使用实际模型、静态update和MySQL QueryGenerator，绝不连接。
  mysql.query = (async (sql: unknown, options: Record<string, unknown>) => {
    const query = typeof sql === 'string' ? sql : (sql as { query: string }).query;
    statements.push({
      sql: query,
      bind:
        options.bind ??
        (typeof sql === 'object' && sql ? (sql as { bind?: unknown }).bind : undefined),
    });
    return 1;
  }) as unknown as typeof mysql.query;
  const models: ModelStatic<Model>[] = [initD2cAgentCheckpoint(mysql), initD2cAgentWrite(mysql)];
  const originalTime = new Date('2020-01-02T03:04:05.123Z');
  for (const model of models) {
    const fields =
      model.name === 'D2cAgentCheckpoint'
        ? {
            checkpoint: null,
            checkpointRef: { probe: true },
            metadata: null,
            metadataRef: { probe: true },
          }
        : { value: null, valueRef: { probe: true } };
    const [count] = await model.scope('checkpointBody').update(
      { ...fields, updatedAt: originalTime },
      {
        where: { id: '1', sessionId },
        silent: true,
        hooks: false,
      },
    );
    assert.equal(count, 1);
    const statement = statements.at(-1)!;
    assert.match(statement.sql, /SET[\s\S]*`datachange_lasttime`\s*=/);
    assert.match(JSON.stringify(statement), /2020-01-02 03:04:05\.123/);
    if (model.name === 'D2cAgentWrite') assert.match(statement.sql, /`writeRef`\s*=/);
    else {
      assert.match(statement.sql, /`checkpointRef`\s*=/);
      assert.match(statement.sql, /`metadataRef`\s*=/);
    }
  }
});
