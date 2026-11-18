import assert from 'node:assert/strict';
import test from 'node:test';
import { data } from '../web/src/workspace/api';
import {
  EditWorkspaceController,
  editDirty,
  editNeedsExitConfirmation,
  editPreviewUrl,
  type EditCopy,
} from '../web/src/workspace/editWorkspaceState';
import {
  detachedEditOptions,
  publicTimelineEntry,
  readCollection,
} from '../web/src/workspace/sharing';
import { readSubagentPage } from '../web/src/workspace/SubagentPanel';
import type { TimelineEntry } from '../web/src/workspace/types';

/** 独立副本使用与私有编辑相同 DTO；预览 ID 前缀由后端隔离。 */
function copy(overrides: Partial<EditCopy> = {}): EditCopy {
  return {
    editId: 'e1',
    revision: 1,
    baseFileRevision: 3,
    files: [{ path: 'src/App.tsx', content: 'original' }],
    entries: ['src/App.tsx'],
    entryPath: 'src/App.tsx',
    target: 'h5',
    expiresAt: '2099-01-01',
    preview: { status: 'idle' },
    ...overrides,
  };
}

/** 模拟服务端修订和持久化结果，不允许任何原会话写入请求。 */
function server(kind: 'plaza' | 'my-works') {
  const calls: { path: string; init: RequestInit }[] = [];
  let current = copy();
  let workRevision = 0;
  let failSave = false;
  const root = detachedEditOptions(kind, 'resource').root;
  const request = (async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init });
    assert.ok(path.startsWith(root));
    assert.doesNotMatch(path, /\/(apply|pause|resume)(?:$|\?)/);
    if (init.method === 'DELETE') return {};
    if (path.endsWith('/save')) {
      if (failSave) throw Object.assign(new Error('作品修订冲突'), { status: 409 });
      const input = JSON.parse(String(init.body));
      assert.equal(input.baseRevision, current.revision);
      return {
        workId: 'own-work',
        revision: ++workRevision,
        name: '个人副本',
        target: 'h5',
        createdAt: '2026-11-18',
      };
    }
    if (init.method === 'PUT') {
      const input = JSON.parse(String(init.body));
      assert.equal(input.baseRevision, current.revision);
      current = {
        ...current,
        revision: current.revision + 1,
        files: input.files.length ? input.files : current.files,
        entryPath: input.entryPath ?? current.entryPath,
      };
    }
    return current;
  }) as typeof data;
  return {
    request,
    calls,
    root,
    setFail: (value: boolean) => {
      failSave = value;
    },
  };
}

for (const kind of ['plaza', 'my-works'] as const) {
  test(`${kind}: 副本保存先 PUT，再用新修订持久化；下载和清理均不接触原会话`, async () => {
    const api = server(kind);
    const editor = new EditWorkspaceController(
      'unused',
      api.request,
      detachedEditOptions(kind, 'resource'),
    );
    await editor.open();
    assert.equal(await editor.apply(), false);
    assert.equal(api.calls.length, 1);
    editor.changeFile('src/App.tsx', 'own content');
    assert.equal(editor.downloadPath(), undefined);
    assert.equal(await editor.saveToLibrary('个人副本'), true);
    assert.equal(editor.getSnapshot().savedWork?.workId, 'own-work');
    assert.equal(editDirty(editor.getSnapshot()), false);
    assert.equal(editNeedsExitConfirmation(editor.getSnapshot()), false);
    assert.equal(editor.downloadPath(), `/api/d2c${api.root}/e1/download`);
    assert.deepEqual(
      api.calls.slice(1).map((call) => [call.path, call.init.method]),
      [
        [`${api.root}/e1`, 'PUT'],
        [`${api.root}/e1/save`, 'POST'],
      ],
    );
    editor.changeFile('src/App.tsx', 'second revision');
    await editor.saveToLibrary();
    assert.equal(editor.getSnapshot().savedWork?.revision, 2);
    assert.equal(editor.getSnapshot().files[0].content, 'second revision');
    editor.dispose();
    assert.equal(api.calls.at(-1)?.init.method, 'DELETE');
  });
}

test('持久化冲突保留副本、修改和退出保护，重试成功后才清除', async () => {
  const api = server('my-works');
  const editor = new EditWorkspaceController(
    'own-work',
    api.request,
    detachedEditOptions('my-works', 'resource'),
  );
  await editor.open();
  editor.changeFile('src/App.tsx', 'keep me');
  api.setFail(true);
  assert.equal(await editor.saveToLibrary(), false);
  assert.match(editor.getSnapshot().error, /冲突/);
  assert.equal(editor.getSnapshot().files[0].content, 'keep me');
  assert.equal(editNeedsExitConfirmation(editor.getSnapshot()), true);
  api.setFail(false);
  assert.equal(await editor.saveToLibrary(), true);
  editor.dispose();
});

test('保存请求期间的新键入不会被旧结果静默持久化', async () => {
  const api = server('plaza');
  let resolve!: (value: EditCopy) => void;
  const request = (async (path: string, init: RequestInit = {}) =>
    init.method === 'PUT'
      ? new Promise<EditCopy>((done) => {
          resolve = done;
        })
      : api.request(path, init)) as typeof data;
  const editor = new EditWorkspaceController(
    'unused',
    request,
    detachedEditOptions('plaza', 'resource'),
  );
  await editor.open();
  editor.changeFile('src/App.tsx', 'sent');
  const saving = editor.saveToLibrary();
  editor.changeFile('src/App.tsx', 'new typing');
  resolve(copy({ revision: 2, files: [{ path: 'src/App.tsx', content: 'sent' }] }));
  assert.equal(await saving, false);
  assert.equal(editor.getSnapshot().files[0].content, 'new typing');
  assert.equal(
    api.calls.some((call) => call.path.endsWith('/save')),
    false,
  );
  assert.equal(editDirty(editor.getSnapshot()), true);
  editor.dispose();
});

test('退出后晚到的长期保存结果不会复活弹窗', async () => {
  let resolve!: (value: unknown) => void;
  const api = server('plaza');
  const request = (async (path: string, init: RequestInit = {}) =>
    path.endsWith('/save')
      ? new Promise<unknown>((done) => {
          resolve = done;
        })
      : api.request(path, init)) as typeof data;
  const editor = new EditWorkspaceController(
    'unused',
    request,
    detachedEditOptions('plaza', 'resource'),
  );
  await editor.open();
  const saving = editor.saveToLibrary();
  editor.dispose();
  resolve({ workId: 'late', revision: 1 });
  assert.equal(await saving, false);
  assert.equal(editor.getSnapshot().copy, null);
});

test('原私有编辑器没有长期保存入口，默认根路径不变', async () => {
  const paths: string[] = [];
  const request = (async (path: string) => {
    paths.push(path);
    return copy();
  }) as typeof data;
  const editor = new EditWorkspaceController('s/1', request);
  await editor.open();
  assert.equal(paths[0], '/sessions/s%2F1/edit');
  assert.equal(await editor.saveToLibrary(), false);
  assert.equal(editor.downloadPath(), undefined);
  editor.dispose();
});

test('预览允许新的副本 ID 前缀，仍拒绝外源和路径穿越', () => {
  for (const prefix of ['plazaedit-', 'workedit-']) {
    const state = copy({
      preview: { status: 'ready', url: `/H5_Preview/${prefix}e1/ticket/index.html` },
    });
    assert.equal(editPreviewUrl(state), state.preview.url);
    assert.equal(
      editPreviewUrl({
        ...state,
        preview: { ...state.preview, url: 'https://example.com/H5_Preview/a/t/index.html' },
      }),
      null,
    );
    assert.equal(
      editPreviewUrl({
        ...state,
        preview: { ...state.preview, url: '/H5_Preview/../t/index.html' },
      }),
      null,
    );
  }
});

test('公开附件重新定位到广场，不改变原消息或访问原会话图片', () => {
  const entry: TimelineEntry = {
    entryId: 'e',
    sessionId: 'private',
    seq: 1,
    kind: 'message',
    at: '',
    data: {
      text: 'hello',
      attachments: [
        {
          attachmentId: 'a/b',
          url: '/api/d2c/sessions/private/attachments/a',
          mimeType: 'image/png',
          size: 1,
          width: 1,
          height: 1,
        },
      ],
    },
  };
  const projected = publicTimelineEntry(entry, 'share/one');
  assert.equal(
    projected.data.attachments?.[0].url,
    '/api/d2c/plaza/sessions/share%2Fone/attachments/a%2Fb',
  );
  assert.equal(entry.data.attachments?.[0].url, '/api/d2c/sessions/private/attachments/a');
});

test('广场子 Agent 沿用私有事件契约，但请求只走广场根路径', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/d2c/plaza/sessions/share/subagents/agent/events?afterSeq=8&limit=500');
    assert.equal(init?.credentials, 'same-origin');
    return Response.json({
      success: true,
      data: { agentId: 'agent', entries: [], nextSeq: 8, hasMore: false },
    });
  };
  const page = await readSubagentPage(
    'private',
    'agent',
    8,
    new AbortController().signal,
    '/plaza/sessions/share',
  );
  assert.equal(page.nextSeq, 8);
});

test('新集合接受 items 分页，不会把错误的 versions rows 显示为空列表', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({ success: true, data: { items: [], total: 0, page: 1, pageSize: 12 } });
  assert.equal((await readCollection('/my-works?page=1&pageSize=12')).total, 0);
  globalThis.fetch = async () => Response.json({ success: true, data: { rows: [], total: 0 } });
  await assert.rejects(readCollection('/my-works?page=1&pageSize=12'), /列表响应无效/);
});
