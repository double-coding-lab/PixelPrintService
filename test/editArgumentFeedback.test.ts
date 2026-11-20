import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { editArgumentDetail, editFileText } from '../src/functions/d2c/run/editFile';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

test('摘要长度错误反馈字段和实际长度，不猜摘要、不覆盖文件或泄露原文', () => {
  const args = {
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
