import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { toolArgumentDetail } from '../src/functions/d2c/run/agent/argumentFeedback';

test('字段反馈不泄露参数、嵌套字典键或自定义校验消息', () => {
  const schema = z.object({
    mode: z.enum(['block', 'merge']),
    names: z.record(z.string(), z.string()),
    content: z.string().refine(() => false, 'PRIVATE_SCHEMA_MESSAGE'),
  });
  const detail = toolArgumentDetail(schema, {
    mode: 'PRIVATE_MODE',
    names: { PRIVATE_KEY: 12 },
    content: 'PRIVATE_SOURCE',
  })!;
  assert.match(detail, /mode.*names.*content/);
  assert.doesNotMatch(detail, /PRIVATE/);
  assert.equal(toolArgumentDetail(z.object({ path: z.string() }), { path: 'a' }), undefined);
  assert.equal(toolArgumentDetail({}, {}), undefined);
});

test('真实Agent图按字段纠正切图slug和规则mode，错误调用不执行副作用', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage, ToolMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  let calls = 0;
  let slices = 0;
  let checks = 0;
  model._generate = async (messages) => {
    const index = calls++;
    if (index === 1 || index === 3) {
      const result = messages.filter(ToolMessage.isInstance).at(-1)!;
      assert.match(String(result.content), /INVALID_ARGUMENT/);
      assert.match(String(result.content), index === 1 ? /slug/ : /mode/);
      assert.match(String(result.content), /adjust/);
    }
    const message =
      index === 4
        ? new AIMessage('完成')
        : new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `call-${index}`,
                name: index < 2 ? 'prepare_slices' : 'check_rules',
                args:
                  index < 2
                    ? { slug: index === 0 ? 'pages/page' : 'page' }
                    : { path: 'pages/page', mode: index === 2 ? '--merge' : 'merge' },
              },
            ],
          });
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [new HumanMessage('生成页面')],
    instructions: '调用工具',
    maxTurns: 8,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async () => '',
      write: async () => '',
      remove: async () => '',
      figma: async () => '',
      slices: async () => {
        slices++;
        return '{"ok":true}';
      },
      rules: async () => {
        checks++;
        return '{"ok":true}';
      },
    },
  });
  assert.equal(slices, 1);
  assert.equal(checks, 1);
  assert.equal(calls, 5);
});

test('反馈直接给出合法枚举、映射类型与数值边界，不回传调用值', () => {
  const schema = z.object({
    mode: z.enum(['block', 'merge']),
    limit: z.number().int().min(1).max(100),
    names: z.record(z.string(), z.string()),
  });
  const detail = toolArgumentDetail(schema, {
    mode: 'PRIVATE_BAD_MODE',
    limit: 900,
    names: [{ PRIVATE_KEY: 12 }],
  })!;
  assert.match(detail, /允许值.*block.*merge/);
  assert.match(detail, /最小 1.*最大 100/);
  assert.match(detail, /映射值类型 string/);
  assert.doesNotMatch(detail, /PRIVATE|900/);
});

test('可选参数省略沿正式工具默认行为执行，必填参数错误仍能纠正', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage, ToolMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  const calls = [
    { name: 'read_file', args: { path: 'pages/page/index.tsx' } },
    { name: 'figma', args: { command: 'verify-token' } },
    { name: 'figma', args: { command: 'inspect-node', nodeId: '1:2' } },
    { name: 'build_preview', args: {} },
    { name: 'inspect_preview', args: {} },
    { name: 'check_rules', args: { path: 'pages/page', mode: '--merge' } },
    { name: 'check_rules', args: { path: 'pages/page', mode: 'merge' } },
  ];
  let index = 0;
  const executed: string[] = [];
  model._generate = async (messages) => {
    if (index === 6) {
      const result = messages.filter(ToolMessage.isInstance).at(-1)!;
      assert.match(String(result.content), /允许值.*block.*merge/);
    }
    const step = calls[index++];
    const message = step
      ? new AIMessage({
          content: '',
          tool_calls: [
            {
              id: `optional-${index}`,
              name: step.name,
              args: step.args,
            },
          ],
        })
      : new AIMessage('完成');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [new HumanMessage('检查页面')],
    instructions: '执行工具',
    maxTurns: 12,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async (path, resource, offset, length) => {
        assert.equal(resource, false);
        assert.equal(offset, 0);
        assert.ok(typeof length === 'number' && length > 0);
        executed.push('read');
        return '{}';
      },
      write: async () => '',
      remove: async () => '',
      slices: async () => '',
      figma: async (command, args) => {
        executed.push(command);
        assert.ok(args);
        return '{}';
      },
      rules: async (_path, mode) => {
        assert.equal(mode, 'merge');
        executed.push('rules');
        return '{}';
      },
      preview: {
        needsInspection: async () => false,
        build: async (entry) => {
          assert.equal(entry, undefined);
          executed.push('build');
          return '{}';
        },
        inspect: async (entry) => {
          assert.equal(entry, undefined);
          executed.push('inspect');
          return '{}';
        },
      },
    },
  });
  assert.deepEqual(executed, ['read', 'verify-token', 'inspect-node', 'build', 'inspect', 'rules']);
});
