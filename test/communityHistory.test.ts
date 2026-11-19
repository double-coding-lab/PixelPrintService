import assert from 'node:assert/strict';
import test from 'node:test';
import { readPublicHistory } from '../web/src/workspace/communityHistory';
import { data } from '../web/src/workspace/api';
import type { TimelinePage } from '../web/src/workspace/types';

/** 模拟倒序分页，事件本身仍按 seq 正序返回。 */
function page(seq: number, hasMore: boolean): TimelinePage {
  return {
    entries: [
      {
        entryId: `e${seq}`,
        sessionId: 's',
        seq,
        at: '',
        kind: 'message',
        data: { text: `${seq}` },
      },
    ],
    previousSeq: seq,
    nextSeq: seq,
    hasMore,
  };
}

test('自动逐页补读至结束，逐页交付且请求严格串行', async () => {
  const calls: number[] = [];
  const delivered: number[] = [];
  let active = 0;
  const request = (async (path: string) => {
    assert.equal(++active, 1);
    const cursor = Number(new URL(path, 'http://local').searchParams.get('beforeSeq'));
    calls.push(cursor);
    assert.equal(delivered.length, calls.length - 1);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return cursor === 0 ? page(30, true) : cursor === 30 ? page(20, true) : page(1, false);
  }) as typeof data;
  await readPublicHistory(
    '/plaza/sessions/share',
    0,
    new AbortController().signal,
    (value) => {
      delivered.push(value.entries[0].seq);
    },
    request,
  );
  assert.deepEqual(calls, [0, 30, 20]);
  assert.deepEqual(delivered, [30, 20, 1]);
});

test('失败保留已交付页面，重试只从失败游标继续', async () => {
  const calls: number[] = [];
  const delivered: number[] = [];
  let cursor = 0;
  let fail = true;
  const request = (async (path: string) => {
    const before = Number(new URL(path, 'http://local').searchParams.get('beforeSeq'));
    calls.push(before);
    if (before && fail) throw new Error('network');
    return before ? page(1, false) : page(20, true);
  }) as typeof data;
  const onPage = (value: TimelinePage, next: number) => {
    cursor = next;
    delivered.push(value.entries[0].seq);
  };
  await assert.rejects(
    readPublicHistory('/public', cursor, new AbortController().signal, onPage, request),
    /network/,
  );
  assert.deepEqual(delivered, [20]);
  fail = false;
  await readPublicHistory('/public', cursor, new AbortController().signal, onPage, request);
  assert.deepEqual(calls, [0, 20, 20]);
  assert.deepEqual(delivered, [20, 1]);
});

test('卸载取消共享 signal，忽略迟到响应且不发起下一页', async () => {
  const controller = new AbortController();
  let calls = 0;
  let deliveries = 0;
  const request = (async (_path: string, init?: RequestInit) => {
    calls++;
    assert.equal(init?.signal, controller.signal);
    controller.abort();
    return page(30, true);
  }) as typeof data;
  await readPublicHistory(
    '/public',
    0,
    controller.signal,
    () => {
      deliveries++;
    },
    request,
  );
  assert.equal(calls, 1);
  assert.equal(deliveries, 0);
  await readPublicHistory(
    '/public',
    0,
    controller.signal,
    () => {
      deliveries++;
    },
    request,
  );
  assert.equal(calls, 1);
});

for (const before of [0, 20, 30, -1, Number.NaN, 1.5]) {
  test(`拒绝不前进或非法游标 ${before}，不会无限循环请求`, async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return page(before, true);
    }) as typeof data;
    await assert.rejects(
      readPublicHistory('/public', 20, new AbortController().signal, () => {}, request),
      /游标无效/,
    );
    assert.equal(calls, 1);
  });
}

test('空终页正常结束；响应格式错误不能伪装成加载完成', async () => {
  const controller = new AbortController();
  let deliveries = 0;
  await readPublicHistory(
    '/public',
    0,
    controller.signal,
    () => {
      deliveries++;
    },
    (async () => ({ entries: [], hasMore: false })) as typeof data,
  );
  assert.equal(deliveries, 1);
  await assert.rejects(
    readPublicHistory('/public', 0, controller.signal, () => {}, (async () => ({
      entries: null,
      hasMore: false,
    })) as typeof data),
    /响应无效/,
  );
});
