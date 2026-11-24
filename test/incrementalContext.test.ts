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
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { createHistoryArchive } from '../src/functions/d2c/run/agent/archive';
import { createHistoricalSourceView } from '../src/functions/d2c/run/agent/incrementalContext';
import { modelContextView, completedWriteView } from '../src/functions/d2c/run/agent/context';
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';
import { hasPairedRulesFailure } from '../src/functions/d2c/run/agent/reasoning';
import { toolFeedback } from '../src/functions/d2c/run/toolFeedback';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { AgentCheckpoint } from '../src/functions/d2c/run/agent/subagentCheckpoint';

const source = 'const selected = "设计约束：保留原有间距与尺寸";\n'.repeat(400);
const input = new HumanMessage({
  id: 'admission',
  content: '只修复轮播点击居中，保留设计与布局约束',
});

/** 实际HistoryArchive和分页协议，存储由MemorySaver承载，不访问模型或数据库。 */
function fixture() {
  const saver = Object.assign(new MemorySaver(), {
    config: (namespace = '', id?: string) => ({
      configurable: {
        thread_id: 'source-context',
        checkpoint_ns: namespace,
        ...(id ? { checkpoint_id: id } : {}),
      },
    }),
  });
  const archive = createHistoryArchive({
    checkpoint: saver as unknown as Parameters<typeof createHistoryArchive>[0]['checkpoint'],
    guard: async () => {},
  });
  return { archive, view: createHistoricalSourceView(archive, 1000000), saver };
}

/** 标准源码分页，附带唯一工具配对和版本摘要。 */
function read(
  id: string,
  content = source,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): BaseMessage[] {
  return [
    new AIMessage({
      id: `call-${id}`,
      content: '',
      tool_calls: [
        { id, name: 'read_file', args: { path: 'pages/page/index.tsx', resource: false, ...args } },
      ],
    }),
    new ToolMessage({
      id: `result-${id}`,
      name: 'read_file',
      tool_call_id: id,
      status: 'success',
      response_metadata: { retained: true },
      content: JSON.stringify({
        path: 'pages/page/index.tsx',
        content,
        offset: 0,
        totalCharacters: content.length,
        nextOffset: null,
        sha256: createHash('sha256').update(content).digest('hex'),
        ...extra,
      }),
    }),
  ];
}

/** 验证真实归档可按分页完整拼回，并校验版本哈希。 */
async function recover(archive: ReturnType<typeof createHistoryArchive>, reference: string) {
  const info = JSON.parse(reference);
  let offset = 0;
  let text = '';
  while (true) {
    const page = JSON.parse(await archive.readText(info.archivePath, offset, 1000));
    text += page.content;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(text.length, info.characters);
  assert.equal(createHash('sha256').update(text).digest('hex'), info.sha256);
  return JSON.parse(text);
}

test('显式输入前的大源码按版本完整回读；用户约束、设计、规则失败及当前读取保留', async () => {
  const { archive, view } = fixture();
  const design = new HumanMessage({
    id: 'design',
    content: [
      { type: 'text', text: 'DESIGN_KEEP：保留32px间距、原图与配色' },
      { type: 'image_url', image_url: { url: 'attachment://fixture' } },
    ],
  });
  const rules: BaseMessage[] = [
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'rules', name: 'check_rules', args: { path: 'page', mode: 'merge' } }],
    }),
    new ToolMessage({
      name: 'check_rules',
      tool_call_id: 'rules',
      content: JSON.stringify(toolFeedback('RULES_FAILED')),
    }),
  ];
  const messages = [
    design,
    ...read('v1'),
    ...read('v2', source + '// version2'),
    ...rules,
    input,
    ...read('current'),
    new HumanMessage({ id: 'platform-screenshot', content: '平台截图与验收通知' }),
  ];
  const original = JSON.stringify(messages.map((m) => m.toDict()));
  const result = await view(messages, input.id);
  const one = await recover(archive, result[2].text);
  const two = await recover(archive, result[4].text);
  assert.deepEqual(one.result, messages[2].toDict());
  assert.deepEqual(two.result, messages[4].toDict());
  assert.notEqual(JSON.parse(result[2].text).archivePath, JSON.parse(result[4].text).archivePath);
  for (const i of [0, 5, 6, 7, 8, 9, 10]) assert.equal(result[i], messages[i]);
  assert.equal(hasPairedRulesFailure(result), true);
  assert.equal(JSON.stringify(messages.map((m) => m.toDict())), original);
  assert.deepEqual(
    (await view(result, input.id)).map((m) => m.toDict()),
    result.map((m) => m.toDict()),
  );
  assert.ok(
    estimateTokens(result.map((m) => m.toDict())) <
      estimateTokens(messages.map((m) => m.toDict())) * 0.55,
  );
});

test('无唯一明确输入、已摘要前缀、规则资料、未知回执和不完整配对均保守保留', async () => {
  const { view } = fixture();
  const history = read('source');
  for (const id of [undefined, 'missing']) {
    const messages = [...history, input];
    assert.equal(await view(messages, id), messages);
  }
  const duplicated = [...history, input, input];
  assert.equal(await view(duplicated, input.id), duplicated);
  const covered = [...history, input];
  assert.equal(await view(covered, input.id, history.length), covered);
  for (const old of [
    read('old', source, { resource: true }),
    read('old', source, { path: 'rules.md' }, { path: 'rules.md' }),
    read('old', source, {}, { outcome: 'unknown' }),
    read('old', source, {}, { error: 'FAILED' }),
    read('old', source, {}, { nextOffset: 1 }),
    [history[0], history[1], history[1]],
    [history[1]],
  ]) {
    const messages = [...old, input];
    const result = await view(messages, input.id);
    result.forEach((message, index) => assert.equal(message, messages[index]));
  }
});

test('已覆盖的成功写入/局部替换保留各自原始参数版本，未知副作用仍原文', async () => {
  const { archive, view } = fixture();
  const write = new AIMessage({
    content: '保留阶段决策',
    tool_calls: [
      { id: 'write', name: 'write_file', args: { path: 'pages/page/index.tsx', content: source } },
    ],
  });
  const saved = new ToolMessage({ name: 'write_file', tool_call_id: 'write', content: '已保存' });
  const edit = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'edit',
        name: 'edit_file',
        args: {
          path: 'pages/page/index.tsx',
          oldText: source,
          newText: source + '//changed',
          expectedSha256: 'a'.repeat(64),
        },
      },
    ],
  });
  const edited = new ToolMessage({
    name: 'edit_file',
    tool_call_id: 'edit',
    content: '{"ok":true,"outcome":"applied"}',
  });
  const uncertain = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'unknown',
        name: 'write_file',
        args: { path: 'pages/page/index.tsx', content: source },
      },
    ],
  });
  const unknownResult = new ToolMessage({
    name: 'write_file',
    tool_call_id: 'unknown',
    content: '{"outcome":"unknown"}',
  });
  const messages = [write, saved, edit, edited, uncertain, unknownResult, input];
  const archived = await view(messages, input.id);
  const result = modelContextView(archived, 1000000);
  for (const budget of [256, 1000000])
    for (const index of [0, 2])
      assert.equal(
        modelContextView(archived, budget)[index],
        archived[index],
        '低预算也不能再省略版本归档入口',
      );
  for (const i of [0, 2]) {
    const call = (result[i] as AIMessage).tool_calls![0];
    const reference = call.args.content ?? call.args.oldText;
    const original = await recover(archive, reference);
    assert.deepEqual(original.request, messages[i].toDict());
    assert.ok(JSON.parse(reference).message.includes('未向文件写入此占位说明'));
  }
  assert.equal(result[4], uncertain);
  assert.equal(result[5], unknownResult);
  assert.equal((result[2] as AIMessage).tool_calls![0].args.expectedSha256, 'a'.repeat(64));
});

test('归档写失败阻断后续请求，损坏缓存不被当作已归档', async () => {
  for (const corrupted of [false, true]) {
    const { archive } = fixture();
    let failed = false;
    const unsafe = {
      ...archive,
      load: async () => (corrupted ? 'damaged' : undefined),
      save: async () => {
        failed = true;
        throw new Error('ARCHIVE_SAVE_FAILED');
      },
    };
    await assert.rejects(
      createHistoricalSourceView(unsafe, 1000000)([...read('old'), input], input.id),
      corrupted ? /DEEP_ARCHIVE_INVALID/ : /ARCHIVE_SAVE_FAILED/,
    );
    assert.equal(failed, !corrupted);
  }
});

test('summary在首个handler预算检查前准备归档视图，不触发摘要也能减少输入；最新guidance划定边界', async () => {
  const { archive } = fixture();
  const guidance = new HumanMessage({ id: 'guidance', content: '继续修复拖动途中的选中项' });
  const messages = [
    ...read('old'),
    input,
    ...read('before-guidance'),
    guidance,
    ...read('after-guidance'),
    new HumanMessage({ id: 'platform', content: '平台截图通知' }),
  ];
  const model = new FakeToolCallingModel();
  let summaries = 0;
  model._generate = async () => {
    summaries++;
    throw new Error('UNEXPECTED_SUMMARY');
  };
  const middleware = createContextSummary({
    archive,
    model,
    budget: 1000000,
    signal: new AbortController().signal,
    beforeRequest: async () => {},
    recordUsage: () => {},
    overhead: () => 0,
    view: (values) => modelContextView(values, 1000000),
    historicalSourceBoundaryId: (state) => (state as { boundary?: string }).boundary,
  });
  let checked = false;
  await middleware.wrapModelCall!(
    {
      model,
      messages,
      systemMessage: new SystemMessage('固定约束'),
      tools: [],
      state: { boundary: guidance.id },
    } as never,
    (async (request: { messages: BaseMessage[] }) => {
      assert.equal(JSON.parse(request.messages[1].text).type, 'historical_source_reference');
      assert.equal(JSON.parse(request.messages[4].text).type, 'historical_source_reference');
      assert.equal(request.messages[7], messages[7], '当前guidance后的读取不被截图通知推进边界');
      assert.ok(
        estimateTokens(request.messages.map((m) => m.toDict())) <
          estimateTokens(messages.map((m) => m.toDict())) * 0.55,
      );
      checked = true;
      return new AIMessage('继续');
    }) as never,
  );
  assert.equal(checked, true);
  assert.equal(summaries, 0);
});

test('成功写入只有唯一完整配对才省略参数，歧义、流式和多媒体不构成成功证据', () => {
  const request = new AIMessage({
    content: '',
    tool_calls: [{ id: 'write', name: 'write_file', args: { path: 'page.tsx', content: source } }],
  });
  const result = new ToolMessage({ name: 'write_file', tool_call_id: 'write', content: '已保存' });
  for (const messages of [
    [request, result, result],
    [request, result, request, result],
    [request, new ToolMessage({ ...result, content: [{ type: 'text', text: '已保存' }] })],
  ]) {
    assert.equal(completedWriteView(messages, 1000000)[0], request);
  }
});

test('真实runAgent的首次大历史输入先归档再过guard预算，当前任务无需模型摘要', async () => {
  const { saver } = fixture();
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  let captured: BaseMessage[] = [];
  model._generate = async (messages: BaseMessage[]) => {
    assert.ok(!messages[0].text.startsWith('压缩以下对话资料'), '历史成功源码应先减负，不必摘要');
    captured = messages;
    throw new Error('STOP_AFTER_FIRST_CONTEXT');
  };
  await assert.rejects(
    runAgent({
      model,
      checkpoint: saver as unknown as AgentCheckpoint,
      instructions: '保留真实设计、失败与用户约束',
      bootstrapHistory: [...read('old-v1'), ...read('old-v2', source + '//v2')],
      messages: [input],
      reasoningAdmissionId: input.id,
      reasoningUserText: input.text,
      reasoningContext: { hasSourceFiles: true, hasDesign: true },
      maxTurns: 6,
      contextBudgetTokens: 12000,
      signal: new AbortController().signal,
      assertLease: async () => {},
      tools: {
        list: async () => [],
        read: async () => '',
        write: async () => '',
        remove: async () => '',
        figma: async () => '',
        rules: async () => '',
        slices: async () => '',
        preview: {
          build: async () => '{}',
          inspect: async () => '{}',
          needsInspection: async () => false,
        },
      },
    }),
    (error: unknown) => {
      let cause = error;
      for (let depth = 0; depth < 10 && cause instanceof Error; depth++) {
        if (cause.message === 'STOP_AFTER_FIRST_CONTEXT') return true;
        cause = cause.cause;
      }
      return false;
    },
  );
  const results = captured
    .filter(ToolMessage.isInstance)
    .filter((m) => ['old-v1', 'old-v2'].includes(m.tool_call_id));
  assert.equal(results.length, 2);
  assert.ok(results.every((m) => JSON.parse(m.text).type === 'historical_source_reference'));
  assert.ok(captured.some((m) => m.id === input.id));
});
