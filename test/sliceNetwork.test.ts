import './helpers/projectFixture';
import { diagnoseRunFailure } from '../src/functions/d2c/run/errors';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAgent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createSliceNetwork } from '../src/functions/d2c/run/sliceNetwork';

/** 仅代理dispatch替换为离线响应；保留正式请求的头部、重试与流限额。 */
test('函数切图网络隔离Token、拒绝越界和重定向、限制响应字节', async (t) => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  t.mock.method(
    ProxyAgent.prototype,
    'dispatch',
    function (
      options: Parameters<ProxyAgent['dispatch']>[0],
      handler: Parameters<ProxyAgent['dispatch']>[1],
    ) {
      return mock.dispatch(options, handler);
    },
  );
  t.after(() => mock.close());
  const api = mock.get('https://api.figma.com');
  api.intercept({ path: '/v1/me', headers: { 'x-figma-token': 'secret-a' } }).reply(200, 'ok');
  const images = mock.get('https://images.example');
  images.intercept({ path: '/one' }).reply(200, (opts) => {
    assert.doesNotMatch(JSON.stringify(opts.headers), /secret-a/i);
    return 'image';
  });
  images
    .intercept({ path: '/redirect' })
    .reply(302, '', { headers: { location: 'https://other.example' } });
  images.intercept({ path: '/large' }).reply(200, 'x'.repeat(30));
  const before = globalThis.fetch;
  const network = createSliceNetwork({
    proxyUrl: 'http://127.0.0.1:8888',
    allowedHosts: ['api.figma.com', 'images.example'],
    token: 'secret-a',
    signal: new AbortController().signal,
    uploadBytes: 10,
  });
  try {
    assert.equal((await network.request('https://api.figma.com/v1/me', 'json')).toString(), 'ok');
    assert.equal(
      (await network.request('https://images.example/one', 'image')).toString(),
      'image',
    );
    await assert.rejects(network.request('https://images.example/redirect', 'image'), (error) => {
      assert.ok(error instanceof ToolIssue);
      assert.deepEqual(
        JSON.parse(JSON.stringify(diagnoseRunFailure(error.failure).diagnostics.slice)),
        {
          phase: 'download_image',
          reason: 'HTTP_ERROR',
          statusCode: 302,
          attempt: 1,
          proxyUsed: true,
        },
      );
      return true;
    });
    await assert.rejects(network.request('https://images.example/large', 'image'), (error) => {
      assert.ok(error instanceof ToolIssue);
      assert.deepEqual(
        JSON.parse(JSON.stringify(diagnoseRunFailure(error.failure).diagnostics.slice)),
        {
          phase: 'download_image',
          reason: 'RESPONSE_TOO_LARGE',
          statusCode: 200,
          bytes: 30,
          attempt: 1,
          proxyUsed: true,
        },
      );
      return true;
    });
    await assert.rejects(network.request('https://other.example', 'image'));
    await assert.rejects(network.request('https://images.example/token', 'json'));
    assert.equal(globalThis.fetch, before);
    mock.assertNoPendingInterceptors();
  } finally {
    await network.close();
  }
});

test('不同会话凭据独立，429长等待和已取消请求不会继续发起网络请求', async (t) => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  t.mock.method(
    ProxyAgent.prototype,
    'dispatch',
    function (
      options: Parameters<ProxyAgent['dispatch']>[0],
      handler: Parameters<ProxyAgent['dispatch']>[1],
    ) {
      return mock.dispatch(options, handler);
    },
  );
  t.after(() => mock.close());
  const api = mock.get('https://api.figma.com');
  api.intercept({ path: '/one', headers: { 'x-figma-token': 'one' } }).reply(200, 'one');
  api.intercept({ path: '/two', headers: { 'x-figma-token': 'two' } }).reply(200, 'two');
  api.intercept({ path: '/limited' }).reply(429, '', { headers: { 'retry-after': '301' } });
  const options = {
    proxyUrl: 'http://127.0.0.1:8888',
    allowedHosts: ['api.figma.com'],
    uploadBytes: 100,
    signal: new AbortController().signal,
  };
  const first = createSliceNetwork({ ...options, token: 'one' });
  const second = createSliceNetwork({ ...options, token: 'two' });
  const controller = new AbortController();
  controller.abort();
  const cancelled = createSliceNetwork({
    ...options,
    token: 'cancelled',
    signal: controller.signal,
  });
  try {
    const results = await Promise.all([
      first.request('https://api.figma.com/one', 'json'),
      second.request('https://api.figma.com/two', 'json'),
    ]);
    assert.deepEqual(
      results.map((value) => value.toString()),
      ['one', 'two'],
    );
    await assert.rejects(
      first.request('https://api.figma.com/limited', 'json'),
      (error: unknown) =>
        (error as { feedback?: { code: string } }).feedback?.code === 'RATE_LIMIT_WAIT',
    );
    await assert.rejects(cancelled.request('https://api.figma.com/never', 'json'));
    mock.assertNoPendingInterceptors();
  } finally {
    await Promise.all([first.close(), second.close(), cancelled.close()]);
  }
});

/** 请求经ProxyAgent发出；错误诊断保留节点与状态，不保留URL和Token。 */
test('Figma非成功响应在后台保留状态、节点和代理使用信息', async (t) => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  t.mock.method(
    ProxyAgent.prototype,
    'dispatch',
    function (
      options: Parameters<ProxyAgent['dispatch']>[0],
      handler: Parameters<ProxyAgent['dispatch']>[1],
    ) {
      return mock.dispatch(options, handler);
    },
  );
  t.after(() => mock.close());
  mock
    .get('https://api.figma.com')
    .intercept({ path: '/v1/files/private/nodes?ids=1%3A2' })
    .reply(404, 'private response');
  const network = createSliceNetwork({
    proxyUrl: 'http://127.0.0.1:8888',
    allowedHosts: ['api.figma.com'],
    token: 'private-token',
    signal: new AbortController().signal,
    uploadBytes: 100,
  });
  try {
    await assert.rejects(
      network.request('https://api.figma.com/v1/files/private/nodes?ids=1%3A2', 'json'),
      (error) => {
        assert.ok(error instanceof ToolIssue);
        const report = diagnoseRunFailure(error.failure);
        assert.deepEqual(report.diagnostics.slice, {
          phase: 'fetch_node',
          reason: 'HTTP_ERROR',
          nodeId: '1:2',
          statusCode: 404,
          attempt: 1,
          proxyUsed: true,
        });
        assert.doesNotMatch(JSON.stringify(report), /private|https:/);
        return true;
      },
    );
    mock.assertNoPendingInterceptors();
  } finally {
    await network.close();
  }
});

/** 网络失败耗尽原有三次重试后，保留真实底层码与尝试次数。 */
test('切图网络重试耗尽保留原因且不泄漏上游异常正文', async (t) => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  t.mock.method(
    ProxyAgent.prototype,
    'dispatch',
    function (
      options: Parameters<ProxyAgent['dispatch']>[0],
      handler: Parameters<ProxyAgent['dispatch']>[1],
    ) {
      return mock.dispatch(options, handler);
    },
  );
  t.after(() => mock.close());
  mock
    .get('https://api.figma.com')
    .intercept({ path: '/v1/files/private/nodes?ids=1%3A2' })
    .replyWithError(Object.assign(new Error('private-token and url'), { code: 'ECONNRESET' }))
    .times(3);
  const network = createSliceNetwork({
    proxyUrl: 'http://127.0.0.1:8888',
    allowedHosts: ['api.figma.com'],
    token: 'private-token',
    signal: new AbortController().signal,
    uploadBytes: 100,
  });
  try {
    await assert.rejects(
      network.request('https://api.figma.com/v1/files/private/nodes?ids=1%3A2', 'json'),
      (error) => {
        assert.ok(error instanceof ToolIssue);
        const report = diagnoseRunFailure(error.failure);
        assert.equal(report.failure.code, 'NETWORK_TIMEOUT');
        assert.equal(report.diagnostics.slice?.reason, 'NETWORK_ERROR');
        assert.equal(report.diagnostics.slice?.attempt, 3);
        assert.equal(report.diagnostics.slice?.proxyUsed, true);
        assert.equal(report.diagnostics.causeCode, 'ECONNRESET');
        assert.doesNotMatch(JSON.stringify(report), /private|https:/);
        return true;
      },
    );
    mock.assertNoPendingInterceptors();
  } finally {
    await network.close();
  }
});

/** 社区版未配置代理时保持直连，并记录实际的代理使用状态。 */
test('社区版未配置代理时直连请求并记录proxyUsed=false', async (t) => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(mock);
  t.after(async () => {
    setGlobalDispatcher(previous);
    await mock.close();
  });
  t.mock.method(ProxyAgent.prototype, 'dispatch', () => {
    throw new Error('Unexpected proxy');
  });
  mock
    .get('https://api.figma.com')
    .intercept({ path: '/v1/files/test/nodes?ids=1%3A2' })
    .reply(404, 'private body');
  const network = createSliceNetwork({
    proxyUrl: '',
    allowedHosts: ['api.figma.com'],
    token: 'private-token',
    signal: new AbortController().signal,
    uploadBytes: 100,
  });
  try {
    await assert.rejects(
      network.request('https://api.figma.com/v1/files/test/nodes?ids=1%3A2', 'json'),
      (error) => {
        assert.ok(error instanceof ToolIssue);
        const report = diagnoseRunFailure(error.failure);
        assert.equal(report.diagnostics.slice?.proxyUsed, false);
        assert.equal(report.diagnostics.slice?.statusCode, 404);
        assert.equal(report.diagnostics.slice?.nodeId, '1:2');
        assert.doesNotMatch(JSON.stringify(report), /private|https:/);
        return true;
      },
    );
    mock.assertNoPendingInterceptors();
  } finally {
    await network.close();
  }
});
