import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TextContentError } from '../src/functions/d2c/content/store';
import { diagnoseRunFailure, RunExecutionError } from '../src/functions/d2c/run/errors';

/** 正文故障保留服务端固定诊断；公开失败不包含对象身份或密钥材料。 */
test('正文错误穿透工具与子任务包装，固定分类为存储故障且不泄漏引用', () => {
  for (const code of ['DOWNLOAD_FAILED', 'INTEGRITY_FAILED', 'INVALID_REFERENCE'] as const) {
    const raw = new TextContentError(code);
    Object.assign(raw, { locator: 'PRIVATE_LOCATOR', key: 'PRIVATE_KEY' });
    const report = diagnoseRunFailure(
      new RunExecutionError('SUBAGENT_FAILED', { stage: 'tool', tool: 'delegate_agent' }, raw),
    );
    assert.equal(report.failure.code, 'STORAGE_FAILED');
    assert.equal(report.failure.stage, 'storage');
    assert.equal(report.failure.tool, 'delegate_agent');
    assert.equal(report.diagnostics.contentCode, code);
    assert.equal('contentCode' in report.failure, false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|locator|keyId/);
  }
});

/** 取消和租约中断仍沿用执行控制语义，不被嵌套的存储故障覆盖。 */
test('正文诊断不覆盖暂停和租约等优先失败分类', () => {
  const report = diagnoseRunFailure(
    new RunExecutionError(
      'LEASE_LOST',
      { stage: 'worker' },
      new TextContentError('DOWNLOAD_FAILED'),
    ),
  );
  assert.equal(report.failure.code, 'LEASE_LOST');
});
