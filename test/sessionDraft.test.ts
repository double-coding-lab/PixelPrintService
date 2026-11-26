import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionDraft } from '../web/src/workspace/sessionDraft';

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const open = (actor = 'alice', workspace = 'w1', session = 's1') => {
    const draft = createSessionDraft(workspace, session, () => storage);
    draft.bindActor(actor);
    return draft;
  };
  return { values, storage, open };
}

test('聊天文本刷新恢复，按用户、工作区与会话隔离，空白输入原样保存', () => {
  const { open, values } = fixture();
  open().setText('  草稿\n');
  assert.equal(open().text, '  草稿\n');
  assert.equal(open('bob').text, '');
  assert.equal(open('alice', 'w2').text, '');
  assert.equal(open('alice', 'w1', 's2').text, '');
  assert.deepEqual(Object.keys(JSON.parse([...values.values()][0])).sort(), ['text', 'version']);
  open().setText('');
  assert.equal(values.size, 0);
});

test('失败不结算，成功只清对应输入版本，编辑后改回同文也保留', () => {
  const { open } = fixture();
  const draft = open();
  draft.setText('发出');
  const sent = draft.snapshot();
  assert.equal(open().text, '发出', '请求未成功时缓存仍存在');
  draft.setText('新输入');
  assert.equal(draft.clearIfUnchanged(sent), false);
  draft.setText('发出');
  assert.equal(draft.clearIfUnchanged(sent), false);
  assert.equal(open().text, '发出');
  assert.equal(draft.clearIfUnchanged(draft.snapshot()), true);
  assert.equal(open().text, '');
});

test('晚到成功可清原会话，不能清重进后或另一会话的新输入', () => {
  const { open } = fixture();
  const old = open();
  old.setText('旧输入');
  const sent = old.snapshot();
  const other = open('alice', 'w1', 's2');
  other.setText('其他会话');
  const reentered = open();
  reentered.setText('旧输入');
  assert.equal(old.clearIfUnchanged(sent), false, '重进后同文也有新持久化版本');
  assert.equal(open().text, '旧输入');
  assert.equal(other.text, '其他会话');
  const isolated = open('alice', 'w1', 's3');
  isolated.setText('发送中离开');
  assert.equal(isolated.clearIfUnchanged(isolated.snapshot()), true);
  assert.equal(open('alice', 'w1', 's3').text, '');
});

test('身份返回前可输入；新输入和主动清空均优先于旧缓存，未知身份不持久化', () => {
  const { open, values, storage } = fixture();
  open().setText('历史草稿');
  const draft = createSessionDraft('w1', 's1', () => storage);
  draft.setText('身份加载时输入');
  assert.equal(values.size, 1);
  draft.bindActor('alice');
  assert.equal(draft.text, '身份加载时输入');
  assert.equal(open().text, '身份加载时输入');
  const blank = createSessionDraft('w1', 's1', () => storage);
  blank.setText('');
  blank.bindActor('alice');
  assert.equal(open().text, '');
  const unknown = createSessionDraft('w1', 's1', () => storage);
  unknown.setText('仅内存');
  assert.equal(values.size, 0);
  assert.equal(unknown.text, '仅内存');
});

test('localStorage 获取/读/写/删异常、非法缓存均不影响输入与结算', () => {
  for (const storage of [
    () => {
      throw new Error('disabled');
    },
    () => ({
      getItem() {
        throw new Error('read');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('remove');
      },
    }),
    () => ({ getItem: () => '{broken', setItem() {}, removeItem() {} }),
    () => undefined,
  ]) {
    const draft = createSessionDraft('w', 's', storage);
    draft.bindActor('alice');
    assert.equal(draft.text, '');
    draft.setText('可编辑');
    assert.equal(draft.text, '可编辑');
    assert.equal(draft.clearIfUnchanged(draft.snapshot()), true);
    assert.equal(draft.text, '');
  }
});

test('已有缓存后配额耗尽仍可编辑，并在发送成功后清空当前输入', () => {
  const { storage, open } = fixture();
  open().setText('旧缓存');
  const draft = createSessionDraft('w1', 's1', () => ({
    ...storage,
    setItem() {
      throw new Error('quota');
    },
  }));
  draft.bindActor('alice');
  draft.setText('成功发出的新文本');
  assert.equal(draft.text, '成功发出的新文本');
  assert.equal(draft.clearIfUnchanged(draft.snapshot()), true);
  assert.equal(draft.text, '');
  assert.equal(open().text, '');
});

test('普通HTTP环境缺少randomUUID时仍可输入、恢复和成功清理草稿', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const { open } = fixture();
    const draft = open();
    draft.setText('HTTP草稿');
    assert.equal(open().text, 'HTTP草稿');
    assert.equal(draft.clearIfUnchanged(draft.snapshot()), true);
    assert.equal(open().text, '');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
