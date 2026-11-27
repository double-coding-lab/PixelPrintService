import './helpers/projectFixture';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { StateBackend } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { coveredReadView } from '../src/functions/d2c/run/agent/readCoverage';
import { modelContextView } from '../src/functions/d2c/run/agent/context';
import { createContextSummary } from '../src/functions/d2c/run/agent/summary';
import { createHistoryArchive, type HistoryArchive } from '../src/functions/d2c/run/agent/archive';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';
import { createFixedResourceBackend } from '../src/functions/d2c/run/agent/resources';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';

const text = Array.from(
  { length: 700 },
  (_, i) => `规则${i}：保留尺寸、文字、布局与交互🙂。\n`,
).join('');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function read(id: string, start: number, end: number, extra = {}, args = {}): BaseMessage[] {
  return [
    new AIMessage({
      id: `call-${id}`,
      content: '',
      tool_calls: [
        {
          id,
          name: 'read_file',
          args: { path: '/resources/templates/skills/pp-d2c/SKILL.md', resource: true, ...args },
        },
      ],
    }),
    new ToolMessage({
      id: `result-${id}`,
      name: 'read_file',
      tool_call_id: id,
      status: 'success',
      response_metadata: { keep: 'metadata' },
      content: JSON.stringify({
        offset: start,
        content: text.slice(start, end),
        totalCharacters: text.length,
        nextOffset: end === text.length ? null : end,
        sha256: digest(text),
        ...extra,
      }),
    }),
  ];
}
const pages = () => [
  ...read('old', 0, text.length),
  ...read('a', 0, 5000),
  ...read('b', 5000, 10000),
  ...read('c', 10000, text.length),
];
function originalsRetained(messages: BaseMessage[]) {
  const coverage = new Array(text.length).fill(false);
  for (const result of messages.filter(ToolMessage.isInstance)) {
    if (result.status === 'error') continue;
    const page = JSON.parse(result.text);
    if (typeof page.content !== 'string') continue;
    assert.equal(page.content, text.slice(page.offset, page.offset + page.content.length));
    for (let i = page.offset; i < page.offset + page.content.length; i++) coverage[i] = true;
  }
  assert.ok(coverage.every(Boolean), '每一个原字符都必须在当前上下文内可见');
}

test('不同页长的后续多页完整覆盖旧页，逐字保留全部信息与元数据且无引用链', () => {
  const messages = pages();
  const original = JSON.stringify(messages.map((m) => m.toDict()));
  const view = coveredReadView(messages);
  const ref = JSON.parse(view[1].text);
  assert.equal(ref.type, 'context_reference');
  assert.deepEqual(
    ref.coveredBy.map((p: any) => p.toolCallId),
    ['a', 'b', 'c'],
  );
  assert.equal(view.length, messages.length);
  assert.equal(view[1].id, messages[1].id);
  assert.deepEqual(view[1].response_metadata, messages[1].response_metadata);
  originalsRetained(view);
  assert.equal(JSON.stringify(messages.map((m) => m.toDict())), original);
  assert.deepEqual(
    coveredReadView(view).map((m) => m.toDict()),
    view.map((m) => m.toDict()),
  );
  const last = JSON.parse(view[7].text);
  assert.equal(last.content, text.slice(10000));
});

test('低Token重复文字不因替换为引用而增加模型输入', () => {
  const low = 'a'.repeat(2000);
  const version = { sha256: digest(low), totalCharacters: low.length };
  const messages = [
    ...read('old', 0, 2000, { ...version, content: low, nextOffset: null }),
    ...read('a', 0, 1000, { ...version, content: low.slice(0, 1000), nextOffset: 1000 }),
    ...read('b', 1000, 2000, { ...version, content: low.slice(1000), nextOffset: null }),
  ];
  const view = coveredReadView(messages);
  assert.ok(
    estimateTokens(view.map((m) => m.toDict())) <= estimateTokens(messages.map((m) => m.toDict())),
  );
});

test('恢复或摘要只剩较旧页时重新提供正文，不依赖跨请求已读状态', () => {
  const messages = pages();
  coveredReadView(messages);
  assert.equal(coveredReadView(messages.slice(0, 2))[1], messages[1]);
  const restored = messages.slice(0, 2).map((m) => m.toDict());
  assert.equal((coveredReadView(messages.slice(0, 2))[1] as ToolMessage).text, messages[1].text);
  assert.deepEqual(
    messages.slice(0, 2).map((m) => m.toDict()),
    restored,
  );
});

test('部分重叠、覆盖有缺口、不同版本和资源范围不能折叠旧页', () => {
  for (const later of [
    read('new', 3000, 10000),
    [...read('a', 0, 4999), ...read('b', 5000, 10000)],
    read('new', 0, 10000, { sha256: digest('changed') }),
    read('new', 0, 10000, {}, { resource: false }),
    read('new', 0, 10000, {}, { path: 'other.md' }),
  ]) {
    const messages = [...read('old', 0, 10000), ...later];
    assert.equal(coveredReadView(messages)[1], messages[1]);
  }
});

test('旧回执无版本、异常/未知及扩展字段、冲突正文与歧义配对均保持原文', () => {
  for (const extra of [
    { sha256: undefined },
    { sha256: 42 },
    { error: 'failed' },
    { ok: false },
    { outcome: 'unknown' },
    { warning: 'MUST_KEEP_WARNING' },
    { offset: -1 },
    { nextOffset: 1 },
  ]) {
    const messages = [...read('old', 0, 10000, extra), ...read('new', 0, text.length)];
    assert.equal(coveredReadView(messages)[1], messages[1]);
  }
  const old = read('old', 0, text.length),
    newer = read('new', 0, text.length, { content: text.replace('规则0', '已变0') });
  for (const messages of [
    [...old, ...newer],
    [...old, ...read('old', 0, text.length)],
    [old[0], old[1], old[1], ...read('new', 0, text.length)],
    [
      old[0],
      new ToolMessage({ ...(old[1] as ToolMessage), status: 'error' }),
      ...read('new', 0, text.length),
    ],
  ]) {
    assert.deepEqual(
      coveredReadView(messages).map((m) => m.toDict()),
      messages.map((m) => m.toDict()),
    );
  }
});

test('真实摘要中间件在无损区间去重后避免一次多余摘要，需求和失败信息不丢失', async () => {
  const current = new HumanMessage({
    id: 'current',
    content: 'CURRENT_REQUIREMENT_KEEP：只修改交互，保留布局',
  });
  const failure = new ToolMessage({
    name: 'read_file',
    tool_call_id: 'failed',
    status: 'error',
    content: 'ACTUAL_FAILURE_KEEP',
  });
  const messages = [
    current,
    ...pages(),
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'read_file', id: 'failed', args: { path: 'missing' } }],
    }),
    failure,
  ];
  const budget = Math.ceil(
    estimateTokens(modelContextView(messages, 1000000).map((m) => m.toDict())) / 0.6,
  );
  assert.ok(estimateTokens(messages.map((m) => m.toDict())) > budget * 0.7);
  for (const optimized of [false, true]) {
    const data = new Map<string, string>();
    let calls = 0;
    const model = new FakeToolCallingModel();
    model._generate = async () => {
      calls++;
      const message = new AIMessage('保留用户要求和真实失败；资料按快照回读');
      return { generations: [{ text: message.text, message }] };
    };
    const archive = {
      backend: new StateBackend({ state: { files: {} } }),
      assertHealthy() {},
      load: async (p: string) => data.get(p),
      save: async (p: string, c: string) => {
        data.set(p, c);
        return { path: p };
      },
    } as unknown as HistoryArchive;
    const middleware = createContextSummary({
      archive,
      model,
      budget,
      overhead: () => 0,
      signal: new AbortController().signal,
      beforeRequest: async () => {},
      recordUsage() {},
      historicalSourceInputId: current.id,
      ...(optimized ? { view: (m: BaseMessage[]) => modelContextView(m, budget) } : {}),
    });
    let output: BaseMessage[] = [];
    await middleware.wrapModelCall!(
      {
        model,
        messages,
        systemMessage: new SystemMessage('保留真实约束'),
        tools: [],
        state: {},
      } as never,
      (async (r: { messages: BaseMessage[] }) => {
        output = r.messages;
        return new AIMessage('继续');
      }) as never,
    );
    assert.ok(
      output.some((m) => m.id === current.id),
      '当前用户要求逐字保留',
    );
    assert.ok(
      output.some((m) => m.text.includes('ACTUAL_FAILURE_KEEP')),
      '最新失败保留',
    );
    if (optimized) {
      assert.equal(calls, 0);
      originalsRetained(output);
    } else {
      assert.ok(calls > 0);
      const snapshot = [...data].find(([p]) => p.startsWith('/history/snapshot_'));
      assert.equal(snapshot?.[1], JSON.stringify(messages.map((m) => m.toDict())));
    }
  }
});

test('真实固定包及历史分页返回整份正文版本，重读与分批版本一致，更新版本独立', async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'read-coverage-'));
  try {
    const bundle = await readTemplateResources(path.resolve('pixelprint'), await realpath(empty));
    const resources = createFixedResourceBackend({
      bundle,
      bundleHash: bundle.hash,
      target: 'h5',
      signal: new AbortController().signal,
      assertLease: async () => {},
    });
    const resourcePath = '/resources/templates/skills/pp-d2c/SKILL.md';
    const full = JSON.parse(await resources.readText(resourcePath, 0, 256000));
    const partial = JSON.parse(await resources.readText(resourcePath, 10, 1000));
    assert.equal(full.sha256, digest(full.content));
    assert.equal(partial.sha256, full.sha256);
    assert.equal(partial.content, full.content.slice(10, 1010));

    // 用真实Agent注册的schema和固定包验证目录到正文的工具调用链。
    let step = 0;
    let selected: { offset: number; end: number };
    const model = new FakeToolCallingModel();
    model.bindTools = () => model;
    model._generate = async (messages: BaseMessage[]) => {
      const latest = messages.filter(ToolMessage.isInstance).at(-1);
      let args: Record<string, unknown>;
      if (step === 0)
        args = { path: resourcePath, resource: true, view: 'outline', offset: 0, length: 4 };
      else if (step === 1) {
        const outline = JSON.parse(latest!.text);
        assert.equal(outline.view, 'outline');
        assert.equal(outline.sha256, full.sha256);
        assert.equal(outline.content, undefined);
        selected =
          outline.sections.find((s: { level: number }) => s.level >= 2) ?? outline.sections[0];
        args = {
          path: resourcePath,
          resource: true,
          view: 'full',
          offset: selected.offset,
          length: selected.end - selected.offset,
        };
      } else if (step === 2) {
        const page = JSON.parse(latest!.text);
        assert.equal(page.content, full.content.slice(selected.offset, selected.end));
        args = { path: 'page.tsx', resource: false, view: 'outline' };
      } else {
        assert.equal(JSON.parse(latest!.text).code, 'INVALID_ARGUMENT');
        const message = new AIMessage('已按章节读取真实正文，目录不作为检查通过的证据');
        return { generations: [{ text: message.text, message }] };
      }
      const message = new AIMessage({
        content: '',
        tool_calls: [{ name: 'read_file', id: `outline-${step++}`, args }],
      });
      return { generations: [{ text: message.text, message }] };
    };
    await runAgent({
      model,
      tools: {
        list: async () => [],
        read: async () => assert.fail('不读取会话正文'),
        write: async () => assert.fail('不写入'),
        remove: async () => '',
        figma: async () => '',
        rules: async () => '',
        slices: async () => '',
      },
      resources: { bundle, bundleHash: bundle.hash, target: 'h5' },
      messages: [new HumanMessage('只查看生成流程中的一段规则')],
      instructions: '只读资料定位',
      maxTurns: 5,
      contextBudgetTokens: 1000000,
      signal: new AbortController().signal,
      assertLease: async () => {},
    });
    assert.equal(step, 3);

    const saver = Object.assign(new MemorySaver(), {
      config: (ns = '') => ({ configurable: { thread_id: 'read-coverage', checkpoint_ns: ns } }),
    });
    const archive = createHistoryArchive({
      checkpoint: saver as unknown as Parameters<typeof createHistoryArchive>[0]['checkpoint'],
      guard: async () => {},
    });
    await archive.save('/history/read.json', text);
    const a = JSON.parse(await archive.readText('/history/read.json', 0, 1000)),
      b = JSON.parse(await archive.readText('/history/read.json', 1000, 1000));
    assert.equal(a.sha256, digest(text));
    assert.equal(a.sha256, b.sha256);
    await archive.save('/history/read.json', text + 'changed');
    assert.notEqual(
      JSON.parse(await archive.readText('/history/read.json', 0, 1000)).sha256,
      a.sha256,
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
