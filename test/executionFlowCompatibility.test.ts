import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { createFileVersions } from '../src/functions/d2c/run/agent/fileVersions';
import { createDelegationScheduler } from '../src/functions/d2c/run/agent/delegationScheduler';
import { createSubagentTools } from '../src/functions/d2c/run/agent/subagentTools';
import { editFileText } from '../src/functions/d2c/run/editFile';
import { toolFeedback, ToolIssue } from '../src/functions/d2c/run/toolFeedback';
import { subagentLimits } from '../src/functions/d2c/run/subagent';
import type { GenerationTools } from '../src/functions/d2c/run/types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id }] });
}
function modelFor(generate: (messages: BaseMessage[]) => AIMessage) {
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    const message = generate(messages);
    return { generations: [{ text: message.text, message }] };
  };
  return model;
}
function toolsFor(files: Map<string, string>): GenerationTools {
  return {
    list: async () => [...files.keys()],
    read: async (path) =>
      JSON.stringify({
        content: files.get(path),
        sha256: hash(files.get(path) ?? ''),
        nextOffset: null,
      }),
    write: async (path, content) => {
      files.set(path, content);
      return 'saved';
    },
    remove: async () => '',
    figma: async () => '',
    rules: async () => '{"ok":true}',
    slices: async () => '',
  };
}
const execute = (model: ReturnType<typeof modelFor>, tools: GenerationTools, extra = {}) =>
  runAgent({
    model,
    tools,
    messages: [new HumanMessage('执行兼容性检查')],
    instructions: 'FLOW_PARENT',
    maxTurns: 100,
    contextBudgetTokens: 1000000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    recordSubagent: async () => {},
    ...extra,
  });

test('多报告共用一个nodeId在扫描及模型副作用前拒绝，可按每个节点重新委派', async () => {
  let root = 0,
    scans = 0,
    writes = 0;
  const files = new Map<string, string>();
  const tools = toolsFor(files);
  tools.write = async () => {
    writes++;
    return '';
  };
  tools.scanRules = async () => {
    scans++;
    throw new Error('must not scan');
  };
  const model = modelFor((messages) => {
    assert.match(messages[0].text, /FLOW_PARENT/);
    if (root++ === 0)
      return call(
        'delegate_agent',
        {
          role: 'rule_scan',
          task: '扫描三个不同节点',
          nodeId: '92:1318',
          writePaths: [
            'pages/page/blocks/hero/rule-hits.json',
            'pages/page/blocks/coupon/rule-hits.json',
          ],
        },
        'ambiguous',
      );
    const feedback = JSON.parse(messages.filter(ToolMessage.isInstance).at(-1)!.text);
    assert.equal(feedback.code, 'INVALID_ARGUMENT');
    assert.match(feedback.detail, /多个区块须分别委派/);
    return new AIMessage('按节点独立安排扫描');
  });
  await execute(model, tools);
  assert.equal(scans, 0);
  assert.equal(writes, 0);
  assert.equal(root, 2);
});

for (const complete of [true, false])
  test(`局部请求触顶先核验交付，complete=${complete}`, async () => {
    const path = 'pages/page/rule-hits.json';
    const files = new Map([['rules.md', '规则']]);
    const events: any[] = [];
    let child = 0;
    const report = {
      block: 'page',
      cache_key: 'design',
      generated_at: '2026-11-23T00:00:00Z',
      generated_by: 'rule-scan',
      hits: [],
    };
    const model = modelFor((messages) => {
      if (messages[0].text.includes('FLOW_PARENT')) {
        const last = messages.filter(ToolMessage.isInstance).at(-1);
        if (last) return new AIMessage(last.text);
        return call(
          'delegate_agent',
          { role: 'rule_scan', nodeId: '1:1', task: '扫描页面', writePaths: [path] },
          'scan',
        );
      }
      child++;
      if (child === subagentLimits.executionTurns)
        return call('write_file', { path, content: report, complete }, 'final-report');
      return call('read_file', { path: 'rules.md' }, `read-${child}`);
    });
    const result = JSON.parse(
      (
        await execute(model, toolsFor(files), {
          recordSubagent: async (event: any) => events.push(event),
        })
      ).output,
    );
    assert.equal(child, subagentLimits.executionTurns);
    assert.deepEqual(JSON.parse(files.get(path)!), report);
    assert.equal(result.success, complete);
    if (complete) assert.equal(events.filter((event) => event.status === 'failed').length, 0);
    else {
      assert.equal(result.reason, 'DEEP_SUBAGENT_MAX_TURNS');
      assert.ok(result.delivery.problems.length);
    }
  });

test('Agent读写回执自动推进编辑基线，外部修改和显式旧摘要仍拒绝，缓存请求明确跳过', async () => {
  const path = 'pages/page/index.jsx';
  const files = new Map([
    [path, 'first'],
    ['.d2c-cache/last-page.json', '{"platform":true}'],
  ]);
  const tools = toolsFor(files);
  let index = 0,
    edits = 0,
    writes = 0;
  const write = tools.write;
  tools.write = async (...args) => {
    writes++;
    return write(...args);
  };
  tools.edit = async (path, oldText, newText, expected) => {
    edits++;
    try {
      const content = editFileText(path, files.get(path)!, oldText, newText, expected);
      files.set(path, content);
      return JSON.stringify({ ok: true, sha256: hash(content), path });
    } catch (error) {
      if (error instanceof ToolIssue) return JSON.stringify(error.feedback);
      throw error;
    }
  };
  const steps = [
    () => call('read_file', { path }, 'read'),
    () => call('write_file', { path, content: 'second' }, 'write'),
    () => call('edit_file', { path, oldText: 'second', newText: 'third' }, 'edit'),
    () => {
      files.set(path, 'external');
      return call('edit_file', { path, oldText: 'external', newText: 'unsafe' }, 'conflict');
    },
    () => call('read_file', { path }, 'fresh'),
    () =>
      call(
        'edit_file',
        { path, oldText: 'external', newText: 'unsafe', expectedSha256: hash('first') },
        'explicit-stale',
      ),
    () =>
      call(
        'write_file',
        { path: '.d2c-cache/last-page.json', content: '{"forged":true}' },
        'cache',
      ),
  ];
  const model = modelFor((messages) => {
    if (index === 4 || index === 6)
      assert.match(messages.filter(ToolMessage.isInstance).at(-1)!.text, /EDIT_REVISION_CONFLICT/);
    const step = steps[index++];
    if (!step) {
      assert.match(messages.filter(ToolMessage.isInstance).at(-1)!.text, /PLATFORM_MANAGED_CACHE/);
      return new AIMessage('完成');
    }
    return step();
  });
  await execute(model, tools);
  assert.equal(files.get(path), 'external');
  assert.equal(files.get('.d2c-cache/last-page.json'), '{"platform":true}');
  assert.equal(writes, 1);
  assert.equal(edits, 3);
});

test('版本回执按Agent隔离，缺回执不读取当前文件后猜测摘要', () => {
  const a = createFileVersions(),
    b = createFileVersions();
  const path = 'pages/a.jsx';
  a.wrote(path, 'mine');
  assert.equal(a.expected(path), hash('mine'));
  assert.throws(() => b.expected(path), ToolIssue);
  assert.equal(a.expected(path, hash('old')), hash('old'));
});

test('目录尾斜杠兼容仍保留调度互斥、越界拒绝及UI范围', async () => {
  const scheduler = createDelegationScheduler({
    concurrency: 1,
    signal: new AbortController().signal,
  });
  await scheduler.exclusive(['pages/page/'], async () => {
    assert.throws(() => scheduler.assertAvailable(['pages/page/index.jsx']), ToolIssue);
  });
  await assert.rejects(async () => scheduler.exclusive(['../bad/'], async () => ''), ToolIssue);
  const files = new Map([['pages/page/blocks/hero/index.jsx', 'source']]);
  const tools = toolsFor(files);
  const calls: string[] = [];
  tools.rules = async (path) => {
    calls.push(path);
    return JSON.stringify({ ok: true, checked: ['R01'], skipped: [], violations: [] });
  };
  const child = createSubagentTools(tools, 'ui', ['pages/page/blocks/hero/index.jsx']);
  await child.rules('pages/page/blocks/hero/', 'block');
  assert.deepEqual(calls, ['pages/page/blocks/hero']);
  await assert.rejects(() => child.rules('pages/page/blocks/other/', 'block'), ToolIssue);
});
