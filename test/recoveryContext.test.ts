import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  SystemMessage,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { createHistoryArchive } from '../src/functions/d2c/run/agent/archive';
import { createRecoveryMarker } from '../src/functions/d2c/run/agent/checkpoint';
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import { modelContextView, repeatedFeedbackView } from '../src/functions/d2c/run/agent/context';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { AgentCheckpoint } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { toolFeedback } from '../src/functions/d2c/run/toolFeedback';

const source = 'const layout = "保留原有产物、间距与图片";\n'.repeat(500);
const path = 'pages/page/index.tsx';
function read(id: string, text = source): BaseMessage[] {
  return [
    new AIMessage({
      content: '',
      tool_calls: [{ id, name: 'read_file', args: { path, resource: false } }],
    }),
    new ToolMessage({
      name: 'read_file',
      tool_call_id: id,
      content: JSON.stringify({
        path,
        content: text,
        offset: 0,
        totalCharacters: text.length,
        nextOffset: null,
      }),
    }),
  ];
}
type OfflineCheckpoint = MemorySaver & {
  config: (
    namespace?: string,
    id?: string,
  ) => { configurable: { thread_id: string; checkpoint_ns: string; checkpoint_id?: string } };
};
function memory(previous?: OfflineCheckpoint): OfflineCheckpoint {
  const saver = Object.assign(new MemorySaver(), {
    config: (namespace = '', id?: string) => ({
      configurable: {
        thread_id: 'recovery-context',
        checkpoint_ns: namespace,
        ...(id ? { checkpoint_id: id } : {}),
      },
    }),
  });
  if (previous) {
    saver.storage = structuredClone(previous.storage);
    saver.writes = structuredClone(previous.writes);
  }
  return saver;
}
const guard = async () => {};
const archiveFor = (saver: ReturnType<typeof memory>) =>
  createHistoryArchive({
    checkpoint: saver as unknown as Parameters<typeof createHistoryArchive>[0]['checkpoint'],
    guard,
  });

/** 真正中断原生图，重建保存器和消息实例后带恢复标记续接，不模拟恢复结果。 */
test('plain continuation restores a rebuilt graph with archived source, current tools and original constraints intact', async () => {
  const first = memory();
  const old = new HumanMessage({
    id: 'old-user',
    content: 'OLD_CONSTRAINT_KEEP：不要重做页面。UNFINISHED_KEEP：还需完成交互并真实验收',
  });
  const unknownCall = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'unknown-write',
        name: 'write_file',
        args: { path: 'unknown.tsx', content: 'UNKNOWN_WRITE_ARGUMENT_KEEP' },
      },
    ],
  });
  const unknownResult = new ToolMessage({
    name: 'write_file',
    tool_call_id: 'unknown-write',
    status: 'error',
    content: '{"success":false,"outcome":"unknown","message":"UNKNOWN_SIDE_EFFECT_KEEP"}',
  });
  const bootstrap = [
    old,
    ...read('v1'),
    ...read('v2', source + '//v2'),
    unknownCall,
    unknownResult,
  ];
  const firstInput = new HumanMessage({
    id: 'private-resume-guide',
    content:
      '继续当前任务。先核对已保存文件和工具结果，保留既有产物，不重复执行结果未知的副作用；按当前会话上下文继续。',
  });
  const durable: BaseMessage[] = [...bootstrap, firstInput];
  const writes: string[] = [];
  const artifacts = new Map<string, string>();
  let reads = 0;
  const tools = {
    list: async () => [],
    read: async () => {
      reads++;
      return JSON.stringify({
        path,
        content: source + '//CURRENT_READ_KEEP',
        offset: 0,
        totalCharacters: (source + '//CURRENT_READ_KEEP').length,
        nextOffset: null,
      });
    },
    write: async (file: string, content: string) => {
      writes.push(file);
      artifacts.set(file, content);
      return '已保存';
    },
    remove: async () => '',
    figma: async () => '',
    rules: async () => '',
    slices: async () => '',
  };
  const config = {
    instructions: '保留用户约束，完成未完成项；已有产物不表示验收通过',
    maxTurns: 8,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: guard,
    tools,
  };
  const firstModel = new FakeToolCallingModel();
  firstModel.bindTools = () => firstModel;
  let firstRequests = 0;
  firstModel._generate = async () => {
    if (firstRequests++) throw new Error('OFFLINE_INTERRUPTED');
    const message = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'first-read', name: 'read_file', args: { path, resource: false } },
        { id: 'first-write', name: 'write_file', args: { path: 'first.tsx', content: source } },
      ],
    });
    return { generations: [{ text: message.text, message }] };
  };
  await assert.rejects(
    runAgent({
      ...config,
      model: firstModel,
      checkpoint: first as unknown as AgentCheckpoint,
      bootstrapHistory: bootstrap,
      messages: [firstInput],
      onMessage: async (message) => {
        durable.push(message);
      },
    }),
  );
  assert.equal(firstRequests, 2);
  await createRecoveryMarker(first as never).set(true);
  const originalStorage = JSON.stringify(first.storage);
  const persisted = JSON.stringify(durable.map((message) => message.toDict()));
  // 发布后新进程：从序列化状态创建新 saver 与新消息实例，丢弃全部内存视图缓存。
  const rebuilt = memory(first);
  const stable = mapStoredMessagesToChatMessages(JSON.parse(persisted));
  const current = new HumanMessage({
    id: 'new-authorized-user',
    content: '继续。NEW_CONSTRAINT_KEEP：只补剩余交互，不覆盖用户修改，仍需真实验收',
  });
  const captures: BaseMessage[][] = [];
  const nextModel = new FakeToolCallingModel();
  nextModel.bindTools = () => nextModel;
  nextModel._generate = async (messages: BaseMessage[]) => {
    captures.push(messages);
    const message =
      captures.length === 1
        ? new AIMessage({
            content: '',
            tool_calls: [
              { id: 'current-read', name: 'read_file', args: { path, resource: false } },
              {
                id: 'current-write',
                name: 'write_file',
                args: { path: 'current.tsx', content: source },
              },
            ],
          })
        : new AIMessage('已保留产物；未完成验收保持待处理，不推断通过。');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    ...config,
    model: nextModel,
    checkpoint: rebuilt as unknown as AgentCheckpoint,
    messages: [current],
    recoverHistory: async () => stable,
    previousUserTexts: stable.filter(HumanMessage.isInstance).map((message) => message.text),
    readGuidance: async (applied) =>
      applied.includes('authorized-guidance')
        ? []
        : [
            {
              id: 'authorized-guidance',
              message: {
                role: 'user',
                content: 'GUIDANCE_KEEP：不要改变页面的已有尺寸，继续完成剩余项',
              },
            },
          ],
  });
  assert.equal(captures.length, 2);
  const dump = JSON.stringify(captures[1]);
  for (const text of [
    'OLD_CONSTRAINT_KEEP',
    'UNFINISHED_KEEP',
    'NEW_CONSTRAINT_KEEP',
    'UNKNOWN_WRITE_ARGUMENT_KEEP',
    'UNKNOWN_SIDE_EFFECT_KEEP',
    'CURRENT_READ_KEEP',
    'GUIDANCE_KEEP',
  ])
    assert.ok(dump.includes(text), text);
  for (const id of ['v1', 'v2', 'first-read']) {
    const result = captures[0]
      .filter(ToolMessage.isInstance)
      .find((message) => message.tool_call_id === id)!;
    const reference = JSON.parse(result.text);
    assert.equal(reference.type, 'historical_source_reference');
    const archived = JSON.parse((await archiveFor(rebuilt).load(reference.archivePath))!);
    assert.equal(
      archived.result.data.content,
      stable.filter(ToolMessage.isInstance).find((message) => message.tool_call_id === id)!.content,
    );
  }
  const currentCall = captures[1]
    .filter(AIMessage.isInstance)
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.id === 'current-write')!;
  assert.notEqual(currentCall.args.content, source, '当前成功的大段写入继续沿用原压缩机制');
  assert.match(currentCall.args.content, /仅模型视图省略已保存正文/);
  const savedCurrent = captures[1]
    .filter(ToolMessage.isInstance)
    .find((message) => message.tool_call_id === 'current-write')!;
  assert.equal(savedCurrent.text, '已保存');
  const oldWrite = captures[0]
    .filter(AIMessage.isInstance)
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.id === 'first-write')!;
  const writeReference = JSON.parse(oldWrite.args.content);
  assert.equal(writeReference.type, 'historical_source_reference');
  const writeArchive = JSON.parse((await archiveFor(rebuilt).load(writeReference.archivePath))!);
  assert.equal(
    writeArchive.request.data.tool_calls.find((call: { id: string }) => call.id === 'first-write')
      .args.content,
    source,
  );
  assert.equal(artifacts.get('current.tsx'), source, '压缩只影响模型视图，工具真实保存完整源码');
  assert.deepEqual(writes, ['first.tsx', 'current.tsx'], '历史未知/成功副作用不重放');
  assert.equal(reads, 2);
  assert.equal(await createRecoveryMarker(rebuilt as never).pending(), false);
  assert.equal(JSON.stringify(durable.map((message) => message.toDict())), persisted);
  assert.equal(JSON.stringify(first.storage), originalStorage, '旧持久化快照不被视图改写');
});

/** 首次生成也必须保持已有成功写入压缩，随后 read_file 仍返回真实完整文件。 */
test('fresh graph compacts a large successful write while its saved file and latest read remain complete', async () => {
  const files = new Map<string, string>();
  const captures: BaseMessage[][] = [];
  const durable: BaseMessage[] = [];
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages: BaseMessage[]) => {
    captures.push(messages);
    const message =
      captures.length === 1
        ? new AIMessage({
            content: '',
            tool_calls: [
              { id: 'fresh-write', name: 'write_file', args: { path, content: source } },
            ],
          })
        : captures.length === 2
          ? new AIMessage({
              content: '',
              tool_calls: [
                { id: 'fresh-read', name: 'read_file', args: { path, resource: false } },
              ],
            })
          : new AIMessage('代码已保存，验收仍需按原要求执行');
    return { generations: [{ text: message.text, message }] };
  };
  const user = new HumanMessage({
    id: 'fresh-user',
    content: 'FRESH_CONSTRAINT_KEEP：实现页面并保留所有设计要求',
  });
  await runAgent({
    model,
    messages: [user],
    instructions: '保存源码不表示验收通过',
    checkpoint: memory() as unknown as AgentCheckpoint,
    maxTurns: 4,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: guard,
    onMessage: async (message) => {
      durable.push(message);
    },
    tools: {
      list: async () => [],
      write: async (file, content) => {
        files.set(file, content);
        return '已保存';
      },
      read: async (file) => {
        const content = files.get(file)!;
        return JSON.stringify({
          path: file,
          content,
          offset: 0,
          totalCharacters: content.length,
          nextOffset: null,
        });
      },
      remove: async () => '',
      figma: async () => '',
      rules: async () => '',
      slices: async () => '',
    },
  });
  assert.equal(captures.length, 3);
  for (const messages of captures.slice(1)) {
    const call = messages
      .filter(AIMessage.isInstance)
      .flatMap((message) => message.tool_calls ?? [])
      .find((call) => call.id === 'fresh-write')!;
    assert.match(call.args.content, /仅模型视图省略已保存正文/);
    assert.ok(call.args.content.length < source.length * 0.1);
    assert.ok(messages.some((message) => message.text.includes('FRESH_CONSTRAINT_KEEP')));
  }
  assert.equal(files.get(path), source);
  const readBack = captures[2]
    .filter(ToolMessage.isInstance)
    .find((message) => message.tool_call_id === 'fresh-read')!;
  assert.equal(JSON.parse(readBack.text).content, source);
  const originalWrite = durable
    .filter(AIMessage.isInstance)
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.id === 'fresh-write')!;
  assert.equal(originalWrite.args.content, source);
});

test('only trusted input and applied guidance IDs advance historical source boundary; latest reads and constraints stay visible', async () => {
  const saver = memory();
  const archive = archiveFor(saver);
  const input = new HumanMessage({ id: 'authorized', content: '继续' });
  const guidance = new HumanMessage({
    id: 'guidance',
    content: 'NEW_REQUIREMENT_KEEP：保留当前尺寸',
  });
  const platform = new HumanMessage({
    id: 'platform',
    content: '普通过程通知：还需核对截图，无平台前缀也不能成为授权输入',
  });
  const messages = [
    ...read('old'),
    input,
    ...read('before-guidance'),
    guidance,
    ...read('current'),
    platform,
  ];
  const model = new FakeToolCallingModel();
  const summary = createContextSummary({
    archive,
    model,
    budget: 1000000,
    signal: new AbortController().signal,
    beforeRequest: guard,
    recordUsage: () => {},
    overhead: () => 0,
    historicalSourceInputId: input.id,
    view: (values) => modelContextView(values, 1000000),
  });
  await summary.wrapModelCall!(
    {
      model,
      messages,
      systemMessage: new SystemMessage('固定约束'),
      tools: [],
      state: { guidanceApplied: ['guidance'] },
    } as never,
    (async (request: { messages: BaseMessage[] }) => {
      assert.equal(JSON.parse(request.messages[1].text).type, 'historical_source_reference');
      assert.equal(JSON.parse(request.messages[4].text).type, 'historical_source_reference');
      assert.equal(request.messages[7], messages[7]);
      assert.equal(request.messages[5], guidance);
      assert.equal(request.messages[8], platform);
      return new AIMessage('继续');
    }) as never,
  );
  const currentWrite = new AIMessage({
    content: '',
    tool_calls: [{ id: 'write', name: 'write_file', args: { path, content: source } }],
  });
  const saved = new ToolMessage({ name: 'write_file', tool_call_id: 'write', content: '已保存' });
  const currentView = modelContextView([input, currentWrite, saved, platform], 1000000);
  assert.notEqual(currentView[1], currentWrite);
  assert.equal(currentView[0], input);
  assert.equal(currentView[3], platform);
});

test('feedback dedup keeps latest exact corrective receipt and all unknown, storage, cancellation and differing failures', () => {
  const detail = '真实错误细节必须保持；'.repeat(100);
  const pair = (
    id: string,
    content: string,
    args = { path, mode: 'block' },
    name = 'check_rules',
  ) => [
    new AIMessage({ content: '', tool_calls: [{ id, name, args }] }),
    new ToolMessage({ name, tool_call_id: id, status: 'error', content }),
  ];
  const feedback = JSON.stringify(toolFeedback('RULES_FAILED', { detail }));
  const one = pair('one', feedback),
    two = pair('two', feedback);
  const messages = [...one, ...two];
  const original = JSON.stringify(messages.map((message) => message.toDict()));
  const view = repeatedFeedbackView(messages);
  assert.equal(JSON.parse(view[1].text).duplicateOfToolCallId, 'two');
  assert.equal(view[3], two[1]);
  assert.equal(JSON.stringify(messages.map((message) => message.toDict())), original);
  assert.deepEqual(
    repeatedFeedbackView(view).map((message) => message.toDict()),
    view.map((message) => message.toDict()),
  );
  for (const content of [
    JSON.stringify({ ...JSON.parse(feedback), outcome: 'unknown' }),
    JSON.stringify({ ...JSON.parse(feedback), error: 'STORAGE_FAILED' }),
    JSON.stringify({ ...JSON.parse(feedback), reason: 'CANCELLED' }),
    JSON.stringify({ ...JSON.parse(feedback), cancelled: true }),
    JSON.stringify(toolFeedback('NETWORK_RETRY', { detail })),
    JSON.stringify({ success: false, reason: 'CANCELLED', detail }),
    JSON.stringify({ success: false, reason: 'STORAGE_FAILED', detail }),
  ]) {
    const raw = [...pair('a', content), ...pair('b', content)];
    assert.deepEqual(repeatedFeedbackView(raw), raw);
  }
  for (const different of [
    pair('different', JSON.stringify(toolFeedback('RULES_FAILED', { detail: detail + 'changed' }))),
    pair('different', feedback, { path: 'other', mode: 'block' }),
  ]) {
    assert.equal(repeatedFeedbackView([...one, ...different])[1], one[1]);
  }
  assert.deepEqual(repeatedFeedbackView([one[0], one[1], one[1], ...two]), [
    one[0],
    one[1],
    one[1],
    ...two,
  ]);
});
