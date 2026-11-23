import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { createHash } from 'node:crypto';
import {
  modelContextView,
  repeatedReadView,
  completedWriteView,
} from '../src/functions/d2c/run/agent/context';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { GenerationTools } from '../src/functions/d2c/run/types';
const source = 'const title = "当前区块源码与真实设计数据";\n'.repeat(300);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function read(
  id: string,
  content = source,
  args: Record<string, unknown> = {},
  value: Record<string, unknown> = {},
): BaseMessage[] {
  return [
    new AIMessage({
      id: 'request-' + id,
      content: '',
      tool_calls: [
        { id, name: 'read_file', args: { path: 'pages/page/index.tsx', resource: false, ...args } },
      ],
    }),
    new ToolMessage({
      id: 'result-' + id,
      name: 'read_file',
      tool_call_id: id,
      status: 'success',
      content: JSON.stringify({
        path: 'pages/page/index.tsx',
        content,
        offset: 0,
        totalCharacters: content.length,
        nextOffset: null,
        sha256: digest(content),
        ...value,
      }),
      response_metadata: { fixture: 'kept' },
    }),
  ];
}
test('相同读取只保留最近正文，原历史、配对ID和元数据保持不变；重复执行视图幂等', () => {
  const messages = [...read('one'), ...read('two'), ...read('three')];
  const original = JSON.stringify(messages.map((m) => m.toDict()));
  const view = repeatedReadView(messages);
  assert.equal(view.length, messages.length);
  for (const i of [1, 3]) {
    const m = view[i] as ToolMessage;
    const info = JSON.parse(m.text);
    assert.equal(info.type, 'context_reference');
    assert.equal(info.duplicateOfToolCallId, 'three');
    assert.equal(m.tool_call_id, (messages[i] as ToolMessage).tool_call_id);
    assert.deepEqual(m.response_metadata, messages[i].response_metadata);
    assert.equal(m.id, messages[i].id);
    assert.ok(!JSON.stringify(m.toDict()).includes('当前区块源码与真实设计数据'));
  }
  assert.equal(view[5], messages[5]);
  assert.equal(JSON.stringify(messages.map((m) => m.toDict())), original);
  assert.deepEqual(
    repeatedReadView(view).map((m) => m.toDict()),
    view.map((m) => m.toDict()),
  );
  assert.ok(
    estimateTokens(view.map((m) => m.toDict())) <
      estimateTokens(messages.map((m) => m.toDict())) * 0.5,
  );
});
test('独立片段和摘要恢复重新计算视图，不使用跨请求的已读标记', () => {
  const first = read('first'),
    last = read('last');
  const view = repeatedReadView([...first, ...last]);
  assert.equal(JSON.parse(view[1].text).type, 'context_reference');
  assert.equal(repeatedReadView(first)[1], first[1]);
  assert.equal(repeatedReadView(last)[1], last[1]);
  assert.equal(repeatedReadView([...first, ...last])[3], last[1]);
});
test('不同版本、读取页、资源作用域与调用对象保留，真正的错误、未知和非读取回执不折叠', () => {
  for (const other of [
    read('other', source + 'changed'),
    read('other', source, {}, { offset: 10, totalCharacters: source.length + 10 }),
    read('other', source, { resource: true }),
    read('other', source, { path: 'other.tsx' }),
    read('other', source, {}, { sha256: digest('different') }),
  ]) {
    const messages = [...read('one'), ...other];
    assert.equal(repeatedReadView(messages)[1], messages[1]);
  }
  for (const value of [
    { ok: false },
    { success: false },
    { outcome: 'unknown' },
    { error: 'failed' },
  ]) {
    const messages = [...read('one', source, {}, value), ...read('two', source, {}, value)];
    assert.equal(repeatedReadView(messages)[1], messages[1]);
  }
  for (const name of ['check_rules', 'write_file']) {
    const messages = read('one')
      .concat(read('two'))
      .map((m) =>
        AIMessage.isInstance(m)
          ? new AIMessage({ ...m, tool_calls: m.tool_calls!.map((c) => ({ ...c, name })) })
          : new ToolMessage({ ...(m as ToolMessage), name }),
      );
    assert.equal(repeatedReadView(messages)[1], messages[1]);
  }
});
test('歧义配对、孤立结果、失败状态和多媒体结果不作为重复读取证据', () => {
  const one = read('one');
  const two = read('two');
  const result = one[1] as ToolMessage;
  for (const messages of [
    [result, ...two],
    [...one, ...read('one')],
    [one[0], result, result, ...two],
    [one[0], new ToolMessage({ ...result, name: 'figma' }), ...two],
    [one[0], new ToolMessage({ ...result, status: 'error' }), ...two],
    [
      one[0],
      new ToolMessage({
        ...result,
        content: [
          { type: 'text', text: result.text },
          { type: 'image_url', image_url: { url: 'artifact://fixture' } },
        ],
      }),
      ...two,
    ],
  ]) {
    const view = repeatedReadView(messages);
    for (let i = 0; i < messages.length; i++) assert.equal(view[i], messages[i]);
  }
});
test('Figma仅折叠完全相同的inspect-node结果，导出及不同节点始终保留', () => {
  function node(id: string, command = 'inspect-node', nodeId = '1:1') {
    return [
      new AIMessage({
        content: '',
        tool_calls: [
          { id, name: 'figma', args: { command, nodeId, subtree: true, offset: 0, limit: 40 } },
        ],
      }),
      new ToolMessage({
        name: 'figma',
        tool_call_id: id,
        content: JSON.stringify({ nodeId, nodes: [{ text: source }], nextOffset: null }),
      }),
    ];
  }
  const messages = [...node('one'), ...node('two')];
  assert.equal(JSON.parse(repeatedReadView(messages)[1].text).type, 'context_reference');
  for (const other of [node('two', 'export-image'), node('two', 'inspect-node', '1:2')]) {
    const m = [...node('one'), ...other];
    assert.equal(repeatedReadView(m)[1], m[1]);
  }
});
test('百万Token窗口仍压缩成功保存的代码及结构化报告，失败和未知写入不压缩', () => {
  for (const content of [
    source.repeat(3),
    { nativeScan: { fingerprint: 'current' }, nativeReview: [{ reason: source.repeat(3) }] },
  ]) {
    const message = new AIMessage({
      id: 'write',
      content: '阶段说明',
      response_metadata: { finish_reason: 'tool_calls' },
      usage_metadata: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      tool_calls: [
        {
          id: 'write',
          name: 'write_file',
          args: { path: 'pages/page/rule-hits.json', content, complete: false, merge: true },
        },
      ],
    });
    const saved = new ToolMessage({ name: 'write_file', tool_call_id: 'write', content: '已保存' });
    const view = completedWriteView([message, saved], 1000000)[0] as AIMessage;
    assert.equal(typeof view.tool_calls![0].args.content, 'string');
    assert.ok(view.tool_calls![0].args.content.length < 400);
    assert.equal(view.tool_calls![0].args.complete, false);
    assert.equal(view.tool_calls![0].args.merge, true);
    assert.deepEqual(view.usage_metadata, message.usage_metadata);
    assert.deepEqual(view.response_metadata, message.response_metadata);
    assert.equal(message.tool_calls![0].args.content, content);
    assert.ok(!JSON.stringify(view.toDict()).includes('当前区块源码与真实设计数据'));
    for (const failed of ['{"ok":false}', '{"outcome":"unknown"}'])
      assert.equal(
        completedWriteView([message, new ToolMessage({ ...saved, content: failed })], 1000000)[0],
        message,
      );
  }
});
test('真实Agent模型看到重复读取视图，真实工具调用及已保存消息保留原文', async () => {
  let count = 0,
    reads = 0;
  const raw: BaseMessage[] = [];
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages: BaseMessage[]) => {
    if (count === 2) {
      const results = messages.filter(ToolMessage.isInstance);
      assert.equal(JSON.parse(results[0].text).type, 'context_reference');
      assert.equal(JSON.parse(results[1].text).content, source);
    }
    const message =
      count < 2
        ? new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'read-' + count,
                name: 'read_file',
                args: { path: 'pages/page/index.tsx', resource: false, length: null },
              },
            ],
          })
        : new AIMessage('沿用当前区块资料继续实现');
    count++;
    return { generations: [{ text: message.text, message }] };
  };
  const tools: GenerationTools = {
    list: async () => [],
    read: async () => {
      reads++;
      return JSON.stringify({
        path: 'pages/page/index.tsx',
        offset: 0,
        totalCharacters: source.length,
        content: source,
        nextOffset: null,
        sha256: digest(source),
      });
    },
    write: async () => '',
    remove: async () => '',
    figma: async () => '',
    rules: async () => '',
    slices: async () => '',
  };
  await runAgent({
    model,
    tools,
    instructions: '离线读取测试',
    messages: [new HumanMessage('核对当前区块资料')],
    maxTurns: 5,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    onMessage: async (m) => {
      raw.push(m);
    },
  });
  assert.equal(reads, 2);
  assert.equal(count, 3);
  const stored = raw.filter(ToolMessage.isInstance);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((m) => JSON.parse(m.text).content === source));
});

test('仅未抛错、空回执及含故障标记的响应不代表写入成功，JSON与固定文案成功才压缩', () => {
  const path = 'pages/page/index.tsx';
  const call = new AIMessage({
    content: '',
    tool_calls: [{ id: 'w', name: 'write_file', args: { path, content: source.repeat(3) } }],
  });
  for (const content of [
    '',
    ' ',
    'done',
    '{}',
    'null',
    '[]',
    '{"error":"DISK_FULL"}',
    '{"status":"failed"}',
    '{"ok":true,"status":"failed"}',
    '{"success":true,"error":"DISK_FULL"}',
    '{"ok":true,"outcome":"unknown"}',
  ]) {
    const result = new ToolMessage({ tool_call_id: 'w', name: 'write_file', content });
    assert.equal(completedWriteView([call, result], 1000000)[0], call, content);
  }
  for (const content of [
    '已保存',
    `已保存：${path}`,
    `已核对累计报告：${path}`,
    '{"ok":true}',
    '{"success":true,"status":"saved"}',
  ]) {
    const result = new ToolMessage({ tool_call_id: 'w', name: 'write_file', content });
    assert.notEqual(completedWriteView([call, result], 1000000)[0], call, content);
  }
  const mismatched = new ToolMessage({
    tool_call_id: 'w',
    name: 'read_file',
    content: '{"ok":true}',
  });
  assert.equal(completedWriteView([call, mismatched], 1000000)[0], call);
});
