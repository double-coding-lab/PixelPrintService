import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { createSubagentProgress } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import {
  diagnoseRunFailure,
  RunExecutionError,
  runFailureSchema,
  StorageOperationError,
  SubagentExecutionError,
} from '../src/functions/d2c/run/errors';
import { subagentLimits, type SubagentEvent } from '../src/functions/d2c/run/subagent';
import type { GenerationTools } from '../src/functions/d2c/run/types';
import { describeEvent, getEventFailure } from '../web/src/workspace/timeline';
import type { TimelineEntry } from '../web/src/workspace/types';

const limits = [
  ['DEEP_SUBAGENT_MAX_TURNS', 'SUBAGENT_REQUEST_LIMIT'],
  ['DEEP_SUBAGENT_OUTPUT_LIMIT', 'SUBAGENT_OUTPUT_LIMIT'],
] as const;
const reportPath = 'pages/page/rule-hits.json';
const report = JSON.stringify({
  block: 'page',
  cache_key: 'offline-design',
  generated_at: '2026-11-10T00:00:00Z',
  generated_by: 'rule-scan-subagent',
  hits: [],
});

for (const [frameworkCode, code] of limits) {
  test(`${frameworkCode}穿透可信包装，公开说明固定并区分整轮预算`, () => {
    const raw = new Error(frameworkCode);
    const wrapped = new RunExecutionError(
      'SUBAGENT_FAILED',
      { stage: 'tool', tool: 'delegate_agent' },
      new SubagentExecutionError({ agentId: randomUUID(), role: 'ui', phase: 'execute' }, raw),
    );
    for (const error of [
      raw,
      wrapped,
      Object.assign(new Error('PRIVATE_BODY'), { code: frameworkCode }),
    ]) {
      const result = diagnoseRunFailure(error);
      assert.equal(result.failure.code, code);
      assert.equal(result.diagnostics.frameworkCode, frameworkCode);
      assert.match(result.failure.message, /局部.*上限.*局部交付未完成/);
      assert.match(result.failure.suggestion, /已保存产物保留.*主 Agent 可沿原上下文接续/);
      assert.match(result.failure.suggestion, /整轮共享请求预算.*maxTurns/);
      assert.deepEqual(
        runFailureSchema.parse({
          ...result.failure,
          message: 'PRIVATE_MESSAGE',
          suggestion: 'PRIVATE_SUGGESTION',
          frameworkCode,
        }),
        result.failure,
      );
      assert.doesNotMatch(JSON.stringify(result.failure), /PRIVATE|DEEP_/);
    }
    assert.equal(
      diagnoseRunFailure(wrapped).failure.errorId,
      diagnoseRunFailure(raw).failure.errorId,
    );
  });
}

test('局部限额只接受有界Error链上的精确常量，未知和整轮限额保持原分类', () => {
  for (const [frameworkCode] of limits) {
    for (const error of [
      new Error(`prefix ${frameworkCode}`),
      new Error(`${frameworkCode}\n`),
      new Error(`${frameworkCode}_EXTRA`),
      new Error('PRIVATE_BODY', { cause: frameworkCode }),
      { message: frameworkCode },
      { code: frameworkCode },
      { cause: new Error(frameworkCode) },
      new Error('PRIVATE_BODY', { cause: { message: frameworkCode } }),
    ])
      assert.equal(diagnoseRunFailure(error, 'SUBAGENT_FAILED').failure.code, 'SUBAGENT_FAILED');
    let deep = new Error(frameworkCode);
    for (let depth = 0; depth < 8; depth++) deep = new Error('PRIVATE_BODY', { cause: deep });
    assert.equal(diagnoseRunFailure(deep).failure.code, 'EXECUTION_FAILED');
  }
  const shared = diagnoseRunFailure(
    new RunExecutionError('MODEL_REQUEST_LIMIT', { stage: 'model' }, new Error('DEEP_MAX_TURNS')),
  );
  assert.equal(shared.failure.code, 'MODEL_REQUEST_LIMIT');
  assert.equal(diagnoseRunFailure(new Error('DEEP_MAX_TURNS')).failure.code, 'EXECUTION_FAILED');
});

test('局部限额标记不能覆盖真实存储、停止、失租、共享预算或模型故障', () => {
  for (const code of [
    'STORAGE_FAILED',
    'LEASE_LOST',
    'WORKER_INTERRUPTED',
    'RUN_TIMEOUT',
    'MODEL_REQUEST_LIMIT',
    'MODEL_REQUEST_FAILED',
    'MODEL_RATE_LIMITED',
    'MODEL_OUTPUT_LIMIT',
    'MODEL_AUTH_FAILED',
    'NETWORK_TIMEOUT',
  ] as const) {
    const typed = new RunExecutionError(
      code,
      { stage: 'model' },
      new Error('DEEP_SUBAGENT_MAX_TURNS'),
    );
    for (const error of [
      new RunExecutionError('SUBAGENT_FAILED', { stage: 'tool' }, typed),
      new Error('DEEP_SUBAGENT_OUTPUT_LIMIT', { cause: typed }),
      new RunExecutionError('SUBAGENT_REQUEST_LIMIT', { stage: 'tool' }, typed),
    ])
      assert.equal(diagnoseRunFailure(error).failure.code, code);
  }
  const storage = diagnoseRunFailure(
    new StorageOperationError('write_text', 'page.tsx', 8, new Error('DEEP_SUBAGENT_MAX_TURNS')),
    'SUBAGENT_FAILED',
    { stage: 'tool' },
  );
  assert.equal(storage.failure.code, 'STORAGE_FAILED');
});

/** 所有调用经过正式工具schema；不访问数据库、网络或部署配置。 */
function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

/** 仅复用本次回归需要的离线父子图、部分报告与内存检查点。 */
async function graphFixture(t: test.TestContext, mode: 'requests' | 'output') {
  const controller = new AbortController();
  t.after(() => controller.abort(new Error('TEST_CLEANUP')));
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'local-limit-session',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  });
  const subagentProgress = await createSubagentProgress(checkpoint, {
    continuation: false,
    identity: 'local-limit-config',
    messageId: 'local-limit-job',
  });
  const files = new Map<string, string>([['rules.md', '离线测试规则']]);
  const writes: string[] = [];
  const events: SubagentEvent[] = [];
  let childCalls = 0,
    parentCalls = 0;
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async (path) => JSON.stringify({ content: files.get(path), nextOffset: null }),
    write: async (path, content) => {
      files.set(path, content);
      writes.push(path);
      return 'saved';
    },
    remove: async () => assert.fail('unexpected remove'),
    figma: async () => assert.fail('unexpected network'),
    rules: async () => assert.fail('unexpected rule check'),
    slices: async () => assert.fail('unexpected slicing'),
  };
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages: BaseMessage[]) => {
    let message: AIMessage;
    if (messages[0].text.includes('LOCAL_LIMIT_ROOT')) {
      parentCalls++;
      const result = messages.filter(ToolMessage.isInstance).at(-1);
      if (!result)
        message = call(
          'delegate_agent',
          mode === 'requests'
            ? { role: 'rule_scan', nodeId: '1:2', task: '扫描并保存报告', writePaths: [reportPath] }
            : { role: 'review', task: '读取已有规则并分析' },
          'delegate',
        );
      else if (result.name === 'delegate_agent') {
        const ack = JSON.parse(result.text);
        assert.equal(ack.accepted, true);
        message = call('wait_subagents', { agentIds: [ack.agentId], wait: true }, 'wait');
      } else {
        assert.equal(result.name, 'wait_subagents');
        const { agents } = JSON.parse(result.text);
        assert.equal(agents.length, 1);
        assert.equal(agents[0].status, 'completed');
        message = new AIMessage(agents[0].result);
      }
    } else {
      childCalls++;
      message =
        mode === 'output'
          ? new AIMessage('x'.repeat(subagentLimits.outputBytes + 1))
          : childCalls === 1
            ? call('write_file', { path: reportPath, content: report, complete: false }, 'partial')
            : call(
                'read_file',
                { path: 'rules.md', resource: false, offset: 0, length: null },
                `read-${childCalls}`,
              );
    }
    return { generations: [{ text: message.text, message }] };
  };
  const result = await runAgent({
    model,
    tools,
    checkpoint,
    subagentProgress,
    messages: [new HumanMessage({ content: '开始', id: 'local-limit-input' })],
    instructions: 'LOCAL_LIMIT_ROOT',
    maxTurns: 64,
    contextBudgetTokens: 1000000,
    assertLease: async () => {},
    signal: controller.signal,
    recordSubagent: async (event) => {
      events.push(event);
    },
  });
  return { result: JSON.parse(result.output), files, writes, events, childCalls, parentCalls };
}

for (const mode of ['requests', 'output'] as const) {
  test(
    `真实graph局部${mode}限额仅发布一次failed并保留真实delivery`,
    { timeout: 30000 },
    async (t) => {
      const f = await graphFixture(t, mode);
      const [frameworkCode, code] = limits[mode === 'requests' ? 0 : 1];
      const saved = mode === 'requests' ? [reportPath] : [];
      assert.equal(subagentLimits.executionTurns, 40);
      assert.equal(f.childCalls, mode === 'requests' ? 40 : 1);
      assert.equal(f.parentCalls, 3);
      assert.equal(f.result.success, false);
      assert.equal(f.result.reason, frameworkCode);
      assert.deepEqual(f.result.files, saved);
      assert.deepEqual(f.writes, saved);
      assert.equal(f.files.get(reportPath), mode === 'requests' ? report : undefined);
      assert.equal(f.files.get('rules.md'), '离线测试规则');
      const failed = f.events.filter((event) => event.status === 'failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0].diagnosticFailure?.code, code);
      assert.equal(failed[0].failureDetails?.frameworkCode, frameworkCode);
      assert.equal(failed[0].delivery?.success, false);
      assert.equal(failed[0].delivery?.reason, frameworkCode);
      assert.deepEqual(failed[0].delivery?.files, saved);
      assert.match(failed[0].diagnosticFailure!.suggestion, /主 Agent 可沿原上下文接续/);
      assert.equal(f.events.filter((event) => event.status === 'completed').length, 0);
      assert.equal(new Set(f.events.map((event) => event.agentId)).size, 1);
    },
  );
}

/** 以恶意历史字段验证真实时间线投影，不挂载应用或请求接口。 */
function entry(data: Record<string, unknown>, kind = 'stage'): TimelineEntry {
  return {
    entryId: 'event-1',
    sessionId: 'session-a',
    runId: 'run-a',
    seq: 1,
    at: '2026-11-10T00:00:00Z',
    kind,
    data,
  } as TimelineEntry;
}

for (const [, code] of limits) {
  test(`UI ${code}固定显示局部未完成、产物保留和原上下文接续`, () => {
    const agentId = randomUUID();
    const failure = runFailureSchema.parse({
      errorId: agentId,
      code,
      stage: 'tool',
      tool: 'delegate_agent',
    });
    const unsafe = { ...failure, message: 'PRIVATE_MESSAGE', suggestion: 'PRIVATE_SUGGESTION' };
    const projected = getEventFailure(entry({ status: 'failed', failure: unsafe }, 'run_status'))!;
    assert.equal(projected.message, failure.message);
    assert.equal(projected.suggestion, failure.suggestion);
    const text = describeEvent(
      entry({
        stage: 'subagent',
        role: 'ui',
        agentId,
        status: 'failed',
        diagnosticFailure: unsafe,
        delivery: { success: false, reason: 'PRIVATE_REASON' },
      }),
    );
    assert.match(text, /局部交付未完成.*已保存产物保留.*主 Agent 可沿原上下文接续/);
    assert.doesNotMatch(text, /PRIVATE/);
  });
}
