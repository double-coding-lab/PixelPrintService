import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { MemorySaver, emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import {
  createSubagentProgress,
  SubagentCheckpoint,
  settleSubagentMessages,
  type AgentCheckpoint,
} from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { GenerationTools } from '../src/functions/d2c/run/types';

/** 保存器模拟同一数据库、两个执行实例；所有真实图状态仍交由 LangGraph 保存。 */
function fixture() {
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'session-a',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  }) as AgentCheckpoint;
  const files = new Map<string, string>([['rules.md', '真实规则内容']]);
  let reads = 0;
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async (path) => {
      if (path === 'rules.md') reads++;
      const content = files.get(path);
      return JSON.stringify(
        content === undefined
          ? { ok: false, code: 'FILE_NOT_FOUND' }
          : { content, totalCharacters: content.length, offset: 0, nextOffset: null },
      );
    },
    write: async (path, content) => {
      files.set(path, content);
      return 'saved';
    },
    remove: async () => '',
    figma: async () => '',
    rules: async () => '',
    slices: async () => '',
  };
  return {
    checkpoint,
    files,
    tools,
    get reads() {
      return reads;
    },
  };
}

/** 模型仅返回确定的工具调用，测试不会请求外部模型。 */
function model(t: test.TestContext, generate: (messages: BaseMessage[]) => Promise<AIMessage>) {
  const value = new FakeToolCallingModel();
  t.mock.method(value, 'bindTools', () => value);
  t.mock.method(value, '_generate', async (messages: BaseMessage[]) => {
    const message = await generate(messages);
    return { generations: [{ text: message.text, message }] };
  });
  return value;
}

/** 持久化委派只确认已启动，显式等待该 agentId 后才能读取原子任务结果。 */
function waitForAccepted(result: ToolMessage) {
  const ack = JSON.parse(result.text);
  assert.equal(ack.accepted, true);
  assert.equal(typeof ack.agentId, 'string');
  return new AIMessage({
    content: '',
    tool_calls: [
      {
        id: `wait-${result.tool_call_id}`,
        name: 'wait_subagents',
        args: { agentIds: [ack.agentId], wait: true },
      },
    ],
  });
}

/** 等待回执必须包含唯一且已结算的原始结果，不能把 accepted 当成交付。 */
function deliveredResult(messages: BaseMessage[]) {
  const result = messages.filter(ToolMessage.isInstance).at(-1);
  assert.equal(result?.name, 'wait_subagents');
  const { agents } = JSON.parse(result!.text);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, 'completed');
  assert.equal(typeof agents[0].result, 'string');
  return JSON.parse(agents[0].result);
}

const task = { role: 'rule_scan', nodeId: '1:2', writePaths: ['pages/page/rule-hits.json'] };
const report = JSON.stringify({
  block: 'page',
  cache_key: 'design',
  generated_at: '2026-11-10T00:00:00Z',
  generated_by: 'rule-scan-subagent',
  hits: [],
});

test('子图 namespace 隔离，检查点读取和父链保持本地图语义', async () => {
  const f = fixture();
  const a = new SubagentCheckpoint(f.checkpoint, 'child/a/');
  const b = new SubagentCheckpoint(f.checkpoint, 'child/b/');
  const first = emptyCheckpoint();
  first.channel_values = { value: 'a' };
  const firstConfig = await a.put(
    a.config(),
    first,
    { source: 'update', step: 0, parents: {} },
    {},
  );
  const second = emptyCheckpoint();
  second.channel_values = { value: 'next' };
  await a.put(firstConfig, second, { source: 'update', step: 1, parents: {} }, {});
  const tuple = await a.getTuple(a.config());
  assert.equal(tuple?.config.configurable?.checkpoint_ns, '');
  assert.equal(tuple?.parentConfig?.configurable?.checkpoint_ns, '');
  assert.equal((await a.getTuple(firstConfig))?.checkpoint.channel_values.value, 'a');
  assert.equal(await b.getTuple(b.config()), undefined);
  assert.equal(await f.checkpoint.getTuple(f.checkpoint.config()), undefined);
  await assert.rejects(a.deleteThread(), /DELETE_DENIED/);
});

test('继续复用已完成结果，输入、授权、手动文件变化或新需求使其失效', async () => {
  const f = fixture();
  const first = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'config-a',
    messageId: 'message-a',
  });
  const child = await first.open(task, 'cache-a', f.tools);
  f.files.set(task.writePaths[0], 'report');
  await child.wrote(task.writePaths[0]);
  await child.complete('completed');
  const next = await createSubagentProgress(f.checkpoint, {
    continuation: true,
    identity: 'config-a',
    messageId: 'resume-b',
  });
  const restored = await next.open(task, 'cache-a', f.tools);
  assert.equal(restored.state.agentId, child.state.agentId);
  assert.equal(restored.state.result, 'completed');
  assert.match(await next.overview(), /completed/);
  assert.notEqual((await next.open(task, 'cache-b', f.tools)).state.agentId, child.state.agentId);
  assert.notEqual(
    (await next.open({ ...task, writePaths: ['pages/other/rule-hits.json'] }, 'cache-a', f.tools))
      .state.agentId,
    child.state.agentId,
  );
  f.files.set(task.writePaths[0], 'manual edit');
  assert.notEqual((await next.open(task, 'cache-a', f.tools)).state.agentId, child.state.agentId);
  const fresh = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'config-a',
    messageId: 'new-request',
  });
  assert.notEqual((await fresh.open(task, 'cache-a', f.tools)).state.agentId, child.state.agentId);
  const changed = await createSubagentProgress(f.checkpoint, {
    continuation: true,
    identity: 'config-b',
    messageId: 'changed-config',
  });
  assert.equal(await changed.overview(), '');
});

test('未知写入结果只补齐配对，不重新执行；已完成读取保留原结果', () => {
  const call = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'read', name: 'read_file', args: { path: 'rules.md' } },
      { id: 'write', name: 'write_file', args: { path: 'page.tsx', content: 'x' } },
    ],
  });
  const done = new ToolMessage({ tool_call_id: 'read', name: 'read_file', content: 'saved rules' });
  const before = JSON.stringify([call.toDict(), done.toDict()]);
  const result = settleSubagentMessages([call, done]);
  assert.equal(result.length, 3);
  assert.equal(result[1], done);
  assert.match(result[2].text, /unknown/);
  assert.equal(ToolMessage.isInstance(result[2]) && result[2].tool_call_id, 'write');
  assert.equal(JSON.stringify([call.toDict(), done.toDict()]), before);
});

test(
  '真实子图完成读取后停止，新执行实例恢复工具结果而不重新读取',
  { timeout: 20000 },
  async (t) => {
    const f = fixture();
    const store = await createSubagentProgress(f.checkpoint, {
      continuation: false,
      identity: 'config',
      messageId: 'start',
    });
    const child = await store.open(task, 'cache', f.tools);
    const controller = new AbortController();
    let calls = 0;
    const firstModel = model(t, async () => {
      if (++calls === 1)
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'read-once',
              name: 'read_file',
              args: { path: 'rules.md', resource: false, offset: null, length: null },
            },
          ],
        });
      controller.abort(new Error('USER_PAUSED'));
      throw new Error('USER_PAUSED');
    });
    const base = {
      instructions: '读取规则后继续工作，不重新读取已完成工具。',
      maxTurns: 8,
      contextBudgetTokens: 1000000,
      assertLease: async () => {},
      specialist: 'rule_scan' as const,
      continuingSubagent: true,
    };
    await assert.rejects(
      runAgent({
        ...base,
        model: firstModel,
        tools: f.tools,
        checkpoint: child.checkpoint,
        signal: controller.signal,
        messages: [new HumanMessage({ content: '读取规则', id: 'child-first' })],
      }),
    );
    assert.equal(f.reads, 1);
    const secondStore = await createSubagentProgress(f.checkpoint, {
      continuation: true,
      identity: 'config',
      messageId: 'resume',
    });
    const restored = await secondStore.open(task, 'cache', f.tools);
    assert.equal(restored.state.agentId, child.state.agentId);
    const secondModel = model(t, async (messages) => {
      assert.ok(
        messages.some(
          (message) =>
            ToolMessage.isInstance(message) &&
            message.tool_call_id === 'read-once' &&
            message.text.includes('真实规则内容'),
        ),
      );
      return new AIMessage('保留规则，继续未完成部分');
    });
    const result = await runAgent({
      ...base,
      model: secondModel,
      tools: f.tools,
      checkpoint: restored.checkpoint,
      signal: new AbortController().signal,
      messages: [new HumanMessage({ content: '继续', id: 'child-second' })],
    });
    assert.match(result.output, /继续未完成部分/);
    assert.equal(f.reads, 1);
  },
);

/** 正式委派入口接通持久检查点；暂停恢复和已完成复用都不能重新读取规则或重复写报告。 */
test('父 Agent 重新委派恢复原子会话，已完成报告不再次启动子模型', { timeout: 20000 }, async (t) => {
  const f = fixture();
  const events: Array<{ agentId: string; status: string }> = [];
  let pause = true,
    childCalls = 0,
    writes = 0;
  const stop = new AbortController();
  const fake = model(t, async (messages) => {
    const child = messages.some(
      (message) =>
        message.type === 'system' && message.text.includes('你是 PixelPrint 规则扫描专家'),
    );
    if (!child) {
      const result = messages.filter(ToolMessage.isInstance).at(-1);
      if (result?.name === 'delegate_agent') return waitForAccepted(result);
      if (result) {
        assert.equal(deliveredResult(messages).success, true);
        return new AIMessage('扫描已完成');
      }
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'delegate',
            name: 'delegate_agent',
            args: {
              role: 'rule_scan',
              nodeId: '1:2',
              writePaths: task.writePaths,
              task: '读取 rules.md，写入 pages/page/rule-hits.json',
            },
          },
        ],
      });
    }
    childCalls++;
    if (
      !messages.some((message) => ToolMessage.isInstance(message) && message.name === 'read_file')
    )
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'read-rule',
            name: 'read_file',
            args: { path: 'rules.md', resource: false, offset: null, length: null },
          },
        ],
      });
    if (pause) {
      stop.abort(new Error('PAUSED'));
      throw new Error('PAUSED');
    }
    if (
      !messages.some((message) => ToolMessage.isInstance(message) && message.name === 'write_file')
    )
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'save-report',
            name: 'write_file',
            args: { path: task.writePaths[0], content: report },
          },
        ],
      });
    return new AIMessage('规则报告已写入');
  });
  const original = f.tools.write;
  f.tools.write = async (...args) => {
    writes++;
    return original(...args);
  };
  const base = {
    model: fake,
    instructions: 'parent',
    tools: f.tools,
    maxTurns: 20,
    contextBudgetTokens: 1000000,
    assertLease: async () => {},
    recordSubagent: async (event: { agentId: string; status: string }) => {
      events.push(event);
    },
  };
  const initial = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'fixed',
    messageId: 'job',
  });
  await assert.rejects(
    runAgent({
      ...base,
      subagentProgress: initial,
      signal: stop.signal,
      messages: [new HumanMessage('开始')],
    }),
  );
  assert.equal(f.reads, 1);
  pause = false;
  const continued = await createSubagentProgress(f.checkpoint, {
    continuation: true,
    identity: 'fixed',
    messageId: 'resume',
  });
  const result = await runAgent({
    ...base,
    subagentProgress: continued,
    signal: new AbortController().signal,
    messages: [new HumanMessage('继续')],
  });
  assert.equal(result.output, '扫描已完成');
  assert.equal(f.reads, 1);
  assert.equal(writes, 1);
  assert.equal(new Set(events.map((event) => event.agentId)).size, 1);
  const priorCalls = childCalls;
  await runAgent({
    ...base,
    subagentProgress: continued,
    signal: new AbortController().signal,
    messages: [new HumanMessage('核对已完成扫描')],
  });
  assert.equal(childCalls, priorCalls);
  assert.equal(writes, 1);
});

/** 模拟写文件成功但工具回执尚未保存时中止，恢复仅核对摘要并认领，不再执行写入。 */
test('未知写入内容匹配才恢复为已保存，内容不符保持未知', async () => {
  const { recoverSubagentMessages } = await import(
    '../src/functions/d2c/run/agent/subagentCheckpoint'
  );
  const f = fixture();
  const store = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'fixed',
    messageId: 'write-gap',
  });
  const child = await store.open(task, 'cache', f.tools);
  f.files.set(task.writePaths[0], 'actual report');
  const message = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'saved',
        name: 'write_file',
        args: { path: task.writePaths[0], content: 'actual report' },
      },
      {
        id: 'unknown',
        name: 'write_file',
        args: { path: task.writePaths[0], content: 'different' },
      },
    ],
  });
  const restored = await recoverSubagentMessages([message], child.reconcile);
  assert.equal(JSON.parse(restored[1].text).outcome, 'verified_saved');
  assert.equal(JSON.parse(restored[2].text).outcome, 'unknown');
  assert.equal(Object.keys(child.state.files).length, 1);
});

test('覆盖已保存报告后丢失进度回执，先核对原图未知写入而不重建子上下文', async () => {
  const f = fixture();
  const store = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'fixed',
    messageId: 'write-receipt-gap',
  });
  const child = await store.open(task, 'cache', f.tools);
  f.files.set(task.writePaths[0], report);
  await child.wrote(task.writePaths[0]);
  const content = JSON.stringify({ ...JSON.parse(report), block: 'page-updated' });
  const pending = emptyCheckpoint();
  pending.channel_values = {
    messages: [
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'write_file', id: 'pending-write', args: { path: task.writePaths[0], content } },
        ],
      }),
    ],
  };
  await child.checkpoint.put(
    child.checkpoint.config(),
    pending,
    { source: 'update', step: 1, parents: {} },
    {},
  );
  f.files.set(task.writePaths[0], content);
  const restored = await store.open(task, 'cache', f.tools);
  assert.equal(restored.state.agentId, child.state.agentId);
  assert.deepEqual(restored.state.partialFiles, task.writePaths);
  assert.equal(restored.state.result, undefined);
});

test('失败交接保存阶段说明与真实读取，主Agent读取上下文后恢复原子任务不重读', async (t) => {
  const f = fixture();
  const store = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'handoff-test',
    messageId: 'start',
  });
  let parentCalls = 0,
    childCalls = 0;
  let resume: Record<string, unknown>;
  let contextPath = '';
  const agents: string[] = [];
  const value = model(t, async (messages) => {
    if (messages[0].text.includes('PARENT_HANDOFF')) {
      const latest = messages.filter(ToolMessage.isInstance).at(-1);
      if (latest?.name === 'delegate_agent') return waitForAccepted(latest);
      parentCalls++;
      if (parentCalls === 1)
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'delegate-first',
              name: 'delegate_agent',
              args: { ...task, task: '读取规则并保存报告' },
            },
          ],
        });
      if (parentCalls === 2) {
        const result = deliveredResult(messages);
        assert.equal(result.success, false);
        assert.equal(result.reason, 'DEEP_SUBAGENT_MAX_TURNS');
        assert.equal(result.handoff.reportedProgress.phase, '规则已读');
        assert.ok(
          result.handoff.verifiedTools.some(
            (entry: { path?: string }) => entry.path === 'rules.md',
          ),
        );
        assert.deepEqual(result.missingFiles, task.writePaths);
        assert.equal(result.failure, undefined);
        resume = result.handoff.resume;
        contextPath = result.handoff.contextPath;
        assert.match(contextPath, /^\/history\/child-/);
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'read-context-index',
              name: 'read_file',
              args: { path: contextPath, resource: false, offset: 0, length: 12000 },
            },
          ],
        });
      }
      if (parentCalls === 3) {
        const page = JSON.parse(String(messages.filter(ToolMessage.isInstance).at(-1)!.content));
        const pages = JSON.parse(page.content).pages;
        assert.ok(pages.length > 0);
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'read-child-evidence',
              name: 'read_file',
              args: { path: pages[0], resource: false, offset: 0, length: 12000 },
            },
          ],
        });
      }
      if (parentCalls === 4) {
        const page = JSON.parse(String(messages.filter(ToolMessage.isInstance).at(-1)!.content));
        assert.ok(page.content.includes('真实规则内容'));
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'resume-child',
              name: 'delegate_agent',
              args: { ...resume, task: '保留已读规则，只补保存缺少的报告' },
            },
          ],
        });
      }
      const result = deliveredResult(messages);
      assert.equal(result.success, true);
      return new AIMessage('完成');
    }
    childCalls++;
    if (childCalls === 1)
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'read-rules',
            name: 'read_file',
            args: { path: 'rules.md', resource: false, offset: 0, length: 1000 },
          },
        ],
      });
    if (childCalls === 2)
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'save-progress',
            name: 'report_progress',
            args: {
              phase: '规则已读',
              completed: ['已分析R01'],
              remaining: ['保存命中报告'],
              nextStep: '保存rule-hits.json',
            },
          },
        ],
      });
    if (childCalls === 3) throw new Error('DEEP_SUBAGENT_MAX_TURNS');
    if (childCalls === 4) {
      assert.ok(
        messages.some(
          (entry) =>
            ToolMessage.isInstance(entry) && entry.content.toString().includes('真实规则内容'),
        ),
      );
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'write-report',
            name: 'write_file',
            args: { path: task.writePaths[0], content: report },
          },
        ],
      });
    }
    return new AIMessage('报告已保存');
  });
  const result = await runAgent({
    model: value,
    checkpoint: f.checkpoint,
    subagentProgress: store,
    tools: f.tools,
    messages: [new HumanMessage({ content: '完成扫描', id: 'parent-start' })],
    instructions: 'PARENT_HANDOFF',
    maxTurns: 20,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async (event) => {
      if (event.status === 'started') agents.push(event.agentId);
    },
  });
  assert.equal(result.output, '完成');
  assert.equal(f.reads, 1);
  assert.equal(agents.length, 2);
  assert.equal(agents[0], agents[1]);
  assert.equal(f.files.has(task.writePaths[0]), true);
  assert.ok((await store.overview(f.tools)).includes('child-'));
});

test('局部编辑保存后丢失回执仍保留原子图，未知编辑不被认领成功或重放', async () => {
  const f = fixture();
  const store = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'fixed',
    messageId: 'edit-receipt-gap',
  });
  const task = { role: 'ui', nodeId: '1:2', writePaths: ['pages/page/blocks/prize/index.tsx'] };
  const child = await store.open(task, 'cache', f.tools);
  const file = task.writePaths[0];
  f.files.set(file, 'original');
  await child.wrote(file);
  const pending = emptyCheckpoint();
  const messages = [
    new AIMessage({
      content: '',
      tool_calls: [
        {
          name: 'edit_file',
          id: 'pending-edit',
          args: {
            path: file,
            oldText: 'original',
            newText: '',
            expectedSha256: createHash('sha256').update('original').digest('hex'),
          },
        },
      ],
    }),
  ];
  pending.channel_values = { messages };
  await child.checkpoint.put(
    child.checkpoint.config(),
    pending,
    { source: 'update', step: 1, parents: {} },
    {},
  );
  f.files.set(file, '');
  const restored = await store.open(task, 'cache', f.tools);
  assert.equal(restored.state.agentId, child.state.agentId);
  assert.equal(restored.state.result, undefined);
  assert.ok(restored.state.files[file]);
  const { recoverSubagentMessages } = await import(
    '../src/functions/d2c/run/agent/subagentCheckpoint'
  );
  const settled = await recoverSubagentMessages(messages, restored.reconcile);
  assert.equal(JSON.parse(settled[1].text).outcome, 'unknown');
  assert.equal(f.files.get(file), '');
});
