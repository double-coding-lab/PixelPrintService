import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FakeToolCallingModel } from 'langchain';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { createGenerationTools } from '../src/functions/d2c/run/tools';
import { generationPlan } from '../src/functions/d2c/run/generationPlan';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';
import { createSubagentTools } from '../src/functions/d2c/run/agent/subagentTools';
import { runAgent } from '../src/functions/d2c/run/agent/agent';
import { completedWriteView } from '../src/functions/d2c/run/agent/context';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const feedback = (code: string) => (error: unknown) =>
  error instanceof ToolIssue && error.feedback.code === code;

test('局部替换沿用稳定保存、摘要冲突不写入，并发编辑只成功一次', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(resources, 'templates/skills/pp-d2c/bin'), { recursive: true });
  await fs.mkdir(workspace);
  for (const name of ['figma.mjs', 'check-rules.mjs'])
    await fs.writeFile(path.join(resources, 'templates/skills/pp-d2c/bin', name), '');
  await fs.writeFile(path.join(workspace, 'pp-d2c.config.json'), '{}');
  const saved: Array<[string, string]> = [];
  const runtime = await createGenerationTools({
    restored: {
      directory: root,
      resources,
      workspace,
      skill: '',
      skillFile: '',
      configHash: '',
      bundleHash: '',
      dispose: async () => {},
    },
    figmaUrl: null,
    target: 'h5',
    proxyUrl: 'http://unused.internal:8080',
    allowedHosts: [],
    textFileBytes: 65536,
    uploadBytes: 65536,
    signal: new AbortController().signal,
    token: async () => '',
    redact: (value) => value,
    save: async (file, text) => {
      saved.push([file, text]);
    },
    saveBinary: async () => {},
    remove: async () => {},
    assertLease: async () => {},
  });
  const file = 'pages/page/blocks/prize/index.scss';
  const original = '.title { color: red; }\n';
  await runtime.tools.write(file, original);
  assert.equal(JSON.parse(await runtime.tools.read(file, false, 0, 5)).sha256, hash(original));
  const receipt = JSON.parse(await runtime.tools.edit!(file, 'red', 'blue', hash(original)));
  assert.equal(receipt.sha256, hash(original.replace('red', 'blue')));
  assert.equal(saved.at(-1)?.[1], original.replace('red', 'blue'));
  await assert.rejects(
    runtime.tools.edit!(file, 'blue', 'green', hash(original)),
    feedback('EDIT_REVISION_CONFLICT'),
  );
  const current = await fs.readFile(path.join(workspace, file), 'utf8');
  await assert.rejects(
    runtime.tools.edit!(file, 'absent', '', hash(current)),
    feedback('EDIT_MATCH_INVALID'),
  );
  const count = saved.length;
  const edits = await Promise.allSettled(
    ['green', 'black'].map((color) => runtime.tools.edit!(file, 'blue', color, hash(current))),
  );
  assert.equal(edits.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(saved.length, count + 1);
  await runtime.tools.write(file, 'same same');
  await assert.rejects(
    runtime.tools.edit!(file, 'same', 'other', hash('same same')),
    feedback('EDIT_MATCH_INVALID'),
  );
  for (const protectedPath of [
    'pp-d2c.config.json',
    '.d2c-cache/key/asset-urls.json',
    'design-reference/root.json',
  ])
    await assert.rejects(runtime.tools.edit!(protectedPath, 'a', 'b', hash('a')));
  await assert.rejects(
    runtime.tools.edit!('../outside.ts', 'a', 'b', hash('a')),
    feedback('INVALID_ARGUMENT'),
  );
  await assert.rejects(
    runtime.tools.edit!('pages/page/missing.ts', 'a', 'b', hash('a')),
    feedback('FILE_NOT_FOUND'),
  );
  await fs.writeFile(path.join(workspace, file), '\uFEFFcolor: red');
  const bomPage = JSON.parse(await runtime.tools.read(file, false));
  await runtime.tools.edit!(file, 'red', 'blue', bomPage.sha256);
  assert.equal(await fs.readFile(path.join(workspace, file), 'utf8'), '\uFEFFcolor: blue');
  const child = createSubagentTools(runtime.tools, 'ui', [file]);
  const modified = await fs.readFile(path.join(workspace, file), 'utf8');
  await child.edit!(file, modified, 'done', hash(modified));
  assert.deepEqual(child.pendingRuleChecks(), ['pages/page/blocks/prize']);
  await assert.rejects(child.edit!('pages/other.ts', 'a', 'b', hash('a')));
  assert.equal(createSubagentTools(runtime.tools, 'review').edit, undefined);
  assert.equal(
    createSubagentTools(runtime.tools, 'rule_scan', ['pages/page/rule-hits.json']).edit,
    undefined,
  );
});

test('SDK实际工具循环调用edit_file并返回短回执，不重写文件正文', async () => {
  const calls: unknown[] = [];
  const output = [
    new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'edit-1',
          name: 'edit_file',
          args: {
            path: 'pages/page/index.scss',
            oldText: 'red',
            newText: 'blue',
            expectedSha256: hash('red'),
          },
        },
      ],
    }),
    new AIMessage('已调整'),
  ];
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  let index = 0;
  model._generate = async () => {
    const message = output[index++] ?? new AIMessage('完成');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [],
    instructions: '',
    maxTurns: 4,
    contextBudgetTokens: 16000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async () => '',
      write: async () => {
        throw new Error('不得整文件重写');
      },
      remove: async () => '',
      slices: async () => '',
      figma: async () => '',
      rules: async () => '',
      edit: async (...args) => {
        calls.push(args);
        return JSON.stringify({ ok: true, sha256: hash('blue') });
      },
    },
  });
  assert.equal(calls.length, 1);
});

test('输出约定遵守配置且沿用历史入口，不把blocks提到pages根', () => {
  const config = {
    output: { dir: 'src/pages/' },
    images: { assetsDir: 'src/static/' },
    merge: { mode: 'components' },
  };
  assert.match(generationPlan(config, []), /src\/pages\/home\/blocks\/<英文别名>/);
  assert.match(generationPlan(config, []), /merge.mode=components/);
  assert.match(
    generationPlan({}, [
      'pages/legacy/Home.tsx',
      'pages/legacy/components/Card.tsx',
      'shared/utils/index.ts',
    ]),
    /本轮页面目录：pages\/legacy\//,
  );
  assert.match(generationPlan({}, ['App.tsx']), /区块目录统一为 blocks\//);
  assert.match(generationPlan({}, ['shared/utils/index.ts']), /本轮页面目录：pages\/home\//);
  const existing = generationPlan(config, [
    'legacy/home/index.tsx',
    'legacy/home/blocks/prize/index.tsx',
  ]);
  assert.match(existing, /本轮页面目录：legacy\/home\//);
  assert.match(existing, /不为了改成默认merge.mode重新拆分或平铺/);
  assert.match(
    generationPlan(config, ['pages/a/index.tsx', 'pages/b/index.tsx']),
    /当前已有多个页面目录/,
  );
});

test('H5与RN首次生成统一home，已有入口及明确输出根目录保持原组织', () => {
  assert.match(
    generationPlan({ project: { framework: 'react' }, output: { dir: 'pages/' } }, []),
    /本轮页面目录：pages\/home\//,
  );
  assert.match(generationPlan({}, []), /本轮页面目录：pages\/home\//);
  const rn = { project: { framework: 'rn' }, output: { dir: 'pages/' } };
  const plan = generationPlan(rn, []);
  assert.match(plan, /本轮页面目录：pages\/home\//);
  assert.match(plan, /pages\/home\/blocks\/<英文别名>/);
  assert.doesNotMatch(plan, /src\/pages|本轮页面目录：pages\/page/);
  assert.match(
    generationPlan(rn, ['src/pages/page/index.tsx']),
    /本轮页面目录：src\/pages\/page\//,
  );
  assert.match(
    generationPlan({ ...rn, output: { dir: 'screens/' } }, []),
    /本轮页面目录：screens\/home\//,
  );
});

test('局部修改成功后仅压缩模型视图，失败或未知结果保留原参数', () => {
  const oldText = 'old'.repeat(5000);
  const call = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'e',
        name: 'edit_file',
        args: {
          path: 'pages/page/index.tsx',
          oldText,
          newText: 'new'.repeat(5000),
          expectedSha256: hash(oldText),
        },
      },
    ],
  });
  const success = new ToolMessage({ content: '{"ok":true}', tool_call_id: 'e' });
  const view = completedWriteView([call, success], 16000)[0] as AIMessage;
  assert.ok(view.tool_calls![0].args.oldText.length < 100);
  assert.ok(view.tool_calls![0].args.newText.length < 200);
  assert.equal(call.tool_calls![0].args.oldText, oldText);
  const failed = new ToolMessage({
    content: '{"success":false,"outcome":"unknown"}',
    tool_call_id: 'e',
  });
  assert.equal(completedWriteView([call, failed], 16000)[0], call);
});
