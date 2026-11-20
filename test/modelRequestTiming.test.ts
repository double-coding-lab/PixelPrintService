import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HumanMessage } from '@langchain/core/messages';
import {
  gatewayRequestIdSchema,
  modelActivitySchema,
  observeModelChunk,
  observeModelRequest,
  observeModelResponseHeaders,
  type ModelActivity,
} from '../src/functions/d2c/run/agent/modelActivity';
import { createDeepModel } from '../src/functions/d2c/run/agent/model';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { readRunDiagnostics } from '../src/functions/d2c/run/diagnostics';
import { createRunLeases } from '../src/functions/d2c/run/leases';
import { createRunPersistence } from '../src/functions/d2c/run/persistence';
import { DiagnosticsContent } from '../web/src/workspace/DiagnosticsPanel';
import { messageFixture } from './helpers/messages';

/** 使用回环 HTTP 和正式 SDK，禁止连接真实模型或业务数据库。 */
async function gateway(t: TestContext, respond: (response: ServerResponse, index: number) => void) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // 排空本地请求，不记录提示或请求头。
    }
    respond(response, ++requests);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return createDeepModel({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    name: 'offline-timing',
    apiKey: 'PRIVATE_API_KEY',
    contextBudgetTokens: 100000,
  });
}

/** 写入一个真实 Chat Completions SSE 块，模型编号不冒充网关请求编号。 */
function chunk(response: ServerResponse, delta: Record<string, unknown>, finish?: string) {
  response.write(
    `data: ${JSON.stringify({ id: 'chatcmpl-not-a-request-id', choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`,
  );
}

/** 用量和结束块应透传 SDK，但不算实际模型首块。 */
function end(response: ServerResponse) {
  chunk(response, {}, 'stop');
  response.end(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\ndata: [DONE]\n\n`,
  );
}

/** 断言分段使用同一单调时钟，并在毫秒舍入后仍能加回总耗时。 */
function measured(event: ModelActivity) {
  assert.equal(typeof event.firstChunkMs, 'number');
  assert.equal(typeof event.afterFirstChunkMs, 'number');
  assert.equal(event.firstChunkMs! + event.afterFirstChunkMs!, event.durationMs);
  assert.equal(modelActivitySchema.safeParse(event).success, true);
}

test('所有范围共用单调计时入口，忽略空块/用量，仅首次实际输出计时', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  for (const scope of ['generation', 'design', 'review', 'rule_scan', 'ui', 'summary'] as const) {
    const events: ModelActivity[] = [];
    clock = 0;
    await observeModelRequest(
      scope,
      async () => {
        clock += 20;
        observeModelChunk({ content: '' });
        observeModelChunk({ content: '', additional_kwargs: {} });
        clock += 10;
        observeModelResponseHeaders(new Headers({ 'x-request-id': `gw-${scope}` }));
        clock += 20;
        observeModelChunk({ content: 'PRIVATE_OUTPUT' });
        clock += 30;
        observeModelChunk({ content: 'PRIVATE_LATER_OUTPUT' });
        clock += 20;
        return { text: 'PRIVATE_FINAL' };
      },
      async (event) => {
        events.push(event);
        // 持久化耗时不进入模型计时。
        clock += 1000;
      },
    );
    assert.equal(events.length, 2);
    assert.equal(events[1].gatewayRequestId, `gw-${scope}`);
    assert.equal(events[1].firstChunkMs, 50);
    assert.equal(events[1].afterFirstChunkMs, 50);
    assert.equal(events[1].durationMs, 100);
    measured(events[1]);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
});

test('失败、取消、无输出都保留已到阶段和总耗时，不从最终消息猜首块', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  for (const withChunk of [false, true]) {
    for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
      clock = 0;
      const events: ModelActivity[] = [];
      const controller = new AbortController();
      const error = new Error('PRIVATE_ERROR');
      const action = observeModelRequest(
        'summary',
        async () => {
          observeModelResponseHeaders(new Headers({ 'x-request-id': 'gw-partial' }));
          clock = 40;
          if (withChunk)
            observeModelChunk({ additional_kwargs: { reasoning_content: 'PRIVATE_REASONING' } });
          clock = 100;
          if (outcome === 'cancelled') controller.abort(error);
          if (outcome !== 'completed') throw error;
          return { text: 'PRIVATE_FINAL_NOT_A_CHUNK' };
        },
        async (event) => {
          events.push(event);
        },
        controller.signal,
      );
      if (outcome === 'completed') await action;
      else await assert.rejects(action, (value) => value === error);
      const final = events[1];
      assert.equal(final.gatewayRequestId, 'gw-partial');
      assert.equal(final.durationMs, 100);
      assert.equal(final.firstChunkMs, withChunk ? 40 : undefined);
      assert.equal(final.afterFirstChunkMs, withChunk ? 60 : undefined);
      assert.equal(final.interrupted, outcome === 'cancelled' ? true : undefined);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
    }
  }
});

test('请求编号采用格式白名单，未知响应头/正文/错误内容不进入事件', async () => {
  for (const value of [
    'https://secret/path',
    'sk-secret',
    'figd_secret',
    'Bearer-secret',
    'token_secret',
    'api_key-secret',
    'line\nbreak',
    'a'.repeat(129),
    '',
  ])
    assert.equal(gatewayRequestIdSchema.safeParse(value).success, false);
  for (const value of ['gw:123-abc_12.3', randomUUID()])
    assert.equal(gatewayRequestIdSchema.safeParse(value).success, true);
  const events: ModelActivity[] = [];
  await assert.rejects(
    observeModelRequest(
      'generation',
      async () => {
        observeModelResponseHeaders(
          new Headers({
            'x-request-id': 'sk-PRIVATE_KEY',
            'request-id': 'gw-safe-fallback',
            authorization: 'Bearer PRIVATE_AUTH',
            'set-cookie': 'PRIVATE_COOKIE',
            'x-unknown-header': 'PRIVATE_HEADER',
          }),
        );
        throw { status: 400, requestID: 'token_PRIVATE', error: { message: 'PRIVATE_BODY' } };
      },
      async (event) => {
        events.push(event);
      },
    ),
  );
  assert.equal(events[1].gatewayRequestId, 'gw-safe-fallback');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|authorization|cookie|headers|"error":/);
  const base = { operationId: randomUUID(), scope: 'generation', status: 'completed' };
  assert.deepEqual(
    modelActivitySchema.parse({ ...base, headers: 'PRIVATE', body: 'PRIVATE' }),
    base,
  );
});

test('SDK 成功流捕获编号，正文/思考/工具分片均触发首块，纯用量保持未知', async (t) => {
  const deltas = [
    { content: 'PRIVATE_TEXT' },
    { reasoning_content: 'PRIVATE_REASONING' },
    {
      tool_calls: [
        {
          index: 0,
          id: 'call-a',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    },
    {},
  ];
  const model = await gateway(t, (response, index) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `gw-sdk-${index}`,
      'x-private': 'PRIVATE_HEADER',
    });
    chunk(response, { role: 'assistant', content: '' });
    chunk(response, deltas[index - 1]);
    end(response);
  });
  for (let index = 0; index < deltas.length; index++) {
    const events: ModelActivity[] = [];
    await observeModelRequest(
      'generation',
      () => model.invoke('PRIVATE_PROMPT'),
      async (event) => {
        events.push(event);
      },
    );
    const final = events[1];
    assert.equal(final.gatewayRequestId, `gw-sdk-${index + 1}`);
    if (index < 3) measured(final);
    else {
      assert.equal(final.firstChunkMs, undefined);
      assert.equal(final.afterFirstChunkMs, undefined);
    }
    assert.equal(final.tokenUsage?.total_tokens, 9);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|chatcmpl|headers/);
  }
});

test('native stream 直接调用覆盖正文/思考/工具参数首块，空角色和用量仍不计时', async (t) => {
  const deltas = [
    { content: 'PRIVATE_NATIVE_TEXT' },
    { reasoning_content: 'PRIVATE_NATIVE_REASONING' },
    {
      tool_calls: [{ index: 0, id: 'call-native', type: 'function', function: { arguments: '{' } }],
    },
    {},
  ];
  const model = await gateway(t, (response, index) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `gw-native-${index}`,
    });
    chunk(response, { role: 'assistant', content: '' });
    chunk(response, deltas[index - 1]);
    end(response);
  });
  for (let index = 0; index < deltas.length; index++) {
    const events: ModelActivity[] = [];
    await observeModelRequest(
      'summary',
      async () => {
        for await (const _event of model.streamEvents('PRIVATE_PROMPT')) {
          // 仅消费正式 SDK 事件，不聚合正文或伪造最终消息。
        }
      },
      async (event) => {
        events.push(event);
      },
    );
    assert.equal(events[1].gatewayRequestId, `gw-native-${index + 1}`);
    if (index < 3) measured(events[1]);
    else {
      assert.equal(events[1].firstChunkMs, undefined);
      assert.equal(events[1].afterFirstChunkMs, undefined);
    }
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|headers/);
  }
});

test('真实 SDK HTTP 失败保留编号，无首块不制造阶段耗时', async (t) => {
  const model = await gateway(t, (response) => {
    response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'gw-rejected' });
    response.end(
      JSON.stringify({
        error: { message: 'PRIVATE_GATEWAY_ERROR', type: 'invalid_request_error' },
      }),
    );
  });
  const events: ModelActivity[] = [];
  await assert.rejects(
    observeModelRequest(
      'generation',
      () => model.invoke('PRIVATE_PROMPT'),
      async (event) => {
        events.push(event);
      },
    ),
  );
  assert.equal(events[1].status, 'failed');
  assert.equal(events[1].gatewayRequestId, 'gw-rejected');
  assert.equal(events[1].firstChunkMs, undefined);
  assert.equal(typeof events[1].durationMs, 'number');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('真实流首块后断开仍保存两段及编号，首块前/后取消保持实际阶段', async (t) => {
  const model = await gateway(t, (response, index) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `gw-stop-${index}`,
    });
    chunk(response, { role: 'assistant', content: '' });
    if (index !== 2) chunk(response, { content: 'PRIVATE_PARTIAL' });
    if (index === 1) setTimeout(() => response.destroy(), 30);
  });
  const failed: ModelActivity[] = [];
  await assert.rejects(
    observeModelRequest(
      'generation',
      () => model.invoke('probe'),
      async (event) => {
        failed.push(event);
      },
    ),
  );
  measured(failed[1]);
  assert.equal(failed[1].gatewayRequestId, 'gw-stop-1');
  for (const withChunk of [false, true]) {
    const controller = new AbortController();
    const events: ModelActivity[] = [];
    const pending = observeModelRequest(
      'generation',
      async () => {
        for await (const message of await model.stream('probe', { signal: controller.signal })) {
          if (!withChunk || message.text) controller.abort();
        }
      },
      async (event) => {
        events.push(event);
      },
      controller.signal,
    );
    await assert.rejects(pending);
    assert.equal(events[1].interrupted, true);
    assert.equal(events[1].gatewayRequestId, withChunk ? 'gw-stop-3' : 'gw-stop-2');
    if (withChunk) measured(events[1]);
    else assert.equal(events[1].firstChunkMs, undefined);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
});

test('编号缺失/非法保持未知，SDK 错误编号按同一白名单回退', async () => {
  for (const requestID of [undefined, 'https://PRIVATE', 'gw-sdk-error']) {
    const events: ModelActivity[] = [];
    await assert.rejects(
      observeModelRequest(
        'generation',
        async () => {
          observeModelResponseHeaders(new Headers({ 'x-request-id': 'sk-PRIVATE_KEY' }));
          throw { status: 400, requestID, error: { message: 'PRIVATE_BODY' } };
        },
        async (event) => {
          events.push(event);
        },
      ),
    );
    assert.equal(events[1].gatewayRequestId, requestID === 'gw-sdk-error' ? requestID : undefined);
    assert.equal(events[1].firstChunkMs, undefined);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
});

test('并行和嵌套请求上下文隔离，摘要不覆盖父请求或其他子请求', async () => {
  const modelEvents: ModelActivity[] = [];
  const model = await Promise.all(
    ['generation', 'ui', 'summary'].map(async (scope, index) => {
      const events: ModelActivity[] = [];
      await observeModelRequest(
        scope as ModelActivity['scope'],
        async () => {
          observeModelResponseHeaders(new Headers({ 'x-request-id': `gw-parallel-${index}` }));
          await Promise.resolve();
          if (index === 0)
            await observeModelRequest(
              'summary',
              async () => {
                observeModelResponseHeaders(new Headers({ 'x-request-id': 'gw-nested' }));
                observeModelChunk({ content: 'PRIVATE_NESTED' });
              },
              async (event) => {
                modelEvents.push(event);
              },
            );
          observeModelChunk({ tool_call_chunks: [{ args: '{}' }] });
        },
        async (event) => {
          events.push(event);
        },
      );
      return events[1];
    }),
  );
  for (const [index, event] of model.entries()) {
    assert.equal(event.gatewayRequestId, `gw-parallel-${index}`);
    measured(event);
  }
  assert.equal(modelEvents[1].gatewayRequestId, 'gw-nested');
  measured(modelEvents[1]);
});

test('真实 Agent 主/子图无需 agent.ts 回调均记录首块，摘要复用模型入口', async (t) => {
  const model = await gateway(t, (response, index) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': `gw-graph-${index}`,
    });
    chunk(response, { role: 'assistant', content: '' });
    if (index === 1)
      chunk(response, {
        tool_calls: [
          {
            index: 0,
            id: 'delegate-design',
            type: 'function',
            function: {
              name: 'delegate_agent',
              arguments: JSON.stringify({
                role: 'design',
                task: '只读分析',
                writePaths: [],
                nodeId: null,
              }),
            },
          },
        ],
      });
    else chunk(response, { content: index === 2 ? '只读分析完成' : '任务已完成' });
    end(response);
  });
  const events: ModelActivity[] = [];
  const forbidden = async (): Promise<never> => {
    throw new Error('UNEXPECTED_TOOL');
  };
  await runAgent({
    model,
    messages: [new HumanMessage('委派设计分析后回答')],
    instructions: '离线诊断测试',
    tools: {
      list: forbidden,
      read: forbidden,
      write: forbidden,
      remove: forbidden,
      figma: forbidden,
      rules: forbidden,
      slices: forbidden,
    },
    maxTurns: 8,
    contextBudgetTokens: 100000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async () => {},
    onModelActivity: async (event) => {
      events.push(event);
    },
  });
  await observeModelRequest(
    'summary',
    () => model.invoke('摘要'),
    async (event) => {
      events.push(event);
    },
  );
  const ended = events.filter((event) => event.status !== 'started');
  assert.deepEqual(
    ended.map((event) => event.scope),
    ['generation', 'design', 'generation', 'summary'],
  );
  for (const [index, event] of ended.entries()) {
    assert.equal(event.gatewayRequestId, `gw-graph-${index + 1}`);
    measured(event);
  }
});

test('正式持久化→诊断→UI保留失败/取消阶段，旧数据未知，用量计数不变', async () => {
  const f = await messageFixture();
  const queued = await f.messages.enqueue('employee-a', f.id, {
    clientRequestId: randomUUID(),
    content: '离线计时诊断',
  });
  const leases = createRunLeases(f.mysql, { leaseMs: 60000, now: async () => Date.now() });
  const lease = await leases.claim(queued.runId, 'timing-worker');
  assert.ok(lease);
  const persistence = createRunPersistence(f.mysql, leases, lease, {
    limits: f.runtime.d2c.limits,
    notify: () => {},
    redact: (value) => value,
  });
  await persistence.load();
  const controller = new AbortController();
  await assert.rejects(
    observeModelRequest(
      'summary',
      async () => {
        observeModelResponseHeaders(new Headers({ 'x-request-id': 'gw-persisted' }));
        observeModelChunk({ content: 'PRIVATE_OUTPUT' });
        Object.assign(f.tables.D2cRun[0], { status: 'stopping', stopRequested: true });
        controller.abort();
        throw new Error('PRIVATE_ERROR');
      },
      (event) => persistence.recordModelActivity(event),
      controller.signal,
    ),
  );
  const old = randomUUID();
  await persistence.recordModelActivity({
    operationId: old,
    scope: 'generation',
    status: 'started',
  });
  await persistence.recordModelActivity({
    operationId: old,
    scope: 'generation',
    status: 'completed',
    durationMs: 2500,
  });
  const snapshot = await readRunDiagnostics(f.mysql, 'employee-a', f.id, queued.runId);
  const [interrupted, legacy] = snapshot.steps;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.gatewayRequestId, 'gw-persisted');
  assert.equal(typeof interrupted.firstChunkMs, 'number');
  assert.equal(typeof interrupted.afterFirstChunkMs, 'number');
  assert.equal(legacy.gatewayRequestId, null);
  assert.equal(legacy.firstChunkMs, null);
  assert.equal(legacy.afterFirstChunkMs, null);
  assert.equal(snapshot.usage.requests, 2);
  assert.equal(snapshot.usage.interruptedRequests, 1);
  assert.equal(snapshot.usage.completedRequests, 1);
  assert.equal(snapshot.usage.totalTokens, null);
  const html = renderToStaticMarkup(
    React.createElement(DiagnosticsContent, {
      snapshot: { ...snapshot, failure: null },
      now: Date.parse(snapshot.observedAt),
    }),
  );
  assert.match(html, /gw-persisted/);
  assert.match(html, /请求开始→首块/);
  assert.match(html, /首块→结束/);
  assert.match(html, /总耗时/);
  assert.match(html, /耗时未知/);
  assert.match(html, /不能从首块耗时直接推断排队时间/);
  assert.doesNotMatch(JSON.stringify(snapshot) + html, /PRIVATE|headers|sdkItem/);
});
