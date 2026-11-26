import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { binaryMimeType } from '../src/functions/d2c/utils/binaryMimeType';
import { createFileService } from '../src/functions/d2c/files/service';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { buildSourceFileTree } from '../web/src/workspace/fileTree';
import type { FileInfo } from '../web/src/workspace/types';
import { messageFixture } from './helpers/messages';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfoAAAAASUVORK5CYII=',
  'base64',
);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const source = {
  provider: 'local' as const,
  url: 'https://images.example.test/original.png',
  fileName: 'original.png',
  mimeType: 'image/png',
  size: png.length,
  sha256: digest(png),
};

/** 通过真实租约与二进制保存服务建档，避免预设数据库图片类型掩盖链路缺口。 */
async function fixture() {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: 'binary-mime-test',
    content: '生成页面',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => 1700000000000 });
  const lease = (await leases.claim(queued.runId, 'binary-mime-worker'))!;
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    notify: () => {},
    redact: (value) => value,
  });
  await persistence.load();
  const list = (existing?: Parameters<typeof createFileService>[3]) =>
    createFileService(f.mysql, () => f.runtime.d2c.limits, undefined, existing).list(
      'employee-a',
      f.id,
    );
  return { ...f, persistence, list };
}

test('二进制类型优先使用合法回执，通用或无效回执沿用合法存量类型', () => {
  assert.equal(binaryMimeType(source, 'application/octet-stream'), 'image/png');
  assert.equal(binaryMimeType({ mimeType: 'IMAGE/WEBP' }), 'image/webp');
  assert.equal(binaryMimeType({ mimeType: 'font/woff2' }), 'font/woff2');
  assert.equal(binaryMimeType({ mimeType: 'application/pdf' }, 'image/png'), 'application/pdf');
  for (const mimeType of [
    undefined,
    null,
    {},
    '',
    'invalid',
    'image/png\r\nX: 1',
    'x'.repeat(201),
  ]) {
    assert.equal(binaryMimeType({ mimeType }, 'image/jpeg'), 'image/jpeg');
    assert.equal(binaryMimeType({ mimeType }), 'application/octet-stream');
  }
  assert.equal(binaryMimeType({ mimeType: 'application/octet-stream' }, 'image/png'), 'image/png');
});

test('Agent首次写入和内容更新保存当前回执类型，同字节修正类型不增加文件或会话修订', async () => {
  const f = await fixture();
  await f.persistence.writeBinary('assets/banner.png', png, source);
  let row = f.tables.D2cFile.find((file) => file.path === 'assets/banner.png')!;
  assert.equal(row.mimeType, 'image/png');
  row.mimeType = 'application/octet-stream';
  const revision = row.revision;
  const sessionRevision = f.tables.D2cSession[0].fileRevision;
  const events = f.tables.D2cTimeline.length;
  await f.persistence.writeBinary('assets/banner.png', png, source);
  row = f.tables.D2cFile.find((file) => file.path === 'assets/banner.png')!;
  assert.equal(row.mimeType, 'image/png');
  assert.equal(row.revision, revision);
  assert.equal(f.tables.D2cSession[0].fileRevision, sessionRevision);
  assert.equal(f.tables.D2cTimeline.length, events);
  const changed = Buffer.concat([png, Buffer.from('changed')]);
  await f.persistence.writeBinary('assets/banner.png', changed, {
    ...source,
    mimeType: 'image/webp',
  });
  assert.equal(
    f.tables.D2cFile.find((file) => file.path === 'assets/banner.png')!.mimeType,
    'image/webp',
  );
  await f.persistence.writeBinary('assets/font.woff2', Buffer.from('font'), {
    mimeType: 'font/woff2',
  });
  assert.equal(
    f.tables.D2cFile.find((file) => file.path.endsWith('.woff2'))!.mimeType,
    'font/woff2',
  );
});

for (const stored of [null, 'application/octet-stream', 'image/png']) {
  test(`已有图片类型为${stored}时按真实回执查询WebP，并展示独立目录`, async () => {
    const f = await fixture();
    await f.persistence.writeBinary('assets/banner.png', png, source);
    const row = f.tables.D2cFile.find((file) => file.path === 'assets/banner.png')!;
    row.mimeType = stored;
    const before = JSON.stringify(f.tables);
    let lookups = 0;
    const result = await f.list(() => ({
      async existing(sources) {
        lookups++;
        assert.deepEqual(sources, [{ url: source.url, sha256: digest(png) }]);
        return [
          { ...source, url: 'https://images.example.test/ready.webp', mimeType: 'image/webp' },
        ];
      },
    }));
    assert.equal(lookups, 1);
    assert.equal(result.files[0].mimeType, 'image/png');
    assert.equal(result.webpFiles?.length, 1);
    assert.equal(result.webpFiles?.[0].sourceFileId, row.fileId);
    assert.equal(result.webpFiles?.[0].url, 'https://images.example.test/ready.webp');
    assert.equal(JSON.stringify(f.tables), before, '列表兼容仅作投影，不写库或产生文件修订');
    assert.doesNotMatch(JSON.stringify(result), /objectLocator|provider|fileName/);
    const tree = buildSourceFileTree(result.files as FileInfo[], result.webpFiles as FileInfo[]);
    assert.equal(tree[0].key, 'virtual:webp');
    assert.equal(tree[0].title, 'WebP 缩略图');
  });
}

test('内部资料、非图片和缺少可信类型的旧文件不靠扩展名猜测，不进入派生查询', async () => {
  const f = await fixture();
  await f.persistence.writeBinary('assets/banner.png', png, source);
  const row = f.tables.D2cFile.find((file) => file.path === 'assets/banner.png')!;
  for (const kind of ['source', 'internal']) {
    row.kind = kind;
    await f.list(() => ({
      async existing(sources) {
        assert.deepEqual(sources, []);
        return [];
      },
    }));
  }
  row.kind = 'asset';
  row.mimeType = 'application/octet-stream';
  for (const locator of [
    { ...source, mimeType: 'application/pdf' },
    { ...source, mimeType: undefined },
  ]) {
    row.objectLocator = locator;
    const result = await f.list(() => ({
      async existing(sources) {
        assert.deepEqual(sources, []);
        return [];
      },
    }));
    assert.deepEqual(result.webpFiles, []);
  }
});

test('已有图片缺少派生或索引故障时保留原文件，列表读取只查询成功索引', async () => {
  const f = await fixture();
  await f.persistence.writeBinary('assets/banner.png', png, source);
  f.tables.D2cFile[0].mimeType = 'application/octet-stream';
  for (const fail of [false, true]) {
    const before = JSON.stringify(f.tables);
    const result = await f.list(() => ({
      async existing() {
        if (fail) throw new Error('offline');
        return [null];
      },
    }));
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].mimeType, 'image/png');
    assert.deepEqual(result.webpFiles, []);
    assert.equal(JSON.stringify(f.tables), before);
  }
});
