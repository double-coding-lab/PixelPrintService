import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentMigrationStore } from './helpers/contentMigrationStore';
import { enableTextContent } from './helpers/content';
import { migrateContentBatch } from '../src/functions/d2c/content/migration';
import { parseContentMigrationArgs, runContentMigrationCli } from '../scripts/migrate-content';

const text = (content: string) => ({
  content,
  size: Buffer.byteLength(content),
  sha256: createHash('sha256').update(content).digest('hex'),
});
function fixture(mode: 'shadow' | 'external' = 'shadow') {
  const f = contentMigrationStore();
  const storage = enableTextContent(f.mysql, mode);
  for (let id = 1; id <= 3; id++)
    f.tables.D2cFile.push({
      id: String(id),
      fileId: 'file-' + id,
      sessionId: 'session-one',
      kind: 'source',
      path: 'pages/' + id + '.tsx',
      objectLocator: null,
      contentRef: null,
      revision: 1,
      ...text('PRIVATE_SOURCE_' + id),
    });
  return { ...f, storage };
}

test('dry-run固定上界、只分页ID、逐行读正文，零上传/下载/数据库写入', async () => {
  const f = fixture();
  const before = JSON.stringify(f.tables);
  const first = await migrateContentBatch(f.mysql, { table: 'files', dryRun: true, batchSize: 2 });
  assert.equal(first.scanned, 2);
  assert.equal(first.eligible, 2);
  assert.equal(first.written, 0);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextAfterId, '2');
  assert.equal(first.untilId, '3');
  assert.equal(f.storage.operations.length, 0);
  assert.equal(JSON.stringify(f.tables), before);
  f.tables.D2cFile.push({ ...f.tables.D2cFile[0], id: '4' });
  const next = await migrateContentBatch(f.mysql, {
    table: 'files',
    dryRun: true,
    afterId: first.nextAfterId,
    untilId: first.untilId,
  });
  assert.equal(next.scanned, 1);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextAfterId, '3');
});

test('shadow上传不在事务内，引用与inline同提交，不改变业务修订或事件，重跑不重复上传', async () => {
  const f = fixture();
  const transaction = f.mysql.transaction.bind(f.mysql);
  let active = false;
  f.mysql.transaction = ((fn: (t: any) => Promise<unknown>) =>
    transaction(async (t) => {
      active = true;
      try {
        return await fn(t);
      } finally {
        active = false;
      }
    })) as typeof f.mysql.transaction;
  const put = f.storage.backend.put;
  f.storage.backend.put = async (input) => {
    assert.equal(active, false);
    return put(input);
  };
  const result = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(result.written, 3);
  assert.equal(result.error, undefined);
  assert.ok(
    f.tables.D2cFile.every(
      (row) => typeof row.content === 'string' && row.contentRef && row.revision === 1,
    ),
  );
  assert.equal(f.tables.D2cTimeline.length, 0);
  const puts = f.storage.operations.filter((op) => op === 'put').length;
  const again = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(again.written, 0);
  assert.equal(f.storage.operations.filter((op) => op === 'put').length, puts);
});

test('external复用shadow引用前核验，恢复inline用于旧程序回滚，密文对象保留', async () => {
  const f = fixture();
  await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  const refs = f.tables.D2cFile.map((row) => JSON.stringify(row.contentRef));
  const count = f.storage.objects.size;
  f.storage.configure({ mode: 'external' });
  const external = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(external.written, 3);
  assert.ok(f.tables.D2cFile.every((row) => row.content === null));
  assert.deepEqual(
    f.tables.D2cFile.map((row) => JSON.stringify(row.contentRef)),
    refs,
  );
  assert.equal(f.storage.objects.size, count);
  f.storage.configure({ mode: 'inline' });
  const restored = await migrateContentBatch(f.mysql, {
    table: 'files',
    action: 'restore',
    dryRun: false,
  });
  assert.equal(restored.written, 3);
  assert.ok(f.tables.D2cFile.every((row) => row.content.startsWith('PRIVATE_SOURCE_')));
  assert.equal(f.storage.objects.size, count);
});

test('并发旧writer修改后不提交过期引用，上传失败保留上一安全游标可原点重试', async () => {
  const f = fixture();
  const put = f.storage.backend.put;
  let writes = 0;
  f.storage.backend.put = async (input) => {
    if (++writes === 1) Object.assign(f.tables.D2cFile[0], { ...text('concurrent'), revision: 2 });
    if (writes === 2) throw new Error('PRIVATE_PROVIDER_BODY');
    return put(input);
  };
  const first = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(first.conflicts, 1);
  assert.equal(first.written, 0);
  assert.equal(first.nextAfterId, '0');
  assert.equal(first.error?.id, '1');
  assert.equal(first.error?.code, 'REVISION_CONFLICT');
  assert.equal(f.tables.D2cFile[0].content, 'concurrent');
  assert.equal(f.tables.D2cFile[0].contentRef, null);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
  f.storage.backend.put = put;
  const resumed = await migrateContentBatch(f.mysql, {
    table: 'files',
    afterId: first.nextAfterId,
    untilId: first.untilId,
    dryRun: false,
  });
  assert.equal(resumed.written, 3);
  assert.equal(resumed.error, undefined);
});

test('冻结版本与作品按固定分组迁移，预览保留全部清单元数据并跳过构建中输入', async () => {
  const f = fixture('external');
  f.tables.D2cVersionFile.push({
    id: '1',
    versionId: 'version-one',
    kind: 'source',
    objectLocator: null,
    ...text('version body'),
  });
  const version = await migrateContentBatch(f.mysql, { table: 'versions', dryRun: false });
  assert.equal(version.written, 1);
  assert.equal(f.tables.D2cVersionFile[0].contentRef.scope, 'version:version-one');
  f.tables.D2cSavedWorkFile.push({
    id: '1',
    workId: 'work-one',
    kind: 'source',
    objectLocator: null,
    ...text('work body'),
  });
  assert.equal((await migrateContentBatch(f.mysql, { table: 'works', dryRun: false })).written, 1);
  assert.equal(f.tables.D2cSavedWorkFile[0].contentRef.scope, 'work:work-one');
  const manifest = {
    entryPath: 'pages/index.tsx',
    files: { 'index.html': { marker: true } },
    tickets: ['opaque'],
    snapshot: [
      { path: 'pages/index.tsx', kind: 'source', objectLocator: null, ...text('preview body') },
    ],
  };
  f.tables.D2cPreview.push({
    id: '1',
    sessionId: 'session-one',
    status: 'ready',
    buildManifest: manifest,
  });
  f.tables.D2cPreview.push({
    id: '2',
    sessionId: 'session-one',
    status: 'building',
    buildManifest: structuredClone(manifest),
  });
  const result = await migrateContentBatch(f.mysql, { table: 'previews', dryRun: false });
  assert.equal(result.written, 1);
  assert.equal(result.error?.code, 'PREVIEW_ACTIVE');
  assert.equal(result.nextAfterId, '1');
  assert.equal(result.hasMore, true);
  const saved = f.tables.D2cPreview[0].buildManifest;
  assert.deepEqual(saved.files, manifest.files);
  assert.deepEqual(saved.tickets, manifest.tickets);
  assert.equal(saved.snapshot[0].content, null);
  assert.equal(saved.snapshot[0].contentRef.scope, 'session:session-one');
  assert.equal(f.tables.D2cPreview[1].buildManifest.snapshot[0].content, 'preview body');
});

test('脚本参数、BIGINT游标和固定表白名单严格校验，帮助和坏参数不打开连接', async () => {
  let opens = 0;
  const open = async () => {
    opens++;
    throw new Error('must not open');
  };
  assert.equal(await runContentMigrationCli(['--help'], open, () => {}), 0);
  for (const args of [
    ['--apply'],
    ['--dry-run', '--apply', '--table', 'files'],
    ['--apply', '--table', 'bad'],
    ['--apply', '--table', 'files', '--after-id', '-1'],
    ['--apply', '--table', 'files', '--batch-size', '1e2'],
  ])
    await assert.rejects(runContentMigrationCli(args, open, () => {}));
  assert.equal(opens, 0);
  assert.equal(
    parseContentMigrationArgs(['--dry-run', '--table', 'files', '--after-id', '9007199254740993'])
      ?.afterId,
    '9007199254740993',
  );
  const f = fixture();
  await assert.rejects(
    migrateContentBatch(f.mysql, { table: 'files', afterId: '18446744073709551616' }),
  );
});

test('命令checkpoint只含元数据，分批resume/错误原点恢复，外置确认和跨动作state拒绝', async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), 'content-migration-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const state = path.join(folder, 'state.json');
  const f = fixture();
  const output: string[] = [];
  let closes = 0;
  const open = async () => ({
    mysql: f.mysql,
    close: async () => {
      closes++;
    },
  });
  const args = ['--apply', '--table', 'files', '--batch-size', '1', '--state-file', state];
  assert.equal(await runContentMigrationCli(args, open, (value) => output.push(value)), 0);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '1');
  assert.equal((await stat(state)).mode & 0o077, 0);
  assert.equal(
    await runContentMigrationCli([...args, '--resume', '--max-batches', '3'], open, (value) =>
      output.push(value),
    ),
    0,
  );
  assert.equal(JSON.parse(await readFile(state, 'utf8')).nextAfterId, '3');
  assert.doesNotMatch(
    output.join('\n') + (await readFile(state, 'utf8')),
    /PRIVATE|contentRef|locator|key-/,
  );
  await assert.rejects(
    runContentMigrationCli([...args, '--resume', '--restore'], open, () => {}),
    /STATE_MISMATCH/,
  );
  f.storage.configure({ mode: 'external' });
  await assert.rejects(
    runContentMigrationCli(args, open, () => {}),
    /EXTERNAL_CONFIRMATION_REQUIRED/,
  );
  assert.equal(closes, 3);
});

test('提交失败回滚引用且计数不虚报，BIGINT游标不丢精度', async () => {
  const f = fixture();
  f.failCommit();
  const first = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(first.written, 0);
  assert.equal(first.nextAfterId, '0');
  assert.equal(first.error?.id, '1');
  assert.equal(f.tables.D2cFile[0].contentRef, null);
  f.tables.D2cFile.length = 0;
  for (const id of ['9007199254740993', '9007199254740994'])
    f.tables.D2cFile.push({
      id,
      sessionId: 'session-one',
      kind: 'source',
      objectLocator: null,
      ...text('bigint'),
    });
  const result = await migrateContentBatch(f.mysql, { table: 'files', batchSize: 1, dryRun: true });
  assert.equal(result.nextAfterId, '9007199254740993');
  assert.equal(result.untilId, '9007199254740994');
  assert.equal(
    (
      await migrateContentBatch(f.mysql, {
        table: 'files',
        afterId: result.nextAfterId,
        untilId: result.untilId,
        dryRun: true,
      })
    ).nextAfterId,
    '9007199254740994',
  );
});

test('上传中途失败保留最后已提交游标，续迁从失败行继续', async () => {
  const f = fixture();
  const put = f.storage.backend.put;
  let count = 0;
  f.storage.backend.put = async (input) => {
    if (++count === 2) throw new Error('PRIVATE_PROVIDER');
    return put(input);
  };
  const first = await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
  assert.equal(first.written, 1);
  assert.equal(first.nextAfterId, '1');
  assert.equal(first.error?.id, '2');
  f.storage.backend.put = put;
  assert.equal(
    (
      await migrateContentBatch(f.mysql, {
        table: 'files',
        dryRun: false,
        afterId: first.nextAfterId,
        untilId: first.untilId,
      })
    ).written,
    2,
  );
});

test('恢复/复用引用读取中取消及等待行锁后取消均不提交正文', async () => {
  for (const action of ['restore', 'externalize'] as const) {
    const f = fixture();
    await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
    if (action === 'restore') {
      f.storage.configure({ mode: 'external' });
      await migrateContentBatch(f.mysql, { table: 'files', dryRun: false });
    }
    f.storage.configure({ mode: action === 'restore' ? 'inline' : 'external' });
    const before = JSON.stringify(f.tables);
    const controller = new AbortController();
    const get = f.storage.backend.get;
    f.storage.backend.get = async (locator, options) => {
      const value = await get(locator, options);
      controller.abort();
      return value;
    };
    await assert.rejects(
      migrateContentBatch(f.mysql, {
        table: 'files',
        action,
        dryRun: false,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.equal(JSON.stringify(f.tables), before);
  }
  const f = fixture();
  const controller = new AbortController();
  const model = f.mysql.models.D2cFile;
  const find = model.findOne.bind(model);
  model.findOne = (async (options: any) => {
    const row = await find(options);
    if (options.lock) controller.abort();
    return row;
  }) as typeof model.findOne;
  await assert.rejects(
    migrateContentBatch(f.mysql, { table: 'files', dryRun: false, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(f.tables.D2cFile[0].contentRef, null);
});
