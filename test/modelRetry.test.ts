import './helpers/projectFixture';
import { APIConnectionTimeoutError, APIConnectionError, APIUserAbortError } from 'openai';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canRetryModelRequest, modelRetryPlan } from '../src/functions/d2c/run/agent/modelRetry';
import { RunExecutionError } from '../src/functions/d2c/run/errors';

/** 模型故障恢复不能吞掉真正的停止、数据故障或权限错误。 */
test('temporary model errors are retryable but typed fatal causes and authorization remain terminal', () => {
  assert.equal(canRetryModelRequest({ status: 503 }), true);
  assert.equal(canRetryModelRequest(new Error('wrapped', { cause: { code: 'ECONNRESET' } })), true);
  for (const code of [
    'STORAGE_FAILED',
    'LEASE_LOST',
    'RUN_TIMEOUT',
    'WORKER_INTERRUPTED',
  ] as const) {
    assert.equal(
      canRetryModelRequest(
        Object.assign(
          new Error('wrapped', { cause: new RunExecutionError(code, { stage: 'worker' }) }),
          { status: 503 },
        ),
      ),
      false,
    );
  }
  for (const status of [400, 401, 403]) assert.equal(canRetryModelRequest({ status }), false);
  assert.equal(canRetryModelRequest(new Error('unknown failure')), false);
});

test('429退避遵守秒数、HTTP日期和SDK等待头，次数耗尽及长等待不盲重试', () => {
  const now = Date.parse('2026-11-10T09:00:00Z');
  assert.deepEqual(modelRetryPlan({ status: 429 }, 0, now), {
    delayMs: 5000,
    attempt: 1,
    rateLimited: true,
  });
  assert.equal(modelRetryPlan({ status: 429 }, 1, now)!.delayMs, 15000);
  assert.equal(modelRetryPlan({ status: 429 }, 2, now), undefined);
  assert.equal(
    modelRetryPlan({ status: 429, headers: new Headers({ 'retry-after': '2.5' }) }, 0, now)!
      .delayMs,
    2500,
  );
  assert.equal(
    modelRetryPlan(
      new Error('wrapped', {
        cause: { status: 429, headers: { 'Retry-After': 'Tue, 10 Nov 2026 09:00:30 GMT' } },
      }),
      0,
      now,
    )!.delayMs,
    30000,
  );
  assert.equal(
    modelRetryPlan({ status: 429, headers: { 'retry-after-ms': '250' } }, 0, now)!.delayMs,
    250,
  );
  assert.equal(
    modelRetryPlan({ status: 429, headers: { 'retry-after': '120' } }, 0, now),
    undefined,
  );
  assert.equal(
    modelRetryPlan({ status: 429, headers: { 'retry-after': 'invalid' } }, 0, now)!.delayMs,
    5000,
  );
  assert.equal(
    modelRetryPlan({ status: 429, headers: { 'retry-after': '-1' } }, 0, now)!.delayMs,
    5000,
  );
  assert.equal(
    modelRetryPlan(
      new Error('wrapped', {
        cause: new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }),
      }),
      0,
    ),
    undefined,
  );
});

test('真实模型循环429等待后恢复，不重放已经完成的工具并记录每次请求', async (t) => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const model = new FakeToolCallingModel();
  t.mock.method(model, 'bindTools', () => model);
  let calls = 0,
    lists = 0;
  t.mock.method(model, '_generate', async () => {
    calls++;
    if (calls === 1)
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [{ id: 'list-once', name: 'list_files', args: {} }],
            }),
          },
        ],
      };
    if (calls === 2)
      throw Object.assign(new Error('rate limit'), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  });
  const forbidden = async (): Promise<never> => {
    throw new Error('unexpected tool');
  };
  const events: Array<{ status: string; retryAfterMs?: number; retryAttempt?: number }> = [];
  const result = await runAgent({
    model,
    messages: [new HumanMessage('执行任务')],
    instructions: '先列文件后回复',
    tools: {
      list: async () => {
        lists++;
        return [];
      },
      read: forbidden,
      write: forbidden,
      remove: forbidden,
      figma: forbidden,
      rules: forbidden,
      slices: forbidden,
    },
    contextBudgetTokens: 100000,
    maxTurns: 5,
    signal: new AbortController().signal,
    assertLease: async () => {},
    onModelActivity: async (event) => {
      events.push(event);
    },
  });
  assert.equal(result.output, 'done');
  assert.equal(calls, 3);
  assert.equal(lists, 1);
  assert.ok(
    events.some((e) => e.status === 'failed' && e.retryAfterMs === 0 && e.retryAttempt === 1),
  );
  assert.equal(events.filter((e) => e.status === 'started').length, 3);
});

test('持续429最多三次实际请求，停止信号能取消退避且不再请求模型', async (t) => {
  const { FakeToolCallingModel } = await import('langchain');
  const { HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  for (const [stop, maxTurns] of [
    [false, 10],
    [false, 1],
    [true, 10],
  ] as const) {
    const model = new FakeToolCallingModel();
    t.mock.method(model, 'bindTools', () => model);
    let calls = 0;
    const controller = new AbortController();
    t.mock.method(model, '_generate', async () => {
      calls++;
      throw Object.assign(new Error('rate limit'), {
        status: 429,
        headers: { 'retry-after': stop ? '1' : '0' },
      });
    });
    const forbidden = async (): Promise<never> => {
      throw new Error('unexpected tool');
    };
    await assert.rejects(
      runAgent({
        model,
        messages: [new HumanMessage('开始')],
        instructions: '测试',
        tools: {
          list: forbidden,
          read: forbidden,
          write: forbidden,
          remove: forbidden,
          figma: forbidden,
          rules: forbidden,
          slices: forbidden,
        },
        contextBudgetTokens: 100000,
        maxTurns,
        signal: controller.signal,
        assertLease: async () => {},
        onModelActivity: async (event) => {
          if (stop && event.retryAfterMs !== undefined)
            setTimeout(() => controller.abort(new Error('USER_STOPPED')), 20);
        },
      }),
    );
    assert.equal(calls, stop || maxTurns === 1 ? 1 : 3);
  }
});

test('真实SDK超时沿原模型循环重试，不重复已完成工具', async (t) => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const model = new FakeToolCallingModel();
  t.mock.method(model, 'bindTools', () => model);
  let calls = 0,
    lists = 0;
  t.mock.method(model, '_generate', async () => {
    calls++;
    if (calls === 1)
      return {
        generations: [
          {
            text: '',
            message: new AIMessage({
              content: '',
              tool_calls: [{ id: 'list-once', name: 'list_files', args: {} }],
            }),
          },
        ],
      };
    if (calls === 2)
      throw new RunExecutionError(
        'MODEL_REQUEST_FAILED',
        { stage: 'model' },
        new APIConnectionTimeoutError(),
      );
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  });
  const forbidden = async (): Promise<never> => {
    throw new Error('unexpected tool');
  };
  const events: Array<{ status: string; retryAfterMs?: number; retryAttempt?: number }> = [];
  const result = await runAgent({
    model,
    messages: [new HumanMessage('执行任务')],
    instructions: '先列文件后回复',
    tools: {
      list: async () => {
        lists++;
        return [];
      },
      read: forbidden,
      write: forbidden,
      remove: forbidden,
      figma: forbidden,
      rules: forbidden,
      slices: forbidden,
    },
    contextBudgetTokens: 100000,
    maxTurns: 5,
    signal: new AbortController().signal,
    assertLease: async () => {},
    onModelActivity: async (event) => {
      events.push(event);
    },
  });
  assert.equal(result.output, 'done');
  assert.equal(calls, 3);
  assert.equal(lists, 1);
  assert.ok(
    events.some((e) => e.status === 'failed' && e.retryAfterMs === 250 && e.retryAttempt === 1),
  );
  assert.equal(events.filter((e) => e.status === 'started').length, 3);
});

test('SDK异常类型识别、包装与致命原因优先，未知错误不重试', () => {
  for (const error of [new APIConnectionTimeoutError(), new APIConnectionError({})]) {
    assert.ok(modelRetryPlan(error, 0));
    assert.ok(modelRetryPlan(error, 1));
    assert.equal(modelRetryPlan(error, 2), undefined);
    assert.ok(
      modelRetryPlan(new RunExecutionError('MODEL_REQUEST_FAILED', { stage: 'model' }, error), 0),
    );
  }
  assert.equal(modelRetryPlan(new APIUserAbortError(), 0), undefined);
  assert.equal(modelRetryPlan({ name: 'APIConnectionTimeoutError' }, 0), undefined);
  assert.equal(
    modelRetryPlan(new RunExecutionError('MODEL_REQUEST_FAILED', { stage: 'model' }), 0),
    undefined,
  );
  assert.equal(
    modelRetryPlan(
      new APIConnectionError({
        cause: new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }),
      }),
      0,
    ),
    undefined,
  );
  assert.equal(
    modelRetryPlan(
      new APIConnectionError({ cause: Object.assign(new Error('authorization'), { status: 401 }) }),
      0,
    ),
    undefined,
  );
});
