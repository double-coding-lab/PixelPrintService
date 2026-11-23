import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { GenerationTools } from '../src/functions/d2c/run/types';

/** 正式图使用真实工具配对；离线截图替身只表示取得图片，不表示视觉验收通过。 */
async function repair(scenario: 'writes' | 'reads' | 'failed-capture' | 'rejected-writes') {
  let dirty = false;
  let captures = 0;
  let calls = 0;
  const records: BaseMessage[] = [];
  const checkpoint = Object.assign(new MemorySaver(), {
    config: () => ({ configurable: { thread_id: `visual-${scenario}` } }),
  });
  const tools: GenerationTools = {
    list: async () => [],
    read: async () => JSON.stringify({ content: 'current source', nextOffset: null }),
    write: async () => {
      if (scenario === 'rejected-writes')
        return JSON.stringify({ type: 'tool_feedback', ok: false, code: 'EDIT_MATCH_INVALID' });
      dirty = true;
      return '已保存';
    },
    remove: async () => assert.fail('unexpected remove'),
    figma: async () => assert.fail('unexpected Figma'),
    rules: async () => '{}',
    slices: async () => '{}',
    preview: {
      build: async () => assert.fail('inspection reuses its normal build path'),
      needsInspection: async () => dirty,
      inspect: async () => {
        dirty = false;
        captures++;
        return JSON.stringify(
          scenario === 'failed-capture' && captures > 1
            ? { ok: false, status: 'capture_unavailable' }
            : {
                ok: true,
                imageRef: `preview://${String(captures).repeat(64)}`,
                entryPath: 'pages/page/index.tsx',
                fileRevision: captures,
              },
        );
      },
    },
  };
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    calls++;
    const command = (name: string, args: Record<string, unknown>) =>
      new AIMessage({ content: '', tool_calls: [{ name, args, id: `model-${calls}` }] });
    let message: AIMessage;
    if (calls === 1) message = command('inspect_preview', { entryPath: null });
    else if (calls < 5) {
      message =
        scenario === 'reads' && calls > 2
          ? command('read_file', { path: 'pages/page/index.tsx' })
          : command('write_file', { path: 'pages/page/index.tsx', content: `revision ${calls}` });
    } else {
      assert.equal(captures, scenario === 'rejected-writes' ? 1 : 2);
      if (scenario !== 'rejected-writes')
        assert.ok(
          messages.some(
            (value) =>
              ToolMessage.isInstance(value) &&
              value.name === 'inspect_preview' &&
              value.text.includes(
                scenario === 'failed-capture' ? 'capture_unavailable' : '"fileRevision":2',
              ),
          ),
        );
      message = new AIMessage('依据最新检查反馈继续处理。');
    }
    return { generations: [{ text: message.text, message }] };
  };
  const result = await runAgent({
    model,
    messages: [new HumanMessage({ id: `user-${scenario}`, content: '修复当前页面' })],
    instructions: 'VISUAL_REPAIR_TEST',
    checkpoint,
    maxTurns: 8,
    contextBudgetTokens: 100000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools,
    onMessage: async (message) => {
      records.push(message);
    },
  });
  assert.equal(calls, 5);
  assert.equal(result.usage.requests, 5, '平台插入截图不消耗额外模型请求');
  const forced = records.filter(
    (value) => AIMessage.isInstance(value) && value.response_metadata.platformInspection === true,
  );
  assert.equal(forced.length, scenario === 'rejected-writes' ? 0 : 1);
  const stored = await checkpoint.getTuple(checkpoint.config());
  assert.equal(
    (stored?.checkpoint.channel_values._pixelprintVisualInspection as { dirty: boolean }).dirty,
    false,
  );
}

for (const scenario of ['writes', 'reads', 'failed-capture', 'rejected-writes'] as const)
  test(`修复阶段及时真实截图且不重放工具：${scenario}`, () => repair(scenario));

for (const scenario of ['old-state', 'cold-runtime', 'small-debt', 'entry-switch'] as const)
  test(`旧记录和冷启动恢复截图欠账且不重放写入：${scenario}`, async () => {
    const history: BaseMessage[] = [];
    const append = (name: string, args: Record<string, unknown>, output: string, id: string) => {
      history.push(
        new AIMessage({ content: '', tool_calls: [{ name, args, id }] }),
        new ToolMessage({ name, tool_call_id: id, content: output }),
      );
    };
    append(
      'inspect_preview',
      { entryPath: null },
      JSON.stringify({ ok: true, imageRef: 'preview://old', entryPath: 'pages/page/index.tsx' }),
      'old-inspect',
    );
    for (let i = 0; i < (scenario === 'small-debt' ? 1 : 3); i++)
      append('write_file', { path: 'pages/page/index.scss' }, '已保存', `old-write-${i}`);
    if (scenario === 'entry-switch') {
      append(
        'build_preview',
        { entryPath: 'pages/other/index.tsx' },
        '{"ok":true}',
        'select-other',
      );
      for (let i = 0; i < 3; i++)
        append('write_file', { path: 'pages/other/index.scss' }, '已保存', `other-write-${i}`);
    }
    let captures = 0;
    let calls = 0;
    let dirty = scenario === 'old-state';
    const model = new FakeToolCallingModel();
    model.bindTools = () => model;
    model._generate = async () => {
      calls++;
      assert.equal(captures, scenario === 'small-debt' && calls === 1 ? 0 : 1);
      const message = new AIMessage('依据本次真实截图继续');
      return { generations: [{ text: message.text, message }] };
    };
    const result = await runAgent({
      model,
      bootstrapHistory: history,
      checkpoint: Object.assign(new MemorySaver(), {
        config: () => ({ configurable: { thread_id: 'old-visual-checkpoint' } }),
      }),
      messages: [new HumanMessage({ id: 'new-visual-user', content: '继续已有页面' })],
      instructions: 'OLD_VISUAL_STATE',
      maxTurns: 2,
      contextBudgetTokens: 100000,
      signal: new AbortController().signal,
      assertLease: async () => {},
      tools: {
        list: async () => [],
        read: async () => '',
        write: async () => assert.fail('历史写入不能重放'),
        remove: async () => '',
        figma: async () => '',
        rules: async () => '',
        slices: async () => '',
        preview: {
          needsInspection: async () => dirty,
          build: async () => '',
          inspect: async (entryPath) => {
            assert.equal(
              entryPath,
              scenario === 'entry-switch' ? 'pages/other/index.tsx' : 'pages/page/index.tsx',
            );
            captures++;
            dirty = false;
            return JSON.stringify({ ok: false, status: 'capture_unavailable' });
          },
        },
      },
    });
    assert.equal(result.usage.requests, scenario === 'small-debt' ? 2 : 1);
  });
