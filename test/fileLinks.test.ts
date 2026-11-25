import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFileService } from '../src/functions/d2c/files/service';
import type { StorageFileObject } from '../src/hooks/tools/storage';
import { sessionStore } from './helpers/sessionStore';

/** 使用本地存储回执与身份替身，验证只读投影，不下载或上传图片。 */
function fixture() {
  const store = sessionStore();
  store.tables.D2cSession.push({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    fileRevision: 1,
  });
  const source: StorageFileObject = {
    provider: 'local',
    fileName: 'original/banner.png',
    url: 'http://127.0.0.1:8080/storage/original-banner.png',
    sha256: 'a'.repeat(64),
    size: 100,
    mimeType: 'image/png',
  };
  const row = {
    sessionId: 'session-a',
    fileId: 'image-a',
    path: 'assets/banner.png',
    pathHash: createHash('sha256').update('assets/banner.png').digest('hex'),
    kind: 'asset',
    content: null,
    objectLocator: source,
    mimeType: source.mimeType,
    size: source.size,
    sha256: source.sha256,
    revision: 1,
  };
  store.tables.D2cFile.push(row);
  return { ...store, row, source };
}

test('社区版WebP查询使用真实回执及摘要，原文件、访问前缀和修订保持独立', async () => {
  const f = fixture();
  let lookups = 0;
  const service = createFileService(
    f.mysql,
    () => undefined,
    undefined,
    () => ({
      async existing(sources) {
        lookups++;
        assert.deepEqual(sources, [{ url: f.source.url, sha256: f.source.sha256 }]);
        return [
          {
            provider: 'local',
            fileName: 'actual.webp',
            url: 'http://127.0.0.1:8080/storage/actual.webp',
            sha256: 'b'.repeat(64),
            size: 24,
            mimeType: 'image/webp',
          },
        ];
      },
    }),
  );
  await assert.rejects(service.list('employee-b', 'session-a'), /工作区不存在/);
  assert.equal(lookups, 0);
  const result = await service.list('employee-a', 'session-a');
  assert.equal(lookups, 1);
  assert.equal(result.fileRevision, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].fileId, 'image-a');
  assert.notEqual(result.files[0].url, f.source.url, '展示链接可按配置投影，索引仍使用真实回执');
  assert.match(result.files[0].url!, /original\/banner\.png$/);
  assert.equal(result.webpFiles?.[0].fileId, 'webp:image-a');
  assert.equal(result.webpFiles?.[0].sourceFileId, 'image-a');
  assert.equal(result.webpFiles?.[0].path, 'assets/banner.png_.webp');
  assert.equal(result.webpFiles?.[0].url, 'http://127.0.0.1:8080/storage/actual.webp');
  assert.equal(result.webpFiles?.[0].size, 24);
  assert.equal(f.tables.D2cFile.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /objectLocator|provider|fileName/);
});

test('缺少索引或派生服务不可用时保留原清单，不让内部资料进入派生查询', async () => {
  const f = fixture();
  const plain = await createFileService(f.mysql, () => undefined).list('employee-a', 'session-a');
  const service = createFileService(
    f.mysql,
    () => undefined,
    undefined,
    () => ({
      async existing() {
        throw new Error('offline');
      },
    }),
  );
  const result = await service.list('employee-a', 'session-a');
  assert.deepEqual(result.files, plain.files);
  assert.deepEqual(result.webpFiles, []);
  f.row.kind = 'internal';
  const hidden = createFileService(
    f.mysql,
    () => undefined,
    undefined,
    () => ({
      async existing(sources) {
        assert.deepEqual(sources, []);
        return [];
      },
    }),
  );
  assert.deepEqual((await hidden.list('employee-a', 'session-a')).webpFiles, []);
});
