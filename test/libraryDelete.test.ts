import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import { createGalleryService } from '../src/functions/d2c/version/gallery';
import {
  createSavedWorkService,
  type SavedWorkDraft,
} from '../src/functions/d2c/savedWork/service';
import { createPreviewService } from '../src/functions/d2c/preview/service';
import { SessionError } from '../src/functions/d2c/session/access';

type Row = Record<string, any>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const limits = { textFileBytes: 10000, filesPerSession: 100, uploadBytes: 100000 };
const entryPath = 'index.tsx';
const content = 'export default () => null';
const source = {
  path: entryPath,
  pathHash: sha(entryPath),
  kind: 'source',
  content,
  objectLocator: null,
  size: Buffer.byteLength(content),
  sha256: sha(content),
};

/** Serialized offline transactions assert explicit row locks, projections and rollback boundaries. */
function fixture() {
  const tables: Record<string, Row[]> = {
    D2cVersion: [
      {
        versionId: 'version-own',
        createdUserId: 'Alice',
        status: 'ready',
        target: 'h5',
        archiveObject: { shared: true },
        sourceFileRevision: 1,
      },
      { versionId: 'version-foreign', createdUserId: 'bob', status: 'ready', archiveObject: {} },
      { versionId: 'version-saving', createdUserId: 'alice', status: 'saving' },
      { versionId: 'version-failed', createdUserId: 'alice', status: 'failed' },
    ],
    D2cVersionFile: [
      { versionId: 'version-own', ...source },
      { versionId: 'version-own', ...source, kind: 'internal', path: 'rule-hits.json' },
      { versionId: 'version-foreign', ...source },
    ],
    D2cPreview: ['ready', 'building', 'queued', 'failed']
      .map((status) => ({
        previewId: `preview-${status}`,
        versionId: 'version-own',
        sessionId: null,
        status,
        buildManifest: {
          target: 'h5',
          publicToken: 'a'.repeat(64),
          tickets: [{ hash: sha('b'.repeat(64)), expiresAt: 1 }],
          entryPath,
        },
      }))
      .concat([
        {
          previewId: 'preview-session',
          versionId: null,
          sessionId: 'source-session',
          status: 'ready',
          buildManifest: { target: 'h5', entryPath },
        },
      ] as any),
    D2cSavedWork: [
      { ownerEid: 'alice', workId: 'work-own', revision: 2 },
      { ownerEid: 'bob', workId: 'work-copy', revision: 1, sourceId: 'work-own' },
      { ownerEid: 'alice', workId: 'work-keep', revision: 1 },
    ],
    D2cSavedWorkFile: [
      { ownerEid: 'alice', workId: 'work-own', workRevision: 1, ...source },
      { ownerEid: 'alice', workId: 'work-own', workRevision: 2, ...source },
      { ownerEid: 'bob', workId: 'work-copy', workRevision: 1, ...source },
      { ownerEid: 'bob', workId: 'work-own', workRevision: 1, ...source },
      { ownerEid: 'alice', workId: 'work-keep', workRevision: 1, ...source },
    ],
    D2cSession: [{ sessionId: 'source-session' }],
    D2cWorkspace: [{ workspaceId: 'source-workspace' }],
  };
  const calls: Array<{ table: string; operation: string; options: Row }> = [];
  let failAt = '';
  let tail = Promise.resolve();
  const matches = (row: Row, where: Row): boolean =>
    Reflect.ownKeys(where).every((key) => {
      const value = Reflect.get(where, key);
      if (key === Op.and) return value.every((part: Row) => matches(row, part));
      if (key === Op.or) return value.some((part: Row) => matches(row, part));
      if (value && typeof value === 'object' && Op.in in value)
        return value[Op.in].includes(Reflect.get(row, key));
      return Reflect.get(row, key) === value;
    });
  const models = Object.fromEntries(
    Object.keys(tables).map((table) => [
      table,
      {
        async findOne(options: Row) {
          calls.push({ table, operation: 'findOne', options });
          if (options.lock) {
            assert.equal(options.lock, 'UPDATE');
            assert.ok(options.transaction);
            options.transaction.locked.add(table);
          }
          const row = tables[table].find((item) => matches(item, options.where));
          if (!row) return null;
          return Array.isArray(options.attributes)
            ? Object.fromEntries(options.attributes.map((key: string) => [key, row[key]]))
            : { ...row };
        },
        async findAll(options: Row) {
          calls.push({ table, operation: 'findAll', options });
          if (options.lock) assert.ok(options.transaction.locked.has('D2cVersion'));
          const rows = tables[table].filter((row) => matches(row, options.where));
          return rows.map((row) =>
            Array.isArray(options.attributes)
              ? Object.fromEntries(options.attributes.map((key: string) => [key, row[key]]))
              : { ...row },
          );
        },
        async count(options: Row) {
          return tables[table].filter((row) => matches(row, options.where)).length;
        },
        async create(value: Row, options: Row) {
          assert.equal(table, 'D2cPreview');
          assert.ok(options.transaction.locked.has('D2cVersion'));
          tables[table].push(value);
          return value;
        },
        async destroy(options: Row) {
          calls.push({ table, operation: 'destroy', options });
          const parent = table.startsWith('D2cSavedWork') ? 'D2cSavedWork' : 'D2cVersion';
          assert.ok(
            options.transaction?.locked.has(parent),
            'deletion must hold the parent row lock',
          );
          assert.equal(options.order, undefined);
          if (failAt === table) throw new Error('injected delete failure');
          const count = tables[table].filter((row) => matches(row, options.where)).length;
          tables[table] = tables[table].filter((row) => !matches(row, options.where));
          return count;
        },
      },
    ]),
  );
  const mysql = {
    models,
    async transaction<T>(action: (transaction: Transaction) => Promise<T>) {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      const before = structuredClone(tables);
      try {
        return await action({ LOCK: { UPDATE: 'UPDATE' }, locked: new Set() } as any);
      } catch (error) {
        Object.assign(tables, before);
        throw error;
      } finally {
        release();
      }
    },
  } as unknown as Sequelize;
  /** Any accidental storage, cache or build access is a test failure. */
  const forbidden = () => {
    assert.fail('delete must not touch objects, cache or build services');
  };
  const gallery = createGalleryService(mysql, forbidden);
  const saved = createSavedWorkService(mysql, { binary: forbidden, readLimits: () => limits });
  const preview = createPreviewService(mysql, {
    binary: forbidden,
    run: forbidden,
    readLimits: () => limits,
    cache: new Proxy({}, { get: forbidden }) as any,
  });
  return {
    mysql,
    tables,
    calls,
    gallery,
    saved,
    preview,
    fail: (table: string) => {
      failAt = table;
    },
  };
}

/** Reject by public status/reason rather than incidental error messages. */
function failure(status: number, reason: string) {
  return (error: unknown) =>
    error instanceof SessionError && error.statusCode === status && error.reason === reason;
}

test('gallery exposes creator-only canDelete, using the established employee identity comparison', async () => {
  const f = fixture();
  const result = await f.gallery.list('alice', 'all');
  assert.equal(result.rows.find((row) => row.versionId === 'version-own')?.canDelete, true);
  assert.equal(result.rows.find((row) => row.versionId === 'version-foreign')?.canDelete, false);
  assert.equal((await f.gallery.get('ALICE', 'version-own')).canDelete, true);
  assert.equal((await f.gallery.get('bob', 'version-own')).canDelete, false);
});

test('version deletion atomically removes its frozen files and every preview without deleting sources or copied works', async () => {
  const f = fixture();
  const kept = structuredClone({
    works: f.tables.D2cSavedWork,
    files: f.tables.D2cSavedWorkFile,
    sessions: f.tables.D2cSession,
    workspaces: f.tables.D2cWorkspace,
  });
  assert.deepEqual(await f.gallery.remove('ALICE', 'version-own'), {
    versionId: 'version-own',
    deleted: true,
  });
  assert.equal(
    f.tables.D2cVersion.some((row) => row.versionId === 'version-own'),
    false,
  );
  assert.equal(
    f.tables.D2cVersionFile.some((row) => row.versionId === 'version-own'),
    false,
  );
  assert.deepEqual(
    f.tables.D2cPreview.map((row) => row.previewId),
    ['preview-session'],
  );
  assert.equal(f.tables.D2cVersionFile.length, 1);
  assert.deepEqual(
    {
      works: f.tables.D2cSavedWork,
      files: f.tables.D2cSavedWorkFile,
      sessions: f.tables.D2cSession,
      workspaces: f.tables.D2cWorkspace,
    },
    kept,
  );
  const lock = f.calls.find((call) => call.operation === 'findOne')!;
  assert.deepEqual(lock.options.attributes, ['versionId', 'createdUserId', 'status']);
  assert.equal(new Set(f.calls.map((call) => call.options.transaction)).size, 1);
  for (const token of ['a'.repeat(64), 'b'.repeat(64)])
    await assert.rejects(
      f.preview.asset('h5', 'preview-ready', token, 'index.html'),
      failure(404, 'PREVIEW_NOT_FOUND'),
    );
  await assert.rejects(
    f.preview.create('alice', 'version-own', entryPath),
    failure(404, 'VERSION_NOT_FOUND'),
  );
  await assert.rejects(f.gallery.get('alice', 'version-own'), failure(404, 'VERSION_NOT_FOUND'));
  await assert.rejects(f.gallery.remove('alice', 'version-own'), failure(404, 'VERSION_NOT_FOUND'));
});

test('missing and foreign versions are hidden; saving and failed versions cannot be deleted', async () => {
  const f = fixture();
  const before = structuredClone(f.tables);
  for (const id of ['missing', 'version-foreign'])
    await assert.rejects(f.gallery.remove('alice', id), failure(404, 'VERSION_NOT_FOUND'));
  for (const id of ['version-saving', 'version-failed'])
    await assert.rejects(f.gallery.remove('alice', id), failure(409, 'VERSION_NOT_READY'));
  assert.deepEqual(f.tables, before);
  assert.equal(
    f.calls.some((call) => call.operation === 'destroy'),
    false,
  );
});

for (const table of ['D2cPreview', 'D2cVersionFile', 'D2cVersion']) {
  test(`version deletion rolls back all tables when ${table} deletion fails`, async () => {
    const f = fixture();
    const before = structuredClone(f.tables);
    f.fail(table);
    await assert.rejects(f.gallery.remove('alice', 'version-own'), /injected delete failure/);
    assert.deepEqual(f.tables, before);
  });
}

test('preview creation and version deletion share the version lock, in either transaction order', async () => {
  for (const createFirst of [true, false]) {
    const f = fixture();
    f.tables.D2cPreview = [];
    const results = await Promise.allSettled(
      createFirst
        ? [
            f.preview.create('alice', 'version-own', entryPath),
            f.gallery.remove('alice', 'version-own'),
          ]
        : [
            f.gallery.remove('alice', 'version-own'),
            f.preview.create('alice', 'version-own', entryPath),
          ],
    );
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, createFirst ? 'fulfilled' : 'rejected');
    assert.deepEqual(f.tables.D2cPreview, []);
    const locks = f.calls.filter(
      (call) => call.table === 'D2cVersion' && call.operation === 'findOne',
    );
    assert.equal(locks.length, 2);
    assert.ok(locks.every((call) => call.options.lock === 'UPDATE' && call.options.transaction));
  }
});

test('personal delete requires owner and exact current revision before any deletion', async () => {
  const f = fixture();
  const before = structuredClone(f.tables);
  await assert.rejects(f.saved.remove('bob', 'work-own', 2), failure(404, 'SAVED_WORK_NOT_FOUND'));
  await assert.rejects(f.saved.remove('alice', 'missing', 2), failure(404, 'SAVED_WORK_NOT_FOUND'));
  await assert.rejects(f.saved.remove('alice', 'work-own', 1), failure(409, 'SAVED_WORK_CONFLICT'));
  for (const revision of [undefined, 0, -1, 1.2, 4294967295])
    await assert.rejects(
      f.saved.remove('alice', 'work-own', revision as number),
      failure(422, 'INVALID_REVISION'),
    );
  assert.equal(
    f.calls.some((call) => call.operation === 'destroy'),
    false,
  );
  assert.deepEqual(f.tables, before);
});

test('personal delete removes all owned revisions, preserves independent copies, and blocks old source/overwrite access', async () => {
  const f = fixture();
  const kept = structuredClone(f.tables.D2cVersion);
  assert.deepEqual(await f.saved.remove('alice', 'work-own', 2), {
    workId: 'work-own',
    deleted: true,
  });
  assert.equal(
    f.tables.D2cSavedWorkFile.some((row) => row.ownerEid === 'alice' && row.workId === 'work-own'),
    false,
  );
  assert.equal(f.tables.D2cSavedWorkFile.filter((row) => row.ownerEid === 'bob').length, 2);
  assert.equal(
    f.tables.D2cSavedWorkFile.some((row) => row.workId === 'work-keep'),
    true,
  );
  assert.deepEqual(f.tables.D2cVersion, kept);
  const lock = f.calls[0].options;
  assert.deepEqual(lock.attributes, ['ownerEid', 'workId', 'revision']);
  assert.deepEqual(lock.where, { ownerEid: 'alice', workId: 'work-own' });
  assert.equal(lock.lock, 'UPDATE');
  assert.ok(
    f.calls
      .filter((call) => call.operation === 'destroy')
      .every((call) => call.options.transaction === lock.transaction),
  );
  await assert.rejects(
    f.saved.authorize('alice', 'work-own'),
    failure(404, 'SAVED_WORK_NOT_FOUND'),
  );
  await assert.rejects(
    f.mysql.transaction((tx) => f.saved.source('alice', 'work-own', undefined, tx, limits)),
    failure(404, 'SAVED_WORK_NOT_FOUND'),
  );
  const draft: SavedWorkDraft = {
    editId: 'edit-old',
    sourceId: 'work-own',
    revision: 1,
    baseFileRevision: 2,
    target: 'h5',
    entries: [entryPath],
    entryPath,
    configSnapshot: {},
    snapshot: [source as any],
  };
  await assert.rejects(
    f.saved.save('alice', { workId: 'work-own', expectedRevision: 2, draft }),
    failure(404, 'SAVED_WORK_NOT_FOUND'),
  );
  await f.saved.authorize('bob', 'work-copy');
  assert.equal((await f.saved.get('bob', 'work-copy')).files[0].path, entryPath);
});

for (const table of ['D2cSavedWorkFile', 'D2cSavedWork']) {
  test(`personal delete rolls back every revision when ${table} deletion fails`, async () => {
    const f = fixture();
    const before = structuredClone(f.tables);
    f.fail(table);
    await assert.rejects(f.saved.remove('alice', 'work-own', 2), /injected delete failure/);
    assert.deepEqual(f.tables, before);
  });
}
