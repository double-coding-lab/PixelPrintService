import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import {
  createIncrementalVerificationMiddleware,
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
  kind:
    | 'pass'
    | 'fail'
    | 'no-actions'
    | 'mutated'
    | 'guidance'
    | 'nested'
    | 'reads'
    | 'reads-then-verify'
    | 'visual'
    | 'progress'
    | 'edit-baseline'
    | 'edit-conflict'
    | 'deletions',
) {
  let calls = 0,
    inspections = 0,
    mutations = 0;
  let sourceText = 'ready';
  let editAttempts = 0;
  const editScenario = kind === 'edit-baseline' || kind === 'edit-conflict';
  const sha = () => createHash('sha256').update(sourceText).digest('hex');
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async () => {
    calls++;
    const tool = (name: string, args: Record<string, unknown>) =>
      new AIMessage({ content: '', tool_calls: [{ id: `tool-${calls}`, name, args }] });
    const message =
      kind === 'reads' || (kind === 'reads-then-verify' && calls <= 9)
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
    const next =
      editScenario && calls === 1
        ? tool('read_file', { path: 'page.tsx' })
        : editScenario && calls === 2
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'saved-edit-plan',
                  name: 'edit_file',
                  args: { path: 'page.tsx', oldText: 'ready', newText: 'changed' },
                },
                {
                  id: 'saved-action-plan',
                  name: 'inspect_preview',
                  args: { entryPath: 'page.tsx', actions },
                },
              ],
            })
          : kind === 'edit-baseline'
            ? new AIMessage('视觉一致：布局和间距保持一致。')
            : kind === 'deletions' && calls <= 12
              ? tool('delete_file', { path: `unused-${calls}.tsx` })
              : kind === 'progress' && calls <= 12
                ? tool('write_file', { path: 'page.tsx', content: `revision-${calls}` })
                : kind === 'visual'
                  ? [1, 2, 5].includes(calls)
                    ? tool('write_file', { path: 'page.tsx', content: 'changed' })
                    : [3, 6].includes(calls)
                      ? tool('inspect_preview', { actions })
                      : new AIMessage(
                          calls === 4
                            ? '发现视觉变化：标签间距变大。'
                            : '视觉一致：标签恢复了原有间距。',
                        )
                  : message;
    return { generations: [{ text: next.text, message: next }] };
  };
  const tools: GenerationTools = {
    list: async () => ['page.tsx'],
    read: async () =>
      editScenario
        ? JSON.stringify({
            content: sourceText,
            sha256: sha(),
            totalCharacters: sourceText.length,
            offset: 0,
          })
        : '{}',
    edit: async (_path, _old, next, expected) => {
      editAttempts++;
      if (expected !== sha())
        return JSON.stringify({
          type: 'tool_feedback',
          ok: false,
          code: 'EDIT_REVISION_CONFLICT',
          action: 'adjust',
          message: '版本变化，请重新读取',
        });
      assert.equal(sourceText, 'ready');
      sourceText = next;
      mutations++;
      return JSON.stringify({ ok: true, sha256: sha() });
    },
    write: async () => {
      mutations++;
      return '已保存';
    },
    remove: async (path) => {
      mutations++;
      return `已删除：${path}`;
    },
    figma: async () => assert.fail('局部交互不重扫Figma'),
    slices: async () => assert.fail('局部交互不重切图片'),
    rules: async () => assert.fail('局部交互不强制整页merge'),
    preview: {
      needsInspection: async () => false,
      build: async () => '{}',
      inspect: async (_entry, options) => {
        if (kind === 'mutated') assert.equal(mutations, 1, '检查必须在写入完成之后');
        inspections++;
        if (kind === 'edit-conflict' && inspections === 1) sourceText = 'concurrent-change';
        return JSON.stringify({
          ok: true,
          fileRevision: kind === 'visual' || editScenario ? mutations : inspections,
          ...(kind === 'visual' || editScenario
            ? { imageRef: 'attachment://' + String(mutations).repeat(64) }
            : {}),
          entryPath: 'page.tsx',
          errors: kind === 'nested' ? [{ code: 'NESTED_SCROLL_CONTAINER_CLIPPED' }] : [],
          missingAssets: [],
          interaction: {
            passed: kind !== 'fail' && kind !== 'edit-conflict',
            steps: options?.actions?.map((action) => ({
              type: action.type,
              observed:
                action.type === 'expect' && action.state === 'text' ? action.text : undefined,
              passed: kind !== 'fail' && kind !== 'edit-conflict',
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
  const finalIds: string[] = [];
  const input: Parameters<typeof runAgent>[0] = {
    model,
    messages: [new HumanMessage({ id: 'request', content: '点击名字' })],
    instructions: '仅修改已有页面的交互',
    onMessage: async (message) => {
      if (message.id && message.text.startsWith('本次交互')) finalIds.push(message.id);
    },
    reasoningUserText: '点击名字',
    reasoningAdmissionId: 'request',
    reasoningContext: { hasSourceFiles: true, hasDesign: true },
    tools,
    ...(kind === 'visual' || editScenario
      ? { resolveImage: async () => ({ mimeType: 'image/png', data: Buffer.from('fixture') }) }
      : {}),
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
    finalIds,
    rerun: async (id: string, text: string) => {
      const next = await runAgent({
        ...input,
        messages: [new HumanMessage({ id, content: text })],
        reasoningUserText: text,
        reasoningAdmissionId: id.startsWith('resume') ? undefined : id,
      });
      return { next, calls, inspections };
    },
    calls,
    inspections,
    mutations,
    editAttempts,
    sourceText,
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

test('同批写入和验收由平台串行，复用计划且只检查一次', async () => {
  const f = await scenario('mutated');
  assert.equal(f.mutations, 1);
  assert.equal(f.inspections, 1);
  assert.equal(f.calls, 1);
  assert.match(f.result.output, /交互修改已完成/);
});

test('运行中新增滑动要求重新核对验收范围，不复用旧点击通过结论', async () => {
  const f = await scenario('guidance');
  assert.equal(f.inspections, 4, JSON.stringify(f));
  assert.ok(f.finalIds.length > 0);
  assert.ok(
    f.finalIds.every((id) => /^[0-9a-f]{64}$/.test(id)),
    '追加指引后的交付ID也必须适配消息列64字符',
  );
  assert.match(f.result.output, /尚未通过/);
});

test('验收预算随原生检查点恢复，继续不重置，新的明确任务才重新核验', async () => {
  const f = await scenario('fail');
  const resumed = await f.rerun('resume', '继续');
  assert.equal(resumed.inspections, 3);
  assert.equal(resumed.calls, 3);
  assert.match(resumed.next.output, /尚未通过/);
  const platformResume = await f.rerun(
    'resume-platform',
    '继续当前任务。先核对已保存文件和工具结果，保留既有产物，不重复执行结果未知的副作用；按当前会话上下文继续。',
  );
  assert.equal(platformResume.inspections, 3);
  assert.equal(platformResume.calls, 3);
  assert.match(platformResume.next.output, /尚未通过/);
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
  assert.equal(f.calls, 10);
  assert.equal(f.inspections, 0);
  assert.match(f.result.output, /尚未通过/);
});

test('连续无进展的工具结果后保留独立验收机会', async () => {
  const f = await scenario('reads-then-verify');
  assert.equal(f.calls, 10);
  assert.equal(f.inspections, 1);
  assert.match(f.result.output, /交互修改已完成/);
});

test('拖动过程中切换必须有松手前两处同一选中状态的观测', () => {
  const sample = (atStep: number, text: string) => ({
    atStep,
    expect: { type: 'expect', state: 'text', selector: '#selected', text },
  });
  const plan = [
    sample(1, '初始').expect,
    { type: 'swipe', selector: '#tabs', during: [sample(3, '第二项'), sample(8, '第三项')] },
    sample(1, '第三项').expect,
  ];
  const evidence = [
    { observed: '初始' },
    {
      during: [
        { atStep: 3, observed: '第二项' },
        { atStep: 8, observed: '第三项' },
      ],
    },
    { observed: '第三项' },
  ];
  const requirement = '支持滑动滚动 滑动的过程中 也需要选择当前滑动的经过的名字';
  assert.equal(interactionStateEvidence(requirement, plan, evidence), true);
  assert.equal(interactionStateEvidence(requirement, plan, [evidence[0], {}, evidence[2]]), false);
});

test('平台用改前画面复核最新修订，发现间距变化时补一次修正', async () => {
  const f = await scenario('visual');
  assert.equal(f.mutations, 2);
  assert.equal(f.inspections, 5);
  assert.equal(f.calls, 7);
  assert.match(f.result.output, /浏览器动作与断言检查/);
  assert.match(f.result.output, /视觉一致：标签恢复了原有间距/);
});

test('持续保存新源码版本超过八步仍可完成实现再验收', async () => {
  const f = await scenario('progress');
  assert.equal(f.mutations, 12);
  assert.equal(f.inspections, 1);
  assert.equal(f.calls, 13);
  assert.match(f.result.output, /交互修改已完成/);
});

test('改前截图后复用绑定版本的编辑和动作计划，不再要求模型生成补丁', async () => {
  const f = await scenario('edit-baseline');
  assert.equal(f.editAttempts, 1);
  assert.equal(f.mutations, 1);
  assert.equal(f.inspections, 3);
  assert.equal(f.calls, 3);
  assert.match(f.result.output, /视觉一致/);
});
test('截图期间发生并发修改时，保留的编辑按旧摘要拒绝，不覆盖新内容', async () => {
  const f = await scenario('edit-conflict');
  assert.equal(f.editAttempts, 1);
  assert.equal(f.mutations, 0);
  assert.equal(f.sourceText, 'concurrent-change');
  assert.match(f.result.output, /尚未通过/);
});

test('连续成功清理源码计为进展，不在八步时禁止后续实现', async () => {
  const f = await scenario('deletions');
  assert.equal(f.mutations, 12);
  assert.equal(f.inspections, 1);
  assert.match(f.result.output, /交互修改已完成/);
});
test('恢复时核对完整历史，已发出的编辑不会因继续消息遮住回执而重发', async () => {
  const edit = {
    id: 'issued-edit',
    name: 'edit_file' as const,
    args: { path: 'page.tsx', oldText: 'old', newText: 'new', expectedSha256: 'a'.repeat(64) },
  };
  for (const status of ['saved', 'unknown', 'mixed']) {
    const known = status !== 'unknown';
    const mixed = status === 'mixed';
    const batch = mixed
      ? [edit, { ...edit, id: 'second-edit', args: { ...edit.args, path: 'other.tsx' } }]
      : [edit];
    const middleware = createIncrementalVerificationMiddleware({
      admissionId: 'request',
      userText: '点击名字',
      hasSourceFiles: true,
      finish: async () => assert.fail('恢复核对不提前收口'),
    });
    const before = middleware.beforeModel;
    assert.ok(before && typeof before === 'object' && 'hook' in before);
    const state = {
      _pixelprintIncrementalVerification: {
        admissionId: 'request',
        text: '点击名字',
        enabled: true,
        baselineAttempted: true,
        pendingEdits: batch,
        pendingEditInspection: { actions },
      },
      messages: [
        new HumanMessage({ id: 'request', content: '点击名字' }),
        new AIMessage({ content: '', tool_calls: batch }),
        ...(known
          ? [
              new ToolMessage({
                tool_call_id: edit.id,
                name: 'edit_file',
                content: JSON.stringify({ ok: true, sha256: 'b'.repeat(64) }),
              }),
            ]
          : []),
        ...(mixed
          ? [
              new ToolMessage({
                tool_call_id: 'second-edit',
                name: 'edit_file',
                content: JSON.stringify({
                  type: 'tool_feedback',
                  ok: false,
                  code: 'EDIT_REVISION_CONFLICT',
                  action: 'adjust',
                }),
              }),
            ]
          : []),
        new HumanMessage({ id: 'resume', content: '继续' }),
      ],
    };
    const result = (await before.hook(state as never, {} as never)) as any;
    assert.equal(result._pixelprintIncrementalVerification.pendingEdits, undefined);
    if (known) assert.equal(result._pixelprintIncrementalVerification.sourceChanged, true);
    if (known && !mixed)
      assert.deepEqual(
        result._pixelprintIncrementalVerification.pendingInspection.actions,
        actions,
      );
    else {
      assert.equal(result._pixelprintIncrementalVerification.pendingInspection, undefined);
      if (!known) assert.match(result.messages[0].text, /结果未确认/);
    }
  }
});
