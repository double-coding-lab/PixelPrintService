import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeToolCallingModel } from 'langchain';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import {
  createSubagentProgress,
  type AgentCheckpoint,
} from '../src/functions/d2c/run/agent/subagentCheckpoint';
import {
  createSubagentTools,
  subagentReservations,
} from '../src/functions/d2c/run/agent/subagentTools';
import { createDelegationScheduler } from '../src/functions/d2c/run/agent/delegationScheduler';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { subagentEventSchema, type SubagentEvent } from '../src/functions/d2c/run/subagent';
import { createGenerationInstructions } from '../src/functions/d2c/run/instructions';
import { ToolIssue, toolFeedback, toolIssue } from '../src/functions/d2c/run/toolFeedback';
import { RunExecutionError } from '../src/functions/d2c/run/errors';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const directory = 'page/blocks/card';
const filename = `${directory}/index.tsx`;
const passed = JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });

/** 记录实际受控能力调用；真实框架测试仍走正式工具循环、事件和反馈层。 */
function fixture() {
  const files = new Map<string, string>();
  const checks: unknown[][] = [];
  const tools: GenerationTools = {
    list: async () => [...files.keys()],
    read: async () => JSON.stringify({ content: '{}', nextOffset: null }),
    write: async (path, content) => {
      files.set(path, content);
      return 'saved';
    },
    remove: async () => '',
    slices: async () => '',
    figma: async (_command, args) =>
      JSON.stringify({
        ok: true,
        data: { nodes: [{ attributes: { id: args.nodeId, name: 'sub-card' } }] },
      }),
    rules: async (...args) => {
      checks.push(args);
      return passed;
    },
  };
  return { tools, files, checks };
}

/** 权限拒绝必须留在可纠正分类内。 */
function invalid(error: unknown) {
  return error instanceof ToolIssue && error.feedback.code === 'INVALID_ARGUMENT';
}

test('UI只能检查授权区块目录，兼容尾斜杠并拒绝merge、祖先、兄弟、子目录及越界别名', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  await child.write(filename, 'actual');
  for (const path of [
    'page',
    'page/blocks',
    'page/blocks/other',
    `${directory}/child`,
    filename,
    `./${directory}`,
    `${directory}/../other`,
    `/` + directory,
    'page//blocks/card',
    'page/blocks/%63ard',
    'page\\blocks\\card',
  ])
    await assert.rejects(child.rules(path, 'block'), invalid, path);
  await assert.rejects(child.rules(directory, 'merge'), invalid);
  assert.deepEqual(f.checks, []);
  await child.rules(`${directory}/`, 'block');
  assert.deepEqual(f.checks, [[directory, 'block']]);
  assert.deepEqual(child.pendingRuleChecks(), []);
  await assert.rejects(child.write(`${directory}/style.scss`, ''), invalid);
  for (const role of ['design', 'review', 'rule_scan'] as const) {
    const other = createSubagentTools(
      f.tools,
      role,
      role === 'rule_scan' ? [`${directory}/rule-hits.json`] : [],
    );
    await assert.rejects(other.rules(directory, 'block'), invalid);
  }
  assert.equal(f.checks.length, 1);
});

test('可信委派nodeId包含instance时也注入第三参，调用方伪造scope不能覆盖', async () => {
  for (const nodeId of ['1:2', 'I1:2;3:4']) {
    const f = fixture();
    const child = createSubagentTools(f.tools, 'ui', [filename], nodeId);
    const forged = { rootNodeId: '999:1' };
    await child.write(filename, 'owned');
    await child.rules(directory, 'block', forged);
    assert.deepEqual(f.checks, [[directory, 'block', { rootNodeId: nodeId }]]);
    assert.deepEqual(forged, { rootNodeId: '999:1' });
    assert.deepEqual(child.pendingRuleChecks(), []);
    await assert.rejects(child.rules(directory, 'merge', forged), invalid);
    assert.equal(f.checks.length, 1);
  }
  const legacy = fixture();
  await createSubagentTools(legacy.tools, 'ui', [filename]).rules(directory, 'block', {
    rootNodeId: '999:1',
  });
  assert.deepEqual(legacy.checks, [[directory, 'block']], '旧直接调用保持两参，不信任伪造第三参');
});

test('检查目录与精确writePaths不兼容时保守拒绝，不扩大授权', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  f.files.set(`${directory}/rule-hits.json`, '{}');
  f.files.set(`${directory}/style.scss`, 'owned by another task');
  await assert.rejects(child.rules(directory, 'block'), invalid);
  f.files.delete(`${directory}/style.scss`);
  f.files.set(`${directory}/blocks/inner/index.tsx`, 'nested owner');
  await assert.rejects(child.rules(directory, 'block'), invalid);
  const unknown = createSubagentTools(f.tools, 'ui', ['page/index.tsx']);
  await assert.rejects(unknown.rules('page', 'block'), invalid);
  assert.deepEqual(f.checks, []);
});

test('写后重新验、失败检查及未知报告不能复用旧通过记录', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  await child.write(filename, 'v1');
  await child.rules(directory, 'block');
  await child.write(filename, 'v2');
  assert.deepEqual(child.pendingRuleChecks(), [directory]);
  f.tools.rules = async () =>
    JSON.stringify({ ...toolFeedback('RULES_FAILED'), report: 'real issue' });
  assert.match(await child.rules(directory, 'block'), /RULES_FAILED/);
  assert.deepEqual(child.pendingRuleChecks(), [directory]);
  for (const value of [
    'checked',
    '{"ok":true}',
    '{"ok":false,"checked":["R01"],"violations":[]}',
  ]) {
    f.tools.rules = async () => value;
    await assert.rejects(
      child.rules(directory, 'block'),
      (error) => error instanceof ToolIssue && error.feedback.code === 'RULES_FAILED',
    );
  }
  f.tools.rules = async () => passed;
  await child.rules(directory, 'block');
  assert.deepEqual(child.pendingRuleChecks(), []);
  f.tools.write = async () => {
    throw toolIssue('INVALID_ARGUMENT', 'TOOL_FAILED', { stage: 'tool' });
  };
  await assert.rejects(child.write(filename, 'v3'), invalid);
  assert.deepEqual(child.pendingRuleChecks(), [directory]);
});

test('目录预留保持精确权限冲突拒绝，并阻止同块不同文件并发检查', async () => {
  const paths = [filename, `${directory}/style.scss`];
  assert.deepEqual(subagentReservations('ui', paths), [directory]);
  assert.throws(() => subagentReservations('ui', [filename, filename]), invalid);
  assert.throws(() => subagentReservations('ui', [filename, filename + '/a.ts']), invalid);
  const scheduler = createDelegationScheduler({
    concurrency: 2,
    signal: new AbortController().signal,
  });
  let release!: () => void;
  const active = scheduler.run(
    subagentReservations('ui', [filename]),
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    scheduler.run(subagentReservations('ui', [`${directory}/style.scss`]), async () => {}),
    invalid,
  );
  await assert.rejects(
    scheduler.run([`${directory}/rule-hits.json`], async () => {}),
    invalid,
  );
  release();
  await active;
  await scheduler.run(subagentReservations('ui', paths), async () => {});
});

for (const thrown of [false, true])
  test(`真实子图结束前强制检查，规则失败${thrown ? '抛出' : '返回'}后可修复，修复后必须重新检查`, async () => {
    const f = fixture();
    let attempts = 0;
    let parentCalls = 0;
    let childCalls = 0;
    let receipt: any;
    const events: SubagentEvent[] = [];
    f.tools.rules = async (...args) => {
      const [path] = args;
      f.checks.push(args);
      if (++attempts === 1) {
        if (thrown)
          throw toolIssue(
            'RULES_FAILED',
            'VALIDATION_FAILED',
            { stage: 'tool', tool: 'check_rules' },
            { path },
          );
        return JSON.stringify({ ...toolFeedback('RULES_FAILED'), report: '修复真实规则问题' });
      }
      assert.equal(f.files.get(filename), 'fixed');
      return passed;
    };
    const model = new FakeToolCallingModel();
    model.bindTools = () => model;
    model._generate = async (messages) => {
      const parent = messages.some(
        (entry) => entry.type === 'system' && entry.text.includes('ROOT_CHECK_TEST'),
      );
      let message: AIMessage;
      if (parent) {
        if (parentCalls++ === 0)
          message = new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'delegate',
                name: 'delegate_agent',
                args: { role: 'ui', nodeId: '1:2', task: '实现card', writePaths: [filename] },
              },
            ],
          });
        else {
          receipt = JSON.parse(messages.at(-1)!.text);
          message = new AIMessage('父级只整合');
        }
      } else {
        const step = childCalls++;
        if (step === 0 || step === 2) {
          if (step === 2) assert.match(messages.at(-1)!.text, /RULES_FAILED/);
          message = new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `write-${step}`,
                name: 'write_file',
                args: { path: filename, content: step === 0 ? 'broken' : 'fixed' },
              },
            ],
          });
        } else message = new AIMessage('本块完成'); /** 平台须替换未经最新检查的结束答复。 */
      }
      return { generations: [{ text: message.text, message }] };
    };
    await runAgent({
      model,
      tools: f.tools,
      messages: [new HumanMessage('生成')],
      instructions: 'ROOT_CHECK_TEST',
      maxTurns: 12,
      contextBudgetTokens: 24000,
      signal: new AbortController().signal,
      assertLease: async () => {},
      recordSubagent: async (event) => {
        events.push(subagentEventSchema.parse(event));
      },
    });
    assert.equal(receipt.success, true);
    assert.deepEqual(receipt.files, [filename]);
    assert.deepEqual(f.checks, [
      [directory, 'block', { rootNodeId: '1:2' }],
      [directory, 'block', { rootNodeId: '1:2' }],
    ]);
    assert.equal(
      events.filter((event) => event.tool === 'check_rules' && event.status === 'tool_started')
        .length,
      2,
    );
    assert.ok(
      events.some(
        (event) =>
          event.tool === 'check_rules' &&
          event.status === 'tool_feedback' &&
          event.feedback?.code === 'RULES_FAILED',
      ),
    );
    assert.ok(
      events.some((event) => event.tool === 'check_rules' && event.status === 'tool_completed'),
    );
    assert.equal(events.at(-1)?.status, 'completed');
  });

test('子工具检查不能吞掉取消、存储或租约异常', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  for (const code of ['LEASE_LOST', 'STORAGE_FAILED', 'WORKER_INTERRUPTED'] as const) {
    const error = new RunExecutionError(code, { stage: 'tool', tool: 'check_rules' });
    f.tools.rules = async () => {
      throw error;
    };
    await assert.rejects(child.rules(directory, 'block'), (value) => value === error);
    assert.deepEqual(child.pendingRuleChecks(), [directory]);
  }
});

test('主指令保留机械merge与按需全局复验，并声明真实screenshot基准与现有预览', () => {
  const instructions = createGenerationInstructions('h5', 'https://figma.com/file/test');
  assert.match(instructions, /最终机械merge.*不深入复验子区域/);
  assert.match(instructions, /全局单agent复验仅用户主动要求/);
  assert.match(instructions, /完成末尾简短提示此选项/);
  assert.match(instructions, /首次出码前.*command=screenshot,nodeId=会话绑定根,scale=1/);
  assert.match(instructions, /design-reference根图及元数据.*不能用切图代替/);
  assert.match(instructions, /按设计版本复用或重建.*失败如实报告/);
  assert.doesNotMatch(instructions, /未接入预览/);
});

test('真实UI子图检查通过后再次写入，结束前必须执行第二次最新检查', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  let step = 0;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async () => {
    const current = step++;
    const message =
      current === 0 || current === 2
        ? new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `write-${current}`,
                name: 'write_file',
                args: { path: filename, content: `v${current}` },
              },
            ],
          })
        : current === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'check-first',
                  name: 'check_rules',
                  args: { path: directory, mode: 'block' },
                },
              ],
            })
          : new AIMessage('本块结束');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    tools: child,
    specialist: 'ui',
    requiredRuleChecks: child.requiredRuleChecks,
    instructions: '',
    messages: [new HumanMessage('修改区块')],
    maxTurns: 8,
    contextBudgetTokens: 24000,
    signal: new AbortController().signal,
    assertLease: async () => {},
  });
  assert.equal(f.files.get(filename), 'v2');
  assert.deepEqual(f.checks, [
    [directory, 'block'],
    [directory, 'block'],
  ]);
  assert.deepEqual(child.pendingRuleChecks(), []);
});

test('没有真实执行的规则、并发写入及最新检查故障均不能冒充通过', async () => {
  const f = fixture();
  const child = createSubagentTools(f.tools, 'ui', [filename]);
  f.tools.rules = async () =>
    JSON.stringify({ ok: true, checked: ['R01'], skipped: ['R01'], violations: [] });
  await assert.rejects(
    child.rules(directory, 'block'),
    (error) => error instanceof ToolIssue && error.feedback.code === 'RULES_FAILED',
  );
  f.tools.rules = async () => {
    await child.write(filename, 'changed during check');
    return passed;
  };
  await assert.rejects(
    child.rules(directory, 'block'),
    (error) => error instanceof ToolIssue && error.feedback.code === 'RULES_FAILED',
  );
  assert.deepEqual(child.requiredRuleChecks(), [directory]);
  f.tools.rules = async () => passed;
  await child.rules(directory, 'block');
  f.tools.rules = async () => {
    throw new Error('lease lost');
  };
  await assert.rejects(child.rules(directory, 'block'), /lease lost/);
  assert.deepEqual(child.pendingRuleChecks(), [directory]);
});

test('持久任务显式恢复后仍使用原委派nodeId，模型check_rules伪造scope不能扩大范围', async () => {
  const f = fixture();
  f.files.set(filename, 'saved before interruption');
  f.tools.read = async (path) =>
    JSON.stringify({ content: f.files.get(path) ?? '{}', nextOffset: null });
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'rule-scope-recovery',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  }) as AgentCheckpoint;
  const first = await createSubagentProgress(checkpoint, {
    continuation: false,
    identity: 'scope-context',
    messageId: 'before',
  });
  const task = { role: 'ui' as const, nodeId: '1:2', writePaths: [filename] };
  const opened = await first.open(task, '', f.tools);
  await opened.wrote(filename);
  const resumed = await createSubagentProgress(checkpoint, {
    continuation: true,
    identity: 'scope-context',
    messageId: 'resume',
  });
  let parentCalls = 0,
    childCalls = 0;
  let receipt: { success: boolean; files: string[] } | undefined;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    let message: AIMessage;
    if (
      messages.some(
        (entry) => entry.type === 'system' && entry.text.includes('SCOPE_RECOVERY_PARENT'),
      )
    ) {
      const last = messages.filter(ToolMessage.isInstance).at(-1);
      if (parentCalls++ === 0)
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'resume-ui',
              name: 'delegate_agent',
              args: { ...task, task: '继续原区块检查', resumeAgentId: opened.state.agentId },
            },
          ],
        });
      else if (last?.name === 'delegate_agent') {
        const accepted = JSON.parse(last.text);
        assert.equal(accepted.accepted, true, last.text);
        assert.equal(accepted.agentId, opened.state.agentId);
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'wait-ui',
              name: 'wait_subagents',
              args: { agentIds: [accepted.agentId], wait: true },
            },
          ],
        });
      } else {
        assert.equal(last?.name, 'wait_subagents');
        const result = JSON.parse(last!.text);
        assert.equal(result.agents[0].agentId, opened.state.agentId);
        receipt = JSON.parse(result.agents[0].result);
        message = new AIMessage('整合原区块');
      }
    } else {
      message =
        childCalls++ === 0
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'forged-root',
                  name: 'check_rules',
                  args: { path: directory, mode: 'block', scope: { rootNodeId: '999:1' } },
                },
              ],
            })
          : new AIMessage('原区块检查完成');
    }
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    tools: f.tools,
    subagentProgress: resumed,
    instructions: 'SCOPE_RECOVERY_PARENT',
    messages: [new HumanMessage('恢复区块')],
    maxTurns: 8,
    contextBudgetTokens: 24000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async () => {},
  });
  assert.equal(receipt?.success, true);
  assert.deepEqual(receipt?.files, [filename]);
  assert.ok(f.checks.length > 0);
  for (const check of f.checks)
    assert.deepEqual(check, [directory, 'block', { rootNodeId: '1:2' }]);
  assert.equal(f.files.get(filename), 'saved before interruption');
});
