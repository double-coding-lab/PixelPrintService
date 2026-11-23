import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareSlices } from '../src/functions/d2c/run/slices';
import { createDeepToolFeedback } from '../src/functions/d2c/run/agent/feedback';
import {
  ToolIssue,
  readToolFeedback,
  sliceNamesRequiredFeedback,
  toolFeedback,
  toolFeedbackSchema,
} from '../src/functions/d2c/run/toolFeedback';

const subjects = [
  { nodeId: '38:3793', name: 'img-鹦鹉', parentName: 'Page' },
  { nodeId: '92:1545', name: 'img-锦鲤', parentName: null },
  { nodeId: '92:1549', name: 'bg-琉璃', parentName: 'Page' },
  { nodeId: 'I92:1951;87:1724', name: 'img-麒麟', parentName: 'Page' },
];

test('专门反馈通过核心schema和SDK单文本封装往返，保留真实节点及固定补全提示', () => {
  const feedback = sliceNamesRequiredFeedback(subjects);
  assert.equal(feedback.code, 'SLICE_NAMES_REQUIRED');
  assert.equal(feedback.action, 'adjust');
  assert.equal(feedback.retryable, false);
  assert.deepEqual(feedback.needsNames, subjects);
  assert.equal(feedback.needsNamesTotal, 4);
  for (const type of ['text', 'input_text']) {
    const parsed = readToolFeedback([
      {
        type,
        text: JSON.stringify({
          ...feedback,
          message: 'PRIVATE_MESSAGE',
          hint: 'PRIVATE_HINT',
          sdk: 'PRIVATE_SDK',
          credentials: 'PRIVATE_CREDENTIALS',
        }),
      },
    ])!;
    assert.deepEqual(parsed, feedback);
    assert.match(parsed.message, /names 映射/);
    assert.match(parsed.hint!, /尚未导出或保存图片/);
    assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE/);
  }
});

test('命名清单和字段有界且只投影节点字段，保留总数以分批补全', () => {
  const names = Array.from({ length: 75 }, (_, i) => ({
    nodeId: `${i}:1`,
    name: 'img-鹦鹉'.repeat(100),
    parentName: '祖先'.repeat(200),
    sdk: 'PRIVATE_SDK',
  }));
  const feedback = sliceNamesRequiredFeedback(names);
  assert.equal(feedback.needsNamesTotal, 75);
  assert.equal(feedback.needsNames?.length, 50);
  assert.equal(feedback.needsNames?.[0].nodeId, '0:1');
  assert.equal(feedback.needsNames?.[0].name, names[0].name.slice(0, 200));
  assert.equal(feedback.needsNames?.[0].parentName, names[0].parentName.slice(0, 200));
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE/);
  assert.ok(toolFeedbackSchema.safeParse(feedback).success);
  assert.equal(readToolFeedback(JSON.stringify({ ...feedback, needsNames: names })), undefined);
  const historical = readToolFeedback(
    JSON.stringify({
      ...toolFeedback('INVALID_ARGUMENT'),
      needsNames: subjects,
      needsNamesTotal: 4,
      hint: '补 names 后成功',
    }),
  )!;
  assert.equal(historical.code, 'INVALID_ARGUMENT');
  assert.equal(historical.needsNames, undefined);
  assert.equal(historical.hint, undefined);
  const legacyWithUnboundedExtras = readToolFeedback(
    JSON.stringify({
      ...toolFeedback('INVALID_ARGUMENT'),
      needsNames: names,
      needsNamesTotal: 'historical',
    }),
  )!;
  assert.equal(legacyWithUnboundedExtras.code, 'INVALID_ARGUMENT');
  assert.equal(legacyWithUnboundedExtras.needsNames, undefined);
});

test('命名预检通过真实工具反馈层返回可调整结果，不触发导出或写入', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'slice-names-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let fetched = 0;
  const feedback = createDeepToolFeedback({
    signal: new AbortController().signal,
    assertLease: async () => {},
  });
  const result = await feedback.run('prepare_slices', () =>
    prepareSlices({
      workspace,
      figmaUrl: 'https://www.figma.com/design/key/Page?node-id=1-2',
      slug: 'page',
      assetsDir: 'static/',
      scope: 'offline',
      signal: new AbortController().signal,
      assertLease: async () => {},
      request: async (address) => {
        assert.ok(new URL(address).pathname.endsWith('/nodes'));
        fetched++;
        return Buffer.from(
          JSON.stringify({
            nodes: {
              '1:2': {
                document: {
                  id: '1:2',
                  name: 'Page',
                  children: subjects.map(({ nodeId, name }) => ({ id: nodeId, name })),
                },
              },
            },
          }),
        );
      },
      saveText: async () => assert.fail('命名预检不得保存清单'),
      saveBinary: async () => assert.fail('命名预检不得保存图片'),
    }),
  );
  const parsed = readToolFeedback(result)!;
  assert.equal(parsed.code, 'SLICE_NAMES_REQUIRED');
  assert.equal(parsed.action, 'adjust');
  assert.deepEqual(
    parsed.needsNames?.map((item) => item.nodeId),
    subjects.map((item) => item.nodeId),
  );
  assert.equal(fetched, 1);
  assert.doesNotThrow(() => feedback.assertUnblocked());
});

test('真正无效slug或映射仍是INVALID_ARGUMENT，且在请求前拒绝', async () => {
  const options: Parameters<typeof prepareSlices>[0] = {
    workspace: os.tmpdir(),
    figmaUrl: 'https://www.figma.com/design/key/Page?node-id=1-2',
    slug: 'page',
    assetsDir: 'static/',
    scope: 'offline',
    signal: new AbortController().signal,
    assertLease: async () => {},
    request: async () => assert.fail('非法参数不得请求Figma'),
    saveText: async () => assert.fail('非法参数不得写入'),
    saveBinary: async () => assert.fail('非法参数不得写入'),
  };
  for (const invalid of [
    { slug: '../page' },
    { slug: '中文' },
    { slug: 'a'.repeat(65) },
    { names: { unused: '../escape' } },
    { names: { unused: '中文' } },
    { names: { unused: 'a'.repeat(161) } },
  ]) {
    await assert.rejects(prepareSlices({ ...options, ...invalid }), (error) => {
      assert.ok(error instanceof ToolIssue);
      assert.equal(error.feedback.code, 'INVALID_ARGUMENT');
      assert.equal(error.failure.code, 'VALIDATION_FAILED');
      return true;
    });
  }
});
