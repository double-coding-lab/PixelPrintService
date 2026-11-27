import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import {
  generationFinishingEvidence,
  generationFinishingPrompt,
} from '../src/functions/d2c/run/agent/generationFinishing';
import {
  initialReasoningDecision,
  readReasoningDecision,
  updateReasoningState,
} from '../src/functions/d2c/run/agent/reasoning';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import type { AgentCheckpoint } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import type { GenerationTools } from '../src/functions/d2c/run/types';
import { toolFeedback } from '../src/functions/d2c/run/toolFeedback';

const entryPath = 'pages/home/index.jsx';
const admissionId = 'generate-page';
const user = () => new HumanMessage({ id: admissionId, content: '生成完整页面' });
const merged = () => ({
  ok: true,
  checked: ['R01', 'R02'],
  passed: ['R01', 'R02'],
  skipped: [],
  failed: [],
  violations: [],
  warnings: [],
});
const captured = () => ({
  ok: true,
  previewId: 'preview-current',
  fileRevision: 12,
  entryPath,
  imageRef: `attachment://${'a'.repeat(64)}`,
  width: 375,
  height: 800,
  errors: [],
  missingAssets: [],
});

/** 使用生产工具的真实参数与回执形状，不用助手口头结论作为通过凭据。 */
function pair(
  name: string,
  args: Record<string, unknown>,
  value: unknown,
  id = name,
): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ id, name, args }] }),
    new ToolMessage({
      name,
      tool_call_id: id,
      content: typeof value === 'string' ? value : JSON.stringify(value),
    }),
  ];
}
const merge = () => pair('check_rules', { path: 'pages/home', mode: 'merge' }, merged());
const capture = () => pair('inspect_preview', { entryPath }, captured());
const read = () =>
  pair('read_file', { path: entryPath, resource: false }, 'export default function Page() {}');
const proof = () => [user(), ...merge(), ...capture(), ...read()];
const evidence = (messages: BaseMessage[]) => generationFinishingEvidence(messages, admissionId);

test('only a paired current merge, same-entry capture and later read response provide a hint', () => {
  assert.deepEqual(evidence(proof()), {
    entryPath,
    fileRevision: 12,
    imageRef: captured().imageRef,
  });
  assert.equal(
    evidence([user(), ...merge(), ...capture()]),
    undefined,
    'first visual comparison has no hint',
  );
  assert.equal(
    evidence([user(), ...capture(), ...merge(), ...read()]),
    undefined,
    'merge must precede capture',
  );
  assert.equal(evidence([user(), ...merge(), ...read()]), undefined);
  assert.equal(evidence([user(), ...capture(), ...read()]), undefined);
  assert.equal(
    evidence([user(), ...merge(), ...capture(), new AIMessage('视觉已通过')]),
    undefined,
  );
  assert.match(generationFinishingPrompt, /不证明图片已载入或视觉验收通过/);
  assert.match(generationFinishingPrompt, /先完成尚未完成的截图视觉比较/);
});

test('old, absent, ambiguous, new user and newly applied guidance boundaries fall back', () => {
  assert.equal(generationFinishingEvidence(proof()), undefined);
  assert.equal(generationFinishingEvidence(proof(), 'missing'), undefined);
  assert.equal(evidence([...proof(), user()]), undefined);
  assert.equal(evidence([...proof(), new HumanMessage('新需求：重新调整布局')]), undefined);
  assert.equal(evidence([...merge(), ...capture(), user(), ...read()]), undefined);
  assert.equal(
    evidence([
      new HumanMessage({ id: admissionId, content: '归档摘要：merge和截图都通过' }),
      ...read(),
    ]),
    undefined,
  );
  assert.equal(generationFinishingEvidence(proof(), admissionId, ['new-guidance']), undefined);
  assert.equal(
    generationFinishingEvidence(proof(), admissionId, [admissionId])?.entryPath,
    entryPath,
  );
});

test('pairing rejects missing, duplicated, reordered, forged and chunk messages', () => {
  const p = proof();
  for (const messages of [
    p.filter((_, index) => index !== 1),
    [...p, p[2]],
    [...p, p[1]],
    [p[0], p[2], p[1], ...p.slice(3)],
    [
      p[0],
      new AIMessageChunk({
        content: '',
        tool_calls: [
          { id: 'check_rules', name: 'check_rules', args: { path: 'pages/home', mode: 'merge' } },
        ],
      }),
      ...p.slice(2),
    ],
    [
      p[0],
      p[1],
      new ToolMessage({
        name: 'read_file',
        tool_call_id: 'check_rules',
        content: JSON.stringify(merged()),
      }),
      ...p.slice(3),
    ],
    [
      p[0],
      {
        type: 'ai',
        tool_calls: [{ id: 'check_rules', name: 'check_rules', args: {} }],
      } as unknown as BaseMessage,
      ...p.slice(2),
    ],
  ])
    assert.equal(evidence(messages), undefined);
  assert.equal(
    evidence([
      user(),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'check_rules', args: { path: 'pages/home', mode: 'merge' } }],
      }),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
});

test('actual makeReport fields are required; block, skipped and conflicting reports are not completion', () => {
  for (const patch of [
    { ok: false },
    { skipped: ['R01'] },
    { checked: [] },
    { passed: [] },
    { checked: ['R01', 'R01'] },
    { passed: ['R01', 'R03'] },
    { failed: ['R01'] },
    { violations: [{ rule: 'R01' }] },
    { warnings: [{ rule: 'R01' }] },
    { success: false },
    { type: 'tool_feedback', ok: false, code: 'RULES_FAILED' },
  ])
    assert.equal(
      evidence([
        user(),
        ...pair('check_rules', { path: 'pages/home', mode: 'merge' }, { ...merged(), ...patch }),
        ...capture(),
        ...read(),
      ]),
      undefined,
    );
  assert.equal(
    evidence([
      user(),
      ...pair('check_rules', { path: 'pages/home', mode: 'block' }, merged()),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
  assert.equal(
    evidence([
      user(),
      ...pair('check_rules', { path: 'pages/home', mode: 'merge' }, { ok: true }),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
});

test('a capture needs explicit matching entry, revision, image and clean current diagnostics', () => {
  for (const patch of [
    { ok: false },
    { entryPath: 'pages/other/index.jsx' },
    { fileRevision: undefined },
    { fileRevision: -1 },
    { imageRef: undefined },
    { imageRef: 'https://example.com/image.png' },
    { errors: [{ code: 'RUNTIME_ERROR' }] },
    { errors: undefined },
    { missingAssets: ['missing.png'] },
    { missingAssets: undefined },
    { truncated: true },
    { width: 0 },
  ])
    assert.equal(
      evidence([
        user(),
        ...merge(),
        ...pair('inspect_preview', { entryPath }, { ...captured(), ...patch }),
        ...read(),
      ]),
      undefined,
    );
  for (const args of [
    {},
    { entryPath: null },
    { entryPath: 'pages/other/index.jsx' },
    { entryPath, focusSelector: '.target' },
    { entryPath, actions: [{ type: 'click', selector: '.next' }] },
  ])
    assert.equal(
      evidence([user(), ...merge(), ...pair('inspect_preview', args, captured()), ...read()]),
      undefined,
    );
  assert.equal(
    evidence([
      user(),
      ...pair('check_rules', { path: 'pages', mode: 'merge' }, merged()),
      ...capture(),
      ...read(),
    ]),
    undefined,
    'ancestor scope cannot prove the exact page',
  );
});

test('all later source, dependency and resource modifications invalidate old evidence', () => {
  for (const [name, args] of [
    ['write_file', { path: entryPath, content: 'new source' }],
    ['edit_file', { path: 'pages/home/index.scss', oldText: 'red', newText: 'blue' }],
    ['delete_file', { path: entryPath }],
    ['write_file', { path: 'package.json', content: '{}' }],
    ['write_file', { path: 'pages/home/assets.txt', content: 'new asset' }],
    ['prepare_slices', { slug: 'new-assets' }],
    ['figma', { command: 'fetch-node' }],
    ['unknown_tool', {}],
  ] as const) {
    const change = pair(name, args, { ok: true });
    assert.equal(
      evidence([...proof(), ...change, ...pair('list_files', { path: 'pages/home' }, [])]),
      undefined,
      name,
    );
  }
  const mixed = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'mixed-write', name: 'write_file', args: { path: entryPath, content: 'new source' } },
      { id: 'mixed-merge', name: 'check_rules', args: { path: 'pages/home', mode: 'merge' } },
    ],
  });
  assert.equal(
    evidence([
      user(),
      mixed,
      new ToolMessage({ name: 'write_file', tool_call_id: 'mixed-write', content: 'saved' }),
      new ToolMessage({
        name: 'check_rules',
        tool_call_id: 'mixed-merge',
        content: JSON.stringify(merged()),
      }),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
  assert.ok(
    evidence([
      user(),
      ...pair('write_file', { path: entryPath, content: 'source' }, 'saved'),
      ...merge(),
      ...capture(),
      ...read(),
    ]),
  );
});

test('tool failures, unknown results and uncollected or failed delegated tasks block hints', () => {
  for (const value of [
    toolFeedback('RULES_FAILED'),
    toolFeedback('NETWORK_RETRY'),
    { ok: false },
    { success: false },
    { error: 'failed' },
  ])
    assert.equal(
      evidence([...proof(), ...pair('read_file', { path: entryPath }, value, 'failed-read')]),
      undefined,
    );
  const status = read();
  (status[1] as ToolMessage).status = 'error';
  assert.equal(evidence([user(), ...merge(), ...capture(), ...status]), undefined);
  const delegated = () =>
    pair(
      'delegate_agent',
      { role: 'ui', writePaths: ['pages/home/blocks/card/index.jsx'] },
      { accepted: true, agentId: 'child-1', status: 'completed' },
    );
  const wait = (result: unknown, shouldWait = true) =>
    pair(
      'wait_subagents',
      { wait: shouldWait, mode: 'all' },
      { agents: [{ agentId: 'child-1', status: 'completed', result: JSON.stringify(result) }] },
    );
  const success = { success: true, role: 'ui', files: ['pages/home/blocks/card/index.jsx'] };
  assert.equal(evidence([user(), ...delegated(), ...merge(), ...capture(), ...read()]), undefined);
  for (const delivery of [
    { ...success, success: false },
    { ...success, role: 'rule_scan' },
    { ...success, files: [] },
    { ...success, handoff: {} },
  ])
    assert.equal(
      evidence([user(), ...delegated(), ...wait(delivery), ...merge(), ...capture(), ...read()]),
      undefined,
    );
  assert.equal(
    evidence([
      user(),
      ...delegated(),
      ...wait(success, false),
      ...merge(),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
  assert.ok(
    evidence([user(), ...delegated(), ...wait(success), ...merge(), ...capture(), ...read()]),
  );
  assert.equal(
    evidence([...delegated(), user(), ...merge(), ...capture(), ...read()]),
    undefined,
    'old delegation is not assumed settled',
  );
});

test('evidence only advises: persisted and restored high locks remain unchanged', () => {
  const input = { userText: '只替换图片', hasSourceFiles: true, admissionId };
  const messages = [
    user(),
    ...pair(
      'check_rules',
      { path: 'pages/home', mode: 'merge' },
      toolFeedback('RULES_FAILED'),
      'failed-rules',
    ),
    ...merge(),
    ...capture(),
    ...read(),
  ];
  const state = { messages, _pixelprintReasoning: updateReasoningState(input, { messages }) };
  assert.equal(state._pixelprintReasoning.decision.escalated, true);
  assert.equal(readReasoningDecision(state)?.effort, 'high');
  assert.ok(evidence(messages), 'only the later new merge/capture pair rebuilds hint evidence');
  const saved = JSON.stringify(state._pixelprintReasoning);
  evidence(proof());
  assert.equal(JSON.stringify(state._pixelprintReasoning), saved);
  assert.equal(readReasoningDecision({ _pixelprintReasoning: JSON.parse(saved) })?.effort, 'high');
  assert.equal(initialReasoningDecision({ userText: '生成完整页面' }).effort, 'high');
});

test('correctable failures discard old gates; only new merge, capture and read rebuild evidence', () => {
  for (const [name, code] of [
    ['check_rules', 'RULES_FAILED'],
    ['edit_file', 'INVALID_ARGUMENT'],
  ] as const) {
    const failure = pair(
      name,
      name === 'check_rules' ? { path: 'pages/home', mode: 'merge' } : { path: entryPath },
      toolFeedback(code),
      'recoverable-failure',
    );
    const repair = pair(
      'write_file',
      { path: entryPath, content: 'repaired' },
      `已保存：${entryPath}`,
      'repair',
    );
    assert.ok(evidence([user(), ...failure, ...repair, ...merge(), ...capture(), ...read()]));
    assert.equal(evidence([...proof(), ...failure]), undefined);
    assert.equal(
      evidence([
        ...proof(),
        ...failure,
        ...pair('read_file', { path: entryPath }, 'source', 'later-read'),
      ]),
      undefined,
    );
    assert.equal(evidence([user(), ...merge(), ...failure, ...capture(), ...read()]), undefined);
    assert.equal(evidence([user(), ...failure, ...repair, ...merge(), ...read()]), undefined);
    assert.equal(evidence([user(), ...failure, ...repair, ...merge(), ...capture()]), undefined);
    assert.equal(
      evidence([user(), failure[1], ...repair, ...merge(), ...capture(), ...read()]),
      undefined,
    );
  }
  for (const [name, value] of [
    ['read_file', { ...toolFeedback('INVALID_ARGUMENT'), outcome: 'unknown' }],
    ['delegate_agent', toolFeedback('INVALID_ARGUMENT')],
    ['unknown_tool', toolFeedback('INVALID_ARGUMENT')],
    ['read_file', toolFeedback('RULES_FAILED')],
    ['read_file', toolFeedback('NETWORK_RETRY')],
  ] as const)
    assert.equal(
      evidence([
        user(),
        ...pair(name, {}, value, 'unsafe-failure'),
        ...merge(),
        ...capture(),
        ...read(),
      ]),
      undefined,
    );
  const pending = pair(
    'delegate_agent',
    { role: 'ui' },
    { accepted: true, status: 'completed', agentId: 'pending-child' },
  );
  assert.equal(
    evidence([
      user(),
      ...pending,
      ...pair(
        'check_rules',
        { path: 'pages/home', mode: 'merge' },
        toolFeedback('RULES_FAILED'),
        'failed-before-join',
      ),
      ...merge(),
      ...capture(),
      ...read(),
    ]),
    undefined,
  );
});

for (const scenario of [
  'normal',
  'missing-image',
  'source-change',
  'new-guidance',
  'failed-read',
  'wrong-entry',
  'repaired-rules',
] as const) {
  test(`real agent graph retains high and visual gates: ${scenario}`, async () => {
    const selected: string[] = [];
    const hints: boolean[] = [];
    const images: boolean[] = [];
    let turn = 0;
    let ruleCalls = 0;
    let captureCalls = 0;
    let source = 'export default function Page() {}';
    let repaired = false;
    const userText = scenario === 'repaired-rules' ? '只替换图片' : '生成完整页面';
    const plan = [
      ...(scenario === 'repaired-rules'
        ? [
            pair('check_rules', { path: 'pages/home', mode: 'merge' }, '', 'before-repair')[0],
            pair(
              'write_file',
              { path: entryPath, content: 'export default function Page() { return null; }' },
              '',
              'repair-source',
            )[0],
          ]
        : []),
      merge()[0],
      capture()[0],
      read()[0],
      ...(scenario === 'source-change'
        ? [
            pair(
              'write_file',
              { path: entryPath, content: 'export default function Page() { return null; }' },
              '',
              'source-change',
            )[0],
          ]
        : []),
      new AIMessage('已完成说明'),
    ];
    const model = (effort: string) => {
      const value = new FakeToolCallingModel();
      value.bindTools = () => value;
      value._generate = async (messages) => {
        selected.push(effort);
        hints.push(
          messages.some(
            (message) =>
              message.type === 'system' && message.text.includes(generationFinishingPrompt),
          ),
        );
        images.push(
          messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  block.type === 'image_url' &&
                  JSON.stringify(block).includes('data:image/png;base64,'),
              ),
          ),
        );
        const message = plan[turn++] as AIMessage;
        assert.ok(message, 'no unexpected model request');
        return { generations: [{ text: message.text, message }] };
      };
      return value;
    };
    const models = { low: model('low'), high: model('high') };
    const checkpoint = Object.assign(new MemorySaver(), {
      config: (namespace = '', id?: string) => ({
        configurable: {
          thread_id: 'finishing-graph',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      }),
    }) as AgentCheckpoint;
    const tools: GenerationTools = {
      list: async () => [],
      read: async () =>
        scenario === 'failed-read' ? JSON.stringify(toolFeedback('NETWORK_RETRY')) : source,
      write: async (path, content) => {
        if (scenario !== 'repaired-rules') return '';
        assert.equal(path, entryPath);
        source = content;
        repaired = true;
        return `已保存：${path}`;
      },
      remove: async () => '',
      figma: async () => '',
      slices: async () => '',
      rules: async () => {
        ruleCalls++;
        if (scenario === 'repaired-rules' && ruleCalls === 1)
          return JSON.stringify(toolFeedback('RULES_FAILED'));
        if (scenario === 'repaired-rules')
          assert.equal(repaired, true, 'new merge checks the repaired source');
        return JSON.stringify(merged());
      },
      preview: {
        build: async () => JSON.stringify({ ok: true }),
        inspect: async () => {
          captureCalls++;
          if (scenario === 'repaired-rules') assert.equal(repaired, true);
          return JSON.stringify({
            ...captured(),
            ...(scenario === 'wrong-entry' ? { entryPath: 'pages/other/index.jsx' } : {}),
          });
        },
        needsInspection: async () => false,
      },
    };
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
      'base64',
    );
    await runAgent({
      model: models.high,
      reasoningModels: models,
      reasoningUserText: userText,
      reasoningAdmissionId: admissionId,
      reasoningContext: { hasDesign: true, hasSourceFiles: scenario === 'repaired-rules' },
      messages: [new HumanMessage({ id: admissionId, content: userText })],
      instructions: '按计划执行并复核截图',
      checkpoint,
      maxTurns: 8,
      contextBudgetTokens: 100000,
      signal: new AbortController().signal,
      assertLease: async () => {},
      tools,
      ...(scenario === 'new-guidance'
        ? {
            readGuidance: async (applied: string[]) =>
              turn >= 3 && !applied.includes('new-guidance')
                ? [
                    {
                      id: 'new-guidance',
                      message: { role: 'user' as const, content: '重新生成完整页面并修改布局' },
                    },
                  ]
                : [],
          }
        : {}),
      resolveImage: async (ref) =>
        scenario !== 'missing-image' && ref === captured().imageRef
          ? { mimeType: 'image/png', data: png }
          : null,
    });
    assert.deepEqual(
      selected,
      plan.map((_, index) => (scenario === 'repaired-rules' && index === 0 ? 'low' : 'high')),
    );
    assert.deepEqual(hints, [
      ...(scenario === 'repaired-rules' ? [false, false] : []),
      false,
      false,
      false,
      ...(['normal', 'missing-image', 'source-change', 'repaired-rules'].includes(scenario)
        ? [true]
        : [false]),
      ...(scenario === 'source-change' ? [false] : []),
    ]);
    assert.deepEqual(
      images,
      plan.map(
        (_, index) =>
          scenario !== 'missing-image' && index >= (scenario === 'repaired-rules' ? 4 : 2),
      ),
    );
    assert.equal(ruleCalls, scenario === 'repaired-rules' ? 2 : 1);
    assert.equal(captureCalls, 1);
    const saved = await checkpoint.getTuple(checkpoint.config());
    assert.equal(readReasoningDecision(saved?.checkpoint.channel_values)?.effort, 'high');
    if (scenario === 'repaired-rules')
      assert.equal(readReasoningDecision(saved?.checkpoint.channel_values)?.escalated, true);
  });
}

test('layout mismatches and truncated layout coverage cannot provide a finishing hint', () => {
  for (const layout of [
    { issues: [{ code: 'width_mismatch' }], truncated: false },
    { issues: [], truncated: true },
  ]) {
    assert.equal(
      evidence([
        user(),
        ...merge(),
        ...pair('inspect_preview', { entryPath }, { ...captured(), layout }),
        ...read(),
      ]),
      undefined,
    );
  }
});
