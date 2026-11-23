import './helpers/projectFixture';
import { APIConnectionTimeoutError } from 'openai';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { createSubagentProgress } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import type { ModelActivity } from '../src/functions/d2c/run/agent/modelActivity';
import { RunExecutionError, SubagentExecutionError } from '../src/functions/d2c/run/errors';
import type { SubagentEvent } from '../src/functions/d2c/run/subagent';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const reportPath = 'pages/page/rule-hits.json';

/** 构造第185条缺失 context 的有效 JSON，完整版本只补齐该字段。 */
function report(complete: boolean) {
  return JSON.stringify({
    block: 'page',
    cache_key: 'boundary-design',
    generated_at: '2026-11-12T00:00:00Z',
    generated_by: 'rule-scan-subagent',
    hits: Array.from({ length: 186 }, (_, index) => ({
      rule: 'R01',
      nodeId: `1:${index}`,
      trigger: '真实触发',
      expected: '固定定位',
      ...(index !== 185 || complete ? { context: {} } : {}),
    })),
  });
}

/** 所有委派、写入与等待仍由正式图和工具 schema 执行。 */
function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id }] });
}

/** 真实父子图配离线模型和 MemorySaver，保存完整报告及实际模型事件。 */
async function fixture(t: test.TestContext, repair: boolean, timeoutOnce = false) {
  let injected = false;
  const controller = new AbortController();
  t.after(() => controller.abort(new Error('TEST_CLEANUP')));
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'failure-boundary',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  });
  const progress = await createSubagentProgress(checkpoint, {
    continuation: false,
    identity: 'boundary-config',
    messageId: 'boundary-job',
  });
  const files = new Map<string, string>();
  const writes: string[] = [];
  const receipts: ToolMessage[] = [];
  const events: SubagentEvent[] = [];
  const activities: ModelActivity[] = [];
  let parentCalls = 0,
    childCalls = 0;
  let agentId: string | undefined;
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async (path) => JSON.stringify({ content: files.get(path), nextOffset: null }),
    write: async (path, content) => {
      files.set(path, content);
      writes.push(path);
      return 'saved';
    },
    remove: async () => assert.fail('unexpected remove'),
    figma: async () => assert.fail('unexpected Figma/network'),
    rules: async () => assert.fail('rule_scan cannot invoke check_rules'),
    slices: async () => assert.fail('unexpected slicing/network'),
  };
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    let message: AIMessage;
    const parent = messages.some(
      (entry) => entry.type === 'system' && entry.text.includes('FAILURE_BOUNDARY_ROOT'),
    );
    if (parent) {
      parentCalls++;
      if (parentCalls === 1)
        message = call(
          'delegate_agent',
          {
            role: 'rule_scan',
            nodeId: '1:2',
            writePaths: [reportPath],
            task: '扫描并保存规则报告',
          },
          'delegate-boundary',
        );
      else if (parentCalls === 2) {
        const ack = JSON.parse(messages.filter(ToolMessage.isInstance).at(-1)!.text);
        assert.equal(ack.accepted, true);
        assert.equal(typeof ack.agentId, 'string');
        agentId = ack.agentId;
        message = call('wait_subagents', { agentIds: [agentId], wait: true }, 'wait-boundary');
      } else {
        assert.equal(parentCalls, 3);
        const receipt = messages.filter(ToolMessage.isInstance).at(-1)!;
        assert.equal(receipt.name, 'wait_subagents');
        const { agents } = JSON.parse(receipt.text);
        assert.equal(agents.length, 1);
        assert.equal(agents[0].agentId, agentId);
        assert.equal(agents[0].status, 'completed');
        message = new AIMessage(agents[0].result);
      }
    } else {
      if (timeoutOnce && childCalls === 1 && !injected) {
        injected = true;
        throw new APIConnectionTimeoutError();
      }
      childCalls++;
      if (childCalls === 1)
        message = call(
          'write_file',
          {
            path: reportPath,
            content: report(false),
            complete: true,
          },
          'save-missing-context',
        );
      else if (childCalls === 3 && repair) {
        assert.ok(messages.some((entry) => entry.text.includes('平台交付核对')));
        assert.ok(messages.some((entry) => entry.text.includes('hits[185].context')));
        message = call(
          'write_file',
          { path: reportPath, content: report(true), complete: true },
          'save-fixed-context',
        );
      } else message = new AIMessage('已保存报告');
    }
    message.usage_metadata = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
    return { generations: [{ text: message.text, message }] };
  };
  return {
    checkpoint,
    progress,
    tools,
    files,
    writes,
    receipts,
    activities,
    events,
    get parentCalls() {
      return parentCalls;
    },
    get childCalls() {
      return childCalls;
    },
    get agentId() {
      return agentId;
    },
    run: () =>
      runAgent({
        model,
        tools,
        checkpoint,
        subagentProgress: progress,
        instructions: 'FAILURE_BOUNDARY_ROOT',
        messages: [new HumanMessage({ content: '扫描报告交付', id: 'boundary-input' })],
        maxTurns: 64,
        contextBudgetTokens: 1000000,
        signal: controller.signal,
        assertLease: async () => {},
        recordSubagent: async (event) => {
          events.push(event);
        },
        onModelActivity: async (activity) => {
          activities.push(activity);
        },
        onMessage: async (message) => {
          if (ToolMessage.isInstance(message) && message.name === 'wait_subagents')
            receipts.push(message);
        },
      }),
  };
}

/** 验证全是模型完成事件，执行收尾失败不能伪造模型调用失败。 */
function assertModelsCompleted(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.activities.filter((event) => event.status === 'failed').length, 0);
  const started = f.activities.filter((event) => event.status === 'started');
  const completed = f.activities.filter((event) => event.status === 'completed');
  assert.equal(completed.length, f.parentCalls + f.childCalls);
  assert.deepEqual(
    completed.map((event) => event.operationId).sort(),
    started.map((event) => event.operationId).sort(),
  );
}

/** 框架可包裹异常，但平台边界及原始 cause 身份必须保留。 */
function boundaryError(
  error: unknown,
  cause: Error,
  phase: 'settle' | 'observe',
  agentId?: string,
) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof SubagentExecutionError) {
      assert.equal(current.context.phase, phase);
      assert.equal(current.context.role, 'rule_scan');
      assert.equal(current.context.agentId, agentId);
      assert.equal(current.cause, cause);
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  assert.fail('missing SubagentExecutionError in actual graph rejection');
}

test(
  'hits[185].context 缺失经真实子图补交停止后返回 INCOMPLETE_DELIVERY，父 wait 不 fatal',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, false);
    const result = await f.run();
    const incomplete = JSON.parse(result.output);
    assert.equal(incomplete.success, false);
    assert.equal(incomplete.reason, 'INCOMPLETE_DELIVERY');
    assert.equal(incomplete.agentId, f.agentId);
    assert.deepEqual(incomplete.files, [reportPath]);
    assert.deepEqual(incomplete.missingFiles, []);
    assert.ok(
      incomplete.delivery.problems.some((problem: string) => problem.includes('hits[185].context')),
    );
    assert.equal(incomplete.delivery.recovery.stopped, true);
    assert.ok(incomplete.handoff.contextPath);
    assert.equal(f.parentCalls, 3);
    assert.equal(f.childCalls, 3);
    assert.deepEqual(f.writes, [reportPath]);
    assert.equal(f.files.get(reportPath), report(false));
    assert.equal(f.receipts.length, 1);
    assert.equal(JSON.parse(f.receipts[0].text).agents[0].result, result.output);
    assert.deepEqual(await f.progress.background(), []);
    assertModelsCompleted(f);
  },
);

test('缺 context 报告沿原子图补齐后正常结算成功，保留原任务身份', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true);
  const result = await f.run();
  assert.equal(JSON.parse(result.output).success, true);
  assert.equal(f.parentCalls, 3);
  assert.equal(f.childCalls, 4);
  assert.deepEqual(f.writes, [reportPath, reportPath]);
  assert.equal(f.files.get(reportPath), report(true));
  assert.equal(new Set(f.events.map((event) => event.agentId)).size, 1);
  assert.equal(f.receipts.length, 1);
  assert.deepEqual(await f.progress.background(), []);
  assertModelsCompleted(f);
});

for (const phase of ['settle', 'observe'] as const) {
  test(
    `完整报告补齐后 ${phase} 持久化故障保留 SubagentExecutionError 的 phase 和 cause`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, true);
      const original = new Error(`TEST_${phase.toUpperCase()}_PERSISTENCE_FAILURE`);
      const put = f.checkpoint.put.bind(f.checkpoint);
      let failures = 0;
      t.mock.method(f.checkpoint, 'put', async (...args: Parameters<typeof f.checkpoint.put>) => {
        const progress = args[1].channel_values.progress as
          | {
              background?: { status: string; observed: boolean; result?: string };
            }
          | undefined;
        const background = progress?.background;
        if (background?.status === 'settled' && background.observed === (phase === 'observe')) {
          failures++;
          assert.equal(f.files.get(reportPath), report(true));
          assert.equal(JSON.parse(background.result!).success, true);
          if (phase === 'observe') {
            const root = await f.checkpoint.getTuple(f.checkpoint.config());
            const messages = root?.checkpoint.channel_values.messages as BaseMessage[];
            assert.equal(
              messages
                .filter(ToolMessage.isInstance)
                .filter((message) => message.name === 'wait_subagents').length,
              1,
            );
          }
          throw original;
        }
        return put(...args);
      });
      await assert.rejects(f.run(), (error: unknown) =>
        boundaryError(error, original, phase, f.agentId),
      );
      assert.equal(failures, 1);
      assert.equal(f.parentCalls, 2);
      assert.equal(f.childCalls, 4);
      assert.deepEqual(f.writes, [reportPath, reportPath]);
      assert.equal(f.files.get(reportPath), report(true));
      assert.equal(f.events.filter((event) => event.status === 'completed').length, 1);
      assert.equal(f.receipts.length, phase === 'observe' ? 1 : 0);
      const background = await f.progress.background();
      assert.equal(background.length, 1);
      assert.equal(background[0].status, phase === 'observe' ? 'settled' : 'pending');
      assertModelsCompleted(f);
    },
  );
}

/** 局部错误标记即使出现在 fatal 的 cause 或更外层，也不能掩盖可信存储故障。 */
for (const shape of ['error-cause', 'string-cause', 'outer-local-marker'] as const) {
  test(
    `child typed fatal 含非法工具参数标记不降级局部 handoff：${shape}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, true);
      const localCause =
        shape === 'string-cause'
          ? 'DEEP_MODEL_TOOL_ARGUMENTS_INVALID'
          : new Error('DEEP_MODEL_TOOL_ARGUMENTS_INVALID');
      const fatal = new RunExecutionError(
        'STORAGE_FAILED',
        { stage: 'storage', tool: 'write_file' },
        localCause,
      );
      const thrown =
        shape === 'outer-local-marker'
          ? new Error('DEEP_MODEL_TOOL_ARGUMENTS_INVALID', { cause: fatal })
          : fatal;
      const write = f.tools.write;
      let injections = 0;
      f.tools.write = async (path, content) => {
        if (content === report(true)) {
          injections++;
          throw thrown;
        }
        return write(path, content);
      };
      await assert.rejects(f.run(), (error: unknown) => {
        let current = error;
        const seen = new Set<unknown>();
        let boundaryFound = false,
          fatalFound = false;
        while (current && typeof current === 'object' && !seen.has(current)) {
          seen.add(current);
          if (current instanceof SubagentExecutionError) {
            boundaryFound = true;
            assert.equal(current.context.phase, 'execute');
            assert.equal(current.context.role, 'rule_scan');
            assert.equal(current.context.agentId, f.agentId);
          }
          if (current === fatal) {
            fatalFound = true;
            assert.equal(fatal.code, 'STORAGE_FAILED');
            assert.equal(fatal.cause, localCause);
          }
          current = 'cause' in current ? current.cause : undefined;
        }
        assert.equal(boundaryFound, true);
        assert.equal(
          fatalFound,
          true,
          'typed fatal 身份和原始 cause 必须保留，不得变成局部失败回执',
        );
        return true;
      });
      assert.equal(injections, 1);
      assert.equal(f.parentCalls, 2);
      assert.equal(f.childCalls, 3);
      assert.deepEqual(f.writes, [reportPath]);
      assert.equal(f.files.get(reportPath), report(false));
      assert.equal(f.receipts.length, 0);
      assert.equal(f.events.filter((event) => event.status === 'completed').length, 0);
      const failed = f.events.find((event) => event.status === 'failed');
      assert.equal(failed?.diagnosticFailure?.code, 'STORAGE_FAILED');
      assert.equal(failed?.failureDetails?.subagentPhase, 'execute');
      assert.ok(failed?.failureDetails?.errorType);
      assert.ok(!JSON.stringify(failed?.failureDetails).includes('TEST_'));
      const background = await f.progress.background();
      assert.equal(background.length, 1);
      assert.equal(background[0].status, 'pending');
      assert.equal(background[0].result, undefined);
      assertModelsCompleted(f);
    },
  );
}

test('后台子图超时后原身份续作，已保存工具不因重试重复执行', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true, true);
  const result = await f.run();
  assert.equal(JSON.parse(result.output).success, true);
  assert.deepEqual(f.writes, [reportPath, reportPath]);
  assert.equal(f.events.filter((e) => e.status === 'started').length, 1);
  assert.equal(f.events.filter((e) => e.status === 'completed').length, 1);
  assert.ok(f.events.every((e) => e.agentId === f.agentId));
  assert.equal(f.activities.filter((e) => e.status === 'failed').length, 1);
  assert.ok(f.activities.some((e) => e.status === 'failed' && e.retryAttempt === 1));
  assert.deepEqual(await f.progress.background(), []);
});
