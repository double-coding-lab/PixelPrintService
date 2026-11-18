import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Sequelize } from 'sequelize';
import { createEditService, type EditDraft } from '../src/functions/d2c/edit/service';
import type { EditRecord, EditStore, EditTicket } from '../src/functions/d2c/edit/store';
import { createPreviewCache } from '../src/functions/d2c/preview/cache';
import { sessionPreviewInput, type EditSourceSnapshot } from '../src/functions/d2c/preview/session';
import { SessionError } from '../src/functions/d2c/session/access';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const reason = (value: string) => (error: unknown) =>
  error instanceof SessionError && error.reason === value;

/** No database or Redis server: unexpected source-workspace access must fail. */
async function fixture(t: test.TestContext, previewPrefix = 'plazaedit-') {
  const records = new Map<string, EditRecord>();
  const indices = new Map<string, string>();
  const tickets = new Map<string, EditTicket>();
  const store: EditStore = {
    async load(key) {
      return structuredClone(records.get(key) ?? null);
    },
    async locate(id) {
      return indices.get(id) ?? null;
    },
    async index(id, key) {
      indices.set(id, key);
    },
    async cas(key, previous, next) {
      if (JSON.stringify(records.get(key) ?? null) !== JSON.stringify(previous)) return false;
      if (next) records.set(key, structuredClone(next));
      else records.delete(key);
      return true;
    },
    async ticket(key, ticket) {
      tickets.set(key, structuredClone(ticket));
    },
    async readTicket(key) {
      return structuredClone(tickets.get(key) ?? null);
    },
  };
  const mysql = {
    transaction: async (_options: unknown, callback: (transaction: unknown) => unknown) =>
      callback({}),
  } as unknown as Sequelize;
  const frozen: EditSourceSnapshot = {
    fileRevision: 7,
    target: 'h5',
    entries: ['src/App.tsx'],
    entryPath: 'src/App.tsx',
    configSnapshot: { config: { unit: { outputBase: 750 } } },
    snapshot: [
      {
        path: 'src/App.tsx',
        kind: 'source',
        content: 'original',
        objectLocator: null,
        size: 8,
        sha256: sha('original'),
      },
      {
        path: 'public/a.png',
        kind: 'asset',
        content: null,
        objectLocator: { id: 'frozen-image' },
        size: 5,
        sha256: sha('image'),
      },
    ],
  };
  let revoked = false;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'detached-edit-')));
  const service = createEditService(mysql, {
    store,
    cache: createPreviewCache(root),
    binary: () => ({ downloadFile: async () => Buffer.from('image') }),
    readLimits: () => ({ textFileBytes: 1000, filesPerSession: 10, uploadBytes: 10000 }),
    run: async (input) => [
      { path: 'index.html', mimeType: 'text/html', content: input.files[0].content },
    ],
    detached: {
      previewPrefix,
      async authorize(owner) {
        if (!owner || revoked) throw new SessionError(404, 'SOURCE_REVOKED', 'revoked');
      },
      async source() {
        return structuredClone(frozen);
      },
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  async function ready(owner: string, draft: EditDraft) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = await service.get(owner, 'source-1', draft.editId);
      if (value.preview.status !== 'building') {
        assert.equal(value.preview.status, 'ready');
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('preview did not settle');
  }
  return {
    service,
    store,
    records,
    indices,
    frozen,
    ready,
    revoke: () => {
      revoked = true;
    },
  };
}

test('detached owners independently save, build, remove and reenter the same source', async (t) => {
  const f = await fixture(t);
  const a = await f.service.create('alice', 'source-1');
  const b = await f.service.create('bob', 'source-1');
  assert.equal(f.records.size, 2);
  assert.ok([...f.records.values()].every((record) => record.sessionId === 'source-1'));
  await assert.rejects(f.service.get('bob', 'source-1', a.editId), reason('EDIT_NOT_FOUND'));
  await assert.rejects(
    f.service.save('bob', 'source-1', a.editId, { baseRevision: 1, files: [] }),
    reason('EDIT_NOT_FOUND'),
  );
  await assert.rejects(
    f.service.exportSnapshot('bob', 'source-1', a.editId, 1),
    reason('EDIT_NOT_FOUND'),
  );
  const updated = await f.service.save('alice', 'source-1', a.editId, {
    baseRevision: 1,
    files: [{ path: 'src/App.tsx', content: 'alice edit' }],
  });
  const built = await f.ready('alice', updated);
  const [, , previewId, token] = built.preview.url!.split('/');
  assert.equal(
    (await f.service.asset('h5', previewId, token, 'index.html')).content.toString(),
    'alice edit',
  );
  assert.equal((await f.ready('bob', b)).files[0].content, 'original');
  await f.service.remove('alice', 'source-1', a.editId);
  await assert.rejects(
    f.service.asset('h5', previewId, token, 'index.html'),
    reason('EDIT_NOT_FOUND'),
  );
  assert.equal((await f.service.get('bob', 'source-1', b.editId)).editId, b.editId);
  const reentered = await f.service.create('alice', 'source-1');
  assert.equal(reentered.files[0].content, 'original');
});

test('detached direct apply always rejects without reserving or writing source', async (t) => {
  const f = await fixture(t);
  const draft = await f.service.create('alice', 'source-1');
  await assert.rejects(
    f.service.apply('alice', 'source-1', draft.editId, { baseRevision: 1 }),
    reason('EDIT_APPLY_FORBIDDEN'),
  );
  assert.ok([...f.records.values()].every((record) => !record.applying));
  assert.equal(f.frozen.snapshot[0].content, 'original');
});

test('source revocation blocks reads, edits, export and previously issued assets', async (t) => {
  const f = await fixture(t);
  const draft = await f.ready('alice', await f.service.create('alice', 'source-1'));
  const [, , previewId, token] = draft.preview.url!.split('/');
  f.revoke();
  await assert.rejects(f.service.get('alice', 'source-1', draft.editId), reason('SOURCE_REVOKED'));
  await assert.rejects(
    f.service.save('alice', 'source-1', draft.editId, { baseRevision: 1, files: [] }),
    reason('SOURCE_REVOKED'),
  );
  await assert.rejects(
    f.service.exportSnapshot('alice', 'source-1', draft.editId, 1),
    reason('SOURCE_REVOKED'),
  );
  await assert.rejects(
    f.service.asset('h5', previewId, token, 'index.html'),
    reason('SOURCE_REVOKED'),
  );
  await assert.rejects(f.service.create('alice', 'source-1'), reason('SOURCE_REVOKED'));
});

test('export overlays UTF-8 hashes and sizes on frozen inputs and checks revision and content', async (t) => {
  const f = await fixture(t);
  const draft = await f.service.create('alice', 'source-1');
  const content = '编辑后的源码';
  await f.service.save('alice', 'source-1', draft.editId, {
    baseRevision: 1,
    files: [{ path: 'src/App.tsx', content }],
  });
  f.frozen.fileRevision = 99;
  f.frozen.configSnapshot = { changed: true };
  await assert.rejects(
    f.service.exportSnapshot('alice', 'source-1', draft.editId, 1),
    reason('EDIT_CONFLICT'),
  );
  const exported = await f.service.exportSnapshot('alice', 'source-1', draft.editId, 2);
  assert.equal(exported.sourceId, 'source-1');
  assert.equal(exported.baseFileRevision, 7);
  assert.equal(exported.revision, 2);
  assert.equal(exported.snapshot[0].content, content);
  assert.equal(exported.snapshot[0].size, Buffer.byteLength(content));
  assert.equal(exported.snapshot[0].sha256, sha(content));
  assert.deepEqual(exported.snapshot[1], f.frozen.snapshot[1]);
  assert.deepEqual(exported.configSnapshot, { config: { unit: { outputBase: 750 } } });
  exported.snapshot[0].content = 'caller mutation';
  assert.equal(
    (await f.service.exportSnapshot('alice', 'source-1', draft.editId, 2)).snapshot[0].content,
    content,
  );
  const record = f.records.get(f.indices.get(draft.editId)!)!;
  record.files[0].content = '\0';
  await assert.rejects(
    f.service.exportSnapshot('alice', 'source-1', draft.editId, 2),
    reason('INVALID_CONTENT'),
  );
});

for (const prefix of ['plazaedit-', 'workedit-']) {
  test(`preview accepts only its configured ${prefix} UUID namespace`, async (t) => {
    const f = await fixture(t, prefix);
    const draft = await f.ready('alice', await f.service.create('alice', 'source-1'));
    const [, , previewId, token] = draft.preview.url!.split('/');
    assert.equal(previewId, prefix + draft.editId);
    await f.service.asset('h5', previewId, token, 'index.html');
    for (const wrong of ['edit-', prefix === 'plazaedit-' ? 'workedit-' : 'plazaedit-']) {
      await assert.rejects(
        f.service.asset('h5', wrong + draft.editId, token, 'index.html'),
        reason('EDIT_NOT_FOUND'),
      );
    }
    await assert.rejects(
      f.service.asset('rn', previewId, token, 'index.html'),
      reason('EDIT_NOT_FOUND'),
    );
  });
}

test('source authorizer receives share id while snapshot queries the resolved session id', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } } as import('sequelize').Transaction;
  const marker = new Error('verified resolved source query');
  const mysql = {
    models: {
      D2cFile: {
        async findAll(options: { where: { sessionId: string } }) {
          assert.equal(options.where.sessionId, 'resolved-private-session');
          throw marker;
        },
      },
    },
  } as unknown as Sequelize;
  const authorizer: typeof import('../src/functions/d2c/session/access').ownedSession = async (
    ...args
  ) => {
    assert.deepEqual(args, [mysql, 'alice', 'published-share', transaction, 'write']);
    return {
      session: { sessionId: 'resolved-private-session', target: 'h5' },
      workspace: { activeResourceRevisionId: 'resource-1' },
    } as unknown as Awaited<
      ReturnType<typeof import('../src/functions/d2c/session/access').ownedSession>
    >;
  };
  await assert.rejects(
    sessionPreviewInput(
      mysql,
      'alice',
      'published-share',
      undefined,
      transaction,
      { textFileBytes: 1000, filesPerSession: 10 },
      true,
      authorizer,
    ),
    (error) => error === marker,
  );
});

test('personal-work acknowledgement advances only baseline, allowing repeated saves and idempotent retry', async (t) => {
  const f = await fixture(t, 'workedit-');
  const draft = await f.service.create('alice', 'source-1');
  const saved = await f.service.advanceBaseline('alice', 'source-1', draft.editId, 1, 8);
  assert.equal(saved.revision, 1);
  assert.equal(saved.baseFileRevision, 8);
  assert.equal(saved.files[0].content, 'original');
  assert.equal(
    (await f.service.advanceBaseline('alice', 'source-1', draft.editId, 1, 8)).baseFileRevision,
    8,
  );
  const edited = await f.service.save('alice', 'source-1', draft.editId, {
    baseRevision: 1,
    files: [{ path: 'src/App.tsx', content: 'second save' }],
  });
  const exported = await f.service.exportSnapshot(
    'alice',
    'source-1',
    draft.editId,
    edited.revision,
  );
  assert.equal(exported.baseFileRevision, 8);
  await f.service.advanceBaseline('alice', 'source-1', draft.editId, exported.revision, 9);
  assert.equal(
    (await f.service.exportSnapshot('alice', 'source-1', draft.editId, edited.revision))
      .baseFileRevision,
    9,
  );
  await assert.rejects(
    f.service.advanceBaseline('alice', 'source-1', draft.editId, edited.revision, 8),
    reason('EDIT_CONFLICT'),
  );
});

test('baseline acknowledgement rejects changed draft, foreign owner, replaced draft and revoked source', async (t) => {
  const f = await fixture(t, 'workedit-');
  const draft = await f.service.create('alice', 'source-1');
  await assert.rejects(
    f.service.advanceBaseline('bob', 'source-1', draft.editId, 1, 8),
    reason('EDIT_NOT_FOUND'),
  );
  await f.service.save('alice', 'source-1', draft.editId, { baseRevision: 1, files: [] });
  await assert.rejects(
    f.service.advanceBaseline('alice', 'source-1', draft.editId, 1, 8),
    reason('EDIT_CONFLICT'),
  );
  assert.equal((await f.service.get('alice', 'source-1', draft.editId)).baseFileRevision, 7);
  const next = await f.service.create('alice', 'source-1');
  await assert.rejects(
    f.service.advanceBaseline('alice', 'source-1', draft.editId, 2, 8),
    reason('EDIT_NOT_FOUND'),
  );
  f.revoke();
  await assert.rejects(
    f.service.advanceBaseline('alice', 'source-1', next.editId, 1, 8),
    reason('SOURCE_REVOKED'),
  );
});

test('baseline CAS cannot acknowledge content saved concurrently after export', async (t) => {
  const f = await fixture(t, 'workedit-');
  const draft = await f.service.create('alice', 'source-1');
  const originalCas = f.store.cas;
  let raced = false;
  f.store.cas = async (key, previous, next) => {
    if (!raced && next?.baseFileRevision === 8) {
      raced = true;
      await f.service.save('alice', 'source-1', draft.editId, {
        baseRevision: 1,
        files: [{ path: 'src/App.tsx', content: 'concurrent edit' }],
      });
    }
    return originalCas(key, previous, next);
  };
  await assert.rejects(
    f.service.advanceBaseline('alice', 'source-1', draft.editId, 1, 8),
    reason('EDIT_CONFLICT'),
  );
  const current = await f.service.get('alice', 'source-1', draft.editId);
  assert.equal(current.baseFileRevision, 7);
  assert.equal(current.revision, 2);
  assert.equal(current.files[0].content, 'concurrent edit');
});
