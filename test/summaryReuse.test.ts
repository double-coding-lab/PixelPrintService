import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
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
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import {
  loadSummaryReceipt,
  saveSummaryReceipt,
} from '../src/functions/d2c/run/agent/summaryReceipt';
import type { HistoryArchive } from '../src/functions/d2c/run/agent/archive';
import {
  SubagentCheckpoint,
  type AgentCheckpoint,
} from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { createHistoryArchive } from '../src/functions/d2c/run/agent/archive';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';

function archiveMemory() {
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
  return { archive, data };
}
function summaryModel() {
  const model = new FakeToolCallingModel();
  const inputs: string[] = [];
  model._generate = async (messages: BaseMessage[]) => {
    inputs.push(messages.map((m) => m.text).join('\n'));
    const message = new AIMessage({
      content: '保留原始目标、已保存产物和未完成交互；失败仍需核对，完整证据按归档回查。',
      response_metadata: { finish_reason: 'stop' },
    });
    return { generations: [{ text: message.text, message }] };
  };
  return { model, inputs };
}
const tools = {
  list: async () => [],
  read: async () => '',
  write: async () => assert.fail('不能重放写入'),
  remove: async () => '',
  figma: async () => '',
  rules: async () => '',
  slices: async () => '',
};

/** 使用真实图和持久保存器，摘要之后生成失败，再模拟发布后从完整业务历史继续。 */
test('completed multi-part summary survives generation failure and process rebuild without repeating model summaries', async () => {
  const first = Object.assign(new MemorySaver(), {
    config: (namespace = '', id?: string) => ({
      configurable: {
        thread_id: 'summary-reuse',
        checkpoint_ns: namespace,
        ...(id ? { checkpoint_id: id } : {}),
      },
    }),
  });
  const { model: low, inputs } = summaryModel();
  const generation = new FakeToolCallingModel();
  generation.bindTools = () => generation;
  generation._generate = async () => {
    throw new Error('TEST_AFTER_SUMMARY_FAILURE');
  };
  const history: BaseMessage[] = [
    new HumanMessage({ id: 'old-user', content: 'OLD_CONSTRAINT_KEEP：保留所有交互要求。' }),
  ];
  for (let i = 0; i < 8; i++)
    history.push(
      new AIMessage({ content: `历史阶段${i}：` + '设计约束及未完成任务。'.repeat(1400) }),
    );
  const firstInput = new HumanMessage({ id: 'first-user', content: '继续，只补剩余交互。' });
  const config = {
    instructions: '继续已有任务，已有文件不代表验收通过',
    maxTurns: 40,
    contextBudgetTokens: 18000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools,
  };
  await assert.rejects(
    runAgent({
      ...config,
      checkpoint: first as unknown as AgentCheckpoint,
      model: generation,
      reasoningModels: { low, high: generation },
      messages: [firstInput],
      bootstrapHistory: history,
    }),
  );
  const before = inputs.length;
  assert.ok(before > 1, '真实长历史应分成多批');
  const rebuilt = Object.assign(new MemorySaver(), { config: first.config });
  rebuilt.storage = structuredClone(first.storage);
  rebuilt.writes = structuredClone(first.writes);
  const stable = mapStoredMessagesToChatMessages(
    JSON.parse(JSON.stringify([...history, firstInput].map((m) => m.toDict()))),
  );
  const next = new FakeToolCallingModel();
  next.bindTools = () => next;
  const captured: BaseMessage[][] = [];
  next._generate = async (messages: BaseMessage[]) => {
    captured.push(messages);
    const message = new AIMessage('继续核对剩余交互');
    return { generations: [{ text: message.text, message }] };
  };
  const current = new HumanMessage({
    id: 'new-user',
    content: 'NEW_REQUIREMENT_KEEP：只补交互，保留既有布局。',
  });
  await runAgent({
    ...config,
    signal: new AbortController().signal,
    checkpoint: rebuilt as unknown as AgentCheckpoint,
    model: next,
    reasoningModels: { low, high: next },
    messages: [current],
    recoverHistory: async () => stable,
  });
  assert.equal(inputs.length, before, '已完成的多批摘要不能因后续生成失败重新执行');
  assert.ok(captured.length > 0);
  assert.ok(
    captured[0].some((m) => m.text.includes(current.text)),
    '新要求逐字保留',
  );
  assert.ok(
    captured[0].some((m) => m.text.includes('/history/snapshot_')),
    '完整历史保留可回查入口',
  );
});

/** 最后两条可能就是超大工具组；压缩后立即再入中间件不应再次触发。 */
test('large final tool group is archived with token headroom and current user remains verbatim', async () => {
  const { archive, data } = archiveMemory();
  const { model, inputs } = summaryModel();
  const current = new HumanMessage({
    id: 'current',
    content: 'CURRENT_REQUIREMENT_KEEP：不要改动现有布局，补齐按钮交互。',
  });
  const payload = 'LATEST_EVIDENCE_KEEP：真实布局事实\n'.repeat(1400);
  const messages = [
    current,
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'read', name: 'read_file', args: { path: 'page.tsx' } }],
    }),
    new ToolMessage({ name: 'read_file', tool_call_id: 'read', content: payload }),
  ];
  const original = JSON.stringify(messages.map((m) => m.toDict()));
  const middleware = createContextSummary({
    archive,
    model,
    budget: 12000,
    overhead: () => 2000,
    signal: new AbortController().signal,
    beforeRequest: async () => {},
    recordUsage: () => {},
    historicalSourceInputId: current.id,
  });
  const request = {
    model,
    messages,
    systemMessage: new SystemMessage('固定约束'),
    tools: [],
    state: {},
  };
  let outgoing: BaseMessage[] = [];
  const command = (await middleware.wrapModelCall!(
    request as never,
    (async (r: { messages: BaseMessage[] }) => {
      outgoing = r.messages;
      return new AIMessage('继续');
    }) as never,
  )) as { update: Record<string, unknown> };
  assert.ok(inputs.length > 0);
  const count = inputs.length;
  assert.ok(estimateTokens(outgoing.map((m) => m.toDict())) < 3500, '压缩后应留有明确空间');
  assert.ok(outgoing.some((m) => m.text === current.text));
  assert.ok(
    [...data.entries()].some(
      ([path, text]) => path.startsWith('/history/snapshot_') && text === original,
    ),
  );
  await middleware.wrapModelCall!(
    {
      ...request,
      messages: [...messages, new AIMessage('继续实现')],
      state: command.update,
    } as never,
    (async (r: { messages: BaseMessage[] }) => {
      assert.ok(r.messages.some((m) => m.text === current.text));
      return new AIMessage('继续');
    }) as never,
  );
  assert.equal(inputs.length, count);
  assert.equal(JSON.stringify(messages.map((m) => m.toDict())), original);
});

/** 回放分组变化、工具参数键序与归档回执可等价恢复；内容差异及未配对调用不复用。 */
test('receipt validates exact semantic prefix, grouping, archived output and paired tools', async () => {
  const { archive, data } = archiveMemory();
  const snapshot =
    '/history/snapshot_' + createHash('sha256').update('完整原始消息').digest('hex') + '.json';
  data.set(snapshot, '完整原始消息');
  const goal = new HumanMessage({ id: 'old', content: '保留约束' });
  const call = new AIMessage({
    content: '准备读取',
    tool_calls: [{ id: 'read', name: 'read_file', args: { path: 'page.tsx', resource: false } }],
  });
  const result = new ToolMessage({
    name: 'read_file',
    tool_call_id: 'read',
    content: '真实读取结果',
  });
  await saveSummaryReceipt(archive, [goal, call, result], new HumanMessage('真实摘要'), snapshot);
  const split = [
    goal,
    new AIMessage('准备读取'),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'read', name: 'read_file', args: { resource: false, path: 'page.tsx' } }],
    }),
    result,
    new HumanMessage('继续'),
  ];
  assert.equal((await loadSummaryReceipt(archive, split))?.cutoffIndex, 4);
  assert.equal(await loadSummaryReceipt(archive, [goal, call]), undefined);
  assert.equal(
    await loadSummaryReceipt(archive, [new HumanMessage('已变化的约束'), call, result]),
    undefined,
  );
  assert.equal(
    await loadSummaryReceipt(archive, [
      goal,
      call,
      new ToolMessage({ ...result, content: '不同结果' }),
    ]),
    undefined,
  );
  data.set(
    '/history/tools/receipt.json',
    JSON.stringify({ callId: 'read', name: 'read_file', content: result.content }),
  );
  assert.equal(
    (
      await loadSummaryReceipt(archive, [
        goal,
        call,
        new ToolMessage({
          ...result,
          content: JSON.stringify({ archived: true, path: '/history/tools/receipt.json' }),
        }),
      ])
    )?.cutoffIndex,
    3,
  );
  data.delete(snapshot);
  assert.equal(await loadSummaryReceipt(archive, split), undefined);
  data.set(snapshot, '已损坏的原始消息');
  await assert.rejects(loadSummaryReceipt(archive, split), /DEEP_ARCHIVE_INVALID/);
});

test('receipt storage failures stop before generation and invalid receipt is not treated as context', async () => {
  const { archive, data } = archiveMemory();
  data.set('/history/compaction_receipt.json', '{}');
  await assert.rejects(loadSummaryReceipt(archive, [new HumanMessage('继续')]));
  archive.load = async () => {
    throw new Error('STORAGE_FAILED');
  };
  await assert.rejects(loadSummaryReceipt(archive, []), /STORAGE_FAILED/);
});

for (const outcome of ['failed', 'unknown', 'pending'] as const)
  test(`latest ${outcome} tool group remains complete alongside current user and guidance`, async () => {
    const { archive } = archiveMemory();
    const { model } = summaryModel();
    const current = new HumanMessage({
      id: 'current-user',
      content: 'CURRENT_GOAL_KEEP：保留布局，只修交互。',
    });
    const guidance = new HumanMessage({
      id: 'guidance-user',
      content: 'GUIDANCE_KEEP：不要覆盖我的修改。',
    });
    const call = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'uncertain',
          name: 'edit_file',
          args: { path: 'page.tsx', oldText: 'before', newText: 'after' },
        },
      ],
    });
    const result = new ToolMessage({
      name: 'edit_file',
      tool_call_id: 'uncertain',
      ...(outcome === 'failed' ? { status: 'error' as const } : {}),
      content: JSON.stringify({
        success: false,
        outcome,
        detail: 'UNCERTAIN_EFFECT_KEEP：'.repeat(1800),
      }),
    });
    const messages = [
      new HumanMessage('原始任务约束'),
      new AIMessage('已完成阶段的历史。'.repeat(2300)),
      current,
      guidance,
      call,
      ...(outcome === 'pending' ? [] : [result]),
    ];
    const middleware = createContextSummary({
      archive,
      model,
      budget: 12000,
      overhead: () => 2000,
      signal: new AbortController().signal,
      beforeRequest: async () => {},
      recordUsage: () => {},
      historicalSourceInputId: current.id,
    });
    await middleware.wrapModelCall!(
      {
        model,
        messages,
        systemMessage: new SystemMessage('不重放未知副作用'),
        tools: [],
        state: { guidanceApplied: [guidance.id!] },
      } as never,
      (async (r: { messages: BaseMessage[] }) => {
        assert.ok(r.messages.some((m) => m.text === current.text));
        assert.ok(r.messages.some((m) => m.text === guidance.text));
        assert.ok(
          r.messages.some((m) => AIMessage.isInstance(m) && m.tool_calls?.[0]?.id === 'uncertain'),
        );
        if (outcome !== 'pending')
          assert.ok(r.messages.includes(result), '最新失败/未知结果保留原文，不能被摘要冒充成功');
        return new AIMessage('先核对未知操作的真实状态');
      }) as never,
    );
  });

/** 固定回执文件名继续受子图namespace隔离，父图和其他子任务不能消费它。 */
test('summary receipts stay isolated between parent and sibling subagent checkpoints', async () => {
  const saver = Object.assign(new MemorySaver(), {
    config: (namespace = '', id?: string) => ({
      configurable: {
        thread_id: 'receipt-isolation',
        checkpoint_ns: namespace,
        ...(id ? { checkpoint_id: id } : {}),
      },
    }),
  });
  const a = createHistoryArchive({
    checkpoint: new SubagentCheckpoint(saver as AgentCheckpoint, 'child-a/'),
    guard: async () => {},
  });
  const b = createHistoryArchive({
    checkpoint: new SubagentCheckpoint(saver as AgentCheckpoint, 'child-b/'),
    guard: async () => {},
  });
  const parent = createHistoryArchive({ checkpoint: saver as never, guard: async () => {} });
  const original = '完整私有原文';
  const snapshot =
    '/history/snapshot_' + createHash('sha256').update(original).digest('hex') + '.json';
  const messages = [new HumanMessage('同样内容也不能跨子任务复用')];
  await a.save(snapshot, original);
  await saveSummaryReceipt(a, messages, new HumanMessage('child-a的摘要'), snapshot);
  assert.ok(await loadSummaryReceipt(a, messages));
  assert.equal(await loadSummaryReceipt(b, messages), undefined);
  assert.equal(await loadSummaryReceipt(parent, messages), undefined);
});

/** 整个上下文都是受保护工具组时，原生中间件直通，不能把首条普通输入当成摘要回执。 */
test('no safe compaction boundary leaves original messages intact and creates no summary receipt', async () => {
  const { archive, data } = archiveMemory();
  const { model, inputs } = summaryModel();
  const user = new HumanMessage({
    id: 'protected-user',
    content: '保留当前要求，先核对未知写入。',
  });
  const messages = [
    user,
    new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'pending-write',
          name: 'write_file',
          args: { path: 'page.tsx', content: '未知写入正文'.repeat(2500) },
        },
      ],
    }),
  ];
  const middleware = createContextSummary({
    archive,
    model,
    budget: 8000,
    overhead: () => 2000,
    signal: new AbortController().signal,
    beforeRequest: async () => {},
    recordUsage: () => {},
    historicalSourceInputId: user.id,
  });
  await middleware.wrapModelCall!(
    {
      model,
      messages,
      systemMessage: new SystemMessage('未知副作用须先核对'),
      tools: [],
      state: {},
    } as never,
    (async (r: { messages: BaseMessage[] }) => {
      assert.deepEqual(r.messages, messages);
      return new AIMessage('先核对状态');
    }) as never,
  );
  assert.equal(inputs.length, 0);
  assert.equal(data.has('/history/compaction_receipt.json'), false);
});
