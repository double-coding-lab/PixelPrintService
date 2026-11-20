import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { ruleRepairReport, type RuleRepairState } from '../src/functions/d2c/run/agent/ruleRepair';
import { createSubagentProgress } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import type { AgentCheckpoint } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { createSubagentTools } from '../src/functions/d2c/run/agent/subagentTools';
import { toolFeedback } from '../src/functions/d2c/run/toolFeedback';
import { RunExecutionError } from '../src/functions/d2c/run/errors';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const path = 'pages/page/blocks/hero';
const violation = { rule: 'R02', nodeId: '1:2', expected: '引用图片', actual: '已登记但未引用' };
const report = (violations: Array<Record<string, unknown>> = [violation]) =>
  JSON.stringify({
    ...toolFeedback('RULES_FAILED'),
    report: JSON.stringify({ ok: false, violations }),
  });
const passed = JSON.stringify({ ok: true, checked: ['R02'], skipped: [], violations: [] });

/** 离线真实图保留消息配对和检查点，循环模型模拟反复修改清单而违规不变。 */
function fixture(t: test.TestContext, reports: string[]) {
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'rule-repair',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  }) as AgentCheckpoint;
  const files = new Map<string, string>();
  let checks = 0;
  let calls = 0;
  let repair: RuleRepairState | undefined;
  let stalled: string[] = [];
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async (file) => JSON.stringify({ content: files.get(file) ?? '', nextOffset: null }),
    write: async (file, content) => {
      files.set(file, content);
      return 'saved';
    },
    remove: async () => '',
    figma: async () => '',
    slices: async () => '',
    rules: async () => reports[Math.min(checks++, reports.length - 1)],
  };
  const childTools = createSubagentTools(tools, 'ui', [`${path}/assets.txt`]);
  const model = new FakeToolCallingModel();
  t.mock.method(model, 'bindTools', () => model);
  t.mock.method(model, '_generate', async () => {
    const n = calls++;
    const message =
      n >= reports.length * 2
        ? new AIMessage('完成')
        : new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `call-${n}`,
                name: n % 2 ? 'check_rules' : 'write_file',
                args:
                  n % 2
                    ? { path, mode: 'block' }
                    : { path: `${path}/assets.txt`, content: `manifest-${n}` },
              },
            ],
          });
    return { generations: [{ text: message.text, message }] };
  });
  const execute = (admissionId = 'input-1', resetRuleRepair = false) =>
    runAgent({
      model,
      tools: childTools,
      checkpoint,
      specialist: 'ui',
      messages: [new HumanMessage({ content: '实现区块', id: `${admissionId}-${calls}` })],
      instructions: '',
      deliveryAdmissionId: admissionId,
      resetRuleRepair,
      requiredRuleChecks: childTools.requiredRuleChecks,
      onRuleRepair: (state, paths) => {
        repair = state;
        stalled = paths;
      },
      maxTurns: 30,
      contextBudgetTokens: 1000000,
      assertLease: async () => {},
      signal: new AbortController().signal,
    });
  return {
    execute,
    checkpoint,
    files,
    tools,
    get checks() {
      return checks;
    },
    get calls() {
      return calls;
    },
    get repair() {
      return repair;
    },
    get stalled() {
      return stalled;
    },
  };
}

test('违规比较忽略顺序与行号，保留节点、实际差异、文件和期望变化', () => {
  const a = { ...violation, line: 2, snippet: 'before' };
  const b = { rule: 'R03', nodeId: '2:3', expected: 'A', actual: 'B' };
  const first = ruleRepairReport(report([a, b]));
  const moved = ruleRepairReport(report([b, { ...a, line: 20, snippet: 'after' }]));
  assert.equal(first?.passed, false);
  assert.deepEqual(first, moved);
  for (const change of [
    { actual: '未登记且未引用' },
    { expected: '新期望' },
    { nodeId: '1:3' },
    { file: 'other.jsx' },
  ]) {
    const changed = ruleRepairReport(report([{ ...violation, ...change }]));
    assert.notDeepEqual(changed, ruleRepairReport(report()));
  }
  for (const value of [
    'bad',
    '{}',
    JSON.stringify({ ok: false, violations: [] }),
    JSON.stringify(toolFeedback('RULES_FAILED')),
  ])
    assert.equal(ruleRepairReport(value), undefined);
});

test('两轮无改善即结束UI循环；清单写入不清零，文件、失败和检查配对保留', async (t) => {
  const f = fixture(t, [report(), report(), report(), passed]);
  await f.execute();
  assert.equal(f.checks, 3);
  assert.equal(f.calls, 6);
  assert.deepEqual(f.stalled, [path]);
  assert.equal(f.repair?.scopes[path].unchanged, 2);
  assert.equal(f.files.get(`${path}/assets.txt`), 'manifest-4');
  const saved = (await f.checkpoint.getTuple(f.checkpoint.config()))!.checkpoint.channel_values;
  const messages = saved.messages as Array<AIMessage | ToolMessage>;
  assert.equal(messages.filter(ToolMessage.isInstance).length, 6);
  assert.match(messages.at(-1)!.text, /RULES_FAILED/);
  // 相同输入重建图，既不重放工具，也不额外请求模型。
  await f.execute();
  assert.equal(f.checks, 3);
  assert.equal(f.calls, 6);
});

test('违规减少或实际原因改变时允许继续，修复通过后清除失败计数', async (t) => {
  const other = { ...violation, nodeId: '1:3' };
  const f = fixture(t, [
    report([violation, other]),
    report([violation, other]),
    report(),
    report(),
    report([{ ...violation, actual: '已引用但映射变化' }]),
    report([{ ...violation, actual: '已引用但映射变化' }]),
    passed,
  ]);
  await f.execute();
  assert.equal(f.checks, 7);
  assert.deepEqual(f.stalled, []);
  assert.deepEqual(f.repair?.scopes, {});
});

test('新用户输入可重开有限修复机会，原始失败记录仍保留', async (t) => {
  const f = fixture(t, [report(), report(), report(), passed]);
  await f.execute();
  await f.execute('input-2');
  assert.equal(f.checks, 4);
  assert.deepEqual(f.stalled, []);
});

test('检查中的存储故障继续抛出，不转为规则无进展交接', async (t) => {
  const f = fixture(t, [report()]);
  const error = new RunExecutionError('STORAGE_FAILED', { stage: 'storage' });
  f.tools.rules = async () => {
    throw error;
  };
  await assert.rejects(
    f.execute(),
    (value) => value instanceof RunExecutionError && value.code === 'STORAGE_FAILED',
  );
  assert.deepEqual(f.stalled, []);
});

test('父图收到无进展交接后可继续接管，已有文件和上下文归档均保留', async (t) => {
  const f = fixture(t, [report()]);
  f.files.set('pp-d2c.config.json', '{}');
  let parentCalls = 0;
  let childCalls = 0;
  let handed: Record<string, any> | undefined;
  f.tools.figma = async () =>
    JSON.stringify({
      ok: true,
      data: { nodes: [{ attributes: { id: '1:2', name: 'sub-hero' } }] },
    });
  const model = new FakeToolCallingModel();
  t.mock.method(model, 'bindTools', () => model);
  t.mock.method(model, '_generate', async (messages: BaseMessage[]) => {
    let message: AIMessage;
    if (messages[0].text.includes('ROOT_REPAIR')) {
      const n = parentCalls++;
      if (n === 0)
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'delegate',
              name: 'delegate_agent',
              args: {
                role: 'ui',
                nodeId: '1:2',
                task: '实现hero',
                writePaths: [`${path}/assets.txt`],
              },
            },
          ],
        });
      else if (n === 1)
        message = new AIMessage({
          content: '',
          tool_calls: [{ id: 'wait', name: 'wait_subagents', args: { agentIds: [], wait: true } }],
        });
      else {
        handed = JSON.parse(JSON.parse(messages.at(-1)!.text).agents[0].result);
        message = new AIMessage('主Agent已接手剩余引用问题');
      }
    } else {
      const n = childCalls++;
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `child-${n}`,
            name: n % 2 ? 'check_rules' : 'write_file',
            args:
              n % 2
                ? { path, mode: 'block' }
                : { path: `${path}/assets.txt`, content: `saved-${n}` },
          },
        ],
      });
    }
    return { generations: [{ text: message.text, message }] };
  });
  const progress = await createSubagentProgress(f.checkpoint, {
    continuation: false,
    identity: 'repair-job',
    messageId: 'input-1',
  });
  const result = await runAgent({
    model,
    tools: f.tools,
    subagentProgress: progress,
    checkpoint: f.checkpoint,
    messages: [new HumanMessage({ content: '生成', id: 'input-1' })],
    instructions: 'ROOT_REPAIR',
    maxTurns: 30,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async () => {},
  });
  assert.match(result.output, /主Agent已接手/);
  assert.equal(handed?.success, false);
  assert.equal(handed?.reason, 'RULE_REPAIR_STALLED');
  assert.equal(handed?.ruleRepair.scopes[path].unchanged, 2);
  assert.deepEqual(handed?.files, [`${path}/assets.txt`]);
  assert.ok(handed?.handoff.contextPath.startsWith('/history/'));
  assert.equal(childCalls, 6);
});
