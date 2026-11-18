import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFileService } from '../src/functions/d2c/files/service';
import { sessionStore } from './helpers/sessionStore';

/** 只准备持久化替身，不连接数据库、不读取任何实际内部执行记录。 */
function fixture() {
  const store = sessionStore();
  const content = JSON.stringify({
    format: 1,
    directories: [{ scope: 'static/theme-a', directory: '20261118120000_1234' }],
  });
  store.tables.D2cSession.push({
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    fileRevision: 1,
  });
  const row = {
    fileId: 'mapping-a',
    sessionId: 'session-a',
    path: '.d2c-cache/image-directories.json',
    pathHash: createHash('sha256').update('.d2c-cache/image-directories.json').digest('hex'),
    kind: 'internal',
    content,
    objectLocator: null,
    mimeType: 'application/json',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    revision: 1,
  };
  store.tables.D2cFile.push(row);
  return {
    ...store,
    row,
    files: createFileService(store.mysql, () => ({ textFileBytes: 10000, filesPerSession: 10 })),
  };
}

test('图片目录映射在文件树中可见，并允许有权限用户只读查看', async () => {
  const f = fixture();
  const list = await f.files.list('employee-a', 'session-a');
  assert.equal(list.files[0].path, '.d2c-cache/image-directories.json');
  const file = await f.files.get('employee-a', 'session-a', 'mapping-a');
  assert.equal(file.content, f.row.content);
  assert.equal(file.kind, 'internal');
});

test('开放图片目录映射读取不绕过工作区归属或会话绑定', async () => {
  const f = fixture();
  await assert.rejects(f.files.get('employee-b', 'session-a', 'mapping-a'), /工作区不存在/);
  f.tables.D2cSession.push({
    sessionId: 'another-session',
    workspaceId: 'workspace-a',
    fileRevision: 0,
  });
  await assert.rejects(f.files.get('employee-a', 'another-session', 'mapping-a'), /文件不存在/);
});

test('图片目录映射仍不可编辑、删除或通过相似根路径读取其他内部资料', async () => {
  const f = fixture();
  const original = f.row.content;
  await assert.rejects(
    f.files.update('employee-a', 'session-a', 'mapping-a', 1, '{}'),
    /不能作为文本编辑/,
  );
  await assert.rejects(
    f.files.remove('employee-a', 'session-a', 'mapping-a', 1),
    /不能作为文本编辑/,
  );
  const current = f.tables.D2cFile[0];
  assert.equal(current.content, original);
  for (const path of [
    '.d2c-cache/other-internal.json',
    '.d2c-cache/image-directories.json.bak',
    '.d2c-cache/../image-directories.json',
  ]) {
    current.path = path;
    current.pathHash = createHash('sha256').update(path).digest('hex');
    await assert.rejects(f.files.get('employee-a', 'session-a', 'mapping-a'), /内部执行资料/);
  }
});

test('图片目录映射保持摘要和文本类型校验', async () => {
  const f = fixture();
  f.row.content = 'changed';
  await assert.rejects(f.files.get('employee-a', 'session-a', 'mapping-a'), /摘要不一致/);
  Object.assign(f.row, { content: null, objectLocator: { fileName: 'binary' } });
  await assert.rejects(f.files.get('employee-a', 'session-a', 'mapping-a'), /二进制文件/);
});
