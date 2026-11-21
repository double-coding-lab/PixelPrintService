import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Op, type Sequelize } from 'sequelize';
import { unzipSync } from 'fflate';
import { prepareTextContent } from '../src/functions/d2c/content/runtime';
import { createVersionService } from '../src/functions/d2c/version/service';
import { createSharingService } from '../src/functions/d2c/sharing/service';
import { createEditService } from '../src/functions/d2c/edit/service';
import type { EditRecord, EditStore, EditTicket } from '../src/functions/d2c/edit/store';
import type { CachedPreviewFile, PreviewCache } from '../src/functions/d2c/preview/cache';
import { buildVersionArchive, type ArchiveFile } from '../src/functions/d2c/version/archive';
import {
  createSavedWorkService,
  type SavedWorkDraft,
} from '../src/functions/d2c/savedWork/service';
import { enableTextContent } from './helpers/content';
import { messageFixture } from './helpers/messages';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const limits = { textFileBytes: 2097152, filesPerSession: 100, uploadBytes: 30000000 };
const text = '\ufeffexport default () => <div>冻结 🌈\r\n原样</div>;\r\n';
type Row = Record<string, any>;

/** No public/editor response may carry a private text reference or encrypted object locator. */
function publicOnly(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /contentRef|keyId|d2c-bodies|pixelprint\.text\.v1/);
}

/** Use the real version service and encrypted store, with in-memory DB and ZIP transport only. */
async function versionFixture(mode: 'inline' | 'shadow' | 'external' = 'external') {
  const f = await messageFixture();
  const content = enableTextContent(f.mysql, mode, 1);
  const session = f.tables.D2cSession.find((row) => row.sessionId === f.id)!;
  session.fileRevision = 1;
  session.validationState = { status: 'failed', fileRevision: 1 };
  let inTransaction = 0;
  const transaction = f.mysql.transaction.bind(f.mysql);
  f.mysql.transaction = ((callback: (tx: any) => Promise<unknown>) =>
    transaction(async (tx) => {
      inTransaction++;
      try {
        return await callback(tx);
      } finally {
        inTransaction--;
      }
    })) as typeof f.mysql.transaction;
  const originalPut = content.backend.put;
  content.backend.put = async (input) => {
    assert.equal(inTransaction, 0, 'text upload inside transaction');
    return originalPut(input);
  };
  const source = {
    fileId: 'frozen-source',
    sessionId: f.id,
    path: 'src/App.tsx',
    pathHash: sha('src/App.tsx'),
    kind: 'source',
    ...(await prepareTextContent(f.mysql, 'session:' + f.id, text)),
    objectLocator: null,
    mimeType: null,
    size: Buffer.byteLength(text),
    sha256: sha(text),
    revision: 1,
  };
  f.tables.D2cFile.push(source);
  const zips = new Map<string, Buffer>();
  const uploads: Buffer[] = [];
  const service = createVersionService(f.mysql, {
    readLimits: () => limits,
    binary: () => ({
      async uploadFile(input) {
        assert.equal(inTransaction, 0, 'ZIP upload inside transaction');
        uploads.push(Buffer.from(input.content));
        zips.set(input.fileName, Buffer.from(input.content));
        return {
          provider: 'local' as const,
          fileName: input.fileName,
          url: 'https://offline.invalid/' + input.fileName,
          mimeType: input.contentType,
          size: input.content.length,
          sha256: sha(input.content),
        };
      },
      async downloadFile(locator) {
        assert.ok(locator && typeof locator === 'object' && 'fileName' in locator);
        const bytes = zips.get(String(locator.fileName));
        assert.ok(bytes, 'unexpected binary download');
        return Buffer.from(bytes);
      },
    }),
  });
  const input = { clientRequestId: 'freeze-one', baseFileRevision: 1 };
  return { ...f, content, source, service, input, uploads };
}

/** Server-exported drafts always contain text, never a client-supplied contentRef. */
function draft(value = text): SavedWorkDraft {
  return {
    editId: 'edit-one',
    revision: 0,
    sourceId: 'upstream-version',
    target: 'h5',
    baseFileRevision: 1,
    snapshot: [
      {
        path: 'src/App.tsx',
        kind: 'source',
        content: value,
        objectLocator: null,
        size: Buffer.byteLength(value),
        sha256: sha(value),
      },
    ],
    configSnapshot: { config: { unit: { outputUnit: 'px', outputBase: 750 } } },
    entries: ['src/App.tsx'],
    entryPath: 'src/App.tsx',
  };
}

/** Owner-scoped memory transactions model atomic revision CAS and rollback without any DB driver. */
function workFixture(mode?: 'inline' | 'shadow' | 'external', threshold = 1) {
  let workRows: Row[] = [];
  let fileRows: Row[] = [];
  let depth = 0;
  let failInsert = false;
  let beforePut: (() => void | Promise<void>) | undefined;
  let beforeGet: (() => void | Promise<void>) | undefined;
  let rejectCas = false;
  const queries: Row[] = [];
  /** Evaluate the ordered reader's SQL predicates, including its scoped second-stage selection. */
  function matches(row: Row, where: Row): boolean {
    return Reflect.ownKeys(where).every((key) => {
      const value = where[key as string];
      if (key === Op.and) return value.every((part: Row) => matches(row, part));
      if (key === Op.or) return value.some((part: Row) => matches(row, part));
      if (value && typeof value === 'object' && Op.in in value)
        return value[Op.in].includes(row[key as string]);
      return row[key as string] === value;
    });
  }
  /** Default scope hides the new column; only contentBody reads can see it. */
  function select(rows: Row[], query: Row, scoped = false) {
    assert.ok(query.where.ownerEid, 'missing SQL ownership filter');
    queries.push({ ...query, depth });
    return rows
      .filter((row) => matches(row, query.where))
      .map((row) => {
        const result = structuredClone(row);
        if (!scoped) delete result.contentRef;
        if (Array.isArray(query.attributes))
          return Object.fromEntries(query.attributes.map((name: string) => [name, result[name]]));
        return result;
      });
  }
  const fileModel = {
    async findAll(query: Row) {
      return select(fileRows, query);
    },
    scope(name: string) {
      assert.equal(name, 'contentBody');
      return { findAll: async (query: Row) => select(fileRows, query, true) };
    },
    async bulkCreate(rows: Row[], query: Row) {
      assert.equal(depth, 1);
      assert.ok(query.transaction);
      if (failInsert) throw new Error('offline insert failure');
      fileRows.push(...structuredClone(rows));
    },
  };
  const mysql = {
    models: {
      D2cSavedWorkFile: fileModel,
      D2cSavedWork: {
        async findOne(query: Row) {
          return select(workRows, query)[0] ?? null;
        },
        async create(values: Row, query: Row) {
          assert.equal(depth, 1);
          assert.ok(query.transaction);
          const row = { ...structuredClone(values), createdAt: new Date(), updatedAt: new Date() };
          workRows.push(row);
          return structuredClone(row);
        },
        async update(values: Row, query: Row) {
          assert.equal(depth, 1);
          assert.ok(query.transaction);
          assert.ok(query.where.ownerEid);
          assert.ok(query.where.revision);
          if (rejectCas) return [0];
          const rows = workRows.filter((row) => matches(row, query.where));
          rows.forEach((row) => Object.assign(row, structuredClone(values)));
          return [rows.length];
        },
      },
    },
    async transaction<T>(
      optionsOrCallback: Row | ((tx: any) => Promise<T>),
      callback?: (tx: any) => Promise<T>,
    ) {
      const run = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!;
      const before = structuredClone([workRows, fileRows]);
      depth++;
      try {
        return await run({ LOCK: { UPDATE: 'UPDATE' } });
      } catch (error) {
        [workRows, fileRows] = before;
        throw error;
      } finally {
        depth--;
      }
    },
  } as unknown as Sequelize;
  const content = mode === undefined ? undefined : enableTextContent(mysql, mode, threshold);
  if (content) {
    const originalPut = content.backend.put;
    const originalGet = content.backend.get;
    content.backend.put = async (input) => {
      assert.equal(depth, 0, 'text preparation must happen outside transactions');
      await beforePut?.();
      return originalPut(input);
    };
    content.backend.get = async (locator, settings) => {
      assert.equal(depth, 0, 'backend.get must not run while a DB transaction holds locks');
      await beforeGet?.();
      return originalGet(locator, settings);
    };
  }
  const service = createSavedWorkService(mysql, {
    readLimits: () => limits,
    binary: () => ({ downloadFile: async () => assert.fail('unexpected binary transport') }),
  });
  return {
    mysql,
    service,
    content,
    queries,
    depth: () => depth,
    workRows: () => workRows,
    fileRows: () => fileRows,
    failInsert: () => {
      failInsert = true;
    },
    onPut: (callback: () => void | Promise<void>) => {
      beforePut = callback;
    },
    onGet: (callback: () => void | Promise<void>) => {
      beforeGet = callback;
    },
    rejectCas: () => {
      rejectCas = true;
    },
  };
}

test('version freeze copies one immutable reference, ZIP/gallery return exact plaintext, DTOs hide refs', async () => {
  const f = await versionFixture();
  const puts = f.content.operations.filter((operation) => operation === 'put').length;
  const ready = await f.service.save('employee-a', f.id, f.input);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.validationSummary?.status, 'failed');
  const frozen = f.tables.D2cVersionFile[0];
  assert.equal(frozen.content, null);
  assert.deepEqual(frozen.contentRef, f.source.contentRef);
  assert.equal(f.content.operations.filter((operation) => operation === 'put').length, puts);
  assert.notEqual(frozen.contentRef, f.source.contentRef);
  assert.equal(Buffer.from(unzipSync(f.uploads[0])['src/App.tsx']).toString(), text);
  f.source.contentRef!.locator.key = 'missing-current-object';
  f.source.content = 'new writer';
  f.tables.D2cFile.splice(0);
  const detail = await f.service.gallery.get('reader', ready.versionId);
  const file = await f.service.gallery.file('reader', ready.versionId, sha('src/App.tsx'));
  assert.equal(file.content, text);
  publicOnly([ready, detail, file]);
  await assert.rejects(() => f.service.archive('intruder', f.id, ready.versionId));
});

test('old writer inline wins over stale shadow reference; freeze does not upload old inline', async () => {
  const f = await versionFixture('shadow');
  const updated = 'export default () => "new inline 🌟";';
  Object.assign(f.source, {
    content: updated,
    size: Buffer.byteLength(updated),
    sha256: sha(updated),
  });
  const operations = [...f.content.operations];
  const ready = await f.service.save('employee-a', f.id, f.input);
  assert.equal(f.tables.D2cVersionFile[0].contentRef, null);
  assert.equal(f.tables.D2cVersionFile[0].content, updated);
  assert.deepEqual(f.content.operations, operations);
  assert.equal(
    (await f.service.gallery.file('reader', ready.versionId, sha('src/App.tsx'))).content,
    updated,
  );
});

test('missing frozen object fails safely; retry retains original reference after current files disappear', async () => {
  const f = await versionFixture();
  const [key, bytes] = [...f.content.objects][0];
  f.content.objects.delete(key);
  await assert.rejects(() => f.service.save('employee-a', f.id, f.input), {
    reason: 'VERSION_SAVE_FAILED',
  });
  const snapshot = structuredClone(f.tables.D2cVersionFile);
  assert.equal(f.tables.D2cVersion[0].status, 'failed');
  assert.equal(f.uploads.length, 0);
  f.tables.D2cFile.splice(0);
  f.content.objects.set(key, bytes);
  const ready = await f.service.save('employee-a', f.id, f.input);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(f.tables.D2cVersionFile, snapshot);
  assert.equal(Buffer.from(unzipSync(f.uploads[0])['src/App.tsx']).toString(), text);
  const packet = f.content.objects.get(key)!;
  packet[packet.length - 1] ^= 1;
  await assert.rejects(
    () => f.service.gallery.file('reader', ready.versionId, sha('src/App.tsx')),
    { reason: 'VERSION_FILE_INVALID' },
  );
});

test('version metadata mismatch refuses a ref-only freeze and rolls back the version', async () => {
  const f = await versionFixture();
  f.source.sha256 = sha('forged metadata');
  await assert.rejects(() => f.service.save('employee-a', f.id, f.input));
  assert.equal(f.tables.D2cVersion.length, 0);
  assert.equal(f.tables.D2cVersionFile.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('archive resolves encrypted content from a detached reference and enforces plaintext integrity/limits', async () => {
  const f = await versionFixture();
  const file: ArchiveFile = { ...f.source, kind: 'source' };
  const noBinary = async () => assert.fail('unexpected binary read');
  await assert.rejects(() => buildVersionArchive([file], noBinary, limits), /ARCHIVE_INVALID_FILE/);
  await assert.rejects(
    () => buildVersionArchive([file], noBinary, limits, async () => 'wrong text'),
    /ARCHIVE_INTEGRITY_FAILED/,
  );
  await assert.rejects(
    () => buildVersionArchive([file], noBinary, { ...limits, textFileBytes: 1 }, async () => text),
    /ARCHIVE_TEXT_LIMIT/,
  );
  const original = structuredClone(file.contentRef);
  const zip = await buildVersionArchive([file], noBinary, limits, async (copy) => {
    file.contentRef!.locator.key = 'mutated-after-await';
    assert.deepEqual(copy.contentRef, original);
    return f.content.store.read(copy.contentRef!.scope, copy.contentRef);
  });
  assert.equal(Buffer.from(unzipSync(zip)['src/App.tsx']).toString(), text);
});

for (const mode of [undefined, 'inline', 'shadow', 'external'] as const) {
  test(`saved work ${mode ?? 'uninstalled'}: prepare outside transaction, resolve snapshots and ZIP, hide references`, async () => {
    const f = workFixture(mode);
    const saved = await f.service.save('alice', { draft: draft() });
    const stored = f.fileRows()[0];
    assert.equal(stored.content, mode === 'external' ? null : text);
    if (mode === undefined) assert.equal('contentRef' in stored, false);
    if (mode === 'shadow' || mode === 'external') {
      assert.equal(stored.contentRef.scope, 'work:' + saved.workId);
      assert.equal(stored.contentRef.sha256, sha(text));
      assert.equal(f.content!.objects.size, 1);
      for (const bytes of f.content!.objects.values())
        assert.equal(bytes.includes(Buffer.from(text)), false);
    }
    const detail = await f.service.get('alice', saved.workId);
    const file = await f.service.getFile('alice', saved.workId, sha('src/App.tsx'));
    assert.equal(file.content, text);
    const operations = f.content ? [...f.content.operations] : undefined;
    const source = await f.mysql.transaction((tx) =>
      f.service.source('alice', saved.workId, undefined, tx, limits),
    );
    assert.equal(source.snapshot[0].content, mode === 'external' ? null : text);
    assert.deepEqual(source.snapshot[0].contentRef, stored.contentRef ?? undefined);
    assert.deepEqual(f.content?.operations, operations, 'source only freezes metadata/ref');
    publicOnly([saved, detail, file]);
    const zip = await f.service.archive('alice', saved.workId);
    assert.equal(Buffer.from(unzipSync(zip.data)['src/App.tsx']).toString(), text);
    const puts = f.content?.operations.filter((op) => op === 'put').length;
    assert.equal((await f.service.save('alice', { draft: draft() })).workId, saved.workId);
    assert.equal(f.content?.operations.filter((op) => op === 'put').length, puts);
  });
}

test('saved work accepts legitimate original frozen scope and reads existing refs after inline rollback', async () => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  const originalRef = await f.content!.store.put('session:original-source', text);
  f.fileRows()[0].contentRef = originalRef;
  f.content!.configure({ mode: 'inline' });
  assert.equal((await f.service.getFile('alice', saved.workId, sha('src/App.tsx'))).content, text);
  const archive = await f.service.archive('alice', saved.workId);
  assert.equal(Buffer.from(unzipSync(archive.data)['src/App.tsx']).toString(), text);
});

test('saved work rejects injected refs on save/download drafts before upload or DB write', async () => {
  const f = workFixture('external');
  const reference = await f.content!.store.put('work:somebody-else', text);
  for (const contentRef of [reference, null, { forged: true }]) {
    const input = draft();
    Object.assign(input.snapshot[0], { contentRef });
    const operations = [...f.content!.operations];
    await assert.rejects(() => f.service.save('alice', { draft: input }), {
      reason: 'INVALID_SAVED_WORK',
    });
    await assert.rejects(() => f.service.archiveDraft(input), { reason: 'INVALID_SAVED_WORK' });
    assert.deepEqual(f.content!.operations, operations);
  }
  assert.equal(f.workRows().length, 0);
  assert.equal(f.fileRows().length, 0);
});

test('saved work overwrite CAS appends encrypted revisions, preserves old bytes, replay skips upload', async () => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { name: 'frozen', draft: draft() });
  const old = structuredClone(f.fileRows()[0]);
  const edit = {
    ...draft('export default () => "new"'),
    editId: 'edit-two',
    revision: 1,
    sourceId: saved.workId,
    baseFileRevision: 1,
  };
  const input = { workId: saved.workId, expectedRevision: 1, draft: edit };
  const updated = await f.service.save('alice', input);
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'frozen');
  assert.deepEqual(f.fileRows()[0], old);
  assert.notEqual(f.fileRows()[1].contentRef.objectId, old.contentRef.objectId);
  assert.equal(f.fileRows()[1].contentRef.scope, 'work:' + saved.workId);
  assert.equal(await f.content!.store.read(old.contentRef.scope, old.contentRef), text);
  const puts = f.content!.operations.filter((op) => op === 'put').length;
  assert.equal((await f.service.save('alice', input)).revision, 2);
  assert.equal(f.content!.operations.filter((op) => op === 'put').length, puts);
  assert.equal(
    (await f.service.getFile('alice', saved.workId, sha('src/App.tsx'))).content,
    edit.snapshot[0].content,
  );
});

test('saved work rechecks CAS after external upload and never commits stale references', async () => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  const originalFiles = structuredClone(f.fileRows());
  f.onPut(() => {
    f.workRows()[0].revision = 2;
  });
  await assert.rejects(
    () =>
      f.service.save('alice', {
        workId: saved.workId,
        expectedRevision: 1,
        draft: {
          ...draft('changed'),
          editId: 'other-edit',
          revision: 1,
          sourceId: saved.workId,
          baseFileRevision: 1,
        },
      }),
    { reason: 'SAVED_WORK_CONFLICT' },
  );
  assert.deepEqual(f.fileRows(), originalFiles);
  assert.equal(f.workRows()[0].revision, 2);
  assert.equal(f.content!.objects.size, 2, 'failed CAS leaves an unreferenced immutable object');
  assert.equal(
    await f.content!.store.read(originalFiles[0].contentRef.scope, originalFiles[0].contentRef),
    text,
  );
});

test('saved work rejects SQL CAS miss, rolls back insert failure, upload failure saves no rows', async () => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  f.rejectCas();
  await assert.rejects(
    () =>
      f.service.save('alice', {
        workId: saved.workId,
        expectedRevision: 1,
        draft: {
          ...draft('changed'),
          editId: 'other-edit',
          revision: 1,
          sourceId: saved.workId,
          baseFileRevision: 1,
        },
      }),
    { reason: 'SAVED_WORK_CONFLICT' },
  );
  assert.equal(f.workRows()[0].revision, 1);
  assert.equal(f.fileRows().length, 1);
  const failed = workFixture('external');
  failed.failInsert();
  await assert.rejects(
    () => failed.service.save('alice', { draft: draft() }),
    /offline insert failure/,
  );
  assert.equal(failed.workRows().length, 0);
  assert.equal(failed.fileRows().length, 0);
  assert.equal(failed.content!.objects.size, 1);
  const upload = workFixture('external');
  upload.onPut(() => {
    throw new Error('private backend error');
  });
  await assert.rejects(() => upload.service.save('alice', { draft: draft() }), {
    code: 'UPLOAD_FAILED',
  });
  assert.equal(upload.workRows().length, 0);
  assert.equal(upload.fileRows().length, 0);
});

test('saved work authorizes before reading/uploading and integrity failures do not return empty plaintext', async () => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  const operations = [...f.content!.operations];
  await assert.rejects(() => f.service.getFile('intruder', saved.workId, sha('src/App.tsx')), {
    reason: 'SAVED_WORK_NOT_FOUND',
  });
  await assert.rejects(() => f.service.archive('intruder', saved.workId), {
    reason: 'SAVED_WORK_NOT_FOUND',
  });
  await assert.rejects(
    () =>
      f.service.save('intruder', {
        workId: saved.workId,
        expectedRevision: 1,
        draft: {
          ...draft('changed'),
          editId: 'other-edit',
          sourceId: saved.workId,
          baseFileRevision: 1,
        },
      }),
    { reason: 'SAVED_WORK_NOT_FOUND' },
  );
  assert.deepEqual(f.content!.operations, operations);
  const row = f.fileRows()[0];
  const key = String(row.contentRef.locator.key);
  const bytes = f.content!.objects.get(key)!;
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => f.service.get('alice', saved.workId), {
    reason: 'SAVED_WORK_CORRUPT',
  });
  await assert.rejects(() => f.service.getFile('alice', saved.workId, sha('src/App.tsx')), {
    reason: 'SAVED_WORK_CORRUPT',
  });
  const operationsBeforeSource = [...f.content!.operations];
  const source = await f.mysql.transaction((tx) =>
    f.service.source('alice', saved.workId, undefined, tx, limits),
  );
  assert.equal(source.snapshot[0].content, null);
  assert.deepEqual(source.snapshot[0].contentRef, row.contentRef);
  assert.deepEqual(f.content!.operations, operationsBeforeSource, 'source must not read objects');
  await assert.rejects(() => f.service.archive('alice', saved.workId), /ARCHIVE_CONTENT_FAILED/);
});

test('saved work threshold keeps small texts inline and old writer strips stale reference on reads', async () => {
  const f = workFixture('external', 1024);
  const saved = await f.service.save('alice', { draft: draft() });
  assert.equal(f.fileRows()[0].content, text);
  assert.equal(f.content!.objects.size, 0);
  const ref = await f.content!.store.put('work:' + saved.workId, text);
  const changed = 'export default () => "old writer";';
  Object.assign(f.fileRows()[0], {
    content: changed,
    size: Buffer.byteLength(changed),
    sha256: sha(changed),
    contentRef: ref,
  });
  const operations = [...f.content!.operations];
  assert.equal(
    (await f.service.getFile('alice', saved.workId, sha('src/App.tsx'))).content,
    changed,
  );
  assert.deepEqual(f.content!.operations, operations);
});

/** Reuse the owner/session/file DB fixture; sharing publication stays in memory as well. */
async function sharingFixture() {
  const f = await versionFixture();
  const share = { shareId: randomUUID(), sessionId: f.id, enabled: true };
  let authorizationReads = 0;
  Object.assign(f.mysql.models, {
    D2cSessionShare: {
      async findOne(query: Row) {
        authorizationReads++;
        assert.equal(query.where.enabled, true);
        return query.where.shareId === share.shareId && share.enabled
          ? structuredClone(share)
          : null;
      },
    },
  });
  const sharing = createSharingService(f.mysql, {
    binary: () => ({
      downloadFile: async () => assert.fail('private text reference entered binary transport'),
    }),
  });
  return { ...f, sharing, share, authorizationReads: () => authorizationReads };
}

test('sharing decrypts external source into the unchanged public DTO and never exposes private locators', async () => {
  const f = await sharingFixture();
  const dto = await f.sharing.file('reader', f.share.shareId, f.source.fileId);
  assert.equal('content' in dto && dto.content, text);
  assert.equal(f.source.content, null);
  assert.deepEqual(
    Object.keys(dto).sort(),
    [
      'content',
      'createdAt',
      'fileId',
      'kind',
      'mimeType',
      'path',
      'revision',
      'sha256',
      'size',
      'updatedAt',
      'url',
    ].sort(),
  );
  assert.equal(
    'url' in dto && dto.url,
    `/api/d2c/plaza/sessions/${f.share.shareId}/files/${f.source.fileId}`,
  );
  assert.equal(f.authorizationReads(), 2, 'publication must be checked before and after decrypt');
  publicOnly(dto);
  assert.doesNotMatch(JSON.stringify(dto), /objectLocator|storedSize|objectId|memory/);
  const operations = [...f.content.operations];
  const files = await f.sharing.files('reader', f.share.shareId);
  assert.equal(files.length, 1);
  publicOnly(files);
  assert.deepEqual(
    f.content.operations,
    operations,
    'file metadata listing must not download text',
  );
});

test('sharing rechecks publication and parent lifetime after decrypt and returns no in-flight plaintext', async (t) => {
  for (const revoke of ['publication', 'session', 'workspace'] as const) {
    await t.test(revoke, async () => {
      const f = await sharingFixture();
      const originalGet = f.content.backend.get;
      let downloads = 0;
      f.content.backend.get = async (locator, options) => {
        downloads++;
        const bytes = await originalGet(locator, options);
        if (revoke === 'publication') f.share.enabled = false;
        if (revoke === 'session')
          f.tables.D2cSession.find((row) => row.sessionId === f.id)!.deletedAt = new Date();
        if (revoke === 'workspace') f.tables.D2cWorkspace[0].deletedAt = new Date();
        return bytes;
      };
      await assert.rejects(() => f.sharing.file('reader', f.share.shareId, f.source.fileId), {
        reason: 'SHARE_NOT_FOUND',
      });
      assert.equal(downloads, 1);
      assert.equal(f.authorizationReads(), 2);
      const operations = [...f.content.operations];
      await assert.rejects(() => f.sharing.file('reader', f.share.shareId, f.source.fileId), {
        reason: 'SHARE_NOT_FOUND',
      });
      assert.deepEqual(f.content.operations, operations, 'revoked reads must fail before storage');
    });
  }
});

test('sharing enforces current session scope and metadata identity; old inline writer still wins', async () => {
  const f = await sharingFixture();
  const originalRef = structuredClone(f.source.contentRef);
  const foreign = await f.content.store.put('session:another-session', text);
  f.source.contentRef = foreign;
  const operations = [...f.content.operations];
  await assert.rejects(() => f.sharing.file('reader', f.share.shareId, f.source.fileId), {
    code: 'INVALID_REFERENCE',
  });
  assert.deepEqual(f.content.operations, operations, 'wrong scope must fail before download');
  f.source.contentRef = originalRef;
  f.source.sha256 = sha('wrong metadata');
  await assert.rejects(() => f.sharing.file('reader', f.share.shareId, f.source.fileId), {
    code: 'INVALID_REFERENCE',
  });
  const inline = 'export default () => "legacy writer";';
  Object.assign(f.source, {
    content: inline,
    size: Buffer.byteLength(inline),
    sha256: sha(inline),
  });
  const dto = await f.sharing.file('reader', f.share.shareId, f.source.fileId);
  assert.equal('content' in dto && dto.content, inline);
  publicOnly(dto);
  assert.deepEqual(f.content.operations, operations, 'inline must bypass the obsolete ref');
});

/** The production detached editor uses the real saved-work authorizer/source, memory Redis/cache. */
function detachedWorkEditor(f: ReturnType<typeof workFixture>) {
  const ready = barrier();
  const records = new Map<string, EditRecord>();
  const tickets = new Map<string, EditTicket>();
  const indices = new Map<string, string>();
  const outputs = new Map<string, CachedPreviewFile[]>();
  const builds: string[][] = [];
  const store: EditStore = {
    load: async (key) => structuredClone(records.get(key) ?? null),
    locate: async (editId) => indices.get(editId) ?? null,
    async index(editId, key) {
      indices.set(editId, key);
    },
    async cas(key, prior, next) {
      if (JSON.stringify(records.get(key) ?? null) !== JSON.stringify(prior)) return false;
      if (next) records.set(key, structuredClone(next));
      else records.delete(key);
      if (next?.preview.status === 'ready') ready.resolve();
      return true;
    },
    async ticket(key, value) {
      tickets.set(key, structuredClone(value));
    },
    readTicket: async (key) => structuredClone(tickets.get(key) ?? null),
  };
  const cache: PreviewCache = {
    has: async (key) => outputs.has(key),
    async write(key, files) {
      outputs.set(key, files);
    },
    readAll: async (key) => outputs.get(key) ?? [],
    async read(key, path) {
      const file = outputs.get(key)?.find((file) => file.path === path);
      if (!file) throw new Error('CACHE_FILE_NOT_FOUND');
      return { content: Buffer.from(file.content), mimeType: file.mimeType };
    },
    migrate: async () => false,
    cleanup: async () => {},
  };
  const editor = createEditService(f.mysql, {
    store,
    cache,
    readLimits: () => limits,
    binary: () => ({ downloadFile: async () => assert.fail('unexpected binary download') }),
    async run(input) {
      assert.equal(f.depth(), 0, 'background build must not hold database locks');
      builds.push(input.files.map((file) => file.content.toString()));
      return [{ path: 'index.html', mimeType: 'text/html', content: input.files[0].content }];
    },
    detached: {
      authorize: f.service.authorize,
      source: f.service.source,
      previewPrefix: 'work-',
    },
  });
  return { editor, records, builds, ready: ready.promise };
}

/** Wait for an observed event instead of relying on fixed wall-clock delays. */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('production savedWork source freezes refs only; detached editor hydrates outside both transactions', async (t) => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  const stored = structuredClone(f.fileRows()[0]);
  const operations = [...f.content!.operations];
  const source = await f.mysql.transaction((tx) =>
    f.service.source('alice', saved.workId, undefined, tx, limits),
  );
  assert.equal(source.snapshot[0].content, null);
  assert.deepEqual(source.snapshot[0].contentRef, stored.contentRef);
  assert.deepEqual(f.content!.operations, operations);
  const d = detachedWorkEditor(f);
  t.after(() => d.editor.close());
  const created = await d.editor.create('alice', saved.workId);
  assert.equal(created.files[0].content, text);
  assert.equal(created.baseFileRevision, 1);
  publicOnly(created);
  const puts = f.content!.operations.filter((op) => op === 'put').length;
  const exported = await d.editor.exportSnapshot('alice', saved.workId, created.editId, 1);
  assert.equal(exported.snapshot[0].content, text);
  publicOnly(exported);
  publicOnly([...d.records.values()]);
  assert.equal(f.content!.operations.filter((op) => op === 'put').length, puts);
  assert.deepEqual(f.fileRows()[0], stored, 'hydration must not rewrite the frozen source');
  assert.ok(f.queries.filter((query) => query.lock).every((query) => query.depth === 1));
});

test('savedWork get/getFile release the short transaction while backend.get is pending', async (t) => {
  for (const method of ['get', 'getFile'] as const) {
    await t.test(method, async () => {
      const f = workFixture('external');
      const saved = await f.service.save('alice', { draft: draft() });
      const entered = barrier();
      const release = barrier();
      f.onGet(async () => {
        entered.resolve();
        await release.promise;
      });
      const pending =
        method === 'get'
          ? f.service.get('alice', saved.workId)
          : f.service.getFile('alice', saved.workId, sha('src/App.tsx'));
      try {
        await entered.promise;
        assert.equal(f.depth(), 0, 'slow GET must not leave an open DB transaction');
        await f.service.authorize('alice', saved.workId);
        assert.equal(f.queries.at(-1)!.lock, undefined);
      } finally {
        release.resolve();
      }
      const result = await pending;
      publicOnly(result);
      assert.equal(f.queries.at(-1)!.transaction, undefined, 'final authorization is a fresh read');
      assert.equal(f.queries.at(-1)!.lock, undefined);
      assert.deepEqual(f.queries.at(-1)!.attributes, ['ownerEid', 'workId', 'revision']);
    });
  }
});

test('savedWork get/getFile discard in-flight plaintext when ownership, existence or revision changes', async (t) => {
  for (const method of ['get', 'getFile'] as const) {
    for (const change of ['owner', 'delete', 'revision'] as const) {
      await t.test(`${method}/${change}`, async () => {
        const f = workFixture('external');
        const saved = await f.service.save('alice', { draft: draft() });
        f.onGet(() => {
          if (change === 'owner') f.workRows()[0].ownerEid = 'bob';
          if (change === 'delete') f.workRows().splice(0);
          if (change === 'revision') f.workRows()[0].revision = 2;
        });
        await assert.rejects(
          () =>
            method === 'get'
              ? f.service.get('alice', saved.workId)
              : f.service.getFile('alice', saved.workId, sha('src/App.tsx')),
          { reason: change === 'revision' ? 'SAVED_WORK_CONFLICT' : 'SAVED_WORK_NOT_FOUND' },
        );
        assert.equal(f.depth(), 0);
      });
    }
  }
});

test('production savedWork to detached edit rechecks source after hydration, preserving the existing draft', async (t) => {
  for (const change of ['owner', 'delete', 'revision'] as const) {
    await t.test(change, async (t) => {
      const f = workFixture('external');
      const saved = await f.service.save('alice', { draft: draft() });
      const d = detachedWorkEditor(f);
      t.after(() => d.editor.close());
      const prior = await d.editor.create('alice', saved.workId);
      const record = [...d.records.values()][0];
      const editId = record.editId;
      f.onGet(() => {
        if (change === 'owner') f.workRows()[0].ownerEid = 'bob';
        if (change === 'delete') f.workRows().splice(0);
        if (change === 'revision') {
          f.workRows()[0].revision = 2;
          f.fileRows().push({ ...structuredClone(f.fileRows()[0]), workRevision: 2 });
        }
      });
      await assert.rejects(() => d.editor.create('alice', saved.workId), {
        reason: change === 'revision' ? 'EDIT_CONFLICT' : 'SAVED_WORK_NOT_FOUND',
      });
      assert.equal(d.records.size, 1);
      assert.equal([...d.records.values()][0].editId, editId);
      assert.equal([...d.records.values()][0].files[0].content, prior.files[0].content);
      assert.equal(f.depth(), 0);
    });
  }
});

test('detached edit cold-cache background get uses hydrated savedWork text without locks or object reads', async (t) => {
  const f = workFixture('external');
  const saved = await f.service.save('alice', { draft: draft() });
  const d = detachedWorkEditor(f);
  t.after(() => d.editor.close());
  const created = await d.editor.create('alice', saved.workId);
  /** Finish the first background build before expiring its local cache. */
  await d.ready;
  await d.editor.close();
  assert.equal(d.builds.length, 1);
  const record = [...d.records.values()][0];
  assert.equal(record.preview.status, 'ready');
  const resumed = detachedWorkEditor(f);
  t.after(() => resumed.editor.close());
  const [key] = d.records.keys();
  resumed.records.set(key, structuredClone(record));
  f.content!.objects.clear();
  const operations = [...f.content!.operations];
  const value = await resumed.editor.get('alice', saved.workId, created.editId);
  assert.equal(value.files[0].content, text);
  await resumed.ready;
  await resumed.editor.close();
  assert.equal(resumed.builds.length, 1);
  assert.deepEqual(resumed.builds[0], [text]);
  assert.deepEqual(
    f.content!.operations,
    operations,
    'background get must reuse frozen editor text',
  );
  assert.equal(f.depth(), 0);
  publicOnly(value);
});
