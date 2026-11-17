import assert from 'node:assert/strict';
import test from 'node:test';
import { watchSessionPreview, type SessionPreviewState } from '../web/src/workspace/sessionPreview';
import type { data } from '../web/src/workspace/api';

/** 可控时钟只推进客户端调度，网络响应由测试单独决定。 */
function clock() {
  let now = 0;
  let key = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  return {
    schedule: ((run: () => void, ms: number) => {
      jobs.set(++key, { at: now + ms, run });
      return key;
    }) as unknown as typeof setTimeout,
    unschedule: ((key: number) => jobs.delete(key)) as unknown as typeof clearTimeout,
    /** 推进至指定时刻，执行已到期工作。 */
    tick(ms: number) {
      now += ms;
      for (const [key, job] of jobs)
        if (job.at <= now) {
          jobs.delete(key);
          job.run();
        }
    },
    count: () => jobs.size,
  };
}

test('重复进入已有成功预览只GET读取，不POST、不启动构建或轮询', async () => {
  for (const entryPath of ['', 'src/页面.tsx']) {
    const timer = clock();
    const methods: string[] = [];
    const watch = watchSessionPreview({
      sessionId: 'cached',
      entryPath,
      ...timer,
      onState: () => {},
      onError: (error) => assert.equal(error, ''),
      request: (async (_path, init) => {
        methods.push(init?.method ?? 'GET');
        return state('ready');
      }) as typeof data,
    });
    watch.ensure();
    timer.tick(800);
    await flush();
    watch.ensure();
    timer.tick(800);
    await flush();
    assert.deepEqual(methods, ['GET', 'GET']);
    assert.equal(timer.count(), 0);
    watch.dispose();
  }
});

/** 构造完整的前后端契约数据，失败时仍携带上一份成功预览。 */
function state(status: string, revision = 2): SessionPreviewState {
  return {
    current: {
      previewId: `p-${revision}`,
      status,
      target: 'h5',
      entryPath: 'src/页面.tsx',
      fileRevision: revision,
    },
    lastReady: {
      previewId: 'p-1',
      status: 'ready',
      target: 'h5',
      entryPath: 'src/页面.tsx',
      fileRevision: 1,
    },
    entries: ['src/页面.tsx'],
    fileRevision: revision,
  };
}

/** 冲刷异步请求的 promise continuation。 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('显式刷新携带 retry 标识，实时通知和普通 ensure 不重试失败轮次', async () => {
  const timer = clock();
  const calls: Array<RequestInit | undefined> = [];
  const watch = watchSessionPreview({
    sessionId: 's',
    entryPath: 'src/页面.tsx',
    ...timer,
    onState: () => {},
    onError: () => {},
    request: (async (_path, init) => {
      calls.push(init);
      return state('failed');
    }) as typeof data,
  });
  watch.ensure();
  timer.tick(800);
  await flush();
  assert.equal(JSON.parse(String(calls.at(-1)?.body)).retry, undefined);
  watch.refresh();
  await flush();
  assert.equal(calls.at(-1)?.method, undefined);
  watch.retry();
  await flush();
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.body)), {
    entryPath: 'src/页面.tsx',
    retry: true,
  });
  assert.equal(timer.count(), 0);
  watch.dispose();
});

test('800ms 合并文件更新；构建中五秒纯查询，终态停止，失败保留 lastReady', async () => {
  const timer = clock();
  const calls: { path: string; init?: RequestInit }[] = [];
  const seen: SessionPreviewState[] = [];
  const responses = [state('building'), state('building'), state('building'), state('failed')];
  const watch = watchSessionPreview({
    sessionId: '会话/a',
    entryPath: 'src/页面.tsx',
    ...timer,
    onState: (value) => seen.push(value),
    onError: (error) => assert.equal(error, ''),
    request: (async (path, init) => {
      calls.push({ path, init });
      return responses.shift();
    }) as typeof data,
  });
  watch.ensure();
  timer.tick(700);
  watch.ensure();
  timer.tick(799);
  assert.equal(calls.length, 0);
  timer.tick(1);
  await flush();
  assert.match(calls[0].path, /previews\?entryPath=/);
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { entryPath: 'src/页面.tsx' });
  timer.tick(4999);
  assert.equal(calls.length, 2);
  timer.tick(1);
  await flush();
  assert.match(calls[2].path, /\?entryPath=src%2F/);
  assert.equal(calls[2].init?.method, undefined);
  timer.tick(5000);
  await flush();
  assert.equal(seen.at(-1)?.current?.status, 'failed');
  assert.equal(seen.at(-1)?.lastReady?.previewId, 'p-1');
  assert.equal(timer.count(), 0);
  watch.dispose();
});

test('新修订取消旧请求，即使旧响应晚到也不能覆盖；卸载清理所有任务', async () => {
  const timer = clock();
  const pending: { init?: RequestInit; resolve: (value: SessionPreviewState) => void }[] = [];
  const seen: SessionPreviewState[] = [];
  const watch = watchSessionPreview({
    sessionId: 's',
    entryPath: 'src/页面.tsx',
    ...timer,
    onState: (value) => seen.push(value),
    onError: () => {},
    request: ((_path, init) =>
      new Promise<SessionPreviewState>((resolve) =>
        pending.push({ init, resolve }),
      )) as typeof data,
  });
  watch.ensure();
  timer.tick(800);
  watch.ensure();
  assert.equal(pending[0].init?.signal?.aborted, true);
  watch.refresh();
  assert.equal(pending.length, 1, 'SSE 不打断合并中的 ensure');
  timer.tick(800);
  assert.equal(pending[1].init?.method, undefined);
  pending[1].resolve(state('ready', 3));
  await flush();
  pending[0].resolve(state('ready', 2));
  await flush();
  assert.deepEqual(
    seen.map((value) => value.fileRevision),
    [3],
  );
  watch.refresh();
  assert.equal(pending[2].init?.method, undefined);
  watch.dispose();
  assert.equal(pending[2].init?.signal?.aborted, true);
  pending[2].resolve(state('building', 4));
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(timer.count(), 0);
});

test('空入口和多入口歧义不轮询，查询失败可显式重试且不丢旧状态', async () => {
  const timer = clock();
  const seen: SessionPreviewState[] = [];
  const errors: string[] = [];
  let count = 0;
  const watch = watchSessionPreview({
    sessionId: 's',
    entryPath: '',
    ...timer,
    onState: (value) => seen.push(value),
    onError: (error) => errors.push(error),
    request: (async () => {
      if (++count === 2) throw new Error('服务暂不可用');
      return {
        current: null,
        lastReady: null,
        entries: count === 1 ? [] : ['a.tsx', 'b.tsx'],
        fileRevision: count,
      };
    }) as typeof data,
  });
  watch.ensure();
  timer.tick(800);
  await flush();
  assert.equal(timer.count(), 0);
  watch.refresh();
  await flush();
  assert.equal(errors.at(-1), '服务暂不可用');
  assert.equal(seen.length, 1);
  watch.ensure();
  timer.tick(800);
  await flush();
  assert.deepEqual(seen.at(-1)?.entries, ['a.tsx', 'b.tsx']);
  assert.equal(timer.count(), 0);
  watch.dispose();
});

test('未选入口先 GET；唯一入口自动 ensure，多个新入口停在选择状态', async () => {
  for (const entries of [['src/页面.tsx'], ['a.tsx', 'b.tsx']]) {
    const timer = clock();
    const calls: { path: string; init?: RequestInit }[] = [];
    const watch = watchSessionPreview({
      sessionId: 's',
      entryPath: '',
      ...timer,
      onState: () => {},
      onError: () => {},
      request: (async (path, init) => {
        calls.push({ path, init });
        return init?.method === 'POST'
          ? state('ready')
          : { current: null, lastReady: null, entries, fileRevision: 1 };
      }) as typeof data,
    });
    watch.ensure();
    timer.tick(800);
    await flush();
    assert.equal(calls[0].init?.method, undefined);
    if (entries.length === 1) {
      assert.equal(calls.length, 2);
      assert.equal(calls[1].init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { entryPath: entries[0] });
    } else assert.equal(calls.length, 1, '歧义入口不能自动选择首项构建');
    assert.equal(timer.count(), 0);
    watch.dispose();
  }
});

test('current 为空且存在多个组件入口时，按后端优先级自动 POST 唯一推荐页面', async () => {
  const components = ['blocks/header/index.tsx', 'blocks/body/index.tsx', 'components/Card.jsx'];
  const cases: { entries: string[]; expected: string }[] = [
    {
      entries: [...components, 'pages/shop/index.tsx', 'App.tsx', 'src/index.tsx'],
      expected: 'pages/shop/index.tsx',
    },
    {
      entries: [...components, 'src/pages/shop/index.jsx', 'src/App.tsx'],
      expected: 'src/pages/shop/index.jsx',
    },
    ...['src/App.tsx', 'src/App.jsx', 'App.tsx', 'App.jsx', 'src/index.tsx', 'index.tsx'].map(
      (entry) => ({ entries: [...components, entry], expected: entry }),
    ),
    {
      entries: [...components, 'pages/shop/index.tsx', 'src/pages/cart/index.jsx', 'App.tsx'],
      expected: '',
    },
    { entries: [...components, 'App.tsx', 'src/index.tsx'], expected: '' },
  ];
  for (const { entries, expected } of cases) {
    const timer = clock();
    const calls: { path: string; init?: RequestInit }[] = [];
    const watch = watchSessionPreview({
      sessionId: 's',
      entryPath: '',
      ...timer,
      onState: () => {},
      onError: (error) => assert.equal(error, ''),
      request: (async (path, init) => {
        calls.push({ path, init });
        return init?.method === 'POST'
          ? {
              ...state('building'),
              current: { ...state('building').current!, entryPath: expected },
              entries,
            }
          : { current: null, lastReady: null, entries, fileRevision: 1 };
      }) as typeof data,
    });
    watch.ensure();
    timer.tick(800);
    await flush();
    assert.equal(calls[0].init?.method, undefined, '发现入口保持 GET 纯查');
    if (expected) {
      assert.equal(calls.length, 2, entries.join(','));
      assert.equal(calls[1].init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { entryPath: expected });
      watch.refresh();
      await flush();
      assert.equal(calls[2].path, `/sessions/s/previews?entryPath=${encodeURIComponent(expected)}`);
      assert.equal(calls[2].init?.method, undefined, 'SSE 刷新只查推荐入口');
    } else {
      assert.equal(calls.length, 1, '多个真正页面或常规入口歧义时仍等待选择');
      assert.equal(timer.count(), 0);
    }
    watch.dispose();
  }
});

test('等待文件持续只读跟踪，文件保存触发新构建，任务结束后停止轮询并显示失败', async () => {
  for (const outcome of ['saved', 'finished']) {
    const timer = clock();
    const calls: Array<RequestInit | undefined> = [];
    const seen: SessionPreviewState[] = [];
    let current = state('waiting_files');
    current.current!.waitingForFile = 'src/index.scss';
    const watch = watchSessionPreview({
      sessionId: 's',
      entryPath: 'src/页面.tsx',
      ...timer,
      onState: (value) => seen.push(value),
      onError: (error) => assert.equal(error, ''),
      request: (async (_path, init) => {
        calls.push(init);
        return current;
      }) as typeof data,
    });
    watch.refresh();
    await flush();
    assert.equal(timer.count(), 1);
    timer.tick(5000);
    await flush();
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((call) => !call?.method),
      '等待期间仅查询，不隐式重试',
    );
    assert.equal(seen.at(-1)!.lastReady!.previewId, 'p-1');
    if (outcome === 'saved') {
      current = state('building', 3);
      watch.ensure();
      timer.tick(800);
      await flush();
      assert.equal(calls.at(-1)!.method, 'POST');
      assert.equal(JSON.parse(String(calls.at(-1)!.body)).retry, undefined);
      current = state('ready', 3);
    } else {
      current = state('failed');
      current.current!.error = {
        code: 'MODULE_NOT_FOUND',
        message: '缺少文件',
        module: './index.scss',
      };
    }
    timer.tick(5000);
    await flush();
    assert.equal(seen.at(-1)!.current!.status, outcome === 'saved' ? 'ready' : 'failed');
    assert.equal(timer.count(), 0);
    watch.dispose();
  }
});
