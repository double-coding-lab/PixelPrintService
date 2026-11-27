import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEditBuildRevision, editBuildKey } from '../src/functions/d2c/edit/buildKey';
import type { EditRecord } from '../src/functions/d2c/edit/store';

/** 用真实内容差异验证缓存身份，副本编号和旧快照摘要不决定新源码身份。 */
test('编辑缓存区分实际源码、资源、目标、入口、单位、构建器和授权范围', () => {
  const input = {
    target: 'h5' as const,
    entryPath: 'App.tsx',
    files: [{ path: 'App.tsx', content: 'first' }],
    snapshot: [
      {
        path: 'App.tsx',
        kind: 'source' as const,
        content: 'stale metadata',
        size: 1,
        sha256: '0'.repeat(64),
        objectLocator: null,
      },
      {
        path: 'image.png',
        kind: 'asset' as const,
        content: null,
        size: 3,
        sha256: createHash('sha256').update('png').digest('hex'),
        objectLocator: { id: 'image' },
      },
    ],
    configSnapshot: { config: { unit: { outputBase: 750 } } },
  };
  const scope = ['edit-', 'alice', 'session-1'];
  const limits = { textFileBytes: 1000, filesPerSession: 10, uploadBytes: 10000 };
  const key = (
    value: Parameters<typeof editBuildKey>[0] = input,
    owner = scope,
    revision = 'compiler-1',
    settings = limits,
  ) => editBuildKey(value, owner, revision, settings);
  const initial = key();
  assert.match(initial, /^[a-f0-9]{64}$/);
  const reordered = structuredClone(input);
  reordered.snapshot.reverse();
  assert.equal(key(reordered), initial, '文件排序不影响产物身份');
  const movedStorage = structuredClone(input);
  movedStorage.snapshot[1].objectLocator = { id: 'new storage, same bytes' };
  assert.equal(key(movedStorage), initial, '相同字节不因存储定位变化重编译');
  for (const [label, change] of [
    [
      '源码',
      (x: typeof input) => {
        x.files[0].content = 'second';
      },
    ],
    [
      '资源',
      (x: typeof input) => {
        x.snapshot[1].sha256 = '1'.repeat(64);
      },
    ],
    [
      '路径',
      (x: typeof input) => {
        x.snapshot[1].path = 'renamed.png';
      },
    ],
    [
      '单位',
      (x: typeof input) => {
        x.configSnapshot.config.unit.outputBase = 375;
      },
    ],
  ] as const) {
    const next = structuredClone(input);
    change(next);
    assert.notEqual(key(next), initial, label);
  }
  assert.notEqual(key({ ...input, target: 'rn' }), initial);
  assert.notEqual(key({ ...input, entryPath: 'Other.tsx' }), initial);
  assert.notEqual(key(input, ['plazaedit-', 'alice', 'session-1']), initial);
  assert.notEqual(key(input, ['edit-', 'bob', 'session-1']), initial);
  assert.notEqual(key(input, ['edit-', 'alice', 'session-2']), initial);
  assert.notEqual(key(input, scope, 'compiler-2'), initial);
  assert.notEqual(key(input, scope, 'compiler-1', { ...limits, uploadBytes: 9000 }), initial);
  assert.throws(() => key({ ...input, files: [] }), /EDIT_INPUT_CORRUPT/);
  const draft = {
    ...input,
    editId: 'new-id',
    revision: 9,
    preview: { status: 'building' },
  } as unknown as EditRecord;
  assert.equal(key(draft), initial, '独立副本和构建任务不改变相同内容的身份');
});

/** 同进程模板固定；新进程重新计算真实模板及依赖锁，避免发布后读旧编译产物。 */
test('构建版本在新实例检测脚本、静态模板与依赖锁变化，跳过依赖目录', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'edit-build-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'container'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'container/build.mjs'), 'version one');
  await writeFile(path.join(root, 'package-lock.json'), 'locked dependencies');
  await writeFile(path.join(root, 'index.html'), '<html>template</html>');
  const revision = createEditBuildRevision(root);
  const first = await revision();
  await writeFile(path.join(root, 'node_modules/unused.js'), 'not part of fingerprint');
  assert.equal(await createEditBuildRevision(root)(), first);
  await writeFile(path.join(root, 'container/build.mjs'), 'version two');
  assert.equal(await revision(), first, '模板在服务实例生命周期固定');
  const second = await createEditBuildRevision(root)();
  assert.notEqual(second, first);
  await writeFile(path.join(root, 'package-lock.json'), 'updated dependencies');
  const third = await createEditBuildRevision(root)();
  assert.notEqual(third, second);
  await writeFile(path.join(root, 'index.html'), '<html>updated template</html>');
  assert.notEqual(await createEditBuildRevision(root)(), third);
});
