import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Op, Sequelize, UniqueConstraintError, type ModelStatic, type Model } from 'sequelize';
import { unzipSync, strFromU8 } from 'fflate';
import { initD2cSavedWork } from '../src/models/D2cSavedWork';
import { initD2cSavedWorkFile } from '../src/models/D2cSavedWorkFile';
import {
  createSavedWorkService,
  type SavedWorkDraft,
} from '../src/functions/d2c/savedWork/service';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const settings = { textFileBytes: 10000, filesPerSession: 100, uploadBytes: 100000 };
/** In-memory transaction adapter asserts owner filters on every database read/update. */
function fixture(readCovers?: (user: string, ids: string[]) => Promise<Map<string, string>>) {
  type Row = Record<string, any>;
  let workRows: Row[] = [];
  let fileRows: Row[] = [];
  const calls: Array<{ kind: string; query: Row }> = [];
  const downloads: unknown[] = [];
  let failFiles = false;
  let uniqueRace = false;
  const matches = (row: Row, where: Row): boolean =>
    Reflect.ownKeys(where).every((key) => {
      if (key === Op.or) return Reflect.get(where, key).some((part: Row) => matches(row, part));
      if (key === Op.and) return Reflect.get(where, key).every((part: Row) => matches(row, part));
      assert.equal(typeof key, 'string');
      const value = where[key as string];
      if (value && typeof value === 'object') {
        if (Op.in in value) return value[Op.in].includes(row[key as string]);
        if (Op.regexp in value) return new RegExp(value[Op.regexp]).test(row[key as string]);
        assert.fail('unsupported fixture operator');
      }
      return row[key as string] === value;
    });
  /** Queries never rely on client-side filtering alone. */
  function query(kind: string, options: Row, rows: Row[]) {
    assert.ok(options.where.ownerEid, `${kind} missing SQL owner filter`);
    calls.push({ kind, query: options });
    return rows.filter((row) => matches(row, options.where));
  }
  const mysql = {
    models: {
      D2cSavedWork: {
        async findOne(q: Row) {
          return query('work', q, workRows)[0] ?? null;
        },
        async findAll(q: Row) {
          const rows = query('work-list', q, workRows);
          return q.limit === undefined ? rows : rows.slice(q.offset, q.offset + q.limit);
        },
        async count(q: Row) {
          return query('count', q, workRows).length;
        },
        async create(value: Row) {
          const row = { ...structuredClone(value), createdAt: new Date(), updatedAt: new Date() };
          workRows.push(row);
          if (uniqueRace) {
            uniqueRace = false;
            throw new UniqueConstraintError({ message: 'race' });
          }
          return row;
        },
        async update(value: Row, q: Row) {
          assert.ok(q.where.revision);
          const rows = query('update', q, workRows);
          rows.forEach((row) => Object.assign(row, structuredClone(value)));
          return [rows.length];
        },
      },
      D2cSavedWorkFile: {
        async findAll(q: Row) {
          return query('file', q, fileRows);
        },
        async bulkCreate(rows: Row[]) {
          if (failFiles) throw new Error('file insert failed');
          fileRows.push(...structuredClone(rows));
        },
      },
    },
    /** Roll back both tables together on all ordinary write failures. */
    async transaction<T>(fn: (tx: any) => Promise<T>) {
      const before = structuredClone([workRows, fileRows]);
      try {
        return await fn({ LOCK: { UPDATE: 'UPDATE' } });
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) [workRows, fileRows] = before;
        throw error;
      }
    },
  } as unknown as Sequelize;
  const service = createSavedWorkService(mysql, {
    readCovers,
    readLimits: () => settings,
    binary: () => ({
      async downloadFile(locator) {
        downloads.push(locator);
        return Buffer.from('image');
      },
    }),
  });
  return {
    service,
    mysql,
    calls,
    downloads,
    workRows: () => workRows,
    fileRows: () => fileRows,
    failFiles: () => {
      failFiles = true;
    },
    race: () => {
      uniqueRace = true;
    },
  };
}
/** Detached source is deliberately not backed by any session or gallery model. */
function draft(content = 'export default () => null'): SavedWorkDraft {
  return {
    editId: 'edit-one',
    revision: 0,
    sourceId: 'public-source',
    target: 'h5',
    baseFileRevision: 7,
    snapshot: [
      {
        path: 'src/App.tsx',
        kind: 'source',
        content,
        objectLocator: null,
        size: Buffer.byteLength(content),
        sha256: sha(content),
      },
      {
        path: 'public/image.png',
        kind: 'asset',
        content: null,
        size: 5,
        sha256: sha('image'),
        objectLocator: {
          provider: 'local',
          fileName: 'immutable/image.png',
          url: 'http://localhost/files/immutable/image.png',
          sha256: sha('image'),
          size: 5,
          mimeType: 'image/png',
          accessKeyId: 'must-strip',
        },
      },
    ],
    entries: ['src/App.tsx'],
    entryPath: 'src/App.tsx',
    configSnapshot: {
      model: { apiKey: 'secret' },
      resourceRevisionId: 'private',
      config: { unit: { outputUnit: 'px', outputBase: 750, token: 'hidden' }, model: 'private' },
    },
  };
}
/** Assert stable service error categories. */
function reason(code: string) {
  return (error: any) => error.reason === code;
}

test('models: schema defaults, nullable text/JSON, immutable revision indexes', () => {
  const sql = new Sequelize('mysql://test:test@localhost/test', { logging: false });
  for (const model of [initD2cSavedWork(sql), initD2cSavedWorkFile(sql)]) {
    for (const [name, column] of Object.entries((model as ModelStatic<Model>).getAttributes())) {
      assert.ok(column.comment, name);
      if (column.allowNull === false && !column.autoIncrement)
        assert.notEqual(column.defaultValue, undefined, name);
      if (['TEXT', 'JSON'].includes((column.type as { key?: string }).key ?? ''))
        assert.equal(column.allowNull, true, name);
    }
    assert.ok(model.options.indexes?.some((index) => index.unique));
  }
});

test('save creates detached permanent copy, strips secrets and returns public metadata', async () => {
  const f = fixture();
  const input = draft();
  const saved = await f.service.save('alice', { draft: input });
  assert.match(saved.name, /^编辑作品 /);
  assert.equal(saved.revision, 1);
  input.snapshot[0].content = 'mutated';
  assert.equal(
    f.fileRows().find((file) => file.kind === 'source')!.content,
    'export default () => null',
  );
  assert.deepEqual(f.workRows()[0].configSnapshot, {
    config: { unit: { outputUnit: 'px', outputBase: 750 } },
  });
  assert.equal(
    'accessKeyId' in f.fileRows().find((file) => file.kind === 'asset')!.objectLocator,
    false,
  );
  const detail = await f.service.get('alice', saved.workId);
  assert.equal(detail.files.length, 2);
  assert.equal('configSnapshot' in detail, false);
  assert.equal('objectLocator' in detail.files[1], false);
  const source = await f.mysql.transaction((tx) =>
    f.service.source('alice', saved.workId, undefined, tx, settings),
  );
  assert.equal(source.fileRevision, 1);
  assert.equal(
    source.snapshot.find((file) => file.kind === 'source')!.content,
    'export default () => null',
  );
  const listed = await f.service.list('alice');
  assert.equal(listed.items.length, 1);
  assert.equal((await f.service.list('bob')).total, 0);
  const file = await f.service.getFile('alice', saved.workId, sha('src/App.tsx'));
  assert.equal(file.content, 'export default () => null');
});

test('all reads/overwrite/download reject another owner, lightweight authorize reads no files', async () => {
  const f = fixture();
  const saved = await f.service.save('alice', { name: 'Original', draft: draft() });
  f.calls.length = 0;
  await f.service.authorize('alice', saved.workId);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].query.attributes, ['workId', 'ownerEid']);
  assert.equal(f.calls[0].query.lock, undefined);
  for (const call of [
    () => f.service.get('bob', saved.workId),
    () => f.service.authorize('bob', saved.workId),
    () => f.service.files('bob', saved.workId),
    () => f.service.getFile('bob', saved.workId, sha('src/App.tsx')),
    () => f.service.archive('bob', saved.workId),
    () =>
      f.mysql.transaction((tx) => f.service.source('bob', saved.workId, undefined, tx, settings)),
    () =>
      f.service.save('bob', {
        workId: saved.workId,
        expectedRevision: 1,
        draft: { ...draft(), sourceId: saved.workId, baseFileRevision: 1 },
      }),
  ]) {
    await assert.rejects(call, reason('SAVED_WORK_NOT_FOUND'));
  }
  assert.equal(f.downloads.length, 0);
});

test('initial idempotency and lastSaveKey replay; CAS creates immutable file revisions and retains omitted name', async () => {
  const f = fixture();
  const saved = await f.service.save('alice', { name: 'Original', draft: draft() });
  assert.equal((await f.service.save('alice', { draft: draft() })).workId, saved.workId);
  assert.equal(f.fileRows().length, 2);
  const edit = {
    ...draft('updated'),
    editId: 'own-edit',
    revision: 1,
    sourceId: saved.workId,
    baseFileRevision: 1,
  };
  const updated = await f.service.save('alice', {
    workId: saved.workId,
    expectedRevision: 1,
    draft: edit,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'Original');
  assert.equal(f.fileRows().length, 4);
  assert.equal(
    f.fileRows().find((file) => file.kind === 'source')!.content,
    'export default () => null',
  );
  const replay = await f.service.save('alice', {
    workId: saved.workId,
    expectedRevision: 1,
    draft: edit,
  });
  assert.equal(replay.revision, 2);
  assert.equal(f.fileRows().length, 4);
  await assert.rejects(
    () =>
      f.service.save('alice', {
        workId: saved.workId,
        expectedRevision: 1,
        draft: { ...edit, revision: 2 },
      }),
    reason('SAVED_WORK_CONFLICT'),
  );
  const rebased = await f.service.save('alice', {
    workId: saved.workId,
    expectedRevision: 2,
    draft: { ...edit, revision: 2, baseFileRevision: 2 },
  });
  assert.equal(rebased.revision, 3);
  const source = await f.mysql.transaction((tx) =>
    f.service.source('alice', saved.workId, undefined, tx, settings),
  );
  assert.equal(source.snapshot.find((file) => file.kind === 'source')!.content, 'updated');
  await assert.rejects(
    () =>
      f.service.save('alice', {
        workId: saved.workId,
        expectedRevision: 3,
        draft: { ...edit, revision: 3, baseFileRevision: 3, sourceId: 'another-source' },
      }),
    reason('SAVED_WORK_CONFLICT'),
  );
});

test('atomic rollback on file failure and initial unique collision replay', async () => {
  const f = fixture();
  f.failFiles();
  await assert.rejects(() => f.service.save('alice', { draft: draft() }), /file insert failed/);
  assert.equal(f.workRows().length, 0);
  assert.equal(f.fileRows().length, 0);
  const race = fixture();
  race.race();
  const saved = await race.service.save('alice', { draft: draft() });
  assert.equal(saved.workId, race.workRows()[0].workId);
});

test('archives only frozen copy/draft, verifies binary bytes and supports RN rpx whitelist', async () => {
  const f = fixture();
  const input = draft();
  input.target = 'rn';
  input.configSnapshot.config = { unit: { outputUnit: 'rpx', outputBase: 750 } };
  const saved = await f.service.save('alice', { draft: input });
  const archive = await f.service.archive('alice', saved.workId);
  assert.equal(archive.mimeType, 'application/zip');
  const zip = unzipSync(archive.data);
  assert.equal(strFromU8(zip['src/App.tsx']), input.snapshot[0].content);
  assert.equal(strFromU8(zip['public/image.png']), 'image');
  const exported = await f.service.archiveDraft(input);
  assert.deepEqual(Object.keys(unzipSync(exported.data)).sort(), Object.keys(zip).sort());
  const damaged = fixture();
  const bad = draft();
  bad.snapshot[1].sha256 = sha('other');
  bad.snapshot[1].objectLocator!.sha256 = sha('other');
  await assert.rejects(() => damaged.service.archiveDraft(bad), /ARCHIVE_INTEGRITY_FAILED/);
});

test('reject invalid metadata, paths, limits, entries and integrity before writing', async () => {
  const f = fixture();
  for (const change of [
    (d: SavedWorkDraft) => {
      d.snapshot[0].sha256 = sha('wrong');
    },
    (d: SavedWorkDraft) => {
      d.snapshot[0].path = '../escape.tsx';
    },
    (d: SavedWorkDraft) => {
      d.entries = ['missing.tsx'];
    },
    (d: SavedWorkDraft) => {
      d.entryPath = 'missing.tsx';
    },
    (d: SavedWorkDraft) => {
      d.snapshot.push({ ...d.snapshot[0] });
    },
    (d: SavedWorkDraft) => {
      d.snapshot[1].objectLocator!.url = 'http://user:secret@localhost/files/image';
    },
  ]) {
    const bad = draft();
    change(bad);
    await assert.rejects(
      () => f.service.save('alice', { draft: bad }),
      reason('INVALID_SAVED_WORK'),
    );
  }
  assert.equal(f.workRows().length, 0);
  await assert.rejects(() => f.service.list('alice', 0), reason('INVALID_PAGE'));
  await assert.rejects(
    () => f.service.save('alice', { name: '', draft: draft() }),
    reason('INVALID_SAVED_WORK'),
  );
});

test('saved runtime cover is frozen from trusted source, preserved on overwrite and used without publication reads', async () => {
  let reads = 0;
  let published = true;
  const url = 'https://images.example.test/runtime.png';
  const f = fixture(async (_user, ids) => {
    reads++;
    return published ? new Map(ids.map((id) => [id, url])) : new Map();
  });
  const snapshot = draft();
  snapshot.configSnapshot = {
    ...snapshot.configSnapshot,
    runtimeCoverUrl: 'https://evil.example.test/forged.png',
  };
  const result = await f.service.save('alice', { draft: snapshot });
  assert.equal(f.workRows()[0].configSnapshot.runtimeCoverUrl, url);
  published = false;
  assert.equal((await f.service.list('alice')).items[0].coverUrl, url);
  const next = {
    ...draft(),
    editId: 'edit-next',
    revision: 1,
    sourceId: result.workId,
    baseFileRevision: result.revision,
  };
  await f.service.save('alice', {
    workId: result.workId,
    expectedRevision: result.revision,
    draft: next,
  });
  assert.equal((await f.service.list('alice')).items[0].coverUrl, url);
  assert.equal(reads, 1);
  assert.equal((await f.service.list('bob')).items.length, 0);
});

test('legacy saved cover follows published source in one batch, unsafe or missing covers stay empty', async () => {
  const f = fixture(
    async (_user, ids) => new Map(ids.map((id) => [id, 'https://images.example.test/runtime.png'])),
  );
  await f.service.save('alice', { draft: draft() });
  delete f.workRows()[0].configSnapshot.runtimeCoverUrl;
  assert.equal(
    (await f.service.list('alice')).items[0].coverUrl,
    'https://images.example.test/runtime.png',
  );
  const noCover = fixture(async () => new Map([['public-source', 'javascript:bad']]));
  await noCover.service.save('alice', { draft: draft() });
  assert.equal((await noCover.service.list('alice')).items[0].coverUrl, null);
});
