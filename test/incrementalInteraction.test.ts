import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import {
  interactionChange,
  satisfiesInteractionPlan,
  interactionStateEvidence,
} from '../src/functions/d2c/run/agent/incrementalVerification';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const actions = [
  { type: 'expect', selector: '#name', state: 'text', text: 'initial' },
  { type: 'click', selector: '#next' },
  { type: 'expect', selector: '#name', state: 'text', text: 'selected' },
];

test('已有源码交互修改单独分类，首次生成和解释不套用交互收尾', () => {
  assert.equal(interactionChange('添加点击名字居中', true), true);
  assert.equal(interactionChange('需循环滚动 并且支持滑动', true), true);
  assert.equal(interactionChange('添加点击名字居中', false), false);
  assert.equal(interactionChange('解释如何实现滚动', true), false);
  assert.equal(interactionChange('请告诉我如何实现滑动', true), false);
  assert.equal(interactionChange('把主题切换成蓝色', true), false);
  assert.equal(interactionChange('修改点击后进行整页验收', true), false);
  assert.equal(interactionChange('重新生成页面并添加点击', true), false);
  assert.equal(satisfiesInteractionPlan('点击名字', actions), true);
  assert.equal(satisfiesInteractionPlan('点击名字', [actions[0]]), false);
  assert.equal(satisfiesInteractionPlan('循环滚动并支持滑动', actions), false);
  const swipes = [-200, 200, -300].flatMap((deltaX) => [
    { type: 'swipe', selector: '#tabs', deltaX, deltaY: 0 },
    { type: 'expect', selector: '#selected', state: 'visible' },
  ]);
  assert.equal(satisfiesInteractionPlan('循环滚动并支持滑动', swipes), true);
  assert.equal(satisfiesInteractionPlan('循环滚动并支持滑动', swipes.slice(0, 4)), false);
});

/** 使用原生图/持久检查点及合成模型，测试验收收敛而不访问网关。 */
async function scenario(
  kind: 'pass' | 'fail' | 'no-actions' | 'mutated' | 'guidance' | 'nested' | 'reads',
) {
  let calls = 0,
    inspections = 0,
    mutations = 0;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async () => {
    calls++;
    const tool = (name: string, args: Record<string, unknown>) =>
      new AIMessage({ content: '', tool_calls: [{ id: `tool-${calls}`, name, args }] });
    const message =
      kind === 'reads'
        ? tool('read_file', { path: 'page.tsx', length: 2000, offset: 0 })
        : kind === 'no-actions'
          ? new AIMessage('已经完成')
          : kind === 'mutated' && calls === 1
            ? new AIMessage({
                content: '',
                tool_calls: [
                  {
                    id: 'mixed-write',
                    name: 'write_file',
                    args: { path: 'page.tsx', content: 'changed' },
                  },
                  { id: 'mixed-inspect', name: 'inspect_preview', args: { actions } },
                ],
              })
            : tool('inspect_preview', { actions });
    return { generations: [{ text: message.text, message }] };
  };
  const tools: GenerationTools = {
    list: async () => ['page.tsx'],
    read: async () => '{}',
    write: async () => {
      mutations++;
      return '已保存';
    },
    remove: async () => '',
    figma: async () => assert.fail('局部交互不重扫Figma'),
    slices: async () => assert.fail('局部交互不重切图片'),
    rules: async () => assert.fail('局部交互不强制整页merge'),
    preview: {
      needsInspection: async () => false,
      build: async () => '{}',
      inspect: async (_entry, options) => {
        inspections++;
        return JSON.stringify({
          ok: true,
          fileRevision: inspections,
          entryPath: 'page.tsx',
          errors: kind === 'nested' ? [{ code: 'NESTED_SCROLL_CONTAINER_CLIPPED' }] : [],
          missingAssets: [],
          interaction: {
            passed: kind !== 'fail',
            steps: options?.actions?.map((action) => ({
              type: action.type,
              observed:
                action.type === 'expect' && action.state === 'text' ? action.text : undefined,
              passed: kind !== 'fail',
            })),
          },
        });
      },
    },
  };
  const checkpoint = Object.assign(new MemorySaver(), {
    config: (namespace = '') => ({
      configurable: { thread_id: `interaction-${kind}`, checkpoint_ns: namespace },
    }),
  });
  let guided = false;
  const input: Parameters<typeof runAgent>[0] = {
    model,
    messages: [new HumanMessage({ id: 'request', content: '点击名字' })],
    instructions: '仅修改已有页面的交互',
    reasoningUserText: '点击名字',
    reasoningAdmissionId: 'request',
    reasoningContext: { hasSourceFiles: true, hasDesign: true },
    tools,
    checkpoint,
    maxTurns: 20,
    contextBudgetTokens: 100000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    ...(kind === 'guidance'
      ? {
          readGuidance: async (applied: string[]) => {
            if (!guided && inspections === 1) {
              guided = true;
              return [
                {
                  id: 'new-guidance',
                  message: {
                    role: 'user' as const,
                    id: 'new-guidance',
                    content: '点击名字并支持滑动',
                  },
                },
              ];
            }
            return [];
          },
        }
      : {}),
  };
  const result = await runAgent(input);
  return {
    result,
    rerun: async (id: string, text: string) => {
      const next = await runAgent({
        ...input,
        messages: [new HumanMessage({ id, content: text })],
        reasoningUserText: text,
        reasoningAdmissionId: id === 'resume' ? undefined : id,
      });
      return { next, calls, inspections };
    },
    calls,
    inspections,
    mutations,
    verification: (await checkpoint.getTuple(checkpoint.config()))?.checkpoint.channel_values
      ._pixelprintIncrementalVerification,
  };
}

test('真实交互断言通过后立即交付，不再进入模型重复读图或修改', async () => {
  const f = await scenario('pass');
  assert.equal(f.calls, 1);
  assert.equal(f.inspections, 1);
  assert.match(f.result.output, /交互修改已完成/);
});

test('最多一轮验收加两轮复验，失败交回未完成项而非模型无限空转', async () => {
  const f = await scenario('fail');
  assert.equal(f.inspections, 3);
  assert.equal(f.calls, 3);
  assert.match(f.result.output, /尚未通过/);
  assert.doesNotMatch(f.result.output, /交互修改已完成/);
});

test('没有动作证据时不能只凭模型宣称完成，两次收尾后明确未通过', async () => {
  const f = await scenario('no-actions');
  assert.equal(f.calls, 2);
  assert.equal(f.inspections, 0);
  assert.match(f.result.output, /尚未通过/);
});

test('同批并行写入和截图不能作为最后修订已通过的证据', async () => {
  const f = await scenario('mutated');
  assert.equal(f.mutations, 1);
  assert.equal(f.inspections, 2);
  assert.match(f.result.output, /交互修改已完成/);
});

test('运行中新增滑动要求重新核对验收范围，不复用旧点击通过结论', async () => {
  const f = await scenario('guidance');
  assert.equal(f.inspections, 4, JSON.stringify(f));
  assert.match(f.result.output, /尚未通过/);
});

test('验收预算随原生检查点恢复，继续不重置，新的明确任务才重新核验', async () => {
  const f = await scenario('fail');
  const resumed = await f.rerun('resume', '继续');
  assert.equal(resumed.inspections, 3);
  assert.equal(resumed.calls, 3);
  assert.match(resumed.next.output, /尚未通过/);
  const next = await f.rerun('new-request', '点击名字并修复选中态');
  assert.equal(next.inspections, 6);
  assert.equal(next.calls, 6);
});

test('静态列表三次滑动加body可见不能证明循环；真实状态变化与回环才能通过', () => {
  const plan = [
    { type: 'expect', selector: '#selected', state: 'text', text: 'last' },
    ...[-100, 100, -100].flatMap((deltaX, i) => [
      { type: 'swipe', selector: '#tabs', deltaX, deltaY: 0 },
      { type: 'expect', selector: '#selected', state: 'text', text: i === 1 ? 'last' : 'first' },
    ]),
  ];
  const steps = plan.map((action) => ({
    passed: true,
    observed: 'text' in action ? action.text : undefined,
  }));
  assert.equal(interactionStateEvidence('循环滑动', plan, steps), true);
  const fake = plan.map((action) =>
    action.type === 'expect' ? { type: 'expect', selector: 'body', state: 'visible' } : action,
  );
  assert.equal(
    interactionStateEvidence(
      '循环滑动',
      fake,
      fake.map(() => ({ passed: true, observed: true })),
    ),
    false,
  );
  assert.equal(
    interactionStateEvidence(
      '循环滑动',
      plan,
      plan.map(() => ({ passed: true, observed: 'last' })),
    ),
    false,
  );
});

test('内部滚动覆盖提示不阻止真实动作断言通过', async () => {
  const f = await scenario('nested');
  assert.equal(f.inspections, 1);
  assert.match(f.result.output, /交互修改已完成/);
});
test('首次截图前连续读取无新验收也有界交回，不抛模型轮次耗尽异常', async () => {
  const f = await scenario('reads');
  assert.equal(f.calls, 8);
  assert.equal(f.inspections, 0);
  assert.match(f.result.output, /尚未通过/);
});
