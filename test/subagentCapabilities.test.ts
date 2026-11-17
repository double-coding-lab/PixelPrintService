import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createSubagentTools,
  subagentToolsForRole,
} from '../src/functions/d2c/run/agent/subagentTools';
import {
  subagentEventSchema,
  subagentInstructions,
  subagentLimits,
  type SubagentRole,
} from '../src/functions/d2c/run/subagent';
import {
  modelActivitySchema,
  observeModelRequest,
} from '../src/functions/d2c/run/agent/modelActivity';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';
import type { GenerationTools } from '../src/functions/d2c/run/types';
import { describeEvent } from '../web/src/workspace/timeline';

/** 记录实际底层动作，证明越权调用不会触达文件或执行工具。 */
function fixture() {
  const actions: unknown[][] = [];
  const tools: GenerationTools = {
    async list() {
      actions.push(['list']);
      return ['page/index.tsx'];
    },
    async read(...args) {
      actions.push(['read', ...args]);
      return 'real cache';
    },
    async write(...args) {
      actions.push(['write', ...args]);
      return 'saved';
    },
    async figma(...args) {
      actions.push(['figma', ...args]);
      return 'real inspection';
    },
    async remove(...args) {
      actions.push(['remove', ...args]);
      return 'removed';
    },
    async rules(...args) {
      actions.push(['rules', ...args]);
      return 'checked';
    },
    async slices(...args) {
      actions.push(['slices', ...args]);
      return 'sliced';
    },
  };
  return { tools, actions };
}

/** 检查固定可纠正分类，避免普通成功文本掩盖拒绝。 */
function invalid(error: unknown) {
  return error instanceof ToolIssue && error.feedback.code === 'INVALID_ARGUMENT';
}

test('只读角色仅暴露list/read，直接调用受禁方法也不会执行', async () => {
  for (const role of ['design', 'review'] as const) {
    const f = fixture();
    const tools = createSubagentTools(f.tools, role);
    assert.deepEqual(subagentToolsForRole(role), ['list_files', 'read_file', 'report_progress']);
    assert.equal(tools.list, f.tools.list);
    assert.equal(tools.read, f.tools.read);
    await assert.rejects(tools.write('page/index.tsx', 'code'), invalid);
    await assert.rejects(tools.figma('inspect-node', {}), invalid);
    assert.throws(() => createSubagentTools(f.tools, role, ['page/index.tsx']), invalid);
    await assert.rejects(tools.remove('page/index.tsx'), invalid);
    await assert.rejects(tools.rules('page', 'block'), invalid);
    await assert.rejects(tools.slices('page'), invalid);
    assert.deepEqual(f.actions, []);
  }
});

test('UI精确白名单允许多block源码和消费记录，默认空与目录授权不能写入', async () => {
  const f = fixture();
  const paths = ['page/a/index.tsx', 'page/b/style.scss', 'page/b/data.json', 'page/b/assets.txt'];
  const tools = createSubagentTools(f.tools, 'ui', paths);
  paths.push('page/late.ts');
  for (const p of paths.slice(0, -1)) assert.equal(await tools.write(p, 'actual'), 'saved');
  for (const p of ['page/late.ts', 'page/a/child.tsx', 'page/a/index.tsx/'])
    await assert.rejects(tools.write(p, 'no'), invalid);
  assert.throws(() => createSubagentTools(f.tools, 'ui'), invalid);
  assert.throws(() => createSubagentTools(f.tools, 'rule_scan', []), invalid);
  assert.equal(f.actions.length, 4);
  assert.throws(() => createSubagentTools(f.tools, 'ui', ['page/a/']), invalid);
});

test('委派前拒绝路径别名、隐藏资源、包配置、清单和伪造规则证据', () => {
  const f = fixture();
  for (const path of [
    '/page/a.tsx',
    '../a.tsx',
    'page/../a.tsx',
    'page\\a.tsx',
    'C:/a.tsx',
    'page//a.tsx',
    './a.tsx',
    'page/%2e%2e/a.tsx',
    'page/a.tsx/',
    ' page/a.tsx',
    '.d2c-cache/meta.json',
    'page/.hidden/a.tsx',
    'page/.d2c-tasks.md',
    'page/package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pp-d2c.config.json',
    'page/node_modules/a.ts',
    'page/rule-hits.json',
    'README.md',
    'page/image.png',
  ])
    assert.throws(() => createSubagentTools(f.tools, 'ui', [path]), invalid, path);
  assert.deepEqual(f.actions, []);
});

test('规则扫描只写明确授权的rule-hits.json，不放宽报告扩展与其他block', async () => {
  const f = fixture();
  const tools = createSubagentTools(f.tools, 'rule_scan', ['page/a/rule-hits.json']);
  await tools.write('page/a/rule-hits.json', '{"hits":[]}');
  for (const path of ['page/b/rule-hits.json', 'page/a/rule-hits-extra.json', 'page/a/index.tsx'])
    await assert.rejects(tools.write(path, ''), invalid);
  for (const path of [
    'rule-hits-extra.json',
    'block-rule-hits.json',
    '.d2c-cache/rule-hits.json',
    '../rule-hits.json',
  ])
    assert.throws(() => createSubagentTools(f.tools, 'rule_scan', [path]), invalid);
  assert.deepEqual(f.actions, [['write', 'page/a/rule-hits.json', '{"hits":[]}']]);
});

test('执行角色figma仅转发已有缓存inspect，不支持网络、导出或任意规则执行', async () => {
  for (const role of ['rule_scan', 'ui'] as const) {
    const f = fixture();
    const tools = createSubagentTools(f.tools, role, [
      role === 'ui' ? 'page/a.tsx' : 'page/rule-hits.json',
    ]);
    assert.deepEqual(subagentToolsForRole(role), [
      'list_files',
      'read_file',
      'write_file',
      ...(role === 'ui' ? ['edit_file'] : []),
      'figma',
      ...(role === 'ui' ? ['check_rules'] : []),
      'report_progress',
    ]);
    await tools.figma('inspect-node', { nodeId: '1:2', depth: 2 });
    for (const command of [
      'fetch-node',
      'cache-check',
      'verify-token',
      'export-image',
      'screenshot',
      'sh',
    ])
      await assert.rejects(tools.figma(command, {}), invalid);
    await assert.rejects(tools.figma('inspect-node', { depth: 3 }), invalid);
    await assert.rejects(tools.figma('inspect-node', { filename: 'out.png' }), invalid);
    await assert.rejects(tools.rules('page', 'merge'), invalid);
    await assert.rejects(tools.remove('page/a.tsx'), invalid);
    await assert.rejects(tools.slices('page'), invalid);
    assert.deepEqual(f.actions, [['figma', 'inspect-node', { nodeId: '1:2', depth: 2 }]]);
    const failure = new Error('lease lost');
    f.tools.figma = async () => {
      throw failure;
    };
    await assert.rejects(tools.figma('inspect-node', {}), (error) => error === failure);
  }
});

test('扫描和UI可分批读完整缓存子树，仍拒绝无界分页和网络操作', async () => {
  for (const role of ['rule_scan', 'ui'] as const) {
    const f = fixture();
    const tools = createSubagentTools(f.tools, role, [
      role === 'ui' ? 'page/a.tsx' : 'page/rule-hits.json',
    ]);
    const args = { nodeId: '1:2', subtree: true, offset: 40, limit: 40 };
    await tools.figma('inspect-node', args);
    assert.deepEqual(f.actions, [['figma', 'inspect-node', args]]);
    await assert.rejects(tools.figma('inspect-node', { subtree: true, limit: 101 }), invalid);
    await assert.rejects(tools.figma('inspect-node', { offset: 40 }), invalid);
    await assert.rejects(tools.figma('fetch-node', args), invalid);
  }
});

test('角色指令保留真实规则输入、父清单职责与固定Skill例外，限额区分读写', () => {
  assert.deepEqual(subagentLimits, {
    calls: 2,
    concurrency: 2,
    turns: 6,
    executionTurns: 40,
    executionCalls: 64,
    taskBytes: 8000,
    outputBytes: 12000,
  });
  assert.match(subagentInstructions('rule_scan'), /rules\/README.md、全部规则.*真实完整缓存/);
  assert.match(subagentInstructions('ui'), /micro-sub.*内联/);
  for (const role of ['design', 'review', 'rule_scan', 'ui'] as SubagentRole[]) {
    const prompt = subagentInstructions(role);
    assert.match(prompt, /nested sub.*parent/);
    assert.match(prompt, /清单由父 Agent 维护/);
    assert.match(prompt, /真实文件路径/);
    assert.match(prompt, /具体过程.*固定 Skill/);
  }
});

test('新角色事件、模型scope及时间线中文展示保持兼容', async () => {
  for (const role of ['rule_scan', 'ui'] as const) {
    const agentId = randomUUID();
    for (const tool of ['write_file', 'figma'] as const) {
      const data = subagentEventSchema.parse({
        stage: 'subagent',
        role,
        agentId,
        status: 'tool_completed',
        tool,
      });
      const label = describeEvent({
        entryId: 'e1',
        sessionId: 's',
        at: '',
        seq: 1,
        runId: 'r',
        kind: 'stage',
        data: { ...data, tool },
      });
      assert.match(label, role === 'ui' ? /UI 实现/ : /规则扫描/);
      assert.ok(label.includes(tool));
    }
    const events: unknown[] = [];
    await observeModelRequest(
      role,
      async () => 'done',
      async (event) => {
        events.push(modelActivitySchema.parse(event));
      },
    );
    assert.equal(events.length, 2);
    assert.match(
      describeEvent({
        entryId: 'e2',
        sessionId: 's',
        at: '',
        seq: 2,
        runId: 'r',
        kind: 'model_status',
        data: { scope: role, status: 'completed' },
      }),
      role === 'ui' ? /UI 实现模型调用/ : /规则扫描模型调用/,
    );
  }
});

test('执行子Agent收到的Figma模型schema只允许缓存查询和深度1或2', async (t) => {
  const { FakeToolCallingModel } = await import('langchain');
  const { HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const model = new FakeToolCallingModel();
  let checked = false;
  t.mock.method(model, 'bindTools', (tools: any[]) => {
    const rules = tools.find((tool) => tool.name === 'check_rules');
    assert.equal(rules.schema.safeParse({ path: 'page/blocks/card', mode: 'block' }).success, true);
    assert.equal(
      rules.schema.safeParse({ path: 'page/blocks/card', mode: 'merge' }).success,
      false,
    );
    const schema = tools.find((tool) => tool.name === 'figma').schema;
    const args = {
      command: 'inspect-node',
      nodeId: '1:2',
      depth: 1,
      filename: null,
      format: null,
      scale: null,
    };
    assert.equal(schema.safeParse(args).success, true);
    assert.equal(schema.safeParse({ ...args, subtree: true, offset: 40, limit: 40 }).success, true);
    assert.equal(schema.safeParse({ ...args, subtree: true, limit: 101 }).success, false);
    assert.equal(schema.safeParse({ ...args, command: 'fetch-node' }).success, false);
    assert.equal(schema.safeParse({ ...args, depth: 4 }).success, false);
    assert.equal(schema.safeParse({ ...args, filename: 'out.png' }).success, false);
    checked = true;
    return model;
  });
  await runAgent({
    model,
    specialist: 'ui',
    messages: [new HumanMessage('读取已有设计缓存')],
    instructions: '',
    maxTurns: 2,
    contextBudgetTokens: 16000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: fixture().tools,
  });
  assert.equal(checked, true);
});
