import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  editArgumentDetail,
  editFileSchema,
  editFileText,
} from '../src/functions/d2c/run/editFile';
import { toolArgumentDetail } from '../src/functions/d2c/run/agent/argumentFeedback';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

test('摘要长度错误反馈字段和实际长度，不猜摘要、不覆盖文件或泄露原文', () => {
  const args = {
    path: 'pages/page/index.tsx',
    expectedSha256: 'a'.repeat(65),
    oldText: 'private original',
    newText: 'private new',
  };
  const detail = editArgumentDetail(args)!;
  assert.match(detail, /expectedSha256.*64.*65/);
  assert.doesNotMatch(detail, /private|aaaa/);
  assert.throws(
    () =>
      editFileText(
        'pages/page/index.tsx',
        'private original',
        args.oldText,
        args.newText,
        args.expectedSha256,
      ),
    (error: unknown) => error instanceof ToolIssue && /当前长度为65/.test(error.feedback.message),
  );
  const current = 'valid original';
  const sha = createHash('sha256').update(current).digest('hex');
  assert.equal(editFileText('pages/page/index.tsx', current, current, 'new', sha), 'new');
});

test('必填字段和别名先于摘要诊断，可省略或null的摘要不产生错误', () => {
  for (const sha of [{}, { expectedSha256: null }, { expectedSha256: 'a'.repeat(65) }]) {
    const args = {
      path: 'pages/page/index.tsx',
      old_text: 'PRIVATE_OLD',
      new_text: 'PRIVATE_NEW',
      ...sha,
    };
    const detail = editArgumentDetail(args)!;
    assert.match(detail, /oldText.*必填.*old_text.*newText.*必填.*new_text/);
    assert.doesNotMatch(detail, /PRIVATE|aaaa/);
    if ('expectedSha256' in sha && typeof sha.expectedSha256 === 'string')
      assert.ok(detail.indexOf('oldText') < detail.indexOf('expectedSha256'));
    else assert.doesNotMatch(detail, /expectedSha256|read_file/);
    assert.equal(toolArgumentDetail(editFileSchema, args), detail);
  }
  for (const expectedSha256 of [undefined, null]) {
    for (const newText of ['changed', '']) {
      const args = { path: 'file.ts', oldText: 'original', newText, expectedSha256 };
      assert.ok(editFileSchema.safeParse(args).success);
      assert.equal(editArgumentDetail(args), undefined);
    }
    assert.match(
      editArgumentDetail({ oldText: 'old', newText: 'new', expectedSha256 })!,
      /path.*必填/,
    );
    assert.match(
      editArgumentDetail({ path: 'file.ts', oldText: 'same', newText: 'same', expectedSha256 })!,
      /相同/,
    );
  }
});

test('显式非法摘要精确拒绝，底层替换始终要求已解析的完整摘要', () => {
  const args = { path: 'file.ts', oldText: 'original', newText: 'changed' };
  for (const expectedSha256 of [123, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.equal(editFileSchema.safeParse({ ...args, expectedSha256 }).success, false);
    const detail = editArgumentDetail({ ...args, expectedSha256 })!;
    assert.match(detail, /expectedSha256.*64/);
    if (typeof expectedSha256 === 'string')
      assert.match(detail, new RegExp(`当前长度为${expectedSha256.length}`));
    assert.doesNotMatch(detail, /original|changed|AAAA|gggg/);
  }
  for (const expected of [undefined, null, 123, '', 'a'.repeat(64)]) {
    assert.throws(
      () => editFileText(args.path, args.oldText, args.oldText, args.newText, expected as string),
      (error: unknown) =>
        error instanceof ToolIssue &&
        error.feedback.code ===
          (expected === 'a'.repeat(64) ? 'EDIT_REVISION_CONFLICT' : 'INVALID_ARGUMENT'),
    );
  }
});

test('真实注册schema解析失败按必填字段反馈，别名和非法SHA调用不执行写入', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage, ToolMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  const path = 'pages/page/index.tsx';
  const attempts = [
    {
      args: { path, old_text: 'PRIVATE_OLD', new_text: 'PRIVATE_NEW' },
      fields: /oldText.*old_text.*newText.*new_text/,
    },
    {
      args: { path, old_text: 'PRIVATE_OLD', new_text: 'PRIVATE_NEW', expectedSha256: null },
      fields: /oldText.*old_text.*newText.*new_text/,
    },
    { args: { path, oldText: 'one', new_text: 'PRIVATE_NEW' }, fields: /newText.*必填.*new_text/ },
    {
      args: { path, oldText: null, newText: 123, expectedSha256: 'a'.repeat(65) },
      fields: /oldText.*newText.*expectedSha256/,
    },
    { args: { path, oldText: '', newText: 'two' }, fields: /oldText.*最短 1/ },
    {
      args: { path, oldText: 'one', newText: 'two', expectedSha256: 123 },
      fields: /expectedSha256.*64/,
    },
    {
      args: { path, oldText: 'one', newText: 'two', expectedSha256: 'A'.repeat(64) },
      fields: /expectedSha256.*当前长度为64/,
    },
  ];
  const model = new FakeToolCallingModel();
  let registeredSchema: z.ZodObject | undefined;
  model.bindTools = (tools) => {
    const edit = tools.find((candidate) => 'name' in candidate && candidate.name === 'edit_file');
    assert.ok(edit && 'schema' in edit);
    registeredSchema = edit.schema as z.ZodObject;
    assert.deepEqual(z.toJSONSchema(registeredSchema), z.toJSONSchema(editFileSchema));
    return model;
  };
  let calls = 0;
  let writes = 0;
  model._generate = async (messages) => {
    if (calls > 0) {
      const previous = attempts[calls - 1];
      const result = messages.filter(ToolMessage.isInstance).at(-1)!;
      const feedback = JSON.parse(String(result.content));
      assert.equal(feedback.code, 'INVALID_ARGUMENT');
      assert.equal(feedback.action, 'adjust');
      assert.match(feedback.detail, previous.fields);
      assert.doesNotMatch(feedback.detail, /PRIVATE|AAAA|aaaa/);
      if (previous.args.expectedSha256 == null)
        assert.doesNotMatch(feedback.detail, /expectedSha256|read_file/);
      assert.equal(writes, 0);
    }
    const attempt = attempts[calls++];
    if (attempt) assert.equal(registeredSchema!.safeParse(attempt.args).success, false);
    const message = attempt
      ? new AIMessage({
          content: '',
          tool_calls: [{ id: `invalid-${calls}`, name: 'edit_file', args: attempt.args }],
        })
      : new AIMessage('完成');
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [new HumanMessage('修改')],
    instructions: '修复',
    maxTurns: 12,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async () => '',
      write: async () => '',
      remove: async () => '',
      figma: async () => '',
      rules: async () => '',
      slices: async () => '',
      edit: async () => {
        writes++;
        return '{"ok":true}';
      },
    },
  });
  assert.ok(registeredSchema);
  assert.equal(writes, 0);
  assert.equal(calls, attempts.length + 1);
});

test('模型工具参数解析失败也保留字段级纠错，下一次使用真实摘要可成功', async () => {
  const { FakeToolCallingModel } = await import('langchain');
  const { AIMessage, HumanMessage } = await import('@langchain/core/messages');
  const { runAgent } = await import('../src/functions/d2c/run/agent/agent');
  let calls = 0;
  let writes = 0;
  const model = new FakeToolCallingModel();
  model.bindTools = () => model;
  model._generate = async (messages) => {
    const index = calls++;
    if (index === 1) assert.match(JSON.stringify(messages), /expectedSha256.*64.*65/);
    const message =
      index === 2
        ? new AIMessage('完成')
        : new AIMessage({
            content: '',
            tool_calls: [
              {
                id: `edit-${index}`,
                name: 'edit_file',
                args: {
                  path: 'pages/page/index.tsx',
                  oldText: 'one',
                  newText: 'two',
                  expectedSha256: 'a'.repeat(index === 0 ? 65 : 64),
                },
              },
            ],
          });
    return { generations: [{ text: message.text, message }] };
  };
  await runAgent({
    model,
    messages: [new HumanMessage('修改')],
    instructions: '修复',
    maxTurns: 4,
    contextBudgetTokens: 256000,
    signal: new AbortController().signal,
    assertLease: async () => {},
    tools: {
      list: async () => [],
      read: async () => '',
      write: async () => '',
      remove: async () => '',
      figma: async () => '',
      rules: async () => '',
      slices: async () => '',
      edit: async () => {
        writes++;
        return '{"ok":true}';
      },
    },
  });
  assert.equal(writes, 1);
  assert.equal(calls, 3);
});
