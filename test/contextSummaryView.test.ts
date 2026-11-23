import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { StateBackend } from 'deepagents';
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import { modelContextView } from '../src/functions/d2c/run/agent/context';
import type { HistoryArchive } from '../src/functions/d2c/run/agent/archive';

for (const resumed of [false, true])
  test(`原生摘要消费精简视图并保留完整JSON与配对，已有摘要=${resumed}`, async () => {
    const source = 'UNIQUE_FULL_READ_PAYLOAD_123\n' + '实际布局与当前区块信息\n'.repeat(600);
    const messages: BaseMessage[] = [
      new HumanMessage({
        id: 'goal',
        content: 'CURRENT_GOAL_MUST_KEEP 保留设计稿事实，继续页面实现',
      }),
    ];
    for (const id of ['one', 'two', 'three'])
      messages.push(
        new AIMessage({
          id: 'call-' + id,
          content: '',
          tool_calls: [{ id, name: 'read_file', args: { path: 'page.tsx' } }],
        }),
        new ToolMessage({
          id: 'result-' + id,
          name: 'read_file',
          tool_call_id: id,
          content: JSON.stringify({
            content: source,
            offset: 0,
            totalCharacters: source.length,
            nextOffset: null,
          }),
        }),
      );
    messages.push(new HumanMessage({ id: 'recent-goal', content: '现在继续保存当前区块' }));
    const summaryMessage = new HumanMessage({
      id: 'old-summary',
      content: '此前已完成旧阶段，继续当前任务',
    });
    const original = JSON.stringify(
      (resumed ? [summaryMessage, ...messages] : messages).map((m) => m.toDict()),
    );
    const raw = resumed
      ? [new HumanMessage('已经归档的旧需求'), new AIMessage('已经归档的旧回复'), ...messages]
      : messages;
    const rawOriginal = JSON.stringify(raw.map((m) => m.toDict()));
    const data = new Map<string, string>();
    const archive = {
      backend: new StateBackend({ state: { files: {} } }),
      assertHealthy: () => {},
      load: async (path: string) => data.get(path),
      save: async (path: string, content: string) => {
        data.set(path, content);
        return { path };
      },
    } as unknown as HistoryArchive;
    const model = new FakeToolCallingModel();
    const summaryInputs: string[] = [];
    model._generate = async (values: BaseMessage[]) => {
      summaryInputs.push(values.map((m) => m.text).join('\n'));
      const message = new AIMessage({
        content: '已读取当前区块，按原路径回查详细源码；保留当前用户要求。',
        response_metadata: { finish_reason: 'stop' },
      });
      return { generations: [{ text: message.text, message }] };
    };
    const middleware = createContextSummary({
      archive,
      model,
      budget: 16000,
      overhead: () => 15872,
      signal: new AbortController().signal,
      beforeRequest: async () => {},
      recordUsage: () => {},
      view: (values) => modelContextView(values, 16000),
    });
    let outgoing: BaseMessage[] = [];
    await middleware.wrapModelCall!(
      {
        model,
        messages: raw,
        systemMessage: new SystemMessage('遵守真实报告和用户要求'),
        tools: [],
        state: resumed ? { _summarizationEvent: { cutoffIndex: 2, summaryMessage } } : {},
      } as never,
      (async (request: { messages: BaseMessage[] }) => {
        outgoing = request.messages;
        return new AIMessage('继续实现');
      }) as never,
    );
    assert.ok(summaryInputs.length > 0);
    const snapshot = [...data.entries()].find(([name]) => name.startsWith('/history/snapshot_'));
    assert.ok(snapshot);
    assert.equal(snapshot[1], original);
    assert.equal(JSON.stringify(raw.map((m) => m.toDict())), rawOriginal);
    const combined = summaryInputs.join('\n') + '\n' + outgoing.map((m) => m.text).join('\n');
    assert.equal(
      combined.split('UNIQUE_FULL_READ_PAYLOAD_123').length - 1,
      1,
      '原文只在摘要或最近保留消息中出现一次',
    );
    assert.ok(outgoing.some((m) => m.id === 'recent-goal'));
    assert.ok(
      combined.includes('CURRENT_GOAL_MUST_KEEP'),
      '再次摘要沿用原cutoff索引，当前要求不能被二次裁剪',
    );
  });
