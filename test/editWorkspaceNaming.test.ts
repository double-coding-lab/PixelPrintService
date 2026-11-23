import assert from 'node:assert/strict';
import test from 'node:test';
import type { data } from '../web/src/workspace/api';
import {
  defaultWorkName,
  EditWorkspaceController,
  editDirty,
  WORK_NAME_MAX_LENGTH,
  type EditCopy,
} from '../web/src/workspace/editWorkspaceState';

/** 仅模拟既有保存契约，记录副本和作品写入以核对验证及重试边界。 */
function fixture() {
  let copy: EditCopy = {
    editId: 'draft',
    revision: 1,
    baseFileRevision: 1,
    files: [{ path: 'src/App.tsx', content: 'original' }],
    entries: ['src/App.tsx'],
    entryPath: 'src/App.tsx',
    target: 'h5',
    expiresAt: '2099-01-01',
    preview: { status: 'idle' },
  };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const request = (async (path: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return {};
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ path, body });
    if (init.method === 'PUT') {
      copy = { ...copy, revision: copy.revision + 1, files: body.files };
    }
    if (path.endsWith('/save')) {
      await held;
      if (fail) throw new Error('保存暂时失败');
      return { workId: 'work', name: body.name ?? '旧作品', revision: 2 };
    }
    return copy;
  }) as typeof data;
  const controller = new EditWorkspaceController('source', request, {
    detached: true,
    root: '/plaza/sessions/source/edit',
  });
  return {
    controller,
    calls,
    setFail: (value: boolean) => (fail = value),
    hold: () => {
      held = new Promise<void>((done) => (release = done));
      return () => release!();
    },
  };
}

test('默认名称使用本地 MMDD，保留已有名称并为日期预留服务端长度', () => {
  const local = new Date(2026, 10, 23, 0, 1);
  assert.equal(defaultWorkName('  广场作品  ', false, local), '广场作品 · 1123');
  assert.equal(defaultWorkName('作品 · 1118', true, local), '作品 · 1118');
  assert.equal(defaultWorkName('定制名称', true, local), '定制名称');
  assert.equal(defaultWorkName(undefined, false, new Date(2026, 0, 2)), '未命名作品 · 0102');
  const long = defaultWorkName('长'.repeat(200), false, local);
  assert.equal(long.length, WORK_NAME_MAX_LENGTH);
  assert.ok(long.endsWith(' · 1123'));
  assert.doesNotMatch(defaultWorkName('x'.repeat(192) + '😀', false, local), /[\uD800-\uDBFF] ·/);
});

test('空白或超长名称在任何 PUT/POST 前拒绝，保留未保存正文', async (t) => {
  const { controller, calls } = fixture();
  t.after(() => controller.dispose());
  await controller.open();
  controller.changeFile('src/App.tsx', 'draft');
  for (const name of ['', ' \n ', '长'.repeat(201)]) {
    assert.equal(await controller.saveToLibrary(name), false);
    assert.equal(calls.length, 1);
    assert.match(controller.getSnapshot().error, /1–200/);
    assert.equal(controller.getSnapshot().files[0].content, 'draft');
    assert.equal(editDirty(controller.getSnapshot()), true);
  }
});

test('自定义名称 trim 后连同新修订保存，200 字符边界接受', async (t) => {
  const { controller, calls } = fixture();
  t.after(() => controller.dispose());
  await controller.open();
  controller.changeFile('src/App.tsx', 'draft');
  const name = '名'.repeat(200);
  assert.equal(await controller.saveToLibrary(`  ${name}  `), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, { baseRevision: 2, name });
  assert.equal(controller.getSnapshot().savedWork?.name, name);
});

test('失败重试保留名称与副本，并发确认只产生一次保存请求', async (t) => {
  const api = fixture();
  t.after(() => api.controller.dispose());
  await api.controller.open();
  api.setFail(true);
  assert.equal(await api.controller.saveToLibrary('  我的作品  '), false);
  assert.match(api.controller.getSnapshot().error, /暂时失败/);
  assert.ok(api.controller.getSnapshot().copy);
  api.setFail(false);
  const release = api.hold();
  const saving = api.controller.saveToLibrary('  我的作品  ');
  assert.equal(await api.controller.saveToLibrary('不应覆盖'), false);
  release();
  assert.equal(await saving, true);
  assert.deepEqual(
    api.calls.filter((call) => call.path.endsWith('/save')).map((call) => call.body.name),
    ['我的作品', '我的作品'],
  );
});
