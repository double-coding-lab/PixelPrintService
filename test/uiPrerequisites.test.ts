import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { uiPrerequisites } from '../src/functions/d2c/run/agent/uiPrerequisites';
import { nativeScanReport } from '../src/functions/d2c/run/ruleScan/report';
import type { NativeRuleScanResult } from '../src/functions/d2c/run/ruleScan';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const directory = 'pages/page/blocks/hero';
const paths = [`${directory}/index.tsx`, `${directory}/index.scss`, `${directory}/assets.txt`];

/** 固定节点与真实报告协议；不写空报告代替待判断项，也不访问外部模型。 */
function fixture() {
  const scan: NativeRuleScanResult = {
    report: {
      block: 'hero',
      cache_key: 'cache',
      generated_at: '2026-11-20',
      generated_by: 'native',
      hits: [],
    },
    pending: [{ rule: 'R11', nodeIds: ['1:2'], reason: '需判断' }],
    deterministicRules: [],
    unsupportedRules: [],
    fingerprint: 'a'.repeat(64),
  };
  const files = new Map<string, string>();
  const tools = {
    list: async () => [...files.keys()],
    read: async (path: string) =>
      JSON.stringify({ content: files.get(path) ?? '{}', nextOffset: null }),
    scanRules: async () => scan,
    figma: async () =>
      JSON.stringify({
        ok: true,
        data: { nodes: [{ attributes: { id: '1:2', name: 'sub-hero' } }] },
      }),
    write: async () => assert.fail('准入不得写报告或源码'),
    remove: async () => assert.fail('准入不得删除文件'),
    rules: async () => assert.fail('准入不冒充代码验收'),
    slices: async () => assert.fail('准入不得请求切图'),
  } as GenerationTools;
  return { files, scan, tools };
}

test('整页报告不能代替区块报告，补齐真实疑难判断后才满足准入', async () => {
  const f = fixture();
  f.files.set('pages/page/rule-hits.json', nativeScanReport(f.scan));
  assert.deepEqual(await uiPrerequisites(f.tools, paths, '1:2'), [
    { path: `${directory}/rule-hits.json`, reason: 'missing' },
  ]);
  f.files.set(`${directory}/rule-hits.json`, nativeScanReport(f.scan));
  assert.deepEqual(await uiPrerequisites(f.tools, paths, '1:2'), [
    { path: `${directory}/rule-hits.json`, reason: 'incomplete' },
  ]);
  f.files.set(
    `${directory}/rule-hits.json`,
    nativeScanReport(
      f.scan,
      JSON.stringify({
        nativeScan: { fingerprint: f.scan.fingerprint },
        nativeReview: [
          {
            rule: 'R11',
            nodeId: '1:2',
            decision: 'not_applicable',
            reason: '真实矩形，无复合几何',
          },
        ],
      }),
    ),
  );
  assert.deepEqual(await uiPrerequisites(f.tools, paths, '1:2'), []);
  f.scan.fingerprint = 'b'.repeat(64);
  assert.equal((await uiPrerequisites(f.tools, paths, '1:2'))[0].reason, 'incomplete');
});

test('真实父模型收到明确依赖交接，缺报告时不发出UI模型请求或子任务启动事件', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const f = fixture();
  let calls = 0;
  const events: unknown[] = [];
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    const index = calls++;
    if (index === 1) {
      assert.match(JSON.stringify(messages), /UI_PREREQUISITES_REQUIRED/);
      assert.match(JSON.stringify(messages), /rule_scan/);
    }
    assert.ok(index < 2, '缺报告不得运行子模型');
    const message =
      index === 0
        ? new AIMessage({
            content: '',
            tool_calls: [
              {
                name: 'delegate_agent',
                id: 'ui-missing-report',
                args: { role: 'ui', task: '实现hero', nodeId: '1:2', writePaths: paths },
              },
            ],
          })
        : new AIMessage('先补齐区块报告');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    tools: f.tools,
    messages: [new HumanMessage('开始')],
    instructions: 'PARENT',
    maxTurns: 4,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async (event) => {
      events.push(event);
    },
  });
  assert.equal(calls, 2);
  assert.equal(events.length, 0);
});

test('有效区块报告允许UI启动，仍需保存全部授权文件并通过区块检查', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const f = fixture();
  f.scan.pending = [];
  f.files.set(`${directory}/rule-hits.json`, nativeScanReport(f.scan));
  let writes = 0;
  let checks = 0;
  f.tools.write = async (path, content) => {
    assert.ok(paths.includes(path));
    f.files.set(path, content);
    writes++;
    return 'saved';
  };
  f.tools.rules = async (path, mode) => {
    assert.equal(path, directory);
    assert.equal(mode, 'block');
    assert.equal(writes, paths.length);
    checks++;
    return JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });
  };
  let parentCalls = 0;
  let childCalls = 0;
  const events: Array<{ role: string; status: string }> = [];
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    const child = messages.some(
      (message) => message.type === 'human' && message.text === '实现hero',
    );
    let message;
    if (child) {
      message =
        childCalls++ === 0
          ? new AIMessage({
              content: '',
              tool_calls: paths.map((path, index) => ({
                name: 'write_file',
                id: `ui-write-${index}`,
                args: { path, content: `file-${index}` },
              })),
            })
          : new AIMessage('授权文件已保存');
    } else {
      if (parentCalls++ > 0) {
        const receipt = messages.find((message) => message.type === 'tool');
        assert.equal(JSON.parse(receipt!.text).success, true);
        message = new AIMessage('UI交付已收取');
      } else
        message = new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'delegate_agent',
              id: 'ui-valid-report',
              args: { role: 'ui', task: '实现hero', nodeId: '1:2', writePaths: paths },
            },
          ],
        });
    }
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    tools: f.tools,
    messages: [new HumanMessage('开始')],
    instructions: 'PARENT',
    maxTurns: 8,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async (event) => {
      events.push(event);
    },
  });
  assert.equal(parentCalls, 2);
  assert.ok(childCalls >= 2);
  assert.equal(writes, paths.length);
  assert.ok(checks >= 1);
  assert.ok(events.some((event) => event.role === 'ui' && event.status === 'completed'));
  assert.equal(f.files.get(`${directory}/rule-hits.json`), nativeScanReport(f.scan));
});
