import './helpers/projectFixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createGenerationTools } from '../src/functions/d2c/run/tools';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-args-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const resources = path.join(directory, 'resources');
  const bin = path.join(resources, 'templates/skills/pp-d2c/bin');
  const cache = path.join(workspace, '.d2c-cache/fixedKey/nodes/1_2.json');
  await fs.mkdir(path.dirname(cache), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  const trap = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(directory, 'script-ran'))},'unexpected');throw new Error('Unexpected script');`;
  for (const name of ['figma.mjs', 'check-rules.mjs'])
    await fs.writeFile(path.join(bin, name), trap);
  await fs.writeFile(path.join(workspace, 'pp-d2c.config.json'), '{}');
  await fs.writeFile(
    cache,
    JSON.stringify({
      _depth: null,
      node: {
        id: '1:2',
        type: 'FRAME',
        children: [
          {
            id: '2:1',
            type: 'FRAME',
            children: [
              {
                id: '2:2',
                type: 'TEXT',
                children: [{ id: '2:3', type: 'TEXT', characters: 'retained' }],
              },
            ],
          },
        ],
      },
    }),
  );
  async function forbidden(): Promise<never> {
    assert.fail('Unexpected credential/storage/network access');
  }
  const { tools } = await createGenerationTools({
    restored: {
      directory,
      workspace,
      resources,
      skill: '',
      skillFile: '',
      configHash: '',
      bundleHash: '',
      dispose: async () => {},
    },
    target: 'h5',
    figmaUrl: 'https://www.figma.com/design/fixedKey/Test?node-id=1-2',
    proxyUrl: 'http://unused.invalid:8080',
    allowedHosts: [],
    textFileBytes: 65536,
    uploadBytes: 65536,
    signal: new AbortController().signal,
    assertLease: async () => {},
    redact: (value) => value,
    token: forbidden,
    save: forbidden,
    saveBinary: forbidden,
    remove: forbidden,
  });
  return { tools, directory };
}

test('主子工具对浅层分页冲突返回具体字段，纠正后读取缓存且不调用网络', async (t) => {
  const f = await fixture(t);
  const { createSubagentTools } = await import('../src/functions/d2c/run/agent/subagentTools');
  for (const tools of [
    f.tools,
    createSubagentTools(f.tools, 'ui', ['page/a.tsx']),
    createSubagentTools(f.tools, 'rule_scan', ['page/rule-hits.json']),
  ]) {
    await assert.rejects(
      tools.figma('inspect-node', {
        nodeId: '2:1',
        depth: 1,
        subtree: false,
        offset: 0,
        limit: 10,
      }),
      (error) => {
        assert.ok(error instanceof ToolIssue);
        assert.equal(error.feedback.code, 'FIGMA_ARGUMENT_CONFLICT');
        assert.match(error.feedback.detail!, /subtree=true/);
        assert.match(error.feedback.detail!, /删除 offset 和 limit/);
        return true;
      },
    );
    const shallow = JSON.parse(
      await tools.figma('inspect-node', { nodeId: '2:1', depth: 1, subtree: false }),
    );
    assert.equal(shallow.ok, true);
    assert.deepEqual(
      shallow.data.nodes.map((node: any) => node.attributes.id),
      ['2:1', '2:2'],
    );
    const subtree = JSON.parse(
      await tools.figma('inspect-node', { nodeId: '2:1', subtree: true, offset: 0, limit: 1 }),
    );
    assert.equal(subtree.ok, true);
    assert.equal(subtree.data.nextOffset, 1);
  }
  await assert.rejects(fs.stat(path.join(f.directory, 'script-ran')), { code: 'ENOENT' });
});

test('同类参数纠错耗尽保留工具参数分类，不误报页面规则失败', async (t) => {
  const f = await fixture(t);
  const { createDeepToolFeedback } = await import('../src/functions/d2c/run/agent/feedback');
  const { diagnoseRunFailure } = await import('../src/functions/d2c/run/errors');
  const feedback = createDeepToolFeedback({
    signal: new AbortController().signal,
    assertLease: async () => {},
  });
  for (let i = 0; i < 11; i++)
    await feedback.run(
      'figma',
      () =>
        f.tools.figma('inspect-node', {
          nodeId: '2:1',
          subtree: false,
          offset: 0,
          limit: 10,
        }),
      'inspect-node',
    );
  assert.throws(feedback.assertUnblocked, (error: unknown) => {
    const report = diagnoseRunFailure(error);
    assert.equal(report.failure.code, 'TOOL_ARGUMENT_INVALID');
    assert.equal(report.diagnostics.feedbackCode, 'ADJUSTMENT_EXHAUSTED');
    assert.equal(report.diagnostics.originalFeedbackCode, 'FIGMA_ARGUMENT_CONFLICT');
    assert.equal(report.failure.command, 'inspect-node');
    return true;
  });
});
