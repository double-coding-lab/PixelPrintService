import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { runAgent, type AgentRunInput } from '../src/functions/d2c/run/agent/agent';
import {
  createSubagentProgress,
  SubagentResumeError,
} from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { readToolFeedback } from '../src/functions/d2c/run/toolFeedback';
import type { GenerationTools } from '../src/functions/d2c/run/types';
import { SubagentExecutionError, RunExecutionError } from '../src/functions/d2c/run/errors';

/** 显式屏障决定先后顺序，不用耗时推断并行。 */
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve,
    async wait(signal: AbortSignal | undefined) {
      assert.ok(signal);
      signal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        await Promise.race([promise, cancelled]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

/** 构造真实图工具调用，模型本身完全离线。 */
function calls(...entries: Array<{ name: string; args: Record<string, unknown> }>) {
  return new AIMessage({
    content: '',
    tool_calls: entries.map((entry, index) => ({
      ...entry,
      id: `call-${crypto.randomUUID()}-${index}`,
    })),
  });
}

/** 每个图使用独立会话；同时绑定父图检查点和正式子进度存储。 */
async function fixture(t: test.TestContext) {
  const controller = new AbortController();
  t.after(() => controller.abort(new Error('TEST_CLEANUP')));
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'background-graph',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  });
  const progress = await createSubagentProgress(checkpoint, {
    continuation: false,
    identity: 'graph-config',
    messageId: 'graph-job',
  });
  const files = new Map<string, string>();
  const writes: string[] = [];
  const removals: string[] = [];
  const checks: string[] = [];
  const messages: BaseMessage[] = [];
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async (path) =>
      JSON.stringify({
        content: path === 'pp-d2c.config.json' ? '{}' : (files.get(path) ?? ''),
        nextOffset: null,
      }),
    write: async (path, content) => {
      writes.push(path);
      files.set(path, content);
      return 'saved';
    },
    remove: async (path) => {
      removals.push(path);
      files.delete(path);
      return 'removed';
    },
    figma: async (_command, args) =>
      JSON.stringify({
        ok: true,
        data: {
          nodes: [{ attributes: { id: args.nodeId, name: 'sub-card' } }],
        },
      }),
    rules: async (path) => {
      checks.push(path);
      return JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });
    },
    slices: async () => assert.fail('unexpected slicing'),
  };
  return {
    controller,
    checkpoint,
    progress,
    files,
    tools,
    writes,
    removals,
    checks,
    messages,
    async run(
      handler: (
        messages: BaseMessage[],
        parent: boolean,
        signal?: AbortSignal,
      ) => Promise<AIMessage>,
      overrides: Partial<AgentRunInput> = {},
    ) {
      const model = new FakeToolCallingModel();
      model.bindTools = () => model;
      model._generate = async (messages, options) => {
        const parent = messages.some(
          (message) => message.type === 'system' && message.text.includes('BACKGROUND_GRAPH_ROOT'),
        );
        const message = await handler(messages, parent, options?.signal);
        return { generations: [{ text: message.text, message }] };
      };
      return runAgent({
        model,
        tools,
        checkpoint,
        subagentProgress: progress,
        instructions: 'BACKGROUND_GRAPH_ROOT',
        messages: [new HumanMessage({ content: '开始并行任务', id: 'graph-input' })],
        maxTurns: 64,
        contextBudgetTokens: 1000000,
        signal: controller.signal,
        assertLease: async () => {},
        recordSubagent: async () => {},
        onMessage: async (message) => {
          messages.push(message);
        },
        ...overrides,
      });
    },
  };
}

/** UI 白名单及真实 sub 节点校验均走正式入口。 */
function delegate(id: string) {
  return {
    name: 'delegate_agent',
    args: {
      role: 'ui',
      nodeId: `1:${id.charCodeAt(0)}`,
      writePaths: [`page/blocks/${id}/index.tsx`],
      task: `GRAPH_CHILD:${id}`,
    },
  };
}

/** 只从当前子图的任务读出身份，不依赖父图聊天。 */
function childId(messages: BaseMessage[]) {
  const task = messages.find(
    (message) => message.type === 'human' && message.text.includes('GRAPH_CHILD:'),
  );
  assert.ok(task);
  return task.text.split('GRAPH_CHILD:')[1].trim();
}

/** 读取正式工具回执；accepted 和最终结果分开断言。 */
function resultOf(messages: BaseMessage[], name: string) {
  const result = messages
    .filter(ToolMessage.isInstance)
    .reverse()
    .find((message) => message.name === name);
  assert.ok(result, `missing ${name}`);
  return JSON.parse(result.text);
}

test(
  '正式父子图并行，父文件释放子模型，冲突反馈不写入，最终答复自动 join 不丢结果',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const entered = barrier(),
      ownWritten = barrier();
    let parentTurns = 0;
    let childBlocked = false;
    const write = f.tools.write;
    f.tools.write = async (path, content) => {
      const result = await write(path, content);
      if (path === 'own/index.tsx') {
        assert.equal(childBlocked, true);
        ownWritten.resolve();
      }
      return result;
    };
    const result = await f.run(async (messages, parent, signal) => {
      if (!parent) {
        if (!messages.some(ToolMessage.isInstance)) {
          childBlocked = true;
          entered.resolve();
          await ownWritten.wait(signal);
          childBlocked = false;
          return calls({
            name: 'write_file',
            args: { path: 'page/blocks/a/index.tsx', content: 'child source' },
          });
        }
        return new AIMessage('CHILD_GRAPH_RESULT');
      }
      if (parentTurns++ === 0) return calls(delegate('a'));
      if (parentTurns === 2) {
        assert.equal(
          resultOf(messages, 'delegate_agent').accepted,
          true,
          JSON.stringify(resultOf(messages, 'delegate_agent')),
        );
        await entered.wait(signal);
        return calls(
          {
            name: 'write_file',
            args: { path: 'page/blocks/a/other.tsx', content: 'forbidden parent' },
          },
          { name: 'delete_file', args: { path: 'page/blocks/a/index.tsx' } },
          { name: 'check_rules', args: { path: 'page/blocks/a', mode: 'block' } },
        );
      }
      if (parentTurns === 3) {
        for (const name of ['write_file', 'delete_file', 'check_rules']) {
          const response = messages
            .filter(ToolMessage.isInstance)
            .reverse()
            .find((message) => message.name === name);
          assert.equal(readToolFeedback(response!.content)?.code, 'INVALID_ARGUMENT');
        }
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.removals, []);
        assert.deepEqual(f.checks, []);
        return calls({
          name: 'write_file',
          args: { path: 'own/index.tsx', content: 'parent source' },
        });
      }
      if (parentTurns === 4) return new AIMessage('PREMATURE_FINAL_MUST_BE_JOINED');
      const joined = resultOf(messages, 'wait_subagents');
      assert.equal(joined.agents.length, 1);
      assert.equal(JSON.parse(joined.agents[0].result).success, true);
      assert.match(joined.agents[0].result, /CHILD_GRAPH_RESULT/);
      return new AIMessage('PARENT_JOINED_RESULT');
    });
    assert.equal(result.output, 'PARENT_JOINED_RESULT');
    assert.deepEqual(f.writes, ['own/index.tsx', 'page/blocks/a/index.tsx']);
    assert.equal(
      f.messages
        .filter(ToolMessage.isInstance)
        .filter((message) => message.name === 'wait_subagents').length,
      1,
    );
    assert.deepEqual(await f.progress.background(), []);
  },
);

test(
  '三个正式委派至多两个子模型并发，父模型可同时推进，空 ID wait 收齐三个结果',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const twoEntered = barrier(),
      release = barrier();
    const started: string[] = [];
    let active = 0,
      maxChildren = 0,
      maxTotal = 0,
      parentTurns = 0;
    const write = f.tools.write;
    f.tools.write = async (path, content) => {
      const result = await write(path, content);
      if (path === 'own/index.tsx') release.resolve();
      return result;
    };
    const result = await f.run(async (messages, parent, signal) => {
      if (!parent) {
        active++;
        maxChildren = Math.max(maxChildren, active);
        try {
          const id = childId(messages);
          if (!messages.some(ToolMessage.isInstance)) {
            started.push(id);
            if (started.length === 2) twoEntered.resolve();
            await release.wait(signal);
            return calls({
              name: 'write_file',
              args: { path: `page/blocks/${id}/index.tsx`, content: `child ${id}` },
            });
          }
          return new AIMessage(`DONE_${id}`);
        } finally {
          active--;
        }
      }
      if (parentTurns++ === 0) return calls(delegate('a'), delegate('b'), delegate('c'));
      if (parentTurns === 2) {
        await twoEntered.wait(signal);
        assert.equal(active, 2);
        assert.equal(started.length, 2);
        maxTotal = Math.max(maxTotal, active + 1);
        const acks = messages
          .filter(ToolMessage.isInstance)
          .filter((message) => message.name === 'delegate_agent')
          .map((message) => JSON.parse(message.text));
        assert.equal(acks.length, 3);
        assert.ok(acks.every((ack) => ack.accepted === true));
        assert.ok(acks.some((ack) => ack.status === 'queued'));
        return calls({
          name: 'write_file',
          args: { path: 'own/index.tsx', content: 'release children' },
        });
      }
      if (parentTurns === 3)
        return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
      const joined = resultOf(messages, 'wait_subagents');
      assert.equal(joined.agents.length, 3);
      assert.ok(
        joined.agents.every(
          (agent: { result: string }) => JSON.parse(agent.result).success === true,
        ),
      );
      return new AIMessage('THREE_JOINED');
    });
    assert.equal(result.output, 'THREE_JOINED');
    assert.equal(maxChildren, 2);
    assert.equal(maxTotal, 3);
    assert.equal(active, 0);
    assert.deepEqual(started.sort(), ['a', 'b', 'c']);
    assert.deepEqual(await f.progress.background(), []);
  },
);

/** 模型等待遵从图传入的真实取消信号，退出时清理监听器。 */
async function untilAborted(signal: AbortSignal | undefined) {
  assert.ok(signal);
  signal.throwIfAborted();
  await new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
}

test(
  '共享停止取消正在等待的父子模型，runAgent 拒绝前双方均退出且没有挂起写入',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const childEntered = barrier(),
      parentEntered = barrier();
    let active = 0,
      exited = 0,
      parentTurns = 0;
    const execution = f.run(async (_messages, parent, signal) => {
      if (parent && parentTurns++ === 0) return calls(delegate('a'));
      active++;
      try {
        if (parent) {
          await childEntered.wait(signal);
          parentEntered.resolve();
        } else childEntered.resolve();
        await untilAborted(signal);
        return new AIMessage('must not complete');
      } finally {
        active--;
        exited++;
      }
    });
    const rejected = assert.rejects(execution);
    await parentEntered.wait(f.controller.signal);
    assert.equal(active, 2);
    f.controller.abort(new Error('GRAPH_SHARED_STOP'));
    await rejected;
    assert.equal(active, 0);
    assert.equal(exited, 2);
    assert.deepEqual(f.writes, []);
    const saved = await f.progress.background();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'pending');
  },
);

test('局部子任务限额结算失败回执，父 wait 后可接管原授权文件', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  let parentTurns = 0,
    childCalls = 0;
  const result = await f.run(async (messages, parent, signal) => {
    if (!parent) {
      childCalls++;
      throw new Error('DEEP_SUBAGENT_MAX_TURNS');
    }
    if (parentTurns++ === 0) return calls(delegate('a'));
    if (parentTurns === 2)
      return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
    if (parentTurns === 3) {
      const agents = resultOf(messages, 'wait_subagents').agents;
      assert.equal(agents.length, 1);
      const failure = JSON.parse(agents[0].result);
      assert.equal(failure.success, false);
      assert.equal(failure.reason, 'DEEP_SUBAGENT_MAX_TURNS');
      assert.ok(failure.handoff);
      return calls({
        name: 'write_file',
        args: { path: 'page/blocks/a/index.tsx', content: 'parent takeover' },
      });
    }
    return new AIMessage('TAKEOVER_DONE');
  });
  assert.equal(result.output, 'TAKEOVER_DONE');
  assert.equal(childCalls, 1);
  assert.equal(f.files.get('page/blocks/a/index.tsx'), 'parent takeover');
  assert.deepEqual(await f.progress.background(), []);
});

/** 每个边界独立运行完整父子图，确认首次调用被替换为 wait，结果交付后才执行副作用。 */
for (const boundary of [
  { name: 'check_rules', args: { path: 'page', mode: 'merge' } },
  { name: 'build_preview', args: { entryPath: null } },
  { name: 'inspect_preview', args: { entryPath: null } },
  { name: 'prepare_slices', args: { slug: 'page' } },
  {
    name: 'ask_user',
    args: { question: '请选择主题', options: ['默认'], recommendedAnswer: '默认' },
  },
]) {
  test(
    `${boundary.name} 全局边界先自动 wait 交付子结果，再允许执行`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const entered = barrier(),
        finish = barrier();
      let parentTurns = 0,
        effects = 0;
      const effect = async () => {
        assert.deepEqual(await f.progress.background(), []);
        effects++;
        return JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });
      };
      f.tools.rules = async (path) =>
        path === 'page'
          ? effect()
          : JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });
      f.tools.slices = effect;
      f.tools.preview = { build: effect, inspect: effect, needsInspection: async () => false };
      const result = await f.run(async (messages, parent, signal) => {
        if (!parent) {
          if (!messages.some(ToolMessage.isInstance)) {
            entered.resolve();
            await finish.wait(signal);
            return calls({
              name: 'write_file',
              args: { path: 'page/blocks/a/index.tsx', content: 'ready for global action' },
            });
          }
          return new AIMessage('BOUNDARY_CHILD_READY');
        }
        if (parentTurns++ === 0) return calls(delegate('a'));
        if (parentTurns === 2) {
          assert.equal(resultOf(messages, 'delegate_agent').accepted, true);
          await entered.wait(signal);
          finish.resolve();
          return calls(boundary);
        }
        if (parentTurns === 3) {
          assert.equal(effects, 0);
          assert.match(
            resultOf(messages, 'wait_subagents').agents[0].result,
            /BOUNDARY_CHILD_READY/,
          );
          return calls(boundary);
        }
        assert.equal(effects, 1);
        return new AIMessage('BOUNDARY_DONE');
      });
      if (boundary.name === 'ask_user') {
        assert.equal(result.waiting?.question, '请选择主题');
        assert.equal(effects, 0);
      } else {
        assert.equal(result.output, 'BOUNDARY_DONE');
        assert.equal(effects, 1);
      }
      assert.equal(
        f.messages
          .filter(ToolMessage.isInstance)
          .filter((message) => message.name === 'wait_subagents').length,
        1,
      );
      assert.deepEqual(await f.progress.background(), []);
    },
  );
}

/** 只统计正式图生成的 wait 工具回执，不把启动确认或 progress 列表当成交付。 */
function waitReceipts(messages: BaseMessage[]) {
  return messages
    .filter(ToolMessage.isInstance)
    .filter((message) => message.name === 'wait_subagents');
}

/** 从 MemorySaver 读取根图实际已提交历史，作为正式恢复入口的稳定历史来源。 */
async function rootHistory(f: Awaited<ReturnType<typeof fixture>>): Promise<BaseMessage[]> {
  const tuple = await f.checkpoint.getTuple(f.checkpoint.config());
  const messages = tuple?.checkpoint.channel_values.messages;
  assert.ok(Array.isArray(messages));
  return messages as BaseMessage[];
}

/** 中断后重建进度实例，并用新的输入 ID 恢复同一个持久化父图。 */
async function resumeOptions(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<Partial<AgentRunInput>> {
  return {
    subagentProgress: await createSubagentProgress(f.checkpoint, {
      continuation: true,
      identity: 'graph-config',
      messageId: 'graph-resume',
    }),
    signal: new AbortController().signal,
    messages: [new HumanMessage({ content: '继续接收已完成子任务', id: 'graph-resume-input' })],
    recoverHistory: () => rootHistory(f),
  };
}

test(
  '子结果 settled 落盘后父 wait 前停止，新父图只收回执而不重放子模型或写入',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const settled = barrier(),
      parentWaiting = barrier();
    const put = f.checkpoint.put.bind(f.checkpoint);
    t.mock.method(f.checkpoint, 'put', async (...args: Parameters<typeof f.checkpoint.put>) => {
      const saved = await put(...args);
      const progress = args[1].channel_values.progress as
        | { background?: { status: string; observed: boolean } }
        | undefined;
      if (progress?.background?.status === 'settled' && !progress.background.observed)
        settled.resolve();
      return saved;
    });
    let parentCalls = 0,
      childCalls = 0;
    const running = f.run(async (messages, parent, signal) => {
      if (!parent) {
        childCalls++;
        if (!messages.some(ToolMessage.isInstance))
          return calls({
            name: 'write_file',
            args: {
              path: 'page/blocks/a/index.tsx',
              content: 'settled source before stop',
            },
          });
        return new AIMessage('SETTLED_BEFORE_PARENT_WAIT');
      }
      if (parentCalls++ === 0) return calls(delegate('a'));
      assert.equal(resultOf(messages, 'delegate_agent').accepted, true);
      parentWaiting.resolve();
      await untilAborted(signal);
      return new AIMessage('must not finish before receiving result');
    });
    const stopped = assert.rejects(running);
    await Promise.all([settled.wait(f.controller.signal), parentWaiting.wait(f.controller.signal)]);
    assert.equal(waitReceipts(f.messages).length, 0);
    f.controller.abort(new Error('STOP_AFTER_SETTLED_BEFORE_WAIT'));
    await stopped;
    const saved = await f.progress.background();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'settled');
    assert.match(saved[0].result!, /SETTLED_BEFORE_PARENT_WAIT/);
    assert.equal(waitReceipts(await rootHistory(f)).length, 0);
    assert.equal(childCalls, 3);
    assert.deepEqual(f.writes, ['page/blocks/a/index.tsx']);
    const checks = [...f.checks];
    let restoredParentCalls = 0;
    const options = await resumeOptions(f);
    const restored = await f.run(async (messages, parent) => {
      assert.equal(parent, true, 'settled 子任务不得重新启动模型');
      if (restoredParentCalls++ === 0)
        return calls({
          name: 'wait_subagents',
          args: {
            agentIds: [saved[0].agentId],
            wait: true,
          },
        });
      const { agents } = resultOf(messages, 'wait_subagents');
      assert.deepEqual(agents, [
        { agentId: saved[0].agentId, status: 'completed', result: saved[0].result },
      ]);
      assert.equal(JSON.parse(agents[0].result!).success, true);
      assert.equal(waitReceipts(messages).length, 1);
      return new AIMessage('RESTORED_SETTLED_DELIVERED');
    }, options);
    assert.equal(restored.output, 'RESTORED_SETTLED_DELIVERED');
    assert.equal(restoredParentCalls, 2);
    assert.equal(childCalls, 3);
    assert.deepEqual(f.writes, ['page/blocks/a/index.tsx']);
    assert.deepEqual(f.checks, checks);
    assert.equal(waitReceipts(f.messages).length, 1);
    const durable = waitReceipts(await rootHistory(f));
    assert.equal(durable.length, 1);
    assert.equal(durable[0].tool_call_id, waitReceipts(f.messages)[0].tool_call_id);
    assert.deepEqual(await options.subagentProgress!.background(), []);
  },
);

test(
  'wait 回执已同步保存而 observed 提交失败，重建父图安全重送且不重放子任务',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const put = f.checkpoint.put.bind(f.checkpoint);
    let observationAttempts = 0,
      successfulObservations = 0;
    t.mock.method(f.checkpoint, 'put', async (...args: Parameters<typeof f.checkpoint.put>) => {
      const progress = args[1].channel_values.progress as
        | { background?: { observed: boolean } }
        | undefined;
      const observing = progress?.background?.observed === true;
      if (observing) {
        observationAttempts++;
        /** 真实 root 工具节点须先提交回执，后续 guard 才允许提交 observed。 */
        assert.equal(waitReceipts(await rootHistory(f)).length, observationAttempts);
        assert.equal(waitReceipts(f.messages).length, observationAttempts);
        if (observationAttempts === 1) throw new Error('TEST_OBSERVED_SAVE_FAILED');
      }
      const result = await put(...args);
      if (observing) successfulObservations++;
      return result;
    });
    let parentCalls = 0,
      childCalls = 0;
    await assert.rejects(
      f.run(async (messages, parent) => {
        if (!parent) {
          childCalls++;
          if (!messages.some(ToolMessage.isInstance))
            return calls({
              name: 'write_file',
              args: {
                path: 'page/blocks/a/index.tsx',
                content: 'source preserved across observed failure',
              },
            });
          return new AIMessage('OBSERVATION_FAILURE_CHILD_RESULT');
        }
        if (parentCalls++ === 0) return calls(delegate('a'));
        assert.equal(parentCalls, 2, 'observed 保存失败须在下一次父模型调用前阻断');
        return calls({
          name: 'wait_subagents',
          args: {
            agentIds: [resultOf(messages, 'delegate_agent').agentId],
            wait: true,
          },
        });
      }),
      (error: unknown) => {
        let current = error;
        const seen = new Set<unknown>();
        while (current && typeof current === 'object' && !seen.has(current)) {
          seen.add(current);
          if (current instanceof SubagentExecutionError) {
            assert.equal(current.context.phase, 'observe');
            assert.ok(current.cause instanceof Error);
            assert.equal(current.cause.message, 'TEST_OBSERVED_SAVE_FAILED');
            return true;
          }
          current = 'cause' in current ? current.cause : undefined;
        }
        assert.fail('missing observe SubagentExecutionError in cause chain');
      },
    );
    assert.equal(parentCalls, 2);
    assert.equal(childCalls, 3);
    assert.equal(observationAttempts, 1);
    assert.equal(successfulObservations, 0);
    const saved = await f.progress.background();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, 'settled');
    assert.match(saved[0].result!, /OBSERVATION_FAILURE_CHILD_RESULT/);
    const firstDurable = waitReceipts(await rootHistory(f));
    assert.equal(firstDurable.length, 1);
    assert.equal(firstDurable[0].tool_call_id, waitReceipts(f.messages)[0].tool_call_id);
    assert.deepEqual(JSON.parse(firstDurable[0].text).agents, [
      {
        agentId: saved[0].agentId,
        status: 'completed',
        result: saved[0].result,
      },
    ]);
    const writes = [...f.writes],
      checks = [...f.checks];
    const options = await resumeOptions(f);
    let restoredParentCalls = 0;
    const result = await f.run(async (messages, parent) => {
      assert.equal(parent, true, '恢复结果不能重跑子模型');
      const receipts = waitReceipts(messages);
      if (restoredParentCalls++ === 0) {
        assert.equal(receipts.length, 1, '恢复模型须看见崩溃前已保存的 wait 回执');
        assert.equal(receipts[0].tool_call_id, firstDurable[0].tool_call_id);
        /** 故意请求直接结束，正式自动 join 应重新交付尚未 observed 的结果。 */
        return new AIMessage('MUST_JOIN_UNOBSERVED_RECEIPT');
      }
      assert.equal(receipts.length, 2);
      assert.notEqual(receipts[0].tool_call_id, receipts[1].tool_call_id);
      for (const receipt of receipts)
        assert.deepEqual(JSON.parse(receipt.text).agents, [
          {
            agentId: saved[0].agentId,
            status: 'completed',
            result: saved[0].result,
          },
        ]);
      return new AIMessage('OBSERVED_RETRY_DELIVERED');
    }, options);
    assert.equal(result.output, 'OBSERVED_RETRY_DELIVERED');
    assert.equal(restoredParentCalls, 2);
    assert.equal(childCalls, 3);
    assert.equal(observationAttempts, 2);
    assert.equal(successfulObservations, 1);
    assert.deepEqual(f.writes, writes);
    assert.deepEqual(f.checks, checks);
    assert.equal(waitReceipts(f.messages).length, 2);
    assert.equal(waitReceipts(await rootHistory(f)).length, 2);
    assert.deepEqual(await options.subagentProgress!.background(), []);
  },
);

/** 混批先修正模型请求，整批不得进入工具节点；修正后沿用真实后台委派及父工具。 */
for (const mixed of [
  { name: 'prepare_slices', args: { slug: 'mixed-page' } },
  { name: 'wait_subagents', args: { agentIds: [], wait: true } },
]) {
  test(
    `首次 delegate+${mixed.name} 混批无副作用，修正后父可保存 .d2c-tasks.md 并收齐结果`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const manifestSaved = barrier();
      const manifest = '# 子任务\n- a: page/blocks/a/index.tsx\n';
      let parentCalls = 0,
        childCalls = 0,
        slices = 0,
        progressSaves = 0;
      const put = f.checkpoint.put.bind(f.checkpoint);
      t.mock.method(f.checkpoint, 'put', async (...args: Parameters<typeof f.checkpoint.put>) => {
        if (args[1].channel_values.progress) progressSaves++;
        return put(...args);
      });
      const write = f.tools.write;
      f.tools.write = async (path, content) => {
        const result = await write(path, content);
        if (path === '.d2c-tasks.md') manifestSaved.resolve();
        return result;
      };
      f.tools.slices = async () => {
        assert.equal(waitReceipts(f.messages).length, 1);
        assert.deepEqual(await f.progress.background(), []);
        slices++;
        return JSON.stringify({ ok: true, marker: 'SLICES_AFTER_CHILD' });
      };
      const result = await f.run(async (messages, parent, signal) => {
        if (!parent) {
          childCalls++;
          if (!messages.some(ToolMessage.isInstance)) {
            await manifestSaved.wait(signal);
            return calls({
              name: 'write_file',
              args: {
                path: 'page/blocks/a/index.tsx',
                content: 'child after corrected batch',
              },
            });
          }
          return new AIMessage('CORRECTED_BATCH_CHILD_RESULT');
        }
        parentCalls++;
        if (parentCalls === 1) return calls(delegate('a'), mixed);
        if (parentCalls === 2) {
          assert.match(messages.at(-1)!.text, /本批工具尚未执行/);
          assert.equal(childCalls, 0);
          assert.equal(progressSaves, 0);
          assert.equal(slices, 0);
          assert.deepEqual(f.writes, []);
          assert.deepEqual(f.removals, []);
          assert.deepEqual(f.checks, []);
          assert.equal(f.files.size, 0);
          assert.equal(messages.filter(ToolMessage.isInstance).length, 0);
          assert.equal(waitReceipts(f.messages).length, 0);
          assert.deepEqual(await f.progress.background(), []);
          return calls(delegate('a'));
        }
        if (parentCalls === 3) {
          assert.equal(resultOf(messages, 'delegate_agent').accepted, true);
          assert.equal(slices, 0);
          return calls({ name: 'write_file', args: { path: '.d2c-tasks.md', content: manifest } });
        }
        if (parentCalls === 4) {
          assert.equal(f.files.get('.d2c-tasks.md'), manifest);
          assert.equal(
            readToolFeedback(messages.filter(ToolMessage.isInstance).at(-1)!.content),
            undefined,
          );
          return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
        }
        const { agents } = resultOf(messages, 'wait_subagents');
        assert.equal(agents.length, 1);
        assert.equal(JSON.parse(agents[0].result).success, true);
        assert.match(agents[0].result, /CORRECTED_BATCH_CHILD_RESULT/);
        if (parentCalls === 5 && mixed.name === 'prepare_slices') return calls(mixed);
        if (mixed.name === 'prepare_slices')
          assert.equal(resultOf(messages, 'prepare_slices').marker, 'SLICES_AFTER_CHILD');
        return new AIMessage('CORRECTED_BATCH_COMPLETE');
      });
      assert.equal(result.output, 'CORRECTED_BATCH_COMPLETE');
      assert.equal(parentCalls, mixed.name === 'prepare_slices' ? 6 : 5);
      assert.equal(childCalls, 3);
      assert.equal(slices, mixed.name === 'prepare_slices' ? 1 : 0);
      assert.deepEqual(f.writes, ['.d2c-tasks.md', 'page/blocks/a/index.tsx']);
      assert.equal(waitReceipts(f.messages).length, 1);
      assert.equal(waitReceipts(await rootHistory(f)).length, 1);
      assert.deepEqual(await f.progress.background(), []);
    },
  );
}

/** 预存真实后台描述，测试新父图如何交接既有任务，不依赖定时竞争。 */
async function seedBackground(
  f: Awaited<ReturnType<typeof fixture>>,
  context: string,
  settled: boolean,
) {
  const params = delegate('a').args;
  const task = { ...params, description: params.task };
  const progress = await f.progress.open(task, context, f.tools);
  f.files.set(params.writePaths[0], 'original saved block');
  await progress.wrote(params.writePaths[0]);
  await progress.startBackground('persisted-background-a', params.task);
  const result = JSON.stringify({
    success: true,
    files: params.writePaths,
    result: 'saved earlier',
  });
  if (settled) {
    await progress.complete(result);
    await progress.settleBackground(result);
  }
  return { params, progress, result };
}

test(
  '后台恢复遇到缓存输入变化仍沿原agentId续作，只复核自己的区块',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const seeded = await seedBackground(f, 'old-cache', false);
    f.tools.subagentContext = async () => 'new-cache';
    let childCalls = 0,
      parentCalls = 0;
    const ids = new Set<string>();
    const result = await f.run(
      async (messages, parent) => {
        if (!parent) {
          childCalls++;
          assert.ok(
            messages.some(
              (message) => message.type === 'human' && message.text.includes('恢复差异'),
            ),
          );
          if (!messages.some(ToolMessage.isInstance))
            return calls({
              name: 'write_file',
              args: { path: seeded.params.writePaths[0], content: 'revalidated block' },
            });
          return new AIMessage('REVALIDATED_CHILD');
        }
        if (parentCalls++ === 0)
          return calls({
            name: 'wait_subagents',
            args: { agentIds: [seeded.progress.state.agentId], wait: true },
          });
        const receipt = resultOf(messages, 'wait_subagents').agents[0];
        assert.equal(receipt.agentId, seeded.progress.state.agentId);
        assert.equal(JSON.parse(receipt.result).success, true);
        return new AIMessage('PARENT_CONTINUED');
      },
      {
        recordSubagent: async (event) => {
          ids.add(event.agentId);
        },
      },
    );
    assert.equal(result.output, 'PARENT_CONTINUED');
    assert.ok(childCalls > 0);
    assert.deepEqual([...ids], [seeded.progress.state.agentId]);
    assert.equal(f.files.get(seeded.params.writePaths[0]), 'revalidated block');
    assert.deepEqual(await f.progress.background(), []);
  },
);

test(
  '已完成未收取的子任务输入有变时交还父级复核，不重跑子模型或冒充成功',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const seeded = await seedBackground(f, 'old-cache', true);
    f.tools.subagentContext = async () => 'updated-cache';
    let parentCalls = 0;
    const result = await f.run(async (messages, parent) => {
      assert.equal(parent, true, '过期settled结果仅交给父级，不自动重跑子任务');
      if (parentCalls++ === 0)
        return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
      const receipt = resultOf(messages, 'wait_subagents').agents[0];
      const handoff = JSON.parse(receipt.result);
      assert.equal(receipt.agentId, seeded.progress.state.agentId);
      assert.equal(handoff.success, false);
      assert.equal(handoff.reason, 'RESUME_INPUT_CHANGED');
      assert.equal(handoff.resumeAgentId, seeded.progress.state.agentId);
      assert.deepEqual(handoff.files, seeded.params.writePaths);
      assert.equal(handoff.handoff.recovery.inputChanged, true);
      return new AIMessage('PARENT_REVIEWED_STALE_INPUT');
    });
    assert.equal(result.output, 'PARENT_REVIEWED_STALE_INPUT');
    const preserved = await f.progress.open(
      { ...seeded.params, description: seeded.params.task },
      'updated-cache',
      f.tools,
      seeded.progress.state.agentId,
    );
    assert.equal(preserved.state.background?.result, seeded.result, '原交付结果保留供审计');
    assert.equal(preserved.state.background?.observed, true);

    assert.equal(f.files.get(seeded.params.writePaths[0]), 'original saved block');
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await f.progress.background(), []);
  },
);

test(
  '恢复授权被拒绝作为失败交接交给父级，确认观察后不反复恢复该描述',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const seeded = await seedBackground(f, '', false);
    const original = f.progress.open.bind(f.progress);
    t.mock.method(f.progress, 'open', async (...args: Parameters<typeof f.progress.open>) => {
      if (args[3]) throw new SubagentResumeError('SCOPE_CHANGED');
      return original(...args);
    });
    let callsCount = 0;
    const result = await f.run(async (messages, parent) => {
      assert.equal(parent, true);
      if (callsCount++ === 0)
        return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
      const receipt = resultOf(messages, 'wait_subagents').agents[0];
      const handoff = JSON.parse(receipt.result);
      assert.equal(handoff.reason, 'RESUME_SCOPE_CHANGED');
      assert.deepEqual(handoff.files, seeded.params.writePaths);
      assert.equal(handoff.resumeAgentId, seeded.progress.state.agentId);
      return new AIMessage('PARENT_TOOK_OVER');
    });
    assert.equal(result.output, 'PARENT_TOOK_OVER');
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await f.progress.background(), []);
  },
);

test('恢复三个已完成只读子任务不消耗本轮两个新委派名额', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const task = { role: 'review', writePaths: [], description: 'review-original-' + i };
    const progress = await f.progress.open(task, '', f.tools);
    await progress.startBackground('completed-review-' + i, task.description);
    await progress.settleBackground(
      JSON.stringify({ success: true, result: 'original-review-' + i }),
    );
    ids.push(progress.state.agentId);
  }
  let parentCalls = 0,
    childCalls = 0;
  const result = await f.run(async (messages, parent) => {
    if (!parent) {
      childCalls++;
      return new AIMessage('FRESH_REVIEW');
    }
    if (parentCalls++ === 0)
      return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
    if (
      !messages.some(
        (message) => ToolMessage.isInstance(message) && message.name === 'delegate_agent',
      )
    ) {
      const receipts = resultOf(messages, 'wait_subagents').agents;
      assert.deepEqual(
        receipts.map((receipt: { agentId: string }) => receipt.agentId).sort(),
        ids.sort(),
      );
      assert.ok(
        receipts.every(
          (receipt: { result: string }) => JSON.parse(receipt.result).success === true,
        ),
      );
      return calls({
        name: 'delegate_agent',
        args: { role: 'review', task: 'one fresh independent review', writePaths: [] },
      });
    }
    assert.equal(resultOf(messages, 'delegate_agent').accepted, true);
    return new AIMessage('RESTORED_AND_NEW_REVIEW');
  });
  assert.equal(result.output, 'RESTORED_AND_NEW_REVIEW');
  assert.ok(childCalls > 0);
  assert.deepEqual(await f.progress.background(), []);
});

test('同任务回执不能让错误的显式resumeAgentId绕过身份验证', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const release = barrier();
  const wrong = crypto.randomUUID();
  let parentCalls = 0;
  const result = await f.run(async (messages, parent, signal) => {
    if (!parent) {
      if (!messages.some(ToolMessage.isInstance)) {
        await release.wait(signal);
        return calls({
          name: 'write_file',
          args: { path: 'page/blocks/a/index.tsx', content: 'authorized original task' },
        });
      }
      return new AIMessage('ORIGINAL_TASK_COMPLETED');
    }
    if (parentCalls++ === 0) return calls(delegate('a'));
    if (parentCalls === 2)
      return calls({
        name: 'delegate_agent',
        args: { ...delegate('a').args, resumeAgentId: wrong },
      });
    if (parentCalls === 3) {
      const rejection = resultOf(messages, 'delegate_agent');
      assert.equal(rejection.success, false);
      assert.equal(rejection.reason, 'RESUME_SCOPE_CHANGED');
      assert.equal(rejection.resumeAgentId, wrong);
      release.resolve();
      return calls({ name: 'wait_subagents', args: { agentIds: [], wait: true } });
    }
    const receipt = resultOf(messages, 'wait_subagents').agents[0];
    assert.notEqual(receipt.agentId, wrong);
    assert.equal(JSON.parse(receipt.result).success, true);
    return new AIMessage('IDENTITY_GUARD_PASSED');
  });
  assert.equal(result.output, 'IDENTITY_GUARD_PASSED');
  assert.deepEqual(f.writes, ['page/blocks/a/index.tsx']);
});

test(
  '恢复中的存储、租约和损坏异常仍中止，不能伪装为可接管的普通拒绝',
  { timeout: 15000 },
  async (t) => {
    for (const failure of [
      new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }),
      new RunExecutionError('LEASE_LOST', { stage: 'worker' }),
      new Error('DEEP_SUBAGENT_PROGRESS_CORRUPT'),
    ]) {
      const f = await fixture(t);
      const seeded = await seedBackground(f, '', false);
      t.mock.method(f.progress, 'open', async () => {
        throw failure;
      });
      await assert.rejects(
        f.run(async () => assert.fail('不得继续父模型')),
        (error) => {
          let current: unknown = error;
          for (let depth = 0; current instanceof Error && depth < 12; depth++) {
            if (current === failure) return true;
            current = current.cause;
          }
          return false;
        },
      );
      assert.equal(f.files.get(seeded.params.writePaths[0]), 'original saved block');
      assert.deepEqual(f.writes, []);
      assert.equal((await f.progress.background()).length, 1);
    }
  },
);
