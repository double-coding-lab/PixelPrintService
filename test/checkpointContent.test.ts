import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { Op, Transaction, type Sequelize } from 'sequelize';
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph';
import {
  emptyCheckpoint,
  ERROR,
  TASKS,
  type Checkpoint,
  type CheckpointMetadata,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import {
  createRunCheckpointSaver,
  D2cMySQLCheckpointSaver,
  type WithCheckpointLease,
} from '../src/functions/d2c/run/agent/checkpoint';
import { createHistoryArchive } from '../src/functions/d2c/run/agent/archive';
import { createRecoveryMarker } from '../src/functions/d2c/run/agent/checkpoint';
import { SessionError } from '../src/functions/d2c/session/access';
import type { createRunLeases } from '../src/functions/d2c/run/leases';
import type { D2cSession } from '../src/models/D2cSession';
import { enableCheckpointStorage } from './helpers/checkpointStorage';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const otherSessionId = '12345678-1234-1234-1234-123456789abd';
const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };
type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
type Query = {
  transaction: Tx;
  where?: Row;
  attributes?: string[];
  order?: [string, string][];
  limit?: number;
  lock?: string;
};
type Tx = {
  sequelize: unknown;
  tables: Tables;
  active: boolean;
  leased: boolean;
  id: number;
  LOCK: { UPDATE: string };
};
const copy = <T>(value: T): T => deserialize(serialize(value));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** 专用MVCC/租约事务替身；读取、排序投影、scope和回滚独立验证，不连接MySQL/存储。 */
function fixture(
  mode?: 'inline' | 'shadow' | 'external',
  threshold = 1,
  limits?: { maxBytes?: number; maxObjectBytes?: number },
) {
  let tables: Tables = { D2cAgentCheckpoint: [], D2cAgentWrite: [] };
  const context = new AsyncLocalStorage<Tx>();
  const queries: Array<{
    table: string;
    attributes?: string[];
    transaction: number;
    ordered: boolean;
  }> = [];
  const state = {
    lease: true,
    lostAtCommit: false,
    mutations: 0,
    failAt: -1,
    transactions: 0,
    serdeLoads: 0,
    serdeDumps: 0,
  };
  let tail = Promise.resolve();
  const mysql = {
    models: {} as Record<string, unknown>,
    async transaction<T>(options: unknown, action?: (transaction: Tx) => Promise<T>): Promise<T> {
      const callback = (typeof options === 'function' ? options : action) as (
        transaction: Tx,
      ) => Promise<T>;
      if (typeof options !== 'function')
        assert.equal((options as Row).isolationLevel, Transaction.ISOLATION_LEVELS.REPEATABLE_READ);
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const tx: Tx = {
        sequelize: mysql,
        tables: copy(tables),
        active: true,
        leased: false,
        id: ++state.transactions,
        LOCK: { UPDATE: 'UPDATE' },
      };
      try {
        const value = await context.run(tx, () => callback(tx));
        tables = tx.tables;
        return value;
      } finally {
        tx.active = false;
        release();
      }
    },
  } as unknown as Sequelize;
  /** SQL条件与二段排序读取使用真实键语义，payload/ref不允许进入排序投影。 */
  function matches(row: Row, where: Row = {}): boolean {
    return Reflect.ownKeys(where).every((key) => {
      const value = where[key as string];
      if (key === Op.and) return value.every((part: Row) => matches(row, part));
      if (key === Op.or) return value.some((part: Row) => matches(row, part));
      if (value && typeof value === 'object') {
        if (Op.in in value) return value[Op.in].includes(row[key as string]);
        const compare = (other: unknown) =>
          Buffer.compare(Buffer.from(String(row[key as string])), Buffer.from(String(other)));
        if (Op.lt in value) return compare(value[Op.lt]) < 0;
        if (Op.gt in value) return compare(value[Op.gt]) > 0;
      }
      return row[key as string] === value;
    });
  }
  function rows(table: string, query: Query) {
    assert.equal(query.transaction, context.getStore());
    assert.equal(query.transaction.sequelize, mysql);
    assert.equal(query.transaction.active, true);
    return query.transaction.tables[table];
  }
  function mutate(query: Query) {
    assert.equal(query.transaction.leased, true);
    if (++state.mutations === state.failAt) throw new Error('private offline SQL failure');
  }
  for (const table of Object.keys(tables)) {
    const references =
      table === 'D2cAgentCheckpoint' ? ['checkpointRef', 'metadataRef'] : ['valueRef'];
    function model(scoped = false): Row {
      const select = (row: Row, query: Query) => {
        const result = copy(row);
        if (!scoped) for (const field of references) delete result[field];
        if (query.attributes) {
          if (mode === undefined)
            assert.ok(
              query.attributes.every((field) => !references.includes(field)),
              '旧schema不得查询新列',
            );
          return Object.fromEntries(query.attributes.map((field) => [field, result[field]]));
        }
        return result;
      };
      return {
        scope(name: string) {
          assert.notEqual(mode, undefined, '旧schema不得启用新scope');
          assert.equal(name, 'checkpointBody');
          return model(true);
        },
        async findAll(query: Query) {
          queries.push({
            table,
            attributes: query.attributes,
            transaction: query.transaction.id,
            ordered: !!query.order,
          });
          if (query.order) assert.deepEqual(query.attributes, ['namespaceHash', 'checkpointId']);
          let result = rows(table, query).filter((row) => matches(row, query.where));
          result.sort((a, b) => {
            for (const [field, direction] of query.order ?? []) {
              const difference = Buffer.compare(
                Buffer.from(String(a[field])),
                Buffer.from(String(b[field])),
              );
              if (difference) return direction === 'DESC' ? -difference : difference;
            }
            return 0;
          });
          if (query.limit !== undefined) result = result.slice(0, query.limit);
          return result.map((row) => select(row, query));
        },
        async findOne(query: Query) {
          queries.push({
            table,
            attributes: query.attributes,
            transaction: query.transaction.id,
            ordered: false,
          });
          const row = rows(table, query).find((row) => matches(row, query.where));
          return row ? select(row, query) : null;
        },
        async create(value: Row, query: Query) {
          mutate(query);
          if (mode === undefined)
            assert.ok(references.every((field) => !Object.hasOwn(value, field)));
          rows(table, query).push(copy(value));
          return copy(value);
        },
        async update(value: Row, query: Query) {
          mutate(query);
          assert.equal(query.lock, undefined);
          if (mode === undefined)
            assert.ok(references.every((field) => !Object.hasOwn(value, field)));
          const selected = rows(table, query).filter((row) => matches(row, query.where));
          selected.forEach((row) => Object.assign(row, copy(value)));
          return [selected.length];
        },
        async destroy(query: Query) {
          mutate(query);
          query.transaction.tables[table] = rows(table, query).filter(
            (row) => !matches(row, query.where),
          );
        },
      };
    }
    mysql.models[table] = model() as never;
  }
  const withLease: WithCheckpointLease = (action) =>
    mysql.transaction(async (transaction) => {
      const tx = transaction as unknown as Tx;
      if (!state.lease) throw new SessionError(409, 'LEASE_LOST', 'lease lost');
      tx.leased = true;
      const result = await action(transaction);
      if (state.lostAtCommit) throw new SessionError(409, 'LEASE_LOST', 'lease lost at commit');
      return result;
    });
  /** 非UTF8头保证实现不能把typed bytes解码为字符串再写回。 */
  let serdeType = 'binary-v1';
  const serde: SerializerProtocol = {
    async dumpsTyped(value) {
      assert.notEqual(context.getStore()?.active, true, 'serde dump必须在租约事务外');
      state.serdeDumps++;
      return [serdeType, Buffer.concat([Buffer.from([0, 255, 128]), serialize(value)])];
    },
    async loadsTyped(type, bytes) {
      assert.notEqual(context.getStore()?.active, true, 'serde restore不得位于读取事务内');
      assert.match(type, /^binary-v[12]$/);
      const payload = Buffer.from(bytes);
      assert.deepEqual(payload.subarray(0, 3), Buffer.from([0, 255, 128]));
      state.serdeLoads++;
      return deserialize(payload.subarray(3));
    },
  };
  const storage = enableCheckpointStorage(mysql, mode ?? 'external', threshold, limits);
  const signals: Array<AbortSignal | undefined> = [];
  let onPut: (() => void | Promise<void>) | undefined;
  let onGet: (() => void | Promise<void>) | undefined;
  if (storage) {
    const put = storage.backend.put;
    storage.backend.put = async (input) => {
      assert.notEqual(context.getStore()?.active, true, '正文上传不得位于租约事务内');
      signals.push(input.signal);
      const result = await put(input);
      await onPut?.();
      return result;
    };
    const get = storage.backend.get;
    storage.backend.get = async (locator, input) => {
      assert.notEqual(context.getStore()?.active, true, '正文下载不得位于数据库事务内');
      signals.push(input.signal);
      const result = await get(locator, input);
      await onGet?.();
      return result;
    };
  }
  const make = (
    customSerde: SerializerProtocol | null = serde,
    signal?: AbortSignal,
    id = sessionId,
  ) =>
    new D2cMySQLCheckpointSaver({
      sessionId: id,
      sequelize: mysql,
      withLease,
      serde: customSerde ?? undefined,
      signal,
    });
  const lease = { sessionId, runId: 'run-a', owner: 'owner-a' };
  const leases: Pick<ReturnType<typeof createRunLeases>, 'commit'> = {
    commit: <T>(
      _lease: typeof lease,
      action: (session: D2cSession, transaction: Transaction) => Promise<T>,
    ) => withLease((tx) => action({ sessionId } as D2cSession, tx)),
  };
  return {
    mysql,
    withLease,
    state,
    storage,
    serde,
    make,
    signals,
    queries,
    context,
    lease,
    leases,
    rows: () => tables,
    setType: (type: string) => {
      serdeType = type;
    },
    onPut: (action?: () => void | Promise<void>) => {
      onPut = action;
    },
    onGet: (action?: () => void | Promise<void>) => {
      onGet = action;
    },
  };
}

function checkpoint(id: string, values: Record<string, unknown> = {}): Checkpoint {
  return {
    ...emptyCheckpoint(),
    id,
    channel_values: values,
    channel_versions: { unchanged: 9, updated: 2 },
  };
}
async function history(saver: D2cMySQLCheckpointSaver, namespace?: string, options = {}) {
  const result = [];
  for await (const tuple of saver.list(
    {
      configurable: {
        thread_id: saver.threadId,
        ...(namespace === undefined ? {} : { checkpoint_ns: namespace }),
      },
    },
    options,
  ))
    result.push(tuple);
  return result;
}

for (const mode of ['inline', 'shadow', 'external'] as const) {
  test(`checkpoint ${mode ?? 'disabled'}: 任意typed bytes、metadata及writes跨saver还原，IO/serde不在事务内`, async () => {
    const f = fixture(mode);
    const saver = f.make();
    const config = await saver.put(
      saver.config('ns'),
      checkpoint('first', { blob: Buffer.from([255, 0, 128]), nil: null, empty: '', zero: 0 }),
      metadata,
      {},
    );
    await saver.putWrites(
      config,
      [
        ['empty', null],
        ['blob', Buffer.from([0, 254])],
      ],
      'task',
      'a',
    );
    const row = f.rows().D2cAgentCheckpoint[0];
    assert.equal(row.checkpoint, null);
    assert.equal(row.metadata, null);
    assert.ok(row.checkpointRef && row.metadataRef);
    assert.equal(f.storage!.objects.size, 4);
    const tuple = await f.make().getTuple(config);
    assert.deepEqual(tuple!.checkpoint.channel_values, {
      blob: Buffer.from([255, 0, 128]),
      nil: null,
      empty: '',
      zero: 0,
    });
    assert.deepEqual(tuple!.metadata, metadata);
    assert.deepEqual(tuple!.pendingWrites, [
      ['task', 'empty', null],
      ['task', 'blob', Buffer.from([0, 254])],
    ]);
    assert.equal((await history(f.make(), 'ns')).length, 1);
  });
}

test('所有新正文外置，旧writer的BLOB优先可读，再次写入更新引用且忽略旧阈值', async () => {
  const f = fixture('external');
  const saver = f.make();
  const external = await saver.put(
    saver.config(),
    checkpoint('external', { version: 'external' }),
    metadata,
    {},
  );
  f.storage!.configure({ mode: 'shadow' });
  const shadow = await saver.put(
    saver.config(),
    checkpoint('shadow', { version: 'shadow' }),
    metadata,
    {},
  );
  f.storage!.configure({ mode: 'inline' });
  const inline = await saver.put(
    saver.config(),
    checkpoint('inline', { version: 'inline' }),
    metadata,
    {},
  );
  for (const config of [external, shadow, inline]) assert.ok(await f.make().getTuple(config));
  const row = f.rows().D2cAgentCheckpoint.find((row) => row.checkpointId === 'external')!;
  const oldRef = copy(row.checkpointRef);
  const [type, bytes] = await f.serde.dumpsTyped(checkpoint('external', { version: 'old writer' }));
  row.checkpoint = Buffer.from(bytes);
  row.checkpointType = type;
  const [metadataType, metadataBytes] = await f.serde.dumpsTyped(metadata);
  row.metadata = Buffer.from(metadataBytes);
  row.metadataType = metadataType;
  f.storage!.objects.delete(String(oldRef.locator.key));
  const before = [...f.storage!.operations];
  assert.deepEqual((await f.make().getTuple(external))!.checkpoint.channel_values, {
    version: 'old writer',
  });
  assert.deepEqual(f.storage!.operations, before);
  await saver.put(
    saver.config(),
    checkpoint('external', { version: 'inline rewrite' }),
    metadata,
    {},
  );
  const rewritten = f.rows().D2cAgentCheckpoint.find((row) => row.checkpointId === 'external')!;
  assert.equal(rewritten.checkpoint, null);
  assert.notEqual(rewritten.checkpointRef.objectId, oldRef.objectId);
  f.storage!.configure({ mode: 'external', thresholdBytes: 2097152 });
  await saver.put(saver.config(), checkpoint('small'), metadata, {});
  assert.ok(f.rows().D2cAgentCheckpoint.at(-1)!.checkpointRef);
});

test('external pending普通first-wins，特殊negative last-wins；失败整批回滚不改历史', async () => {
  const f = fixture('external');
  const saver = f.make();
  const config = await saver.put(saver.config(), checkpoint('cp'), metadata, {});
  await saver.putWrites(
    config,
    [
      ['normal', 'first'],
      [ERROR, 'first error'],
    ],
    'task',
  );
  const original = copy(f.rows().D2cAgentWrite.find((row) => row.idx >= 0));
  await saver.putWrites(
    config,
    [
      ['normal', 'ignored'],
      [ERROR, 'last error'],
    ],
    'task',
  );
  assert.deepEqual(
    f.rows().D2cAgentWrite.find((row) => row.idx >= 0),
    original,
  );
  assert.deepEqual((await f.make().getTuple(config))!.pendingWrites, [
    ['task', ERROR, 'last error'],
    ['task', 'normal', 'first'],
  ]);
  const before = copy(f.rows());
  f.state.failAt = f.state.mutations + 2;
  await assert.rejects(
    saver.putWrites(
      config,
      [
        ['a', 1],
        ['b', 2],
      ],
      'new-task',
    ),
    /offline SQL failure/,
  );
  assert.deepEqual(f.rows(), before);
});

test('普通重复write在backend拒绝上传时仍first-wins且不序列化，但最终仍校验租约；negative不跳过', async (t) => {
  const f = fixture('external');
  const saver = f.make();
  const config = await saver.put(saver.config(), checkpoint('cp'), metadata, {});
  await saver.putWrites(
    config,
    [
      ['normal', 'first'],
      [ERROR, 'first error'],
    ],
    'task',
  );
  const before = copy(f.rows());
  const dumps = f.state.serdeDumps;
  const operations = [...f.storage!.operations];
  let attempts = 0;
  t.mock.method(f.storage!.backend, 'put', async () => {
    attempts++;
    throw new Error('object service unavailable');
  });
  // This function is intentionally not serializable; an ignored replay must never inspect it.
  await saver.putWrites(config, [['normal', () => undefined]], 'task');
  assert.equal(attempts, 0);
  assert.equal(f.state.serdeDumps, dumps);
  assert.deepEqual(f.storage!.operations, operations);
  assert.deepEqual(f.rows(), before);
  f.state.lease = false;
  await assert.rejects(saver.putWrites(config, [['normal', () => undefined]], 'task'), {
    reason: 'LEASE_LOST',
  });
  assert.equal(attempts, 0);
  assert.equal(f.state.serdeDumps, dumps);
  f.state.lease = true;
  await assert.rejects(saver.putWrites(config, [[ERROR, 'new error']], 'task'), {
    code: 'UPLOAD_FAILED',
  });
  assert.equal(attempts, 1);
  assert.equal(f.state.serdeDumps, dumps + 1);
  assert.deepEqual(f.rows(), before);
});

test('普通write准备期间竞争者先提交时最终事务仍first-wins', async () => {
  const f = fixture('external');
  const saver = f.make();
  const config = await saver.put(saver.config(), checkpoint('cp'), metadata, {});
  let once = false;
  f.onPut(async () => {
    if (once) return;
    once = true;
    f.storage!.configure({ mode: 'inline' });
    await saver.putWrites(config, [['normal', 'competitor']], 'task');
    f.storage!.configure({ mode: 'external' });
  });
  await saver.putWrites(config, [['normal', 'late upload']], 'task');
  assert.deepEqual((await saver.getTuple(config))!.pendingWrites, [
    ['task', 'normal', 'competitor'],
  ]);
  assert.equal(f.rows().D2cAgentWrite.length, 1);
});

test('超过对象队列容量的72个大value逐项序列化/上传，无BUSY且保留顺序和negative last-wins', async (t) => {
  const f = fixture('external');
  const saver = f.make();
  const config = await saver.put(saver.config(), checkpoint('batch'), metadata, {});
  const normal = Array.from(
    { length: 72 },
    (_, index) =>
      [`value-${String(index).padStart(3, '0')}`, randomBytes(64 * 1024)] as [string, Buffer],
  );
  let active = 0,
    maximum = 0,
    serializing = 0,
    maximumSerializing = 0;
  async function transport<T>(action: () => Promise<T>): Promise<T> {
    maximum = Math.max(maximum, ++active);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await action();
    } finally {
      active--;
    }
  }
  const put = f.storage!.backend.put;
  const get = f.storage!.backend.get;
  t.mock.method(f.storage!.backend, 'put', (input: Parameters<typeof put>[0]) =>
    transport(() => put(input)),
  );
  t.mock.method(f.storage!.backend, 'get', (...args: Parameters<typeof get>) =>
    transport(() => get(...args)),
  );
  const dump = f.serde.dumpsTyped.bind(f.serde);
  t.mock.method(f.serde, 'dumpsTyped', async (value: unknown) => {
    maximumSerializing = Math.max(maximumSerializing, ++serializing);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await dump(value);
    } finally {
      serializing--;
    }
  });
  await saver.putWrites(config, [...normal, [ERROR, 'first'], [ERROR, 'last']], 'task');
  assert.equal(maximum, 1);
  assert.equal(maximumSerializing, 1);
  assert.deepEqual(
    f
      .rows()
      .D2cAgentWrite.filter((row) => row.idx >= 0)
      .map((row) => row.idx),
    Array.from({ length: 72 }, (_, index) => index),
  );
  const tuple = await f.make().getTuple(config);
  assert.deepEqual(tuple!.pendingWrites![0], ['task', ERROR, 'last']);
  assert.deepEqual(
    tuple!.pendingWrites!.slice(1),
    normal.map(([channel, value]) => ['task', channel, value]),
  );
});

test('普通预检已存在的行提交前消失时明确失败，不能静默丢写或在锁内补上传', async () => {
  const f = fixture('external');
  const config = await f.make().put(f.make().config(), checkpoint('cp'), metadata, {});
  await f.make().putWrites(config, [['normal', 'first']], 'task');
  const saver = new D2cMySQLCheckpointSaver({
    sessionId,
    sequelize: f.mysql,
    serde: f.serde,
    withLease: (action) => {
      f.rows().D2cAgentWrite = [];
      return f.withLease(action);
    },
  });
  const operations = [...f.storage!.operations];
  await assert.rejects(
    saver.putWrites(config, [['normal', 'replay']], 'task'),
    /disappeared during preparation/,
  );
  assert.deepEqual(f.storage!.operations, operations);
  assert.equal(f.rows().D2cAgentWrite.length, 0);
});

test('namespace/会话/typed编码/行身份及task串引用均在restore前失败', async (t) => {
  for (const kind of [
    'namespace',
    'sessionRef',
    'session',
    'type',
    'checkpointId',
    'task',
    'writeType',
    'metadata',
  ] as const) {
    await t.test(kind, async () => {
      const f = fixture('external');
      const saver = f.make();
      const a = await saver.put(saver.config('a'), checkpoint('same'), metadata, {});
      await saver.put(saver.config('b'), checkpoint('same'), metadata, {});
      await saver.put(saver.config('a'), checkpoint('other'), metadata, {});
      if (kind === 'sessionRef') {
        const other = f.make(f.serde, undefined, otherSessionId);
        await other.put(other.config('a'), checkpoint('same'), metadata, {});
      }
      await saver.putWrites(a, [['normal', 'first']], 'one');
      await saver.putWrites(a, [['normal', 'second']], 'two');
      const row = f.rows().D2cAgentCheckpoint[0];
      if (kind === 'namespace') row.checkpointRef = f.rows().D2cAgentCheckpoint[1].checkpointRef;
      if (kind === 'sessionRef') row.checkpointRef = f.rows().D2cAgentCheckpoint[3].checkpointRef;
      if (kind === 'session') row.sessionId = otherSessionId;
      if (kind === 'type') row.checkpointType = 'binary-v2';
      if (kind === 'checkpointId') row.checkpointRef = f.rows().D2cAgentCheckpoint[2].checkpointRef;
      if (kind === 'task') f.rows().D2cAgentWrite[0].valueRef = f.rows().D2cAgentWrite[1].valueRef;
      if (kind === 'writeType') f.rows().D2cAgentWrite[0].valueType = 'binary-v2';
      if (kind === 'metadata') row.metadataRef = row.checkpointRef;
      const rows = copy(f.rows());
      if (kind === 'session') assert.equal(await saver.getTuple(a), undefined);
      else await assert.rejects(saver.getTuple(a));
      assert.deepEqual(f.rows(), rows, '失败读取不得重建或清空历史');
    });
  }
});

test('外置父链delta和旧v3 parent TASKS遵守SDK顺序且不串namespace', async () => {
  const f = fixture('external');
  const saver = f.make();
  const parent = await saver.put(
    saver.config('ns'),
    checkpoint('root', { delta: ['seed'] }),
    metadata,
    {},
  );
  await saver.putWrites(parent, [['delta', 'second']], 'a', 'z');
  await saver.putWrites(parent, [['delta', 'first']], 'z', 'a');
  const child = await saver.put(parent, checkpoint('child'), metadata, {});
  assert.deepEqual(await f.make().getDeltaChannelHistory({ config: child, channels: ['delta'] }), {
    delta: {
      seed: ['seed'],
      writes: [
        ['z', 'delta', 'first'],
        ['a', 'delta', 'second'],
      ],
    },
  });
  await saver.putWrites(parent, [[TASKS, { node: 'old' }]], 'task');
  const legacy = checkpoint('legacy');
  legacy.v = 3;
  const config = await saver.put(parent, legacy, metadata, {});
  const tuple = await f.make().getTuple(config);
  assert.deepEqual(tuple!.checkpoint.channel_values[TASKS], [{ node: 'old' }]);
  assert.equal(tuple!.checkpoint.channel_versions[TASKS], 9);
  assert.deepEqual(tuple!.parentConfig, parent);
});

test('REPEATABLE_READ冻结checkpoint/metadata/pending/父writes后才解密，并发覆盖只影响下次读取', async () => {
  const f = fixture('external');
  const saver = f.make();
  const parent = await saver.put(saver.config(), checkpoint('parent'), metadata, {});
  await saver.putWrites(parent, [[TASKS, 'old parent']], 'p');
  const legacy = checkpoint('child', { version: 'old' });
  legacy.v = 3;
  const config = await saver.put(parent, legacy, metadata, {});
  await saver.putWrites(config, [[ERROR, 'old pending']], 'c');
  let changed = false;
  f.onGet(async () => {
    if (changed) return;
    changed = true;
    await saver.put(
      parent,
      { ...legacy, channel_values: { version: 'new' } },
      { ...metadata, step: 2 },
      {},
    );
    await saver.putWrites(parent, [[TASKS, 'new parent']], 'p');
    await saver.putWrites(config, [[ERROR, 'new pending']], 'c');
  });
  const tuple = await saver.getTuple(config);
  assert.equal(tuple!.checkpoint.channel_values.version, 'old');
  assert.deepEqual(tuple!.checkpoint.channel_values[TASKS], ['old parent']);
  assert.equal(tuple!.metadata!.step, 1);
  assert.deepEqual(tuple!.pendingWrites, [['c', ERROR, 'old pending']]);
  assert.equal((await saver.getTuple(config))!.metadata!.step, 2);
});

test('list分页metadata、匹配项才读取payload，按需yield且跨页无长事务', async () => {
  const f = fixture('external');
  const saver = f.make();
  for (let i = 0; i < 55; i++)
    await saver.put(
      saver.config(i % 2 ? 'odd' : 'even'),
      checkpoint(`c${String(i).padStart(3, '0')}`),
      { ...metadata, step: i === 1 ? 2 : 1 },
      {},
    );
  // The nonmatching payload can be unavailable without affecting a metadata-only filter.
  const unavailable = f.rows().D2cAgentCheckpoint.at(-1)!;
  f.storage!.objects.delete(String(unavailable.checkpointRef.locator.key));
  const matches = await history(saver, undefined, { filter: { step: 2 }, limit: 1 });
  assert.equal(matches[0].checkpoint.id, 'c001');
  assert.equal(matches.length, 1);
  const pages = f.queries.filter((query) => query.ordered && query.attributes?.length === 2);
  assert.equal(pages.length, 2);
  const restoredBefore = f.state.serdeLoads;
  const generator = saver.list(saver.config('odd'), { limit: 2 });
  assert.equal((await generator.next()).value!.checkpoint.id, 'c053');
  assert.equal(f.state.serdeLoads - restoredBefore, 2, '第一次yield不得预加载其余tuple正文');
  assert.notEqual(f.context.getStore()?.active, true);
  await generator.return(undefined);
  assert.equal(f.state.serdeLoads - restoredBefore, 2);
  assert.equal(
    (await history(saver, 'odd', { before: saver.config('odd', 'c005') }))
      .map((tuple) => tuple.checkpoint.id)
      .join(','),
    'c003,c001',
  );
});

test('list元数据筛选与完整tuple之间并发变化时复核filter，limit只计算真实匹配', async () => {
  const f = fixture('external');
  const saver = f.make();
  await saver.put(saver.config(), checkpoint('a'), { ...metadata, step: 1 }, {});
  await saver.put(saver.config(), checkpoint('z'), { ...metadata, step: 1 }, {});
  let changed = false;
  f.onGet(async () => {
    if (changed) return;
    changed = true;
    await saver.put(saver.config(), checkpoint('z'), { ...metadata, step: 2 }, {});
  });
  assert.deepEqual(
    (await history(saver, '', { filter: { step: 1 }, limit: 1 })).map(
      (tuple) => tuple.checkpoint.id,
    ),
    ['a'],
  );
});

test('真实LangGraph暂停恢复跨外置saver实例，先前节点不重复执行', async () => {
  const f = fixture('external');
  const State = Annotation.Root({ count: Annotation<number>, accepted: Annotation<boolean> });
  let executions = 0;
  const graph = () =>
    new StateGraph(State)
      .addNode('first', (state) => {
        executions++;
        return { count: state.count + 1 };
      })
      .addNode('approve', () => ({ accepted: interrupt('approve?') as boolean }))
      .addEdge(START, 'first')
      .addEdge('first', 'approve')
      .addEdge('approve', END)
      .compile({ checkpointer: f.make(null) });
  // Use the SDK serde to exercise actual graph objects and typed values.
  const config = f.make().config();
  await graph().invoke({ count: 0 }, config);
  const resumed = await graph().invoke(new Command({ resume: true }), config);
  assert.equal(resumed.count, 1);
  assert.equal(resumed.accepted, true);
  assert.equal(executions, 1);
});

/** 真实框架失败后跨saver恢复，已完成兄弟任务的外置pending writes必须被复用。 */
test('真实LangGraph并行任务失败后跨外置saver恢复，只重试失败节点', async () => {
  const f = fixture('external');
  const State = Annotation.Root({
    items: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  });
  let completedRuns = 0;
  let shouldFail = true;
  const graph = () =>
    new StateGraph(State)
      .addNode('completed', () => {
        completedRuns++;
        return { items: ['once'] };
      })
      .addNode('retry', () => {
        if (shouldFail) throw new Error('offline sibling failed');
        return { items: ['retry'] };
      })
      .addEdge(START, 'completed')
      .addEdge(START, 'retry')
      .addEdge('completed', END)
      .addEdge('retry', END)
      .compile({ checkpointer: f.make(null) });
  const config = f.make().config();
  await assert.rejects(graph().invoke({ items: [] }, config), /offline sibling failed/);
  assert.equal(completedRuns, 1);
  assert.ok(
    f.rows().D2cAgentCheckpoint.some((row) => row.checkpoint === null && row.checkpointRef),
  );
  assert.ok(f.rows().D2cAgentWrite.some((row) => row.value === null && row.valueRef));
  shouldFail = false;
  const result = await graph().invoke(null, config);
  assert.equal(completedRuns, 1);
  assert.deepEqual(result.items.slice().sort(), ['once', 'retry']);
});

test('恢复门禁和内部历史归档跨外置saver实例恢复，不创建替代会话/历史', async () => {
  const f = fixture('external');
  const marker = createRecoveryMarker(f.make());
  await marker.set(true);
  assert.equal(await createRecoveryMarker(f.make()).pending(), true);
  const archive = createHistoryArchive({ checkpoint: f.make(), guard: async () => undefined });
  await archive.save('/history/context.json', 'private history 中文');
  const restored = createHistoryArchive({ checkpoint: f.make(), guard: async () => undefined });
  assert.equal(await restored.load('/history/context.json'), 'private history 中文');
  await createRecoveryMarker(f.make()).set(false);
  assert.equal(await createRecoveryMarker(f.make()).pending(), false);
  assert.equal(f.rows().D2cAgentCheckpoint.length, 2);
});

test('上传后失租或提交时失租拒绝引用提交，旧checkpoint/writes保持不变', async (t) => {
  for (const kind of ['before', 'commit'] as const) {
    await t.test(kind, async () => {
      const f = fixture('external');
      const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease);
      const config = await saver.put(saver.config(), checkpoint('root'), metadata, {});
      const before = copy(f.rows());
      f.onPut(() => {
        if (kind === 'before') f.state.lease = false;
        else f.state.lostAtCommit = true;
      });
      await assert.rejects(saver.put(saver.config(), checkpoint('new'), metadata, {}), {
        code: 'LEASE_LOST',
      });
      await assert.rejects(saver.putWrites(config, [['value', 'new']], 'new-task'), {
        code: 'LEASE_LOST',
      });
      assert.deepEqual(f.rows(), before);
      assert.ok(f.storage!.objects.size > 2, '上传失败提交只留下未引用不可变对象');
    });
  }
});

test('上传/DB/缺失/损坏故障明确失败且不清空历史，Run工厂保留STORAGE_FAILED分类', async (t) => {
  for (const failure of ['upload', 'database', 'missing', 'corrupt'] as const) {
    await t.test(failure, async () => {
      const f = fixture('external');
      const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease);
      const config = await saver.put(saver.config(), checkpoint('root'), metadata, {});
      const before = copy(f.rows());
      if (failure === 'upload')
        f.onPut(() => {
          throw new Error('private storage credentials');
        });
      if (failure === 'database') f.state.failAt = f.state.mutations + 1;
      if (failure === 'missing') f.storage!.objects.clear();
      if (failure === 'corrupt') {
        const bytes = [...f.storage!.objects.values()][0];
        bytes[bytes.length - 1] ^= 1;
      }
      await assert.rejects(
        failure === 'upload' || failure === 'database'
          ? saver.put(saver.config(), checkpoint('new'), metadata, {})
          : saver.getTuple(config),
        (error: unknown) => {
          assert.ok(error instanceof Error && 'code' in error);
          assert.equal(error.code, 'STORAGE_FAILED');
          assert.doesNotMatch(error.message, /credentials|d2c-bodies|locator|private/);
          return true;
        },
      );
      assert.deepEqual(f.rows(), before);
    });
  }
});

test('signal只由调用者传递，取消不提交DB，旧三参工厂仍可用', async () => {
  const f = fixture('external');
  const controller = new AbortController();
  const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease, controller.signal);
  const config = await saver.put(saver.config(), checkpoint('root'), metadata, {});
  await saver.getTuple(config);
  assert.ok(f.signals.length > 0 && f.signals.every((signal) => signal === controller.signal));
  controller.abort();
  const before = copy(f.rows());
  await assert.rejects(saver.put(saver.config(), checkpoint('aborted'), metadata, {}), {
    name: 'AbortError',
  });
  await assert.rejects(saver.getTuple(config), { name: 'AbortError' });
  assert.deepEqual(f.rows(), before);
  assert.ok(await createRunCheckpointSaver(f.mysql, f.leases, f.lease).getTuple(config));
});

test('等待lease期间取消后callback零写入，put/putWrites/deleteThread保留原数据与取消原因', async (t) => {
  for (const operation of ['put', 'putWrites', 'deleteThread'] as const) {
    for (const reason of ['default', 'error', 'object'] as const) {
      await t.test(`${operation}/${reason}`, async () => {
        const f = fixture('external');
        const seed = f.make();
        const config = await seed.put(seed.config(), checkpoint('root'), metadata, {});
        await seed.putWrites(
          config,
          [
            ['normal', 'original'],
            [ERROR, 'original error'],
          ],
          'seed',
        );
        const controller = new AbortController();
        const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease, controller.signal);
        const before = copy(f.rows());
        const mutations = f.state.mutations;
        let entered!: () => void;
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const commit = f.leases.commit;
        f.leases.commit = async (lease, action) => {
          entered();
          await blocked;
          return commit(lease, action);
        };
        const pending =
          operation === 'put'
            ? saver.put(saver.config(), checkpoint('root', { changed: true }), metadata, {})
            : operation === 'putWrites'
              ? saver.putWrites(config, [['normal', 'changed']], 'new-task')
              : saver.deleteThread(saver.threadId);
        // Attach the rejection handler before releasing the deterministic lease barrier.
        const rejected = assert.rejects(
          pending,
          (error: unknown) => error === controller.signal.reason,
        );
        await waiting;
        if (reason === 'default') controller.abort();
        else
          controller.abort(
            reason === 'error' ? new Error('caller cancelled') : { cancellation: 'caller' },
          );
        release();
        await rejected;
        assert.equal(f.state.mutations, mutations, '取消后不得进入租约callback的行修改');
        assert.deepEqual(f.rows(), before);
      });
    }
  }
});

test('checkpoint update、最后write和delete执行后取消仍在租约事务内抛出并完整回滚', async (t) => {
  for (const operation of [
    'checkpoint-update',
    'last-write',
    'first-delete',
    'last-delete',
  ] as const) {
    for (const reason of ['default', 'custom'] as const) {
      await t.test(`${operation}/${reason}`, async (t) => {
        const f = fixture('external');
        const seed = f.make();
        const config = await seed.put(
          seed.config(),
          checkpoint('root', { original: true }),
          metadata,
          {},
        );
        await seed.putWrites(config, [[ERROR, 'original error']], 'task');
        const before = copy(f.rows());
        const controller = new AbortController();
        const saver = createRunCheckpointSaver(f.mysql, f.leases, f.lease, controller.signal);
        const abort = () => {
          assert.equal(f.context.getStore()?.active, true);
          if (reason === 'default') controller.abort();
          else controller.abort(new Error('custom caller cancellation'));
        };
        const checkpoints = f.mysql.models.D2cAgentCheckpoint;
        const writes = f.mysql.models.D2cAgentWrite;
        let mutationObserved = false;
        if (operation === 'checkpoint-update') {
          const update = checkpoints.update.bind(checkpoints);
          t.mock.method(checkpoints, 'update', async (...args: Parameters<typeof update>) => {
            const result = await update(...args);
            assert.notDeepEqual(f.context.getStore()!.tables, before);
            mutationObserved = true;
            abort();
            return result;
          });
        } else if (operation === 'last-write') {
          const create = writes.create.bind(writes);
          t.mock.method(writes, 'create', async (...args: Parameters<typeof create>) => {
            const result = await create(...args);
            assert.equal(
              f.context.getStore()!.tables.D2cAgentWrite.length,
              2,
              '固定锁序先更新负索引write，再创建末条普通write',
            );
            mutationObserved = true;
            abort();
            return result;
          });
        } else {
          const model = operation === 'first-delete' ? writes : checkpoints;
          const destroy = model.destroy.bind(model);
          t.mock.method(model, 'destroy', async (...args: Parameters<typeof destroy>) => {
            const result = await destroy(...args);
            assert.equal(f.context.getStore()!.tables.D2cAgentWrite.length, 0);
            if (operation === 'last-delete')
              assert.equal(f.context.getStore()!.tables.D2cAgentCheckpoint.length, 0);
            mutationObserved = true;
            abort();
            return result;
          });
        }
        const pending =
          operation === 'checkpoint-update'
            ? saver.put(saver.config(), checkpoint('root', { changed: true }), metadata, {})
            : operation === 'last-write'
              ? saver.putWrites(
                  config,
                  [
                    ['normal', 'new'],
                    [ERROR, 'changed error'],
                  ],
                  'task',
                )
              : saver.deleteThread(saver.threadId);
        await assert.rejects(pending, (error: unknown) => error === controller.signal.reason);
        assert.equal(mutationObserved, true);
        assert.deepEqual(f.rows(), before, '取消必须回滚checkpoint及整批writes/delete');
        assert.deepEqual((await seed.getTuple(config))!.checkpoint.channel_values, {
          original: true,
        });
        assert.deepEqual((await seed.getTuple(config))!.pendingWrites, [
          ['task', ERROR, 'original error'],
        ]);
      });
    }
  }
});

/** 正式保存器经真实typed序列化、分块协议和租约事务，只把小引用提交到两张表。 */
test('checkpoint metadata and pending writes use files across saver reconstruction, with multipart large typed values', async () => {
  const f = fixture('external', 2097152, { maxBytes: 4194304, maxObjectBytes: 1048576 });
  const saver = f.make();
  const data = randomBytes(2500000);
  const config = await saver.put(saver.config(), checkpoint('large', { data }), metadata, {});
  await saver.putWrites(config, [['large-value', data]], 'large-task');
  const row = f.rows().D2cAgentCheckpoint[0];
  assert.equal(row.checkpoint, null);
  assert.equal(row.metadata, null);
  assert.equal(row.checkpointRef.format, 'pixelprint.checkpoint.v2');
  assert.ok(row.metadataRef);
  assert.ok(Buffer.byteLength(JSON.stringify(row.checkpointRef)) < 3000);
  for (const write of f.rows().D2cAgentWrite) {
    assert.equal(write.value, null);
    assert.ok(write.valueRef);
  }
  const restored = await f.make().getTuple(config);
  assert.deepEqual(restored!.checkpoint.channel_values.data, data);
  assert.deepEqual(restored!.metadata, metadata);
  assert.deepEqual(restored!.pendingWrites, [['large-task', 'large-value', data]]);
});
