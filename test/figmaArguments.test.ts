import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFigmaArguments } from '../src/functions/d2c/run/figmaArguments';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

test('非inspect命令清理空值和无操作含义的默认分页参数，不修改调用方对象', () => {
  for (const command of [
    'export-image',
    'fetch-node',
    'screenshot',
    'cache-check',
    'verify-token',
  ]) {
    const input = Object.freeze({
      nodeId: '112:2211',
      filename: 'cover.png',
      offset: 0,
      subtree: false,
      limit: null,
      depth: null,
    });
    const result = normalizeFigmaArguments(command, input as any);
    assert.deepEqual(result, { nodeId: '112:2211', filename: 'cover.png' });
    assert.equal(input.offset, 0);
    assert.equal(input.limit, null);
  }
});

test('有意义的分页参数不能被静默丢弃，字段反馈不包含上游正文或用户路径', () => {
  for (const args of [{ offset: 1 }, { limit: 1 }, { limit: 40 }, { subtree: true }]) {
    assert.throws(
      () => normalizeFigmaArguments('export-image', args),
      (error) => {
        assert.ok(error instanceof ToolIssue);
        assert.equal(error.feedback.code, 'FIGMA_ARGUMENT_CONFLICT');
        assert.equal(error.feedback.action, 'adjust');
        assert.match(error.feedback.detail!, /仅用于 inspect-node/);
        return true;
      },
    );
  }
});

test('真实浅层冲突保持subtree=false，纠正后按显式范围继续', () => {
  const invalid = Object.freeze({
    nodeId: '92:1983',
    depth: 1,
    offset: 0,
    limit: 10,
    subtree: false,
  });
  assert.throws(
    () => normalizeFigmaArguments('inspect-node', invalid),
    (error) => {
      assert.ok(error instanceof ToolIssue);
      assert.match(error.feedback.detail!, /offset\/limit 要求 subtree=true/);
      assert.match(error.feedback.detail!, /浅层读取请删除/);
      return true;
    },
  );
  assert.equal(invalid.subtree, false);
  for (const args of [
    { nodeId: '92:1983', depth: 1, subtree: false },
    { nodeId: '92:1983', depth: 2 },
    { nodeId: '92:1983', subtree: true, offset: 40, limit: 100 },
  ])
    assert.deepEqual(normalizeFigmaArguments('inspect-node', args), args);
});

test('即使绕过模型schema，分页类型、界限和整数约束仍生效', () => {
  for (const args of [
    { subtree: 'true' },
    { offset: -1 },
    { offset: 0.5 },
    { offset: NaN },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ])
    assert.throws(
      () => normalizeFigmaArguments('inspect-node', args as any),
      (error) => error instanceof ToolIssue && error.feedback.code === 'FIGMA_ARGUMENT_CONFLICT',
    );
});
