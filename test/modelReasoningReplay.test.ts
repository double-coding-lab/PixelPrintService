import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import { createDeepModel } from '../src/functions/d2c/run/agent/model';
import {
  storedHistoryToMessages,
  messageToAgentRecords,
} from '../src/functions/d2c/run/agent/history';
import type { StoredAgentMessage } from '../src/functions/d2c/run/types';

/** 使用真实 SDK 和本地 HTTP 服务观察出站协议，不模拟消息转换。 */
test('SDK 回传真实思考：普通/原生流、检查点、私有历史与非流式请求', async (t) => {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    const delta = {
      role: 'assistant',
      reasoning_content: 'preserved private reasoning',
      content: '',
      tool_calls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"home.jsx"}' },
        },
      ],
    };
    if (!request.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'offline',
          choices: [{ index: 0, message: delta, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
        'data: [DONE]\n\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const model = createDeepModel({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    name: 'deepseek-reasoner',
    apiKey: 'offline',
    contextBudgetTokens: 100000,
  });
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
  ];
  const response = await model.invoke([new HumanMessage('read source')], { tools });
  const first = new AIMessage({
    content: response.content,
    tool_calls: response.tool_calls,
    additional_kwargs: response.additional_kwargs,
  });
  assert.equal(first.additional_kwargs.reasoning_content, 'preserved private reasoning');
  const records = messageToAgentRecords(first);
  assert.equal(records[0].sdkItem.reasoningContent, 'preserved private reasoning');
  assert.equal(records[0].text, undefined, '私有思考不混入用户正文');
  const result = new ToolMessage({ content: 'source', tool_call_id: 'call-1', name: 'read_file' });
  const restored = storedHistoryToMessages(
    [...records, ...messageToAgentRecords(result)].map((r) => r.sdkItem as StoredAgentMessage),
  );
  const checkpoint = mapStoredMessagesToChatMessages(
    JSON.parse(JSON.stringify([first.toDict(), result.toDict()])),
  );
  for (const messages of [restored, checkpoint]) {
    await model.invoke([new HumanMessage('read source'), ...messages], { tools });
    assert.equal(
      requests.at(-1)!.messages.find((m) => m.role === 'assistant')!.reasoning_content,
      'preserved private reasoning',
    );
    assert.equal(
      requests.at(-1)!.messages.find((m) => m.role === 'tool')!.reasoning_content,
      undefined,
    );
  }
  // 原生流使用标准 reasoning 块，不再具有 additional_kwargs.reasoning_content。
  const native = new AIMessage({
    content: [
      { type: 'reasoning', reasoning: 'native reasoning' },
      { type: 'text', text: 'working' },
    ],
    tool_calls: first.tool_calls,
  });
  const nativeRecords = messageToAgentRecords(native);
  assert.equal(nativeRecords[0].text, 'working');
  assert.equal(nativeRecords[1].sdkItem.reasoningContent, 'native reasoning');
  const iterator = model._streamChatModelEvents([native, result], { tools });
  for await (const _ of iterator) {
    /* drain actual native stream */
  }
  assert.equal(requests.at(-1)!.messages[0].reasoning_content, 'native reasoning');
  model.streaming = false;
  await model.invoke([native, result], { tools });
  assert.equal(requests.at(-1)!.messages[0].reasoning_content, 'native reasoning');
  // 同一模型实例并发使用不同历史，不得共享可变请求状态。
  await Promise.all(
    ['left', 'right'].map((name) =>
      model.invoke(
        [
          new HumanMessage(name),
          new AIMessage({
            content: name,
            additional_kwargs: { reasoning_content: name },
            tool_calls: first.tool_calls,
          }),
          result,
        ],
        { tools },
      ),
    ),
  );
  for (const name of ['left', 'right']) {
    const request = [...requests].reverse().find((r) => r.messages[0].content === name)!;
    assert.equal(request.messages[1].reasoning_content, name);
  }
  const batch = new AIMessage({
    content: '',
    additional_kwargs: { reasoning_content: '' },
    tool_calls: [
      ...first.tool_calls!,
      { id: 'call-2', name: 'read_file', args: { path: 'style.scss' }, type: 'tool_call' },
    ],
  });
  const batchRecords = messageToAgentRecords(batch);
  assert.equal(batchRecords[0].sdkItem.reasoningContent, '');
  assert.equal(batchRecords[1].sdkItem.reasoningContent, undefined, '一批工具只保存一次思考');
  const batchHistory = storedHistoryToMessages(
    [
      ...batchRecords,
      ...messageToAgentRecords(result),
      ...messageToAgentRecords(
        new ToolMessage({ content: 'style', tool_call_id: 'call-2', name: 'read_file' }),
      ),
    ].map((r) => r.sdkItem as StoredAgentMessage),
  );
  assert.equal(batchHistory.length, 3);
  assert.equal(batchHistory[0].additional_kwargs.reasoning_content, '');
  // 旧历史没有思考时不伪造；普通 OpenAI 消息维持原协议。
  await model.invoke([new HumanMessage('plain'), new AIMessage('hello')]);
  assert.equal(
    requests.at(-1)!.messages.some((m) => 'reasoning_content' in m),
    false,
  );
  assert.equal('reasoning_content' in native.additional_kwargs, false, '不得修改检查点消息');
});
