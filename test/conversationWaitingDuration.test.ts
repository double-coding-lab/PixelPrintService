import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationRound from '../web/src/workspace/ConversationRound';
import { projectConversationRound } from '../web/src/workspace/roundProjection';
import type { TimelineEntry } from '../web/src/workspace/types';

/** 构造顶层生命周期，固定时间并显式包含长等待区间。 */
function entry(seq: number, seconds: number, status: string): TimelineEntry {
  return {
    entryId: `waiting-${seq}`,
    sessionId: 'session-a',
    runId: 'run-a',
    seq,
    at: new Date(Date.parse('2026-11-04T00:00:00Z') + seconds * 1000).toISOString(),
    kind: status === 'queued' ? 'stage' : 'run_status',
    data: { status, ...(status === 'queued' ? { stage: 'queued' } : {}) },
  };
}

/** 使用真实聊天组件验证冻结后的文案，不以组件实现细节模拟计时器。 */
function render(entries: TimelineEntry[]) {
  return renderToStaticMarkup(
    React.createElement(ConversationRound, {
      entries,
      active: true,
      onLayoutChange() {},
      renderMessage: () => null,
    }),
  ).replaceAll('<!-- -->', '');
}

test('聊天提问冻结、连续回答续计及最终完成共用扣除等待的区间', () => {
  const events = [
    entry(1, 0, 'queued'),
    entry(2, 10, 'waiting_input'),
    entry(3, 100, 'waiting_input'),
  ];
  assert.equal(projectConversationRound(events, true).durationMs, 10000);
  assert.equal(projectConversationRound(events, true).endedAt, null);
  assert.match(render(events), /等待回答 · 10 秒/);
  assert.match(render(events), /计时暂停/);
  events.push(
    entry(4, 200, 'queued'),
    entry(5, 205, 'waiting_input'),
    entry(6, 300, 'queued'),
    entry(7, 308, 'succeeded'),
  );
  assert.equal(projectConversationRound(events, false).durationMs, 23000);
  assert.match(render(events), /已完成 · 23 秒/);
});

test('等待结束仅结算已执行时间；缺失等待端点保持未知', () => {
  const events = [entry(1, 0, 'queued'), entry(2, 10, 'waiting_input'), entry(3, 800, 'cancelled')];
  assert.equal(projectConversationRound(events, false).durationMs, 10000);
  events[1].at = 'invalid';
  assert.equal(projectConversationRound(events, false).durationMs, null);
});
