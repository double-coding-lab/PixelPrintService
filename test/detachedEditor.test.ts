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
import { PreviewBuildError } from '../src/functions/d2c/preview/runner';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const reason = (value: string) => (error: unknown) =>
  error instanceof SessionError && error.reason === value;

/** No database or Redis server: unexpected source-workspace access must fail. */
async function fixture(
  t: test.TestContext,
  previewPrefix = 'plazaedit-',
  overrides: Partial<Parameters<typeof createEditService>[1]> = {},
) {
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
  const cache = createPreviewCache(root, { ttlMs: 7200000 });
  const service = createEditService(mysql, {
    store,
    cache,
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
    ...overrides,
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  async function ready(owner: string, draft: EditDraft, expected: 'ready' | 'failed' = 'ready') {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = await service.get(owner, 'source-1', draft.editId);
      if (value.preview.status !== 'building') {
        assert.equal(value.preview.status, expected);
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('preview did not settle');
  }
  return {
    root,
    service,
    store,
    records,
    indices,
    frozen,
    cache,
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

test('detached build errors expose safe diagnostics and a correlated error ID', async (t) => {
  for (const prefix of ['plazaedit-', 'workedit-']) {
    await t.test(prefix, async (t) => {
      const reports: Record<string, unknown>[] = [];
      const f = await fixture(t, prefix, {
        run: async () => {
          throw new PreviewBuildError('PREVIEW_BUILD_FAILED', {
            code: 'SYNTAX_ERROR',
            file: 'src/App.tsx',
            line: 3,
          });
        },
        report: (details) => {
          reports.push(details);
        },
      });
      const draft = await f.service.create('alice', 'source-1');
      const failed = await f.ready('alice', draft, 'failed');
      assert.match(failed.preview.error!, /语法或编译错误/);
      assert.match(failed.preview.error!, /src\/App\.tsx/);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].phase, 'build');
      assert.equal(reports[0].editor, prefix.slice(0, -1));
      assert.equal(reports[0].sourceId, 'source-1');
      assert.equal(reports[0].editId, draft.editId);
      assert.ok(failed.preview.error!.includes(String(reports[0].errorId)));
      assert.equal(f.frozen.snapshot[0].content, 'original');
      assert.ok(!JSON.stringify(reports).includes('original'));
    });
  }
});

test('detached image download failures retain storage phase without blaming source code', async (t) => {
  const reports: Record<string, unknown>[] = [];
  const secret = 'private-storage-details';
  const f = await fixture(t, 'plazaedit-', {
    report: (details) => {
      reports.push(details);
    },
    binary: () => ({
      downloadFile: async () => {
        throw Object.assign(new Error(secret), {
          stage: 'download',
          networkCode: 'ETIMEDOUT',
          statusCode: 504,
        });
      },
    }),
  });
  const draft = await f.service.create('alice', 'source-1');
  const failed = await f.ready('alice', draft, 'failed');
  assert.match(failed.preview.error!, /输入文件读取或校验失败/);
  assert.doesNotMatch(failed.preview.error!, /检查源码/);
  assert.equal(reports[0].phase, 'input');
  assert.equal(reports[0].artifactPath, 'public/a.png');
  assert.equal(reports[0].storageStage, 'download');
  assert.equal(reports[0].causeCode, 'ETIMEDOUT');
  assert.equal(reports[0].statusCode, 504);
  assert.ok(!JSON.stringify([failed, reports]).includes(secret));
});

test('detached cache failures settle even if the diagnostic reporter throws or rejects', async (t) => {
  for (const failure of ['none', 'throw', 'reject']) {
    await t.test(failure, async (t) => {
      const reports: Record<string, unknown>[] = [];
      const f = await fixture(t, 'workedit-', {
        report: (details) => {
          reports.push(details);
          if (failure === 'throw') throw new Error('private logger');
          if (failure === 'reject') return Promise.reject(new Error('private logger'));
        },
      });
      t.mock.method(f.cache, 'write', async () => {
        throw Object.assign(new Error('private filesystem path'), { code: 'EACCES' });
      });
      const draft = await f.service.create('alice', 'source-1');
      const failed = await f.ready('alice', draft, 'failed');
      assert.match(failed.preview.error!, /缓存保存失败/);
      assert.equal(reports[0].phase, 'cache');
      assert.equal(reports[0].causeCode, 'EACCES');
      assert.ok(!JSON.stringify([failed, reports]).includes('private'));
    });
  }
});

test('closing an active detached build preserves settlement without fault logging', async (t) => {
  const reports: Record<string, unknown>[] = [];
  const f = await fixture(t, 'plazaedit-', {
    run: async ({ signal }) => {
      if (signal.aborted) throw signal.reason;
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      return [];
    },
    report: (details) => {
      reports.push(details);
    },
  });
  await f.service.create('alice', 'source-1');
  await f.service.close();
  const preview = [...f.records.values()][0].preview;
  assert.equal(preview.status, 'failed');
  assert.match(preview.error!, /已中断/);
  assert.deepEqual(reports, []);
});

/** 真实磁盘缓存、独立 Redis 副本；命中时不得再次取图或调用编译器。 */
test('重复打开及无改动保存复用产物，草稿和票据仍独立，改动与还原分别处理', async (t) => {
  let builds = 0,
    downloads = 0;
  const f = await fixture(t, 'plazaedit-', {
    run: async (input) => {
      builds++;
      return [
        {
          path: 'index.html',
          mimeType: 'text/html',
          content: input.files.find((x) => x.path === 'src/App.tsx')!.content,
        },
      ];
    },
    binary: () => ({
      downloadFile: async () => {
        downloads++;
        return Buffer.from('image');
      },
    }),
  });
  const a = await f.ready('alice', await f.service.create('alice', 'source-1'));
  const oldUrl = a.preview.url!;
  await f.service.remove('alice', 'source-1', a.editId);
  const b = await f.ready('alice', await f.service.create('alice', 'source-1'));
  assert.notEqual(b.editId, a.editId);
  assert.notEqual(b.preview.url, oldUrl);
  assert.equal(builds, 1);
  assert.equal(downloads, 1);
  const [, , oldPreview, oldTicket] = oldUrl.split('/');
  await assert.rejects(
    f.service.asset('h5', oldPreview, oldTicket, 'index.html'),
    reason('EDIT_NOT_FOUND'),
  );
  await f.ready(
    'alice',
    await f.service.save('alice', 'source-1', b.editId, { baseRevision: 1, files: [] }),
  );
  assert.equal(builds, 1, '没有实际内容变化时不编译');
  await assert.rejects(
    f.service.save('alice', 'source-1', b.editId, { baseRevision: 1, files: [] }),
    reason('EDIT_CONFLICT'),
  );
  const changed = await f.ready(
    'alice',
    await f.service.save('alice', 'source-1', b.editId, {
      baseRevision: 2,
      files: [{ path: 'src/App.tsx', content: 'edited' }],
    }),
  );
  assert.equal(builds, 2);
  const [, , id, token] = changed.preview.url!.split('/');
  assert.equal((await f.service.asset('h5', id, token, 'index.html')).content.toString(), 'edited');
  await f.ready(
    'alice',
    await f.service.save('alice', 'source-1', b.editId, {
      baseRevision: 3,
      files: [{ path: 'src/App.tsx', content: 'original' }],
    }),
  );
  assert.equal(builds, 2, '还原到已缓存源码可复用');
  await f.service.create('bob', 'source-1').then((x) => f.ready('bob', x));
  assert.equal(builds, 3, '不同用户分别建立缓存授权范围');
});

test('同内容在新服务实例复用磁盘结果，源修订变化仍新建独立副本', async (t) => {
  let builds = 0;
  const f = await fixture(t, 'plazaedit-', {
    run: async () => {
      builds++;
      return [{ path: 'index.html', mimeType: 'text/html', content: Buffer.from('original') }];
    },
  });
  const old = await f.ready('alice', await f.service.create('alice', 'source-1'));
  await f.service.remove('alice', 'source-1', old.editId);
  await f.service.close();
  const next = await fixture(t, 'plazaedit-', {
    cache: f.cache,
    run: async () => assert.fail('命中不能编译'),
    binary: () => ({ downloadFile: async () => assert.fail('命中不能下载') }),
  });
  next.frozen.fileRevision++;
  const draft = await next.ready('alice', await next.service.create('alice', 'source-1'));
  assert.equal(draft.baseFileRevision, 8);
  assert.notEqual(draft.editId, old.editId);
  assert.equal(builds, 1);
});

test('构建器、配置、目标、入口、源码和图片变化分别使编辑缓存失效', async (t) => {
  let builds = 0,
    revision = 'one',
    image = Buffer.from('image');
  const f = await fixture(t, 'plazaedit-', {
    buildRevision: async () => revision,
    binary: () => ({ downloadFile: async () => image }),
    run: async () => {
      builds++;
      return [{ path: 'index.html', mimeType: 'text/html', content: Buffer.from(String(builds)) }];
    },
  });
  f.frozen.entries.push('src/Other.tsx');
  f.frozen.snapshot.push({ ...f.frozen.snapshot[0], path: 'src/Other.tsx' });
  const open = async () => f.ready('alice', await f.service.create('alice', 'source-1'));
  await open();
  assert.equal(builds, 1);
  await open();
  assert.equal(builds, 1);
  revision = 'two';
  await open();
  assert.equal(builds, 2);
  f.frozen.configSnapshot = { config: { unit: { outputBase: 375 } } };
  await open();
  assert.equal(builds, 3);
  f.frozen.target = 'rn';
  await open();
  assert.equal(builds, 4);
  f.frozen.entryPath = 'src/Other.tsx';
  await open();
  assert.equal(builds, 5);
  f.frozen.snapshot[0].content = 'new source';
  f.frozen.snapshot[0].sha256 = sha('new source');
  f.frozen.snapshot[0].size = 10;
  await open();
  assert.equal(builds, 6);
  image = Buffer.from('new image');
  f.frozen.snapshot[1].size = image.length;
  f.frozen.snapshot[1].sha256 = sha(image.toString());
  await open();
  assert.equal(builds, 7);
});

test('缺失或损坏的编辑缓存重新构建，失败结果不作为后续命中', async (t) => {
  let builds = 0;
  const f = await fixture(t, 'plazaedit-', {
    run: async () => {
      if (++builds === 1) throw new PreviewBuildError('PREVIEW_BUILD_FAILED');
      return [{ path: 'index.html', mimeType: 'text/html', content: Buffer.from('valid') }];
    },
  });
  await f.ready('alice', await f.service.create('alice', 'source-1'), 'failed');
  const first = await f.ready('alice', await f.service.create('alice', 'source-1'));
  assert.equal(builds, 2);
  const key = [...f.records.values()].find((x) => x.editId === first.editId)!.preview.key!;
  await rm(path.join(f.root, key), { recursive: true, force: true });
  await f.ready('alice', await f.service.create('alice', 'source-1'));
  assert.equal(builds, 3);
  const { writeFile, utimes } = await import('node:fs/promises');
  const expired = new Date(Date.now() - 7200001);
  await utimes(path.join(f.root, key), expired, expired);
  await f.ready('alice', await f.service.create('alice', 'source-1'));
  assert.equal(builds, 4, '过期产物必须重建');
  await writeFile(path.join(f.root, key, sha('index.html')), 'broken');
  await f.ready('alice', await f.service.create('alice', 'source-1'));
  assert.equal(builds, 5);
});

test('已有副本的历史 job 缓存键仍可读取，缓存命中继续检查来源权限', async (t) => {
  const f = await fixture(t);
  const a = await f.ready('alice', await f.service.create('alice', 'source-1'));
  const key = sha('legacy edit job key');
  await f.cache.write(key, [
    { path: 'index.html', mimeType: 'text/html', content: Buffer.from('legacy output') },
  ]);
  const stored = [...f.records.values()].find((x) => x.editId === a.editId)!;
  stored.preview.key = key;
  const current = await f.service.get('alice', 'source-1', a.editId);
  const [, , id, token] = current.preview.url!.split('/');
  assert.equal(
    (await f.service.asset('h5', id, token, 'index.html')).content.toString(),
    'legacy output',
  );
  f.revoke();
  await assert.rejects(f.service.create('alice', 'source-1'), reason('SOURCE_REVOKED'));
  await assert.rejects(f.service.asset('h5', id, token, 'index.html'), reason('SOURCE_REVOKED'));
});

test('缓存命中与新保存并发时，旧任务不能发布到新修订', async (t) => {
  const f = await fixture(t);
  await f.ready('alice', await f.service.create('alice', 'source-1'));
  const original = f.cache.has.bind(f.cache);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = true;
  t.mock.method(f.cache, 'has', async (key: string) => {
    if (hold) {
      hold = false;
      entered();
      await gate;
      return true;
    }
    return original(key);
  });
  try {
    const draft = await f.service.create('alice', 'source-1');
    await waiting;
    const next = await f.service.save('alice', 'source-1', draft.editId, {
      baseRevision: 1,
      files: [{ path: 'src/App.tsx', content: 'new revision' }],
    });
    release();
    const ready = await f.ready('alice', next);
    assert.equal(ready.revision, 2);
    const [, , id, token] = ready.preview.url!.split('/');
    assert.equal(
      (await f.service.asset('h5', id, token, 'index.html')).content.toString(),
      'new revision',
    );
  } finally {
    release();
  }
});

/** 真实 Vite 首次编译，重建服务后只走磁盘产物；不依赖外网或模型。 */
test('真实在线编辑编译结果在关闭后供独立新副本复用', { timeout: 120000 }, async (t) => {
  const code = 'export default function App(){return <h1>Reusable preview</h1>}';
  function source(f: Awaited<ReturnType<typeof fixture>>) {
    f.frozen.snapshot[0].content = code;
    f.frozen.snapshot[0].size = Buffer.byteLength(code);
    f.frozen.snapshot[0].sha256 = sha(code);
  }
  const readLimits = () => ({ textFileBytes: 1000, filesPerSession: 10, uploadBytes: 30000000 });
  const first = await fixture(t, 'plazaedit-', { run: undefined, readLimits });
  source(first);
  const opened = await first.service.create('alice', 'source-1');
  let completed = opened;
  const deadline = Date.now() + 90000;
  while (completed.preview.status === 'building' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    completed = await first.service.get('alice', 'source-1', opened.editId);
  }
  assert.equal(completed.preview.status, 'ready', completed.preview.error);
  await first.service.remove('alice', 'source-1', opened.editId);
  await first.service.close();
  const next = await fixture(t, 'plazaedit-', {
    cache: first.cache,
    readLimits,
    run: async () => assert.fail('同内容不能再次启动编译器'),
    binary: () => ({ downloadFile: async () => assert.fail('同内容不能再次取图') }),
  });
  source(next);
  const reused = await next.ready('alice', await next.service.create('alice', 'source-1'));
  assert.notEqual(reused.editId, opened.editId);
  const [, , id, token] = reused.preview.url!.split('/');
  assert.match(
    (await next.service.asset('h5', id, token, 'index.html')).content.toString(),
    /<html/i,
  );
});
