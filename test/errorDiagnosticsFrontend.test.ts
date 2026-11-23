import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiagnosticError, ErrorDiagnostics } from '../shared/errorDiagnostics';
import {
  ErrorDiagnosticsPanel,
  ErrorDiagnosticsResults,
  errorDiagnosticText,
  projectErrorDiagnostics,
  readErrorDiagnostics,
} from '../web/src/workspace/ErrorDiagnostics';

/** 合成安全 DTO，计数故意大于当前页，避免按本地条目推算总数。 */
function fixture(overrides: Partial<ErrorDiagnostics> = {}): ErrorDiagnostics {
  const item: DiagnosticError = {
    id: 'error-one',
    seq: 1000,
    at: '2026-11-21T01:00:00Z',
    runId: 'old-run',
    category: 'model',
    scope: 'main',
    code: 'MODEL_REQUEST_FAILED',
    message: '模型网关请求受限',
    stage: 'model',
    tool: 'read_file',
    command: 'inspect-node',
    agentId: null,
    agentRole: 'main',
    errorId: 'error-id',
    requestId: 'request-id',
    attempt: 2,
    recovery: 'subsequent_success',
  };
  return {
    sessionId: 'session/one',
    observedAt: '2026-11-21T01:01:00Z',
    snapshotSeq: 2000,
    snapshotToken: 'a'.repeat(64),
    total: 79,
    executionErrors: 70,
    toolCorrections: 9,
    ruleFailures: 2,
    filteredTotal: 81,
    items: [item],
    nextBefore: 50,
    hasMore: true,
    coverage: {
      complete: false,
      scannedEvents: 20000,
      limit: 20000,
      historical: 'saved_events_only',
    },
    ...overrides,
  };
}

/** 直接渲染生产视图；SSR 不发请求且不依赖 CSS loader。 */
function render(value: ErrorDiagnostics | null, loading = false, error = ''): string {
  return renderToStaticMarkup(
    React.createElement(ErrorDiagnosticsResults, {
      snapshot: value ? projectErrorDiagnostics(value, 'session/one') : null,
      loading,
      error,
      expanded: new Set(['error-one']),
      onToggle: () => {},
    }),
  ).replaceAll('<!-- -->', '');
}

test('服务器总计与分页、历史范围和覆盖不完整均显式展示，错误区域不整体折叠', () => {
  const html = render(fixture());
  for (const text of [
    '错误总数（不含规则未通过）',
    '>79<',
    '执行错误',
    '>70<',
    '工具纠正数',
    '>9<',
    '规则未通过数',
    '>2<',
    '匹配记录数（含规则未通过） 81',
    '已加载 1 条',
    '历史按已保存事件统计',
    '覆盖不完整',
    '当前列表尚未完整加载',
    'old-run',
    'MODEL_REQUEST_FAILED',
    'error-id',
    'request-id',
    '主 Agent',
    'read_file',
    'inspect-node',
    '后续已成功',
    '尝试次数',
    '复制排查信息',
  ])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.doesNotMatch(html, /PRIVATE_MESSAGE|rawStack|Invalid Date/);
});

test('初次加载、失败、404 与刷新旧零值不能显示为零；只有已确认零值显示零', () => {
  const zero = fixture({
    total: 0,
    executionErrors: 0,
    toolCorrections: 0,
    ruleFailures: 0,
    filteredTotal: 0,
    items: [],
    hasMore: false,
    nextBefore: null,
  });
  for (const [value, loading, error] of [
    [null, true, ''],
    [null, false, '错误诊断接口暂不可用（404），统计未能读取。'],
    [zero, true, ''],
    [zero, false, '读取失败'],
  ] as const) {
    const html = render(value, loading, error);
    assert.doesNotMatch(html, /<strong>0<|服务端记录总数 0|暂无匹配/);
    assert.match(html, /<strong>—<\/strong>/);
  }
  assert.match(render(zero), /<strong>0<\/strong>/);
  assert.match(render(zero), /其他历史尚未覆盖/);
  assert.match(
    render({ ...zero, coverage: { ...zero.coverage, complete: true } }),
    /已保存事件中暂无匹配/,
  );
});

test('DTO 白名单拒绝错误计数和错会话、水位、筛选、游标；未知枚举固定标签', () => {
  for (const change of [
    { total: undefined },
    { executionErrors: -1 },
    { toolCorrections: null },
    { ruleFailures: NaN },
    { filteredTotal: '0' },
    { coverage: undefined },
    { items: {} },
    { hasMore: true, nextBefore: null },
    { snapshotSeq: undefined },
    { snapshotToken: undefined },
    { snapshotToken: '<b>invalid token</b>' },
  ]) {
    assert.throws(() => projectErrorDiagnostics({ ...fixture(), ...change }, 'session/one'));
  }
  assert.throws(() => projectErrorDiagnostics(fixture(), 'other-session'));
  assert.throws(() => projectErrorDiagnostics(fixture(), 'session/one', { snapshotSeq: 99 }));
  assert.throws(() =>
    projectErrorDiagnostics(fixture(), 'session/one', { snapshotToken: 'b'.repeat(64) }),
  );
  assert.equal(
    projectErrorDiagnostics(fixture(), 'session/one', { snapshotToken: 'a'.repeat(64) })
      .snapshotToken,
    'a'.repeat(64),
  );
  assert.throws(() => projectErrorDiagnostics(fixture(), 'session/one', { runId: 'other-run' }));
  assert.throws(() => projectErrorDiagnostics(fixture(), 'session/one', { category: 'tool' }));
  assert.throws(() => projectErrorDiagnostics(fixture(), 'session/one', { scope: 'subagent' }));
  assert.throws(() => projectErrorDiagnostics(fixture(), 'session/one', { before: 50 }));
  const offsetPage = fixture({ nextBefore: 100 });
  assert.equal(
    projectErrorDiagnostics(offsetPage, 'session/one', { before: 50, snapshotSeq: 2000 }).items[0]
      .seq,
    1000,
  );
  assert.throws(() =>
    projectErrorDiagnostics(offsetPage, 'session/one', { before: 100, snapshotSeq: 2000 }),
  );
  const raw = fixture();
  Object.assign(raw.items[0], {
    category: 'PRIVATE_CATEGORY',
    scope: 'PRIVATE_SCOPE',
    recovery: 'PRIVATE_RECOVERY',
    agentRole: '__proto__',
    code: '<img src=x onerror=alert(1)>',
    at: 'bad date',
    message: '目标服务连接或响应超时',
    rawStack: 'PRIVATE_STACK',
  });
  Object.assign(raw, { rawStack: 'PRIVATE_ROOT_STACK' });
  const projected = projectErrorDiagnostics(raw, 'session/one');
  const html = renderToStaticMarkup(
    React.createElement(ErrorDiagnosticsResults, {
      snapshot: projected,
      loading: false,
      error: '',
      expanded: new Set<string>(),
      onToggle: () => {},
    }),
  );
  for (const text of ['分类未知', '归属未知', '角色未知', '恢复状态未知', '时间未记录', 'UNKNOWN'])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /PRIVATE_|<img|Invalid Date/);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|rawStack/);
});

test('固定说明和命令以文本渲染，复制保留说明与元数据，不包含额外 stack', () => {
  const raw = fixture();
  raw.items[0].command = '<img src=x onerror=alert(1)>';
  Object.assign(raw.items[0], { rawStack: 'PRIVATE_STACK', detail: { secret: 'PRIVATE_SECRET' } });
  const safe = projectErrorDiagnostics(raw, 'session/one');
  const html = render(raw);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|PRIVATE_/);
  raw.items[0].message = '<b>目标服务连接或响应超时</b>';
  assert.match(render(raw), /&lt;b&gt;目标服务连接或响应超时&lt;\/b&gt;/);
  const copy = errorDiagnosticText('session/one', safe.items[0]);
  assert.match(copy, /sessionId: session\/one/);
  assert.match(copy, /requestId: request-id/);
  assert.match(copy, /说明: 模型网关请求受限/);
  assert.match(copy, /恢复状态: 后续已成功/);
  assert.doesNotMatch(copy, /PRIVATE_|rawStack|message:/);
});

test('固定 GET/50、编码筛选与水位，忽略取消的传输层也不能交付旧结果', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  };
  try {
    const controller = new AbortController();
    const pending = readErrorDiagnostics(
      'session/one',
      {
        runId: 'old-run',
        category: 'model',
        scope: 'main',
        snapshotSeq: 2000,
        snapshotToken: 'a'.repeat(64),
        before: 50,
        pageSize: 2,
      },
      controller.signal,
    );
    const url = new URL(calls[0].url, 'http://localhost');
    assert.equal(url.pathname, '/api/d2c/sessions/session%2Fone/errors');
    assert.equal(url.searchParams.get('runId'), 'old-run');
    assert.equal(url.searchParams.get('pageSize'), '50');
    assert.equal(url.searchParams.get('before'), '50');
    assert.equal(url.searchParams.get('snapshotSeq'), '2000');
    assert.equal(url.searchParams.get('snapshotToken'), 'a'.repeat(64));
    assert.equal(calls[0].init?.method ?? 'GET', 'GET');
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(calls[0].init?.body, undefined);
    controller.abort();
    finish(new Response(JSON.stringify({ success: true, data: fixture({ nextBefore: 100 }) })));
    assert.equal(await pending, null);
    assert.equal(await readErrorDiagnostics('session/one', {}, controller.signal), null);
    assert.equal(calls.length, 1);
    const latest = readErrorDiagnostics('session/one', {}, new AbortController().signal);
    finish(new Response(JSON.stringify({ success: true, data: fixture() })));
    assert.equal((await latest)?.total, 79);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('错误 HTTP 与缺省 DTO 拒绝读取，服务端异常正文不会被视为诊断数据', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 409, 500]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ success: false, resultMessage: '<b>PRIVATE</b>' }), {
          status,
        });
      await assert.rejects(
        readErrorDiagnostics('session/one', {}, new AbortController().signal),
        (error: { status?: number }) => error.status === status,
      );
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: {} }));
    await assert.rejects(readErrorDiagnostics('session/one', {}, new AbortController().signal));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('生产面板初始 SSR 为全部会话且统计未知，无副作用请求', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorDiagnosticsPanel, {
      sessionId: 'session/one',
      runId: 'new-run',
      revision: 1,
    }),
  );
  assert.match(html, /aria-label="执行错误诊断"/);
  assert.match(html, /<option value="session" selected="">会话全部轮次/);
  assert.match(html, /当前所选轮次 · new-run/);
  assert.match(html, /统计尚未确认/);
  assert.doesNotMatch(html, /<strong>0<|<details/);
});

test('子任务失败详情经白名单展示和复制，拒绝服务端额外私有字段', () => {
  const value = fixture();
  value.items[0].failureDetails = {
    errorType: 'TypeError',
    causeCode: 'ENOTFOUND',
    subagentPhase: 'execute',
    statusCode: 503,
    ...({ stack: 'PRIVATE_STACK', message: 'PRIVATE_MESSAGE' } as object),
  };
  const projected = projectErrorDiagnostics(value, 'session/one');
  const text = errorDiagnosticText('session/one', projected.items[0]);
  assert.match(text, /TypeError/);
  assert.match(text, /ENOTFOUND/);
  assert.match(text, /503/);
  assert.doesNotMatch(JSON.stringify(projected) + text, /PRIVATE_/);
  assert.match(render(value), /系统错误码/);
});
