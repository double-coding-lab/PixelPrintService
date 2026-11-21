import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { prepareTextContent, resolveTextContent } from '../src/functions/d2c/content/runtime';
import { createEditService } from '../src/functions/d2c/edit/service';
import type { EditRecord, EditStore, EditTicket } from '../src/functions/d2c/edit/store';
import { createPreviewCache } from '../src/functions/d2c/preview/cache';
import type { runPreviewBuild } from '../src/functions/d2c/preview/runner';
import { createPreviewService } from '../src/functions/d2c/preview/service';
import {
  hydratePreviewSnapshot,
  sessionPreviewInput,
  type PreviewSnapshotFile,
} from '../src/functions/d2c/preview/session';
import { enableTextContent } from './helpers/content';
import { messageFixture } from './helpers/messages';

const userId = 'employee-a';
const entryPath = 'src/App.tsx';
const original = 'export default () => <h1>冻结正文 中文</h1>;';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** CAS和票据仅在本测试内存中运行，不连接真实Redis。 */
function editStore() {
  const records = new Map<string, EditRecord>();
  const tickets = new Map<string, EditTicket>();
  const indices = new Map<string, string>();
  const store: EditStore = {
    async load(id) {
      return structuredClone(records.get(id) ?? null);
    },
    async locate(id) {
      return indices.get(id) ?? null;
    },
    async index(id, key) {
      indices.set(id, key);
    },
    async cas(id, previous, next) {
      if (JSON.stringify(records.get(id) ?? null) !== JSON.stringify(previous)) return false;
      if (next) records.set(id, structuredClone(next));
      else records.delete(id);
      return true;
    },
    async ticket(id, ticket) {
      tickets.set(id, structuredClone(ticket));
    },
    async readTicket(id) {
      return structuredClone(tickets.get(id) ?? null);
    },
  };
  return { store, records };
}

/** 业务事务替身+真实加密协议+临时磁盘缓存；构建器捕获实际字节，不访问外部服务。 */
async function fixture(t: test.TestContext, external = true) {
  const f = await messageFixture();
  const transactionContext = new AsyncLocalStorage<{ active: boolean }>();
  const transaction = f.mysql.transaction.bind(f.mysql);
  f.mysql.transaction = (async (...args: unknown[]) => {
    const callback = args.pop() as (tx: unknown) => Promise<unknown>;
    return Reflect.apply(transaction, f.mysql, [
      ...args,
      (tx: unknown) => {
        const context = { active: true };
        return transactionContext.run(context, async () => {
          try {
            return await callback(tx);
          } finally {
            context.active = false;
          }
        });
      },
    ]);
  }) as typeof f.mysql.transaction;
  const content = external ? enableTextContent(f.mysql, 'external', 1) : undefined;
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'content-preview-')));
  const cache = createPreviewCache(root);
  const builds: Parameters<typeof runPreviewBuild>[0][] = [];
  const run: typeof runPreviewBuild = async (input) => {
    input.signal?.throwIfAborted();
    assert.ok(input.files.every((file) => Buffer.isBuffer(file.content)));
    builds.push(input);
    return [{ path: 'index.html', mimeType: 'text/html', content: input.files[0].content }];
  };
  const outputs = new Map<string, Buffer>();
  const preview = createPreviewService(f.mysql, {
    readLimits: () => f.runtime.d2c.limits,
    cache,
    run,
    binary: () => ({
      async downloadFile(locator) {
        assert.ok(locator && typeof locator === 'object' && 'fileName' in locator);
        const bytes = outputs.get(String(locator.fileName));
        assert.ok(bytes, '正文引用不能进入二进制下载器');
        return Buffer.from(bytes);
      },
      async uploadFile(input) {
        outputs.set(input.fileName, Buffer.from(input.content));
        return {
          provider: 'local',
          fileName: input.fileName,
          url: 'https://storage.invalid/' + input.fileName,
          mimeType: input.contentType,
          size: input.content.length,
          sha256: hash(input.content),
        };
      },
    }),
  });
  const redis = editStore();
  const edit = createEditService(f.mysql, {
    store: redis.store,
    cache,
    run,
    readLimits: () => f.runtime.d2c.limits,
    binary: () => ({
      async downloadFile() {
        throw new Error('正文引用不能进入二进制下载器');
      },
    }),
  });
  const storage = await prepareTextContent(f.mysql, `session:${f.id}`, original);
  f.tables.D2cFile.push({
    fileId: 'file-a',
    sessionId: f.id,
    path: entryPath,
    pathHash: hash(entryPath),
    kind: 'source',
    ...storage,
    objectLocator: null,
    size: Buffer.byteLength(original),
    sha256: hash(original),
    revision: 1,
  });
  f.tables.D2cSession[0].fileRevision = 1;
  t.after(async () => {
    await edit.close();
    await preview.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...f, ...redis, content, root, cache, builds, preview, edit, transactionContext };
}

/** 直接冻结入口保留真实权限与锁序，观察复制引用时是否触发存储操作。 */
function freeze(f: Awaited<ReturnType<typeof fixture>>, owner = userId) {
  return f.mysql.transaction((transaction) =>
    sessionPreviewInput(f.mysql, owner, f.id, entryPath, transaction, f.runtime.d2c.limits, true),
  );
}

/** 按状态等待后台任务，避免固定延时冒充完成。 */
async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('后台预览未在期限内结算');
}

test('外置快照仅复制已有引用，fingerprint与inline相同；旧writer过期ref被清理', async (t) => {
  const f = await fixture(t);
  const before = [...f.content!.operations];
  const frozen = await freeze(f);
  assert.deepEqual(f.content!.operations, before, '事务冻结不上传、不下载正文');
  assert.equal(frozen.snapshot[0].content, null);
  assert.deepEqual(frozen.snapshot[0].contentRef, f.tables.D2cFile[0].contentRef);
  const file = f.tables.D2cFile[0];
  file.content = original;
  assert.equal((await freeze(f)).fingerprint, frozen.fingerprint);
  file.content = 'export default () => <p>旧writer的新正文</p>;';
  file.size = Buffer.byteLength(file.content);
  file.sha256 = hash(file.content);
  const latest = await freeze(f);
  assert.equal(latest.snapshot[0].contentRef, null);
  assert.notEqual(latest.fingerprint, frozen.fingerprint);
  assert.equal(latest.snapshot[0].content, file.content);
  assert.deepEqual(f.content!.operations, before);
});

test('Worker编译外置冻结输入；改写当前文件后冷缓存重建仍解析原正文', async (t) => {
  const f = await fixture(t);
  const created = await f.preview.createSession(userId, f.id);
  assert.ok(created.current);
  const previewId = created.current.previewId;
  assert.doesNotMatch(JSON.stringify(created), /contentRef|locator|d2c-bodies/);
  const snapshot = structuredClone(f.tables.D2cPreview[0].buildManifest.snapshot);
  const changed = 'export default () => <p>当前新正文</p>;';
  Object.assign(f.tables.D2cFile[0], {
    ...(await prepareTextContent(f.mysql, `session:${f.id}`, changed)),
    size: Buffer.byteLength(changed),
    sha256: hash(changed),
  });
  t.mock.method(f.mysql.models.D2cFile, 'findAll', async () => {
    assert.fail('冻结后不得重读当前文件');
  });
  const puts = f.content!.operations.filter((operation) => operation === 'put').length;
  assert.equal(await f.preview.work(new AbortController().signal), true);
  assert.equal(f.builds[0].files[0].content.toString(), original);
  assert.equal((await f.preview.get(userId, previewId)).status, 'ready');
  await rm(f.root, { recursive: true, force: true });
  await assert.rejects(f.preview.ticket(userId, previewId), { reason: 'PREVIEW_CACHE_MISS' });
  await waitFor(async () => (await f.preview.get(userId, previewId)).status === 'ready');
  assert.equal(f.builds.length, 2);
  assert.equal(f.builds[1].files[0].content.toString(), original);
  assert.deepEqual(f.tables.D2cPreview[0].buildManifest.snapshot, snapshot);
  assert.equal(f.content!.operations.filter((operation) => operation === 'put').length, puts);
  const ticket = await f.preview.ticket(userId, previewId);
  const asset = await f.preview.asset('h5', previewId, ticket.url.split('/')[3], 'index.html');
  assert.equal(asset.content.toString(), original);
});

test('版本预览从冻结version_file引用解析正文，保持版本公开票据语义', async (t) => {
  const f = await fixture(t);
  f.tables.D2cVersion.push({
    versionId: 'version-a',
    status: 'ready',
    target: 'h5',
    archiveObject: { fileName: 'source.zip' },
    sourceFileRevision: 1,
    manifestHash: 'frozen',
    resourceRevisionId: 'resource-a',
    configSnapshot: { config: {} },
  });
  f.tables.D2cVersionFile.push({ ...f.tables.D2cFile[0], versionId: 'version-a' });
  f.tables.D2cFile.splice(0);
  const queued = await f.preview.create('employee-b', 'version-a', entryPath);
  await f.preview.work(new AbortController().signal);
  assert.equal((await f.preview.get('employee-b', queued.previewId)).status, 'ready');
  assert.equal(f.builds[0].files[0].content.toString(), original);
  const ticket = await f.preview.ticket('employee-b', queued.previewId);
  assert.equal(ticket.expiresAt, null);
  assert.equal(
    (
      await f.preview.asset('h5', queued.previewId, ticket.url.split('/')[3], 'index.html')
    ).content.toString(),
    original,
  );
});

test('未装配runtime的旧inline快照及空字符串继续构建与编辑', async (t) => {
  const f = await fixture(t, false);
  const empty = {
    path: 'src/empty.css',
    pathHash: hash('src/empty.css'),
    fileId: 'file-empty',
    sessionId: f.id,
    kind: 'source',
    content: '',
    objectLocator: null,
    size: 0,
    sha256: hash(''),
    revision: 1,
  };
  f.tables.D2cFile.push(empty);
  const frozen = await freeze(f);
  assert.ok(frozen.snapshot.every((file) => !Object.hasOwn(file, 'contentRef')));
  await f.preview.createSession(userId, f.id);
  await f.preview.work(new AbortController().signal);
  assert.deepEqual(
    f.builds[0].files.map((file) => file.content.toString()),
    [original, ''],
  );
  const draft = await f.edit.create(userId, f.id);
  assert.equal(draft.files.find((file) => file.path === empty.path)?.content, '');
  assert.doesNotMatch(JSON.stringify(draft), /contentRef|locator/);
});

test('编辑创建先授权水合，save/export/apply始终传字符串且拒绝客户端引用注入', async (t) => {
  const f = await fixture(t);
  const draft = await f.edit.create(userId, f.id);
  assert.equal(draft.files[0].content, original);
  assert.doesNotMatch(JSON.stringify(f.records.get(f.id)), /contentRef|d2c-bodies/);
  const edited = 'export default () => <h2>编辑正文</h2>;';
  const input = {
    baseRevision: draft.revision,
    files: [{ path: entryPath, content: edited, contentRef: { locator: 'CLIENT_INJECTION' } }],
  };
  const saved = await f.edit.save(userId, f.id, draft.editId, input);
  assert.doesNotMatch(JSON.stringify(saved), /CLIENT_INJECTION|contentRef|locator/);
  const exported = await f.edit.exportSnapshot(userId, f.id, draft.editId, saved.revision);
  assert.equal(exported.snapshot[0].content, edited);
  assert.doesNotMatch(JSON.stringify(exported), /contentRef|locator|d2c-bodies/);
  await f.edit.apply(userId, f.id, draft.editId, { baseRevision: saved.revision });
  const file = f.tables.D2cFile[0];
  assert.equal(await resolveTextContent(f.mysql, file, `session:${f.id}`), edited);
  assert.equal(file.content, null, '落库模式由files服务处理');
  assert.equal(f.records.get(f.id)!.snapshot[0].content, edited);
  assert.doesNotMatch(JSON.stringify(f.records.get(f.id)), /contentRef|d2c-bodies/);
});

test('edit.create在事务外下载正文，下载期间允许其他事务取得工作区/会话锁', async (t) => {
  const f = await fixture(t);
  const get = f.content!.backend.get;
  let observed = false;
  t.mock.method(
    f.content!.backend,
    'get',
    async (locator: Record<string, unknown>, options: { maxBytes: number }) => {
      assert.notEqual(
        f.transactionContext.getStore()?.active,
        true,
        '正文storage get不得位于MySQL事务内',
      );
      await f.mysql.transaction(async (transaction) => {
        await f.mysql.models.D2cWorkspace.findOne({
          where: { workspaceId: 'workspace-a' },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        await f.mysql.models.D2cSession.findOne({
          where: { sessionId: f.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
      });
      observed = true;
      return get(locator, options);
    },
  );
  const draft = await f.edit.create(userId, f.id);
  assert.equal(observed, true);
  assert.equal(draft.files[0].content, original);
});

test('edit.create水合期间来源修订/配置/内容身份变化均拒绝CAS，保留原副本', async (t) => {
  for (const change of ['revision', 'config', 'contentIdentity', 'binaryLocator'] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      if (change === 'binaryLocator') {
        f.tables.D2cFile.push({
          fileId: 'binary-a',
          sessionId: f.id,
          path: 'assets/a.png',
          pathHash: hash('assets/a.png'),
          kind: 'asset',
          content: null,
          objectLocator: { fileName: 'before' },
          size: 1,
          sha256: hash('a'),
        });
      }
      const old = await f.edit.create(userId, f.id);
      const changed = 'export default () => <div>changed</div>;';
      const storage = await prepareTextContent(f.mysql, `session:${f.id}`, changed);
      const get = f.content!.backend.get;
      let once = false;
      t.mock.method(
        f.content!.backend,
        'get',
        async (locator: Record<string, unknown>, options: { maxBytes: number }) => {
          const bytes = await get(locator, options);
          if (!once) {
            once = true;
            if (change === 'revision') f.tables.D2cSession[0].fileRevision++;
            if (change === 'config') f.tables.D2cWorkspace[0].configJson.h5.unit.outputBase++;
            if (change === 'contentIdentity')
              Object.assign(f.tables.D2cFile[0], {
                ...storage,
                size: Buffer.byteLength(changed),
                sha256: hash(changed),
              });
            if (change === 'binaryLocator')
              f.tables.D2cFile[1].objectLocator = { fileName: 'after' };
          }
          return bytes;
        },
      );
      const cas = t.mock.method(f.store, 'cas');
      const index = t.mock.method(f.store, 'index');
      await assert.rejects(f.edit.create(userId, f.id), { reason: 'EDIT_CONFLICT' });
      assert.equal(index.mock.callCount(), 0);
      assert.equal(
        cas.mock.calls.filter((call) => call.arguments[2]?.editId !== old.editId).length,
        0,
      );
      assert.equal(f.records.get(f.id)!.editId, old.editId);
    });
  }
});

test('edit.create水合期间失权或新副本抢先创建时拒绝覆盖', async (t) => {
  for (const change of ['permission', 'draft'] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const old = await f.edit.create(userId, f.id);
      const get = f.content!.backend.get;
      let once = false;
      let newerId = old.editId;
      t.mock.method(
        f.content!.backend,
        'get',
        async (locator: Record<string, unknown>, options: { maxBytes: number }) => {
          const bytes = await get(locator, options);
          if (!once) {
            once = true;
            if (change === 'permission') f.tables.D2cWorkspace[0].createdUserId = 'employee-b';
            else newerId = (await f.edit.create(userId, f.id)).editId;
          }
          return bytes;
        },
      );
      await assert.rejects(
        f.edit.create(userId, f.id),
        change === 'permission' ? { statusCode: 404 } : { reason: 'EDIT_CONFLICT' },
      );
      assert.equal(f.records.get(f.id)!.editId, newerId);
    });
  }
});

test('外置编辑基线按原文进行三方比对，同文件并发改写保留草稿', async (t) => {
  const f = await fixture(t);
  const draft = await f.edit.create(userId, f.id);
  const saved = await f.edit.save(userId, f.id, draft.editId, {
    baseRevision: 1,
    files: [{ path: entryPath, content: 'draft' }],
  });
  Object.assign(f.tables.D2cFile[0], {
    ...(await prepareTextContent(f.mysql, `session:${f.id}`, 'concurrent')),
    size: Buffer.byteLength('concurrent'),
    sha256: hash('concurrent'),
    revision: 2,
  });
  f.tables.D2cSession[0].fileRevision = 2;
  await assert.rejects(f.edit.apply(userId, f.id, draft.editId, { baseRevision: saved.revision }), {
    reason: 'FILES_CONFLICT',
  });
  assert.equal(f.records.get(f.id)!.files[0].content, 'draft');
  assert.equal(f.records.get(f.id)!.snapshot[0].content, original);
  assert.equal(f.records.get(f.id)!.applying, undefined);
});

test('独立编辑按来源授权后水合作品scope的冻结引用，导出只携带字符串', async (t) => {
  const f = await fixture(t);
  const frozen = await freeze(f);
  const storage = await prepareTextContent(f.mysql, 'work:work-a', original);
  const snapshot = [{ ...frozen.snapshot[0], ...storage }];
  const get = f.content!.backend.get;
  let storageReads = 0;
  t.mock.method(
    f.content!.backend,
    'get',
    async (locator: Record<string, unknown>, options: { maxBytes: number }) => {
      assert.notEqual(
        f.transactionContext.getStore()?.active,
        true,
        'detached正文读取不得位于事务内',
      );
      storageReads++;
      return get(locator, options);
    },
  );
  let authorized = false;
  let sourceReads = 0;
  const detached = createEditService(f.mysql, {
    store: f.store,
    cache: f.cache,
    run: async (input) => [
      { path: 'index.html', mimeType: 'text/html', content: input.files[0].content },
    ],
    readLimits: () => f.runtime.d2c.limits,
    binary: () => ({ downloadFile: async () => assert.fail('不应读取二进制') }),
    detached: {
      previewPrefix: 'work-',
      async authorize(owner) {
        assert.equal(owner, userId);
        authorized = true;
      },
      async source() {
        assert.equal(authorized, true);
        sourceReads++;
        return {
          fileRevision: 1,
          target: 'h5',
          snapshot,
          configSnapshot: frozen.configSnapshot,
          entries: [entryPath],
          entryPath,
        };
      },
    },
  });
  t.after(() => detached.close());
  const before = [...f.content!.operations];
  await assert.rejects(detached.create('employee-b', 'work-a'));
  assert.equal(sourceReads, 0);
  assert.deepEqual(f.content!.operations, before);
  const draft = await detached.create(userId, 'work-a');
  assert.equal(storageReads, 1);
  assert.equal(draft.files[0].content, original);
  const exported = await detached.exportSnapshot(userId, 'work-a', draft.editId, draft.revision);
  assert.equal(exported.snapshot[0].content, original);
  assert.doesNotMatch(JSON.stringify(exported), /contentRef|locator|d2c-bodies/);
  assert.equal(snapshot[0].content, null, '不修改来源冻结快照');
  await detached.close();
});

test('会话/编辑拒绝越权及撤销后的票据，拒绝前不读取正文对象', async (t) => {
  const f = await fixture(t);
  const before = [...f.content!.operations];
  await assert.rejects(f.preview.createSession('employee-b', f.id), { statusCode: 404 });
  await assert.rejects(f.edit.create('employee-b', f.id), { statusCode: 404 });
  assert.deepEqual(f.content!.operations, before);
  const queued = await f.preview.createSession(userId, f.id);
  await f.preview.work(new AbortController().signal);
  const ticket = await f.preview.ticket(userId, queued.current!.previewId);
  const draft = await f.edit.create(userId, f.id);
  await waitFor(
    async () => (await f.edit.get(userId, f.id, draft.editId)).preview.status !== 'building',
  );
  f.tables.D2cWorkspace[0].createdUserId = 'employee-b';
  const after = [...f.content!.operations];
  await rm(f.root, { recursive: true, force: true });
  await assert.rejects(f.preview.ticket(userId, queued.current!.previewId), { statusCode: 404 });
  await assert.rejects(
    f.preview.asset('h5', queued.current!.previewId, ticket.url.split('/')[3], 'index.html'),
    { statusCode: 404 },
  );
  await assert.rejects(f.edit.get(userId, f.id, draft.editId), { statusCode: 404 });
  assert.deepEqual(f.content!.operations, after);
});

test('外置对象缺失或损坏时Worker/编辑明确失败，既不回退当前文件也不泄漏locator', async (t) => {
  for (const kind of ['missing', 'corrupt'] as const) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const queued = await f.preview.createSession(userId, f.id);
      if (kind === 'missing') f.content!.objects.clear();
      else {
        const bytes = [...f.content!.objects.values()][0];
        bytes[bytes.length - 1] ^= 1;
      }
      await f.preview.work(new AbortController().signal);
      const status = await f.preview.get(userId, queued.current!.previewId);
      assert.equal(status.status, 'failed');
      assert.equal(f.builds.length, 0);
      assert.doesNotMatch(JSON.stringify(status), /contentRef|locator|d2c-bodies/);
      await assert.rejects(f.edit.create(userId, f.id), (error: Error) => {
        assert.doesNotMatch(error.message, /locator|d2c-bodies|PRIVATE/);
        return true;
      });
      assert.equal(f.records.size, 0);
    });
  }
});

test('冻结输入摘要/大小/scope不匹配均失败，源码不允许借用二进制locator', async (t) => {
  for (const patch of [{ sha256: 'a'.repeat(64) }, { size: 1 }, { scope: 'session:other' }]) {
    await t.test(JSON.stringify(patch), async (t) => {
      const f = await fixture(t);
      const file = f.tables.D2cFile[0];
      Object.assign(file.contentRef, patch);
      const before = [...f.content!.operations];
      await assert.rejects(freeze(f), { reason: 'FILE_CORRUPT' });
      assert.deepEqual(f.content!.operations, before);
    });
  }
  const f = await fixture(t);
  const queued = await f.preview.createSession(userId, f.id);
  const file = f.tables.D2cPreview[0].buildManifest.snapshot[0];
  delete file.contentRef;
  file.objectLocator = { fileName: 'CLIENT_BODY' };
  await f.preview.work(new AbortController().signal);
  assert.equal((await f.preview.get(userId, queued.current!.previewId)).status, 'failed');
  assert.equal(f.builds.length, 0);
});

test('ready冷重建遇到对象丢失时返回失败并保留原快照，不回读当前文件', async (t) => {
  const f = await fixture(t);
  const queued = await f.preview.createSession(userId, f.id);
  const previewId = queued.current!.previewId;
  await f.preview.work(new AbortController().signal);
  assert.equal((await f.preview.get(userId, previewId)).status, 'ready');
  const snapshot = structuredClone(f.tables.D2cPreview[0].buildManifest.snapshot);
  f.content!.objects.clear();
  t.mock.method(f.mysql.models.D2cFile, 'findAll', async () => assert.fail('不得重读当前文件'));
  await rm(f.root, { recursive: true, force: true });
  await assert.rejects(f.preview.ticket(userId, previewId), { reason: 'PREVIEW_CACHE_MISS' });
  await waitFor(async () => (await f.preview.get(userId, previewId)).status === 'failed');
  const status = await f.preview.get(userId, previewId);
  assert.doesNotMatch(JSON.stringify(status), /contentRef|locator|d2c-bodies/);
  assert.equal(f.builds.length, 1);
  assert.deepEqual(f.tables.D2cPreview[0].buildManifest.snapshot, snapshot);
});

test('授权水合保留空正文并剥离过期引用，取消信号不会读取对象', async (t) => {
  const f = await fixture(t);
  const frozen = await freeze(f);
  const controller = new AbortController();
  controller.abort();
  const before = [...f.content!.operations];
  await assert.rejects(
    hydratePreviewSnapshot(f.mysql, frozen.snapshot, undefined, controller.signal),
    {
      name: 'AbortError',
    },
  );
  assert.deepEqual(f.content!.operations, before);
  const empty: PreviewSnapshotFile = {
    ...frozen.snapshot[0],
    content: '',
    size: 0,
    sha256: hash(''),
  };
  const hydrated = await hydratePreviewSnapshot(f.mysql, [empty]);
  assert.equal(hydrated[0].content, '');
  assert.equal(Object.hasOwn(hydrated[0], 'contentRef'), false);
  assert.deepEqual(f.content!.operations, before);
});
