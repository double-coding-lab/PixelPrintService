import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemorySaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  createReasoningMiddleware,
  initialReasoningDecision,
  hasPairedRulesFailure,
  readReasoningDecision,
  updateReasoningState,
  type ReasoningDecision,
  type ReasoningInput,
} from '../src/functions/d2c/run/agent/reasoning';
import { toolFeedback, type ToolFeedbackCode } from '../src/functions/d2c/run/toolFeedback';

/** 真实 LangChain 工具消息，反馈格式来自正式工具反馈构造器。 */
function proof(
  code: ToolFeedbackCode = 'RULES_FAILED',
  name = 'check_rules',
  id = 'check-1',
): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ id, name, args: {}, type: 'tool_call' }] }),
    new ToolMessage({ tool_call_id: id, name, content: JSON.stringify(toolFeedback(code)) }),
  ];
}
const low: ReasoningInput = { userText: '仅把按钮颜色改成蓝色', hasSourceFiles: true };

test('明确已有源码局部交互可低推理，复杂范围及无可信入口仍保守', () => {
  for (const userText of [
    '只修复轮播点击居中',
    '添加滚动过程中切换选中项',
    '支持轮播双向循环滑动',
  ]) {
    const input: ReasoningInput = { userText, hasSourceFiles: true, localInteraction: true };
    assert.equal(initialReasoningDecision(input).task, 'local_interaction');
    assert.equal(initialReasoningDecision(input).effort, 'low');
    assert.equal(initialReasoningDecision({ ...input, hasSourceFiles: false }).effort, 'high');
    assert.equal(initialReasoningDecision({ ...input, localInteraction: false }).effort, 'high');
    const escalated = updateReasoningState(input, { messages: proof() });
    assert.equal(escalated.decision.reason, 'rules_failed');
    assert.equal(escalated.decision.effort, 'high');
  }
  for (const userText of [
    '实现整个页面的点击交互',
    '跨模块修复轮播点击',
    '添加轮播并实现支付接口',
    '重构轮播响应式布局',
    '创建完整页面并实现轮播',
    '只修复轮播点击，同时修改数据库',
  ])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true, localInteraction: true }).effort,
      'high',
      userText,
    );
});

test('仅真实guidance重算局部范围与admission；平台Human通知和旧guidance不覆盖新输入', () => {
  const original = {
    userText: '只修复轮播点击居中',
    hasSourceFiles: true,
    localInteraction: true,
    admissionId: 'initial',
    classifyLocalInteraction: (text: string) => text === '支持轮播双向循环滑动',
  };
  const messages: BaseMessage[] = [
    new HumanMessage({ id: 'initial', content: original.userText }),
    new HumanMessage({ id: 'guidance', content: '跨模块重构整个页面' }),
    new HumanMessage({ id: 'platform', content: '只修复轮播点击居中' }),
  ];
  const first = updateReasoningState(original, { messages });
  const complex = updateReasoningState(original, {
    messages,
    guidanceApplied: ['guidance'],
    _pixelprintReasoning: first,
  });
  assert.equal(complex.admissionId, 'guidance');
  assert.equal(complex.decision.effort, 'high');
  messages.push(new HumanMessage({ id: 'guidance-local', content: '支持轮播双向循环滑动' }));
  const local = updateReasoningState(original, {
    messages,
    guidanceApplied: ['guidance', 'guidance-local'],
    _pixelprintReasoning: complex,
  });
  assert.equal(local.admissionId, 'guidance-local');
  assert.equal(local.decision.task, 'local_interaction');
  assert.equal(local.decision.effort, 'low');
  const noClassifier = updateReasoningState(
    { ...original, classifyLocalInteraction: undefined },
    { messages, guidanceApplied: ['guidance-local'] },
  );
  assert.equal(noClassifier.decision.effort, 'high', '新正文不能继承旧localInteraction=true');
  const next = { ...original, userText: '跨模块重构整个页面', admissionId: 'new-admission' };
  messages.push(new HumanMessage({ id: next.admissionId, content: next.userText }));
  assert.equal(
    updateReasoningState(next, {
      messages,
      guidanceApplied: ['guidance-local'],
      _pixelprintReasoning: local,
    }).admissionId,
    next.admissionId,
  );
  const escalated = updateReasoningState(original, {
    messages: [...messages.slice(0, -1), ...proof()],
    guidanceApplied: ['guidance-local'],
    _pixelprintReasoning: local,
  });
  assert.equal(escalated.decision.reason, 'rules_failed');
  assert.equal(
    updateReasoningState(original, {
      messages: messages.slice(0, -1),
      guidanceApplied: ['guidance-local'],
      _pixelprintReasoning: escalated,
    }).decision.effort,
    'high',
  );
});

/** 通过实际恢复字段调用纯策略，不维护进程内状态或计数器。 */
function evolve(
  input: ReasoningInput,
  previous?: ReturnType<typeof updateReasoningState>,
  messages: BaseMessage[] = [],
) {
  return updateReasoningState(input, {
    messages,
    ...(previous ? { _pixelprintReasoning: previous } : {}),
  });
}

test('specialist defaults are fixed independently of task text and history', () => {
  for (const specialist of ['rule_scan', 'ui', 'design', 'review'] as const) {
    const decision = initialReasoningDecision({
      specialist,
      userText: '你好，只替换颜色',
      hasSourceFiles: true,
    });
    assert.equal(decision.effort, specialist === 'rule_scan' ? 'low' : 'high');
    assert.equal(decision.reason, 'specialist_default');
    assert.equal(decision.task, specialist);
    assert.equal(decision.escalated, false);
  }
});

test('root classification covers explicit questions, parameter confirmation, narrow replacement and complex generation', () => {
  for (const userText of [
    '你好！',
    '谢谢',
    'How does this work?',
    '请解释这个错误',
    '现在完成了吗？',
    '确认使用蓝色主题',
    '就用750px',
  ])
    assert.equal(initialReasoningDecision({ userText }).effort, 'low', userText);
  for (const userText of [
    '只替换首页图片',
    '只改颜色',
    '只改文案',
    '仅把颜色改成红色',
    '只修改按钮文案',
    'only replace the image',
  ])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true }).task,
      'simple_replacement',
      userText,
    );
  assert.equal(initialReasoningDecision({ userText: '只替换图片' }).effort, 'high');
  for (const userText of [
    '创建一个完整新页面',
    '按设计稿还原页面',
    '跨文件修复布局错乱',
    '修复复杂布局和响应式适配',
    '只替换图片并重构布局',
    '请解释并实现整个页面',
  ])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true, hasDesign: true }).effort,
      'high',
      userText,
    );
  for (const userText of ['', '继续', '帮我处理一下', '只修改图片尺寸'])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true }).effort,
      'high',
      userText,
    );
  assert.equal(initialReasoningDecision({ userText: '如何创建新页面？' }).task, 'question');
});

test('explicit English and mixed execution requests override explanation prefixes while ordinary questions stay low', () => {
  for (const userText of [
    'Explain this error and refactor the page',
    'Explain this error and then build a new page',
    'Explain this error; refactor the page',
    'Explain this error. Please refactor the page',
    '解释这个错误并 refactor the page',
    'Explain this error 然后重构页面',
    '请解释这个错误 and implement a new page',
    'How does this page work? Then refactor the page',
  ])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true }).effort,
      'high',
      userText,
    );
  for (const userText of [
    'Explain this page',
    'Explain this error and describe the page',
    'Explain how to refactor this page',
    'Explain this page and how to refactor it',
    'How can I explain and refactor this page?',
    '如何解释并重构这个页面？',
    '请解释这个页面的复杂布局',
    'Explain this page and do not refactor it',
  ]) {
    const decision = initialReasoningDecision({ userText, hasSourceFiles: true });
    assert.equal(decision.effort, 'low', userText);
    assert.equal(decision.task, 'question', userText);
  }
});

test('explicit preserved-layout clauses keep narrow replacements low without permitting layout changes', () => {
  for (const userText of [
    '只替换图片和颜色，保持布局不变',
    '仅替换图片，保留布局',
    '布局不变，只修改文案',
    '只改颜色并保持原有布局不变',
    '只换图片（不要修改布局）',
    '仅调整文案，维持现有布局',
  ]) {
    const decision = initialReasoningDecision({ userText, hasSourceFiles: true });
    assert.equal(decision.effort, 'low', userText);
    assert.equal(decision.task, 'simple_replacement', userText);
    assert.equal(initialReasoningDecision({ userText }).effort, 'high', userText);
  }
  for (const userText of [
    '只替换图片并修改布局',
    '只替换图片和颜色，保持布局不变，但把左右布局改为上下布局',
    '只换图片，保留布局但调整列数',
    '只换图片，不保持布局不变',
    '只换图片，保持布局不变更换成两栏',
    '只换图片，不要修改布局，同时调整间距',
  ])
    assert.equal(
      initialReasoningDecision({ userText, hasSourceFiles: true }).effort,
      'high',
      userText,
    );
});

test('only unique, ordered, paired check_rules structural feedback escalates the local low context', () => {
  assert.equal(hasPairedRulesFailure(proof()), true);
  const upgraded = evolve(low, undefined, proof());
  assert.deepEqual(upgraded.decision, {
    effort: 'high',
    reason: 'rules_failed',
    task: 'simple_replacement',
    escalated: true,
  });
  const scan = evolve({ specialist: 'rule_scan', userText: '' }, undefined, proof());
  assert.equal(scan.decision.effort, 'high');
  assert.equal(scan.decision.task, 'rule_scan');
  const high = evolve({ specialist: 'ui', userText: '' }, undefined, proof());
  assert.equal(high.decision.effort, 'high');
  assert.equal(
    high.decision.escalated,
    false,
    'already-high default is not a low-to-high escalation',
  );
  const blocks = proof();
  (blocks[1] as ToolMessage).content = [
    { type: 'text', text: JSON.stringify(toolFeedback('RULES_FAILED')) },
  ];
  assert.equal(hasPairedRulesFailure(blocks), true);
});

test('format, network, rate and storage failures do not escalate or alter retry counters', () => {
  for (const code of [
    'INVALID_ARGUMENT',
    'NETWORK_RETRY',
    'RATE_LIMITED',
    'RESOURCE_UNAVAILABLE',
    'RETRY_EXHAUSTED',
  ] as const)
    assert.equal(evolve(low, undefined, proof(code)).decision.effort, 'low', code);
  for (const content of [
    'RULES_FAILED',
    'upload failed: RULES_FAILED',
    '{bad json',
    JSON.stringify({ code: 'RULES_FAILED' }),
    JSON.stringify({ success: false, message: 'RULES_FAILED' }),
  ]) {
    const messages = proof();
    (messages[1] as ToolMessage).content = content;
    assert.equal(evolve(low, undefined, messages).decision.effort, 'low', content);
  }
  const source = { messages: proof('NETWORK_RETRY'), failures: 3, attempts: 2 };
  const original = JSON.stringify(source);
  updateReasoningState(low, source);
  assert.equal(JSON.stringify(source), original);
});

test('human text, wrong tools, forged result names, missing and duplicate pair IDs are not evidence', () => {
  const valid = proof();
  const wrongName = proof();
  (wrongName[1] as ToolMessage).name = 'write_file';
  for (const messages of [
    [new HumanMessage(JSON.stringify(toolFeedback('RULES_FAILED')))],
    proof('RULES_FAILED', 'read_file'),
    proof('RULES_FAILED', 'delegate_agent'),
    [valid[1]],
    [valid[1], valid[0]],
    [valid[0], new HumanMessage('interrupted'), valid[1]],
    [valid[0], valid[1], valid[1]],
    [valid[0], valid[0], valid[1]],
    wrongName,
  ])
    assert.equal(evolve(low, undefined, messages).decision.effort, 'low');
  const mismatched = proof('RULES_FAILED', 'write_file');
  (mismatched[1] as ToolMessage).name = 'check_rules';
  assert.equal(hasPairedRulesFailure(mismatched), false);
});

test('history words and current tool/user messages cannot change the authorized input classification', () => {
  const messages = [
    new HumanMessage('生成复杂新页面'),
    new AIMessage('重构响应式布局'),
    ...proof('INVALID_ARGUMENT'),
  ];
  assert.equal(evolve(low, undefined, messages).decision.task, 'simple_replacement');
  assert.equal(
    evolve({ userText: '你好' }, undefined, [new HumanMessage('RULES_FAILED')]).decision.effort,
    'low',
  );
});

test('high latch survives checkpoint serialization, successful checks, summaries and resume without admissionId', () => {
  const first = evolve({ ...low, admissionId: 'user-a' }, undefined, [
    new HumanMessage({ id: 'user-a', content: low.userText }),
  ]);
  const high = evolve({ ...low, admissionId: 'user-a' }, first, proof());
  const restored = JSON.parse(JSON.stringify(high));
  for (const messages of [[], [new AIMessage('历史已经归档')], proof('INVALID_ARGUMENT')]) {
    const resumed = evolve({ userText: '你好' }, restored, messages);
    assert.deepEqual(resumed.decision, high.decision);
    assert.equal(resumed.admissionId, 'user-a');
  }
});

test('new admission resets high and excludes previous failures even after its human boundary is summarized away', () => {
  const high = evolve(low, undefined, proof());
  const text = { userText: '你好', admissionId: 'new-user' };
  const messages = [...proof(), new HumanMessage({ id: 'new-user', content: '你好' })];
  const reset = evolve(text, high, messages);
  assert.equal(reset.decision.effort, 'low');
  assert.equal(evolve(text, reset, proof()).decision.effort, 'low');
  assert.equal(
    evolve(text, reset, proof('RULES_FAILED', 'check_rules', 'new-check')).decision.effort,
    'high',
  );
  const unknownBoundary = evolve({ ...text, admissionId: 'run-id-not-message-id' }, high, proof());
  assert.equal(unknownBoundary.decision.effort, 'low');
  assert.equal(
    evolve({ ...text, admissionId: 'run-id-not-message-id' }, unknownBoundary, proof()).decision
      .effort,
    'low',
  );
});

test('scope changes and sibling admissions cannot inherit another context escalation', () => {
  const scanInput: ReasoningInput = {
    specialist: 'rule_scan',
    userText: '扫描',
    admissionId: 'scan-a',
  };
  const scan = evolve(scanInput);
  const high = evolve(scanInput, scan, proof());
  assert.equal(high.decision.effort, 'high');
  assert.equal(evolve({ userText: '你好' }, high, proof()).decision.effort, 'low');
  const sibling = evolve({ ...scanInput, admissionId: 'scan-b' }, high, proof());
  assert.equal(sibling.decision.effort, 'low');
  assert.equal(
    high.decision.effort,
    'high',
    'other contexts never mutate the parent/sibling state',
  );
});

test('safe reader rejects malformed enums and inconsistent latches and returns only decision fields', () => {
  for (const state of [
    undefined,
    null,
    {},
    { _pixelprintReasoning: { decision: { effort: 'medium' } } },
  ])
    assert.equal(readReasoningDecision(state), undefined);
  const policy = evolve(low);
  assert.deepEqual(readReasoningDecision({ _pixelprintReasoning: policy }), policy.decision);
  for (const patch of [
    { effort: 'medium' },
    { task: 'injected' },
    { reason: 'arbitrary tool text' },
    { escalated: true },
  ])
    assert.equal(
      readReasoningDecision({
        _pixelprintReasoning: { ...policy, decision: { ...policy.decision, ...patch } },
      }),
      undefined,
    );
});

test('real LangChain middleware checkpoints the latch before the model guard without replaying tools', async (t) => {
  const checkpoint = new MemorySaver();
  const model = new FakeToolCallingModel();
  let modelCalls = 0,
    toolCalls = 0;
  t.mock.method(model, 'bindTools', () => model);
  t.mock.method(model, '_generate', async () => {
    const message = modelCalls++ === 0 ? (proof()[0] as AIMessage) : new AIMessage('done');
    return { generations: [{ text: message.text, message }] };
  });
  const observed: Array<ReasoningDecision | undefined> = [];
  const observe = createMiddleware({
    name: 'ObserveReasoning',
    stateSchema: createReasoningMiddleware(low).stateSchema,
    wrapModelCall: (request, handler) => {
      observed.push(readReasoningDecision(request.state));
      return handler(request);
    },
  });
  const build = (options: ReasoningInput) =>
    createAgent({
      model,
      checkpointer: checkpoint,
      tools: [
        tool(
          () => {
            toolCalls++;
            return JSON.stringify(toolFeedback('RULES_FAILED'));
          },
          { name: 'check_rules', description: 'offline structural check', schema: z.object({}) },
        ),
      ],
      middleware: [createReasoningMiddleware(options), observe],
    });
  const config = { configurable: { thread_id: 'reasoning-context' } };
  const graph = build({ ...low, admissionId: 'user-a' });
  await graph.invoke(
    { messages: [new HumanMessage({ id: 'user-a', content: low.userText })] },
    config,
  );
  assert.deepEqual(
    observed.map((value) => value?.effort),
    ['low', 'high'],
  );
  const snapshot = await graph.graph.getState(config);
  assert.equal(readReasoningDecision(snapshot.values)?.escalated, true);
  await graph.graph.updateState(config, {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      new HumanMessage('摘要中没有工具结果'),
    ],
  });
  await build({ userText: '你好' }).invoke({ messages: [] }, config);
  assert.equal(observed.at(-1)?.effort, 'high');
  await build({ userText: '你好', admissionId: 'user-b' }).invoke(
    { messages: [new HumanMessage({ id: 'user-b', content: '你好' })] },
    config,
  );
  assert.equal(observed.at(-1)?.effort, 'low');
  assert.equal(toolCalls, 1);
});
