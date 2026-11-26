import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { StateBackend } from 'deepagents';
import { createDeepModel } from '../src/functions/d2c/run/agent/model';
import { messageReasoningFields } from '../src/functions/d2c/run/agent/reasoningContent';
import { storedHistoryToMessages } from '../src/functions/d2c/run/agent/history';
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import type { HistoryArchive } from '../src/functions/d2c/run/agent/archive';

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** 严格本地网关拒绝缺字段，不访问真实模型；核对真实 SDK 的最终请求。 */
test('DeepSeek 旧历史、平台消息及摘要后补全空思考；其他模型保持原协议', async (t) => {
  const requests: Array<{
    model: string;
    tools?: unknown[];
    messages: Array<Record<string, unknown>>;
  }> = [];
  const recognized = new Set([
    'deepseek-flash',
    'deepseek-v4.1-flash-1017',
    'deepseek/deepseek-v3.2',
  ]);
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    if (
      recognized.has(body.model) &&
      body.tools?.length &&
      body.messages.some(
        (m: Record<string, unknown>) =>
          m.role === 'assistant' && typeof m.reasoning_content !== 'string',
      )
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Missing reasoning_content' },
        }),
      );
      return;
    }
    const message = { role: 'assistant', content: 'done' };
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'local-response',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
        }),
      );
    } else {
      res.setHeader('content-type', 'text/event-stream');
      res.end(
        `data: ${JSON.stringify({ id: 'local-response', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: 'local-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const modelFor = (name: string) =>
    createDeepModel({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      name,
      apiKey: 'offline',
      contextBudgetTokens: 12000,
      reasoningPolicy: 'provider-default',
    });
  const legacy = storedHistoryToMessages([
    { type: 'function_call', name: 'read_file', callId: 'legacy-call', arguments: '{}' },
    {
      type: 'function_call_result',
      name: 'read_file',
      callId: 'legacy-call',
      status: 'completed',
      output: 'saved result',
    },
  ]);
  const real = new AIMessage({
    content: 'known answer',
    additional_kwargs: { reasoning_content: 'real preserved reasoning' },
  });
  const native = new AIMessage({
    content: [
      { type: 'reasoning', reasoning: 'native preserved reasoning' },
      { type: 'text', text: 'answer' },
    ],
  });
  const messages = [
    new SystemMessage('system'),
    new HumanMessage('continue'),
    ...legacy,
    real,
    native,
    new AIMessage({ content: '', additional_kwargs: { reasoning_content: '' } }),
    new AIMessage('platform notice'),
  ];
  const original = JSON.stringify(messages.map((m) => m.toDict()));
  const restored = mapStoredMessagesToChatMessages(JSON.parse(original));
  for (const name of recognized) {
    const model = modelFor(name);
    for (const streaming of [true, false]) {
      model.streaming = streaming;
      assert.equal((await model.invoke(restored, { tools })).text, 'done');
      const outgoing = requests.at(-1)!;
      const assistants = outgoing.messages.filter((m) => m.role === 'assistant');
      assert.deepEqual(
        assistants.map((m) => m.reasoning_content),
        ['', 'real preserved reasoning', 'native preserved reasoning', '', ''],
      );
      assert.equal(outgoing.messages.find((m) => m.role === 'tool')!.content, 'saved result');
      assert.ok(
        outgoing.messages
          .filter((m) => m.role !== 'assistant')
          .every((m) => !Object.hasOwn(m, 'reasoning_content')),
      );
      assert.equal(Object.hasOwn(outgoing, 'thinking'), false, '保留供应商思考策略');
    }
    for await (const _ of model._streamChatModelEvents(restored, { tools })) {
      /* drain native events */
    }
    assert.equal(
      requests
        .at(-1)!
        .messages.filter((m) => m.role === 'assistant')
        .every((m) => typeof m.reasoning_content === 'string'),
      true,
    );
    // 只有旧消息、完全没有真实思考时也必须走兼容分支。
    await model.invoke([new HumanMessage('legacy only'), ...legacy], { tools });
    assert.equal(
      requests.at(-1)!.messages.find((m) => m.role === 'assistant')!.reasoning_content,
      '',
    );
  }
  for (const name of ['gpt-4.1', 'claude-sonnet', 'qwen3', 'not-deepseek-flash']) {
    await modelFor(name).invoke([new HumanMessage('other'), ...legacy], { tools });
    assert.ok(requests.at(-1)!.messages.every((m) => !Object.hasOwn(m, 'reasoning_content')));
  }
  await modelFor('deepseek-flash').invoke([
    new HumanMessage('without tools'),
    new AIMessage('plain'),
  ]);
  assert.ok(requests.at(-1)!.messages.every((m) => !Object.hasOwn(m, 'reasoning_content')));
  assert.equal(JSON.stringify(messages.map((m) => m.toDict())), original, '不回写原始历史或检查点');
  assert.equal(JSON.stringify(restored.map((m) => m.toDict())), original);

  // 摘要必须真实触发，保留近期缺字段工具组；原文归档和当前要求仍完整。
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
  let summaryCalls = 0;
  const summary = new FakeToolCallingModel();
  summary._generate = async () => {
    summaryCalls++;
    const message = new AIMessage('保留原要求、已完成工作和待处理事项。');
    return { generations: [{ text: message.text, message }] };
  };
  const current = new HumanMessage({
    id: 'current',
    content: 'CURRENT_REQUIRED：继续现有任务，不要重做。',
  });
  const history: BaseMessage[] = [
    current,
    ...Array.from({ length: 6 }, () => new AIMessage('旧材料。'.repeat(700))),
    ...legacy,
  ];
  const historyBefore = JSON.stringify(history.map((m) => m.toDict()));
  const middleware = createContextSummary({
    archive,
    model: summary,
    budget: 12000,
    overhead: () => 2000,
    signal: new AbortController().signal,
    beforeRequest: async () => {},
    recordUsage: () => {},
    historicalSourceInputId: current.id,
  });
  const generation = modelFor('deepseek-v4.1-flash-1017');
  await middleware.wrapModelCall!(
    {
      model: generation,
      messages: history,
      systemMessage: new SystemMessage('constraints'),
      tools: [],
      state: {},
    } as never,
    (async (r: { messages: BaseMessage[] }) => generation.invoke(r.messages, { tools })) as never,
  );
  assert.ok(summaryCalls > 0, '必须经过真实摘要分支');
  const afterSummary = requests.at(-1)!;
  assert.ok(
    afterSummary.messages.some(
      (m) => m.role === 'user' && String(m.content).includes(current.text),
    ),
  );
  assert.ok(
    afterSummary.messages.some((m) => m.role === 'tool' && m.content === 'saved result'),
    '保留近期工具回执',
  );
  assert.ok(
    afterSummary.messages
      .filter((m) => m.role === 'assistant')
      .every((m) => typeof m.reasoning_content === 'string'),
  );
  assert.ok([...data.values()].includes(historyBefore), '完整原文仍可回查');
  assert.equal(JSON.stringify(history.map((m) => m.toDict())), historyBefore);
});

/** 原生思考保留，重建的工具参数不混入旧原始调用，也不持久化补出的空字段。 */
test('平台重建助手消息只复制真实思考字段', () => {
  const original = new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'native thinking' }],
    additional_kwargs: {
      tool_calls: [{ id: 'stale', type: 'function', function: { name: 'old', arguments: '{}' } }],
      private: 'keep private',
    },
  });
  const rebuilt = new AIMessage({
    content: 'new',
    ...messageReasoningFields(original),
    tool_calls: [{ id: 'new', name: 'read_file', args: {} }],
  });
  assert.deepEqual(rebuilt.additional_kwargs, { reasoning_content: 'native thinking' });
  assert.equal(rebuilt.tool_calls?.[0].id, 'new');
  assert.deepEqual(messageReasoningFields(new AIMessage('old without thinking')), {});
  assert.deepEqual(
    messageReasoningFields(
      new AIMessage({ content: '', additional_kwargs: { reasoning_content: '' } }),
    ),
    { additional_kwargs: { reasoning_content: '' } },
  );
  assert.equal(Object.hasOwn(original.additional_kwargs, 'reasoning_content'), false);
});
