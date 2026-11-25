import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { createSubagentProgress } from '../src/functions/d2c/run/agent/subagentCheckpoint';
import { RunExecutionError } from '../src/functions/d2c/run/errors';
import { toolIssue } from '../src/functions/d2c/run/toolFeedback';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { nativeScanReport, nativeScanProblems } from '../src/functions/d2c/run/ruleScan/report';
import type { NativeRuleScanResult } from '../src/functions/d2c/run/ruleScan';

const reportPath = 'pages/page/rule-hits.json';
/** 平台算法的确定性结果替身，真实图仍执行授权写入和交付核对。 */
function scan(pending = false): NativeRuleScanResult {
  return {
    report: {
      block: 'pages/page',
      cache_key: 'file',
      generated_at: '2026-11-12T00:00:00Z',
      generated_by: 'platform-native-rules',
      hits: [
        {
          rule: 'R01',
          nodeId: '1:1',
          trigger: 'fixed-',
          expected: 'position: fixed',
          context: { name: 'fixed-title' },
        },
      ],
    },
    pending: pending ? [{ rule: 'R11', nodeIds: ['1:2'], reason: '复杂几何' }] : [],
    deterministicRules: ['R01'],
    unsupportedRules: [],
    fingerprint: 'current-design',
  };
}

/** 纯内存模型/文件替身，不请求模型、Figma、数据库或对象存储。 */
async function fixture(
  t: test.TestContext,
  pending: boolean,
  review: boolean,
  durable = false,
  failure?: { scan?: unknown; write?: unknown },
  reviewOnly = false,
  complete = true,
  pendingView = false,
) {
  const files = new Map<string, string>();
  let rootCalls = 0,
    childCalls = 0,
    scans = 0;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    const root = messages.some((m) => m.type === 'system' && m.text.includes('NATIVE_ROOT'));
    let message: AIMessage;
    if (root) {
      rootCalls++;
      message =
        rootCalls === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'native-delegate',
                  name: 'delegate_agent',
                  args: {
                    role: 'rule_scan',
                    nodeId: '1:1',
                    task: '扫描页面',
                    writePaths: [reportPath],
                  },
                },
              ],
            })
          : (() => {
              const output = JSON.parse(messages.filter(ToolMessage.isInstance).at(-1)!.text);
              return output.accepted
                ? new AIMessage({
                    content: '',
                    tool_calls: [
                      {
                        id: 'native-wait',
                        name: 'wait_subagents',
                        args: { agentIds: [output.agentId], wait: true },
                      },
                    ],
                  })
                : new AIMessage(
                    JSON.stringify(
                      output.agents?.[0]?.result ? JSON.parse(output.agents[0].result) : output,
                    ),
                  );
            })();
    } else {
      childCalls++;
      assert.ok(
        messages.some(
          (m) => m.type === 'system' && m.text.includes('只对其中的规则和节点补充判断'),
        ),
      );
      if (pendingView && childCalls === 1) {
        assert.ok(
          messages.some(
            (m) => m.type === 'system' && m.text.includes('"fingerprint":"current-design"'),
          ),
        );
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'pending-view',
              name: 'read_file',
              args: {
                path: reportPath,
                view: 'scan_pending',
                resource: false,
                offset: 0,
                length: 1,
              },
            },
          ],
        });
        return { generations: [{ message, text: message.text }] };
      }
      if (pendingView && childCalls === 2) {
        const pending = JSON.parse(messages.filter(ToolMessage.isInstance).at(-1)!.text);
        assert.equal(pending.view, 'scan_pending');
        assert.equal(pending.remaining, 1);
        assert.equal(pending.fingerprint, 'current-design');
        assert.equal(pending.hits, undefined);
        assert.equal(pending.pending[0].nodeId, '1:2');
      }
      message =
        childCalls === (pendingView ? 2 : 1) && review
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  id: 'native-review',
                  name: 'write_file',
                  args: {
                    path: reportPath,
                    content: JSON.stringify({
                      ...(reviewOnly
                        ? {}
                        : {
                            ...scan(true).report,
                            hits: [{ ...scan(true).report.hits[0], expected: 'tampered' }],
                          }),
                      nativeScan: { fingerprint: 'current-design' },
                      nativeReview: [
                        {
                          rule: 'R11',
                          nodeId: '1:2',
                          decision: 'not_applicable',
                          reason: '真实节点为简单圆形',
                        },
                      ],
                    }),
                    merge: reviewOnly,
                    complete,
                  },
                },
              ],
            })
          : new AIMessage('已完成分析');
    }
    return { generations: [{ message, text: message.text }] };
  };
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'native-scan',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  });
  const progress = durable
    ? await createSubagentProgress(checkpoint, {
        continuation: false,
        identity: 'native-v1',
        messageId: 'scan-job',
      })
    : undefined;
  const result = await runAgent({
    model,
    instructions: 'NATIVE_ROOT',
    messages: [new HumanMessage({ content: '生成页面', id: 'scan-job' })],
    maxTurns: 30,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async () => {},
    tools: {
      list: async () => [...files.keys()],
      read: async (path) => JSON.stringify({ content: files.get(path), nextOffset: null }),
      write: async (path, content) => {
        if (failure?.write) throw failure.write;
        files.set(path, content);
        return 'saved';
      },
      remove: async () => assert.fail('unexpected delete'),
      figma: async () => assert.fail('unexpected network'),
      rules: async () => assert.fail('scan cannot claim code validation'),
      slices: async () => assert.fail('unexpected slices'),
      scanRules: async (path, nodeId) => {
        if (failure?.scan) throw failure.scan;
        assert.equal(path, reportPath);
        assert.equal(nodeId, '1:1');
        scans++;
        return scan(pending);
      },
    },
    ...(durable ? { checkpoint, subagentProgress: progress } : {}),
  });
  return { result: JSON.parse(result.output), files, rootCalls, childCalls, scans };
}

test('真实Rule-Scan链先保存程序报告，无疑难项时不调用子模型', async (t) => {
  const f = await fixture(t, false, false);
  assert.equal(f.result.success, true);
  assert.equal(f.childCalls, 0);
  assert.equal(f.scans, 1);
  assert.equal(f.rootCalls, 2);
  assert.equal(JSON.parse(f.files.get(reportPath)!).hits[0].expected, 'position: fixed');
});

test('正式后台委派和wait收集程序扫描结果，保持检查点与文件保存且不调用子模型', async (t) => {
  const f = await fixture(t, false, false, true);
  assert.equal(f.result.success, true);
  assert.equal(f.childCalls, 0);
  assert.equal(f.rootCalls, 3);
  assert.equal(f.scans, 1);
  assert.ok(f.files.has(reportPath));
});

test('模型只补疑难项，不能覆盖确定性命中，结束后仍不宣称代码检查通过', async (t) => {
  const f = await fixture(t, true, true);
  assert.equal(f.result.success, true);
  assert.equal(f.childCalls, 1, '完整保存后由平台交付，不再请求口头收尾');
  assert.equal(JSON.parse(f.files.get(reportPath)!).hits[0].expected, 'position: fixed');
  assert.deepEqual(nativeScanProblems(scan(true), f.files.get(reportPath)!), []);
});

test('后台子Agent仅追加疑难判断即可交付，平台保留报告头和程序命中', async (t) => {
  const f = await fixture(t, true, true, true, undefined, true);
  assert.equal(f.result.success, true);
  assert.equal(f.childCalls, 1, '后台扫描也省去口头收尾请求');
  const report = JSON.parse(f.files.get(reportPath)!);
  assert.equal(report.hits[0].expected, 'position: fixed');
  assert.equal(report.nativeReview.length, 1);
  assert.deepEqual(nativeScanProblems(scan(true), f.files.get(reportPath)!), []);
});

test('模型口头完成或零命中不能跳过疑难项，有限补交后交回未完成', async (t) => {
  const f = await fixture(t, true, false);
  assert.equal(f.result.success, false);
  assert.equal(f.result.reason, 'INCOMPLETE_DELIVERY');
  assert.ok(f.result.delivery.problems.some((x: string) => x.includes('疑难项未完成')));
  assert.ok(f.childCalls <= 3);
  assert.equal(JSON.parse(f.files.get(reportPath)!).hits.length, 1);
});

test('疑难判断已补齐但显式complete=false，仍保留部分交付而不提前结束', async (t) => {
  const f = await fixture(t, true, true, true, undefined, true, false);
  assert.equal(f.result.success, false);
  assert.equal(f.result.reason, 'INCOMPLETE_DELIVERY');
  assert.ok(f.result.delivery.problems.some((x: string) => x.includes('仅保存部分扫描')));
  assert.ok(f.childCalls > 1);
});

test('真实子图通过有界待判断视图补交，完整报告无需进入模型读取结果', async (t) => {
  const f = await fixture(t, true, true, true, undefined, true, true, true);
  assert.equal(f.result.success, true);
  assert.equal(f.childCalls, 2);
  assert.deepEqual(nativeScanProblems(scan(true), f.files.get(reportPath)!), []);
});

test('原指纹判断可恢复，输入变化使旧判断失效；越界判断不构成完成', () => {
  const current = scan(true);
  const reviewed = nativeScanReport(
    current,
    JSON.stringify({
      nativeScan: { fingerprint: 'current-design' },
      nativeReview: [{ rule: 'R11', nodeId: '1:2', decision: 'not_applicable', reason: '可表达' }],
    }),
  );
  assert.equal(nativeScanReport(current, undefined, reviewed), reviewed);
  assert.deepEqual(nativeScanProblems(current, reviewed), []);
  const changed = { ...current, fingerprint: 'changed' };
  assert.throws(() => nativeScanReport(changed, reviewed), /SCAN_REPORT_SCOPE_MISMATCH/);
  assert.throws(
    () =>
      nativeScanReport(
        current,
        JSON.stringify({
          nativeReview: [
            { rule: 'R11', nodeId: '1:2', decision: 'not_applicable', reason: '未绑定' },
          ],
        }),
      ),
    /SCAN_REPORT_SCOPE_MISMATCH/,
  );
  assert.ok(nativeScanProblems(changed, nativeScanReport(changed, undefined, reviewed)).length);
  const outside = nativeScanReport(
    current,
    JSON.stringify({
      nativeScan: { fingerprint: 'current-design' },
      nativeReview: [{ rule: 'R11', nodeId: '9:9', decision: 'not_applicable', reason: '越界' }],
    }),
  );
  assert.ok(nativeScanProblems(current, outside).length);
});

test('显式非法hits或nativeReview拒绝保存，不当作空命中或已完成判断', () => {
  const current = scan(true);
  for (const fields of [{ hits: {} }, { hits: null }, { nativeReview: {} }])
    assert.throws(
      () =>
        nativeScanReport(
          current,
          JSON.stringify({ nativeScan: { fingerprint: current.fingerprint }, ...fields }),
        ),
      /SCAN_REPORT_INVALID/,
    );
});

test('程序扫描缓存缺失交回父级补齐，真正存储失败仍中止', async (t) => {
  const f = await fixture(t, false, false, false, {
    scan: toolIssue('FIGMA_CACHE_INCOMPLETE', 'VALIDATION_FAILED', {
      stage: 'tool',
      tool: 'figma',
    }),
  });
  assert.equal(f.result.success, false);
  assert.equal(f.result.reason, 'NATIVE_SCAN_BLOCKED');
  assert.equal(f.result.failure.feedback.code, 'FIGMA_CACHE_INCOMPLETE');
  assert.equal(f.files.size, 0);
  assert.equal(f.childCalls, 0);
  await assert.rejects(
    fixture(t, false, false, false, {
      write: new RunExecutionError('STORAGE_FAILED', { stage: 'storage' }),
    }),
    /执行数据保存或读取失败/,
  );
});

test('新规则允许实际范围内子节点命中，范围外命中仍不能交付', () => {
  const current = scan(true);
  current.unsupportedRules = ['R30'];
  current.pending = [{ rule: 'R30', nodeIds: ['1:1'], reason: '新规则需整范围判断' }];
  current.report.context = { scope_nodeIds: ['1:1', '1:2'] };
  const report = nativeScanReport(
    current,
    JSON.stringify({
      nativeScan: { fingerprint: current.fingerprint },
      nativeReview: [{ rule: 'R30', nodeId: '1:1', decision: 'hit', reason: '子节点命中' }],
      hits: [
        { rule: 'R30', nodeId: '1:2', trigger: '真实条件', expected: '实现约束', context: {} },
      ],
    }),
  );
  assert.deepEqual(nativeScanProblems(current, report), []);
  const outside = nativeScanReport(
    current,
    JSON.stringify({
      nativeScan: { fingerprint: current.fingerprint },
      nativeReview: [{ rule: 'R30', nodeId: '1:1', decision: 'hit', reason: '错误范围' }],
      hits: [{ rule: 'R30', nodeId: '9:9', trigger: '条件', expected: '约束', context: {} }],
    }),
  );
  assert.ok(nativeScanProblems(current, outside).length);
});

test('原生报告已保存但回执丢失，按同一归一化函数认领，不重放写入；旧指纹拒绝', async () => {
  const checkpoint = Object.assign(new MemorySaver(), {
    config(namespace = '', id?: string) {
      return {
        configurable: {
          thread_id: 'native-reconcile',
          checkpoint_ns: namespace,
          ...(id ? { checkpoint_id: id } : {}),
        },
      };
    },
  });
  const progress = await createSubagentProgress(checkpoint, {
    continuation: false,
    identity: 'native-v1',
    messageId: 'job',
  });
  const files = new Map<string, string>();
  let writes = 0;
  const current = scan(true);
  const tools = {
    list: async () => [...files.keys()],
    read: async (path: string) => JSON.stringify({ content: files.get(path), nextOffset: null }),
    write: async () => {
      writes++;
      return 'unexpected';
    },
    remove: async () => '',
    figma: async () => '',
    rules: async () => '',
    slices: async () => '',
    scanRules: async () => current,
  };
  const task = await progress.open(
    { role: 'rule_scan', nodeId: '1:1', writePaths: [reportPath] },
    'design',
    tools,
  );
  const request = JSON.stringify({
    nativeScan: { fingerprint: current.fingerprint },
    nativeReview: [
      { rule: 'R11', nodeId: '1:2', decision: 'not_applicable', reason: '真实几何判断' },
    ],
  });
  files.set(reportPath, nativeScanReport(current, request));
  assert.equal(await task.reconcile(reportPath, request), true);
  assert.equal(await task.reconcile(reportPath, request, true), true);
  assert.equal(writes, 0);
  const old = JSON.stringify({ ...JSON.parse(request), nativeScan: { fingerprint: 'old' } });
  assert.equal(await task.reconcile(reportPath, old), false);
});
