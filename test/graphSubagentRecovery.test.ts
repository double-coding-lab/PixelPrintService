import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { graphExecutionLimits } from '../src/functions/d2c/run/agent/graphRecovery';
import {
  createSubagentProgress,
  type AgentCheckpoint,
} from '../src/functions/d2c/run/agent/subagentCheckpoint';
import type { GenerationTools } from '../src/functions/d2c/run/types';

/** 正式父子图触发小预算，验证原生图异常成为可收取的交接，已完成写入只执行一次。 */
for (const scenario of ['scan-partial', 'ui-failed-check', 'ui-passed-check'] as const)
  test(`native child graph exhaustion: ${scenario}`, { timeout: 30000 }, async (t) => {
    const original = graphExecutionLimits.steps;
    Object.defineProperty(graphExecutionLimits, 'steps', { value: 48, configurable: true });
    t.after(() =>
      Object.defineProperty(graphExecutionLimits, 'steps', { value: original, configurable: true }),
    );
    const checkpoint = Object.assign(new MemorySaver(), {
      config(namespace = '', id?: string) {
        return {
          configurable: {
            thread_id: 'child-graph-limit',
            checkpoint_ns: namespace,
            ...(id ? { checkpoint_id: id } : {}),
          },
        };
      },
    }) as AgentCheckpoint;
    const progress = await createSubagentProgress(checkpoint, {
      continuation: false,
      identity: 'graph-budget',
      messageId: 'graph-job',
    });
    const ui = scenario.startsWith('ui-');
    const reportPath = ui ? 'pages/page/blocks/card/index.tsx' : 'pages/page/rule-hits.json';
    let checks = 0;
    const files = new Map<string, string>([['pp-d2c.config.json', '{}']]);
    const writes: string[] = [];
    let childCalls = 0;
    const tools: GenerationTools = {
      list: async () => [...files.keys()],
      read: async (path) =>
        JSON.stringify({ content: files.get(path) ?? 'fixed rule', nextOffset: null }),
      write: async (path, content) => {
        files.set(path, content);
        writes.push(path);
        return 'saved';
      },
      remove: async () => assert.fail('unexpected delete'),
      figma: async (_command, args) =>
        JSON.stringify({
          ok: true,
          data: { nodes: [{ attributes: { id: args.nodeId, name: 'sub-card' } }] },
        }),
      rules: async () => {
        checks++;
        assert.equal(ui, true);
        return JSON.stringify({
          ok: scenario === 'ui-passed-check',
          checked: ['R01'],
          skipped: [],
          violations: scenario === 'ui-passed-check' ? [] : ['actual violation'],
        });
      },
      slices: async () => assert.fail('unexpected slicing'),
    };
    const model = new FakeToolCallingModel();
    model.bindTools = () => model;
    model._generate = async (messages) => {
      let response: AIMessage;
      if (messages[0].text.includes('GRAPH_LIMIT_PARENT')) {
        const last = messages.filter(ToolMessage.isInstance).at(-1);
        if (!last)
          response = new AIMessage({
            content: '',
            tool_calls: [
              {
                name: 'delegate_agent',
                id: 'delegate-budget',
                args: {
                  role: ui ? 'ui' : 'rule_scan',
                  nodeId: '1:2',
                  task: '分批保存扫描，沿原上下文继续',
                  writePaths: [reportPath],
                },
              },
            ],
          });
        else if (last.name === 'delegate_agent') {
          const ack = JSON.parse(last.text);
          response = new AIMessage({
            content: '',
            tool_calls: [
              {
                name: 'wait_subagents',
                id: 'wait-budget',
                args: { agentIds: [ack.agentId], wait: true },
              },
            ],
          });
        } else {
          const receipt = JSON.parse(last.text);
          assert.equal(receipt.agents[0].status, 'completed');
          response = new AIMessage(receipt.agents[0].result);
        }
      } else {
        childCalls++;
        response =
          childCalls === 1
            ? new AIMessage({
                content: '',
                tool_calls: [
                  {
                    name: 'write_file',
                    id: 'save-partial',
                    args: {
                      path: reportPath,
                      content: ui
                        ? 'export default function Card(){ return <div />; }'
                        : JSON.stringify({
                            block: 'page',
                            cache_key: 'design',
                            generated_at: '2026-11-17',
                            generated_by: 'rule-scan-subagent',
                            hits: [],
                          }),
                      complete: false,
                    },
                  },
                ],
              })
            : new AIMessage({
                content: '',
                tool_calls: [
                  {
                    name: 'read_file',
                    id: `read-${childCalls}`,
                    args: { path: reportPath, resource: false, offset: 0, length: null },
                  },
                ],
              });
      }
      return { generations: [{ text: response.text, message: response }] };
    };
    const result = await runAgent({
      model,
      tools,
      checkpoint,
      subagentProgress: progress,
      instructions: 'GRAPH_LIMIT_PARENT',
      messages: [new HumanMessage({ content: '开始扫描', id: 'graph-input' })],
      maxTurns: 100,
      contextBudgetTokens: 1000000,
      signal: AbortSignal.timeout(25000),
      assertLease: async () => {},
      recordSubagent: async () => {},
    });
    const handoff = JSON.parse(result.output);
    if (scenario === 'ui-passed-check') {
      assert.equal(handoff.success, true);
      assert.equal(checks, 1);
      assert.deepEqual(writes, [reportPath]);
      assert.deepEqual(await progress.background(), []);
      return;
    }
    assert.equal(handoff.success, false);
    assert.equal(handoff.reason, 'GRAPH_STEP_LIMIT');
    if (ui) {
      assert.equal(handoff.failure.feedback.code, 'RULES_FAILED');
      assert.ok(checks > 0);
    }
    assert.deepEqual(handoff.files, [reportPath]);
    assert.ok(handoff.handoff.resume.resumeAgentId);
    assert.equal(handoff.handoff.resume.resumeAgentId, handoff.agentId);
    assert.ok(handoff.handoff.contextPath);
    assert.deepEqual(writes, [reportPath]);
    assert.ok(childCalls > 2 && childCalls < 40);
    assert.deepEqual(await progress.background(), []);
  });
