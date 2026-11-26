import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosticsContent } from '../web/src/workspace/DiagnosticsPanel';
import { readExecutionDiagnostics } from '../web/src/workspace/executionDiagnostics';
import type { SessionDiagnostics } from '../web/src/workspace/types';
import type { ExecutionDiagnostics, ExecutionScope } from '../shared/executionDiagnostics';

function scope(count: number): ExecutionScope {
  return {
    runCount: count,
    elapsedMs: count * 1000,
    runningCount: 0,
    complete: true,
    usage: {
      requests: count,
      reportedRequests: count,
      totalTokens: count * 10,
      usageComplete: true,
    },
  };
}
function fixture(): SessionDiagnostics {
  return {
    sessionId: 'session-a',
    timelineSeq: 10,
    observedAt: '2026-01-01T00:10:00Z',
    runId: 'child',
    status: 'succeeded',
    modelName: 'safe-model',
    createdAt: null,
    finishedAt: null,
    elapsedMs: 1000,
    lease: { expiresAt: null, expired: false },
    runs: [],
    current: null,
    steps: [],
    hasMore: false,
    checkpoint: { available: false, savedAt: null, scope: 'session', continuation: 'none' },
    usage: { requests: 1, reportedRequests: 1, inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    failure: null,
    execution: {
      selected: scope(1),
      recoveryChain: scope(2),
      session: scope(4),
      resumeFromRunId: 'parent',
      interruption: null,
    },
  };
}
function render(value: SessionDiagnostics, now = Date.parse(value.observedAt)) {
  return renderToStaticMarkup(
    React.createElement(DiagnosticsContent, { snapshot: value, now }),
  ).replaceAll('<!-- -->', '');
}

test('三种范围明确区分；本地时钟只累加仍在计时的区间，历史结束保持固定', () => {
  const value = fixture();
  let html = render(value);
  assert.match(html, /所选轮次统计[\s\S]*?总 Token<\/dt><dd>10/);
  assert.match(html, /关联恢复链统计[\s\S]*?总 Token<\/dt><dd>20/);
  assert.match(html, /整会话统计[\s\S]*?总 Token<\/dt><dd>40/);
  assert.match(html, /整会话错误数不是恢复链错误数/);
  assert.match(html, /可能含人工继续，不代表自动恢复成功/);
  assert.match(html, /前序轮次：<code>parent/);
  value.execution!.selected.runningCount = 1;
  html = render(value, Date.parse(value.observedAt) + 5000);
  assert.match(html, /所选轮次耗时<\/span><strong>6 秒/);
  assert.match(html, /关联恢复链统计[\s\S]*?累计区间耗时<\/dt><dd>2 秒/);
});

test('部署或进程中断单独提示，不冒充实际失败或已恢复；真实存储错误保留警示', () => {
  const value = fixture();
  value.status = 'interrupted';
  value.execution!.interruption = 'worker';
  let html = render(value);
  assert.match(html, /进程或服务中断/);
  assert.match(html, /可能由发布重启或进程退出引起/);
  assert.match(html, /ant-alert-info/);
  assert.doesNotMatch(html, /ant-alert-warning/);
  value.execution!.interruption = 'failure';
  value.failure = {
    errorId: '11111111-1111-4111-8111-111111111111',
    code: 'STORAGE_FAILED',
    stage: 'storage',
    message: 'PRIVATE_MESSAGE',
    suggestion: 'PRIVATE_SUGGESTION',
  };
  html = render(value);
  assert.match(html, /ant-alert-warning/);
  assert.match(html, /执行数据保存或读取失败/);
  assert.doesNotMatch(html, /PRIVATE_/);
});

test('缺失或非法范围摘要不回显私有字段，旧数据不生成零消耗和恢复结论', () => {
  const value = fixture();
  delete value.execution;
  assert.match(render(value), /旧记录未采集范围摘要/);
  const raw = {
    ...fixture().execution!,
    private: 'PRIVATE_ROOT',
    recoveryChain: { ...scope(2), private: 'PRIVATE_CHAIN' },
  };
  assert.doesNotMatch(JSON.stringify(readExecutionDiagnostics(raw)), /PRIVATE_/);
  for (const patch of [
    { interruption: 'PRIVATE_REASON' },
    { resumeFromRunId: 'PRIVATE SQL secret' },
    { session: { ...scope(4), runCount: 2001 } },
    { selected: { ...scope(1), elapsedMs: -1 } },
  ]) {
    const invalid = { ...raw, ...patch };
    assert.equal(readExecutionDiagnostics(invalid), undefined);
    value.execution = invalid as ExecutionDiagnostics;
    assert.doesNotMatch(render(value), /PRIVATE_|SQL secret/);
    assert.match(render(value), /旧记录未采集范围摘要/);
  }
  value.execution = {
    ...fixture().execution!,
    recoveryChain: {
      ...scope(2),
      complete: false,
      elapsedMs: null,
      runningCount: 0,
      usage: { requests: null, reportedRequests: null, totalTokens: null, usageComplete: null },
    },
  };
  assert.match(render(value), /范围不完整/);
});

test('等待回答期间本轮、恢复链和会话秒表均冻结，回答重新入队后才递增', () => {
  const value = fixture();
  value.status = 'waiting_input';
  value.sessionElapsedMs = 4000;
  value.sessionRunningCount = 0;
  const now = Date.parse(value.observedAt) + 3600000;
  let html = render(value, now);
  assert.match(html, /所选轮次耗时<\/span><strong>1 秒/);
  assert.match(html, /累计执行时间<\/span><strong>4 秒/);
  assert.match(html, /关联恢复链统计[\s\S]*?累计区间耗时<\/dt><dd>2 秒/);
  assert.match(html, /等待回答暂停计时/);
  value.status = 'running';
  value.execution!.selected.runningCount = 1;
  value.execution!.recoveryChain.runningCount = 1;
  value.sessionRunningCount = 1;
  html = render(value, Date.parse(value.observedAt) + 5000);
  assert.match(html, /所选轮次耗时<\/span><strong>6 秒/);
  assert.match(html, /累计执行时间<\/span><strong>9 秒/);
});
