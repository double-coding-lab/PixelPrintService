import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Transaction } from 'sequelize';
import { createFileService } from '../src/functions/d2c/files/service';
import { renameBlockDirectories } from '../src/functions/d2c/files/renameBlocks';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { resolveTextContent } from '../src/functions/d2c/content/runtime';
import { enableTextContent } from './helpers/content';
import { messageFixture } from './helpers/messages';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Exercise the actual business services with encrypted memory objects and transactional rows. */
async function fixture(mode: 'inline' | 'shadow' | 'external' = 'external') {
  const f = await messageFixture();
  const content = enableTextContent(f.mysql, mode, 1);
  let depth = 0;
  const originalTransaction = f.mysql.transaction.bind(f.mysql);
  f.mysql.transaction = (async (first: unknown, second?: unknown) => {
    const callback = (typeof first === 'function' ? first : second) as (
      transaction: Transaction,
    ) => Promise<unknown>;
    const wrapped = async (transaction: Transaction) => {
      depth++;
      try {
        return await callback(transaction);
      } finally {
        depth--;
      }
    };
    return typeof first === 'function'
      ? originalTransaction(wrapped)
      : originalTransaction(first as object, wrapped);
  }) as typeof f.mysql.transaction;
  const hooks: { onPut?: () => void | Promise<void> } = {};
  const put = content.backend.put.bind(content.backend);
  content.backend.put = async (input) => {
    assert.equal(depth, 0, 'Object uploads must be outside database transactions');
    const locator = await put(input);
    await hooks.onPut?.();
    return locator;
  };
  const files = createFileService(f.mysql, () => f.runtime.d2c.limits);
  const add = async (path: string, text: string) =>
    files.create('employee-a', f.id, {
      path,
      content: text,
      baseFileRevision: f.tables.D2cSession[0].fileRevision,
    });
  const row = (path: string) => f.tables.D2cFile.find((file) => file.path === path)!;
  const text = (path: string) => resolveTextContent(f.mysql, row(path), `session:${f.id}`);
  return { ...f, content, hooks, files, add, row, text };
}

/** Claim real lease ownership and load its baseline before testing Agent writes. */
async function running(f: Awaited<ReturnType<typeof fixture>>) {
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'content-run',
    content: '生成页面',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => 1700000000000 });
  const lease = (await leases.claim(queued.runId, 'content-worker'))!;
  const persistence = () =>
    createRunPersistence(f.mysql, leases, lease, {
      limits: f.runtime.d2c.limits,
      notify: () => {},
      redact: (value) => value,
    });
  const p = persistence();
  await p.load();
  return { p, persistence, leases, lease };
}

test('without runtime the legacy inline schema stays untouched, including empty strings', async () => {
  const f = await messageFixture();
  Object.assign(f.mysql.models.D2cFile, {
    scope: () => assert.fail('Legacy schema must not select contentRef'),
  });
  const files = createFileService(f.mysql, () => f.runtime.d2c.limits);
  const created = await files.create('employee-a', f.id, {
    path: 'src/legacy.ts',
    content: '',
    baseFileRevision: 0,
  });
  assert.equal((await files.get('employee-a', f.id, created.fileId!)).content, '');
  await files.update('employee-a', f.id, created.fileId!, 1, 'legacy');
  assert.equal(f.tables.D2cFile[0].content, 'legacy');
  assert.equal(Object.hasOwn(f.tables.D2cFile[0], 'contentRef'), false);
});

test('external create/get/update/delete preserve string DTOs, empty text and access boundaries', async () => {
  const f = await fixture();
  const created = await f.add('src/page.tsx', '中文正文');
  assert.equal(created.content, '中文正文');
  assert.equal(f.row('src/page.tsx').content, null);
  assert.equal(f.row('src/page.tsx').objectLocator, null);
  assert.equal(f.row('src/page.tsx').contentRef.scope, `session:${f.id}`);
  const read = await f.files.get('employee-a', f.id, created.fileId!);
  assert.equal(read.content, '中文正文');
  assert.doesNotMatch(
    JSON.stringify([created, read, await f.files.list('employee-a', f.id)]),
    /contentRef|locator|keyId|objectId/,
  );
  await assert.rejects(f.files.get('employee-b', f.id, created.fileId!));
  await f.files.update('employee-a', f.id, created.fileId!, 1, '');
  assert.equal(f.row('src/page.tsx').content, '');
  assert.equal(f.row('src/page.tsx').contentRef, null);
  assert.equal((await f.files.get('employee-a', f.id, created.fileId!)).content, '');
  await f.files.update('employee-a', f.id, created.fileId!, 2, '外置新正文');
  await f.files.remove('employee-a', f.id, created.fileId!, 3);
  assert.equal(f.tables.D2cFile.length, 0);
  assert.equal(f.content.objects.size, 2, 'Deletes must not garbage-collect immutable objects');
});

test('upload-time revision races reject stale updates and leave only unreferenced objects', async () => {
  const f = await fixture();
  const created = await f.add('src/page.ts', 'original');
  const ref = structuredClone(f.row('src/page.ts').contentRef);
  f.hooks.onPut = () => {
    f.row('src/page.ts').revision++;
    f.tables.D2cSession[0].fileRevision++;
  };
  await assert.rejects(
    f.files.update('employee-a', f.id, created.fileId!, 1, 'stale update'),
    /文件已更新/,
  );
  assert.deepEqual(f.row('src/page.ts').contentRef, ref);
  assert.equal(await f.text('src/page.ts'), 'original');
  assert.equal(f.content.objects.size, 2);
});

test('failed database commits roll back references, revisions and events without deleting uploads', async () => {
  const f = await fixture();
  const before = JSON.stringify(f.tables);
  f.failNext('D2cTimeline');
  await assert.rejects(f.add('src/page.ts', 'orphan candidate'));
  assert.equal(JSON.stringify(f.tables), before);
  assert.equal(f.content.objects.size, 1);
});

test('create rechecks session revision after upload and does not insert stale prepared text', async () => {
  const f = await fixture();
  f.hooks.onPut = () => {
    f.tables.D2cSession[0].fileRevision++;
  };
  await assert.rejects(f.add('src/page.ts', 'prepared'), /会话文件已更新/);
  assert.equal(f.tables.D2cFile.length, 0);
  assert.equal(f.content.objects.size, 1);
});

test('apply resolves originals for three-way checks and keeps same-content calls idempotent', async () => {
  const f = await fixture();
  await f.add('src/a.ts', 'original a');
  await f.add('src/b.ts', 'original b');
  const applied = await f.files.apply('employee-a', f.id, {
    baseFileRevision: 1,
    files: [{ path: 'src/a.ts', content: 'edited a' }],
    originals: [{ path: 'src/a.ts', content: 'original a' }],
  });
  assert.equal(applied.fileRevision, 3);
  assert.equal(await f.text('src/a.ts'), 'edited a');
  assert.equal(await f.text('src/b.ts'), 'original b');
  const again = await f.files.apply('employee-a', f.id, {
    baseFileRevision: 1,
    files: [{ path: 'src/a.ts', content: 'edited a' }],
    originals: [{ path: 'src/a.ts', content: 'original a' }],
  });
  assert.equal(again.fileRevision, 3);
  await assert.rejects(
    f.files.apply('employee-a', f.id, {
      baseFileRevision: 1,
      files: [{ path: 'src/a.ts', content: 'conflicting edit' }],
      originals: [{ path: 'src/a.ts', content: 'original a' }],
    }),
    /已被 Agent 更新/,
  );
  const before = JSON.stringify(f.tables);
  await assert.rejects(
    f.files.apply(
      'employee-a',
      f.id,
      {
        baseFileRevision: 3,
        files: [{ path: 'src/a.ts', content: 'must roll back' }],
      },
      async () => {
        throw new Error('Lost edit reservation');
      },
    ),
    /Lost edit reservation/,
  );
  assert.equal(JSON.stringify(f.tables), before);
});

test('rename rewrites external imports and mapping in a plan outside locks, then retries idempotently', async () => {
  const f = await fixture();
  const from = 'pages/page/blocks/sub-更多福利';
  const to = 'pages/page/blocks/more-benefits';
  await f.add(`${from}/index.tsx`, 'export default () => null;');
  await f.add('pages/page/index.tsx', "import Benefit from './blocks/sub-更多福利';");
  const sourceRef = structuredClone(f.row(`${from}/index.tsx`).contentRef);
  const input = { baseFileRevision: 2, renames: [{ from, to }], limits: f.runtime.d2c.limits };
  const results = await Promise.all([
    renameBlockDirectories(f.mysql, 'employee-a', f.id, input),
    renameBlockDirectories(f.mysql, 'employee-a', f.id, input),
  ]);
  assert.equal(results.filter((result) => !result.unchanged).length, 1);
  assert.deepEqual(f.row(`${to}/index.tsx`).contentRef, sourceRef);
  assert.equal(
    await f.text('pages/page/index.tsx'),
    "import Benefit from './blocks/more-benefits';",
  );
  assert.equal(f.row('.d2c-cache/block-paths.json').content, null);
  assert.equal(JSON.parse((await f.text('.d2c-cache/block-paths.json'))!).fileRevision, 3);
  assert.equal((await renameBlockDirectories(f.mysql, 'employee-a', f.id, input)).unchanged, true);
});

test('rename rejects changes between planning/upload and commit without partial path updates', async () => {
  const f = await fixture();
  const from = 'pages/page/blocks/sub-更多福利';
  await f.add(`${from}/index.tsx`, 'export {};');
  await f.add('pages/page/index.tsx', "import './blocks/sub-更多福利';");
  let changed = false;
  f.hooks.onPut = () => {
    if (!changed) {
      f.row('pages/page/index.tsx').revision++;
      f.tables.D2cSession[0].fileRevision++;
      changed = true;
    }
  };
  await assert.rejects(
    renameBlockDirectories(f.mysql, 'employee-a', f.id, {
      baseFileRevision: 2,
      renames: [{ from, to: 'pages/page/blocks/more-benefits' }],
      limits: f.runtime.d2c.limits,
    }),
    /会话文件已更新/,
  );
  assert.ok(f.row(`${from}/index.tsx`));
  assert.equal(f.row('.d2c-cache/block-paths.json'), undefined);
  assert.equal(await f.text('pages/page/index.tsx'), "import './blocks/sub-更多福利';");
});

test('Agent restores external source/internal text, deduplicates writes and clears binary text refs', async () => {
  const f = await fixture();
  const { p, persistence } = await running(f);
  await p.write('src/page.ts', 'Agent source');
  await p.write('.d2c-cache/image-directories.json', '{}', 'internal');
  const before = JSON.stringify(f.tables);
  const puts = f.content.operations.filter((op) => op === 'put').length;
  await p.write('src/page.ts', 'Agent source');
  assert.equal(JSON.stringify(f.tables), before);
  assert.equal(f.content.operations.filter((op) => op === 'put').length, puts);
  // A resumed run captures the last committed file revision, as the lease lifecycle does.
  f.tables.D2cRun[0].baseFileRevision = f.tables.D2cSession[0].fileRevision;
  const loaded = await persistence().load();
  assert.equal(loaded.ownerUserId, 'employee-a');
  assert.equal('ownerEid' in loaded, false);
  assert.equal(loaded.files.find((file) => file.path === 'src/page.ts')!.content, 'Agent source');
  assert.equal(loaded.files.find((file) => file.kind === 'internal')!.content, '{}');
  assert.doesNotMatch(JSON.stringify(loaded.files), /contentRef|keyId|objectId/);
  const bytes = Buffer.from('binary');
  await p.writeBinary('static/image.png', bytes, { provider: 'memory', key: 'image-1' });
  f.row('static/image.png').contentRef = f.row('src/page.ts').contentRef;
  await p.writeBinary('static/image.png', bytes, { provider: 'memory', key: 'image-1' });
  assert.equal(f.row('static/image.png').contentRef, null);
  f.row('static/image.png').contentRef = f.row('src/page.ts').contentRef;
  await p.writeBinary('static/image.png', Buffer.from('new binary'), {
    provider: 'memory',
    key: 'image-2',
  });
  assert.equal(f.row('static/image.png').contentRef, null);
  assert.equal(f.row('static/image.png').content, null);
  assert.equal(f.row('static/image.png').sha256, hash('new binary'));
});

test('Agent upload losing lease cannot commit and a new owner restores the original body', async () => {
  const f = await fixture();
  const { p, leases, lease } = await running(f);
  await p.write('src/page.ts', 'saved');
  const ref = structuredClone(f.row('src/page.ts').contentRef);
  f.hooks.onPut = () => {
    f.tables.D2cRun[0].leaseOwner = 'replacement-worker';
  };
  await assert.rejects(p.write('src/page.ts', 'lost-owner body'), /租约已失效/);
  assert.deepEqual(f.row('src/page.ts').contentRef, ref);
  assert.equal(f.content.objects.size, 2);
  f.tables.D2cRun[0].baseFileRevision = f.tables.D2cSession[0].fileRevision;
  const recovered = createRunPersistence(
    f.mysql,
    leases,
    { ...lease, owner: 'replacement-worker' },
    {
      limits: f.runtime.d2c.limits,
      notify: () => {},
      redact: (value) => value,
    },
  );
  assert.equal((await recovered.load()).files[0].content, 'saved');
});

test('Agent rechecks the original file revision after a row changes during upload', async () => {
  const f = await fixture();
  const { p } = await running(f);
  await p.write('src/page.ts', 'saved');
  f.hooks.onPut = () => {
    const row = f.row('src/page.ts');
    Object.assign(row, {
      content: 'newer write',
      size: Buffer.byteLength('newer write'),
      sha256: hash('newer write'),
      revision: row.revision + 1,
    });
  };
  await assert.rejects(p.write('src/page.ts', 'stale prepared write'), /稳定文件修订冲突/);
  assert.equal(await f.text('src/page.ts'), 'newer write');
});

test('Agent database failure keeps the old body and leaves the new upload unreferenced', async () => {
  const f = await fixture();
  const { p } = await running(f);
  await p.write('src/page.ts', 'saved');
  const before = JSON.stringify(f.tables);
  f.failNext('D2cTimeline');
  await assert.rejects(p.write('src/page.ts', 'not committed'));
  assert.equal(JSON.stringify(f.tables), before);
  assert.equal(await f.text('src/page.ts'), 'saved');
  assert.equal(f.content.objects.size, 2);
});

test('failed external restore never establishes a writable persistence baseline', async () => {
  const f = await fixture();
  const { p, persistence } = await running(f);
  await p.write('src/page.ts', 'saved');
  f.tables.D2cRun[0].baseFileRevision = f.tables.D2cSession[0].fileRevision;
  f.content.objects.clear();
  const recovered = persistence();
  await assert.rejects(recovered.load());
  const puts = f.content.operations.filter((operation) => operation === 'put').length;
  await assert.rejects(recovered.write('src/unsafe.ts', 'must not upload'), /稳定文件修订冲突/);
  assert.equal(f.content.operations.filter((operation) => operation === 'put').length, puts);
});

test('inline old-writer content takes precedence over stale refs and corrupt refs fail closed', async () => {
  const f = await fixture('shadow');
  const created = await f.add('src/page.ts', 'old');
  Object.assign(f.row('src/page.ts'), {
    content: 'old writer',
    size: Buffer.byteLength('old writer'),
    sha256: hash('old writer'),
  });
  assert.equal((await f.files.get('employee-a', f.id, created.fileId!)).content, 'old writer');
  f.content.configure({ mode: 'inline' });
  await f.files.update('employee-a', f.id, created.fileId!, 1, 'new inline');
  assert.equal(f.row('src/page.ts').contentRef, null);
  f.content.configure({ mode: 'external' });
  await f.files.update('employee-a', f.id, created.fileId!, 2, 'external');
  f.row('src/page.ts').contentRef.scope = 'session:another-session';
  await assert.rejects(f.files.get('employee-a', f.id, created.fileId!));
});

test('public user ownership is rechecked after upload and before restoring Agent files', async () => {
  const f = await fixture();
  const created = await f.add('src/page.ts', 'owned source');
  const ref = structuredClone(f.row('src/page.ts').contentRef);
  f.hooks.onPut = () => {
    f.tables.D2cWorkspace[0].createdUserId = 'employee-b';
  };
  await assert.rejects(
    f.files.update('employee-a', f.id, created.fileId!, 1, 'ownership changed'),
    /工作区不存在/,
  );
  assert.deepEqual(f.row('src/page.ts').contentRef, ref);

  const g = await fixture();
  const { p, persistence } = await running(g);
  await p.write('src/page.ts', 'restore source');
  g.tables.D2cRun[0].baseFileRevision = g.tables.D2cSession[0].fileRevision;
  g.tables.D2cWorkspace[0].createdUserId = 'employee-b';
  await assert.rejects(persistence().load(), /工作区不存在/);
});
