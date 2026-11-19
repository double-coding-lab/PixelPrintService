import './helpers/projectFixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SliceDiagnosticError } from '../src/functions/d2c/run/sliceDiagnostics';
import { diagnoseRunFailure } from '../src/functions/d2c/run/errors';

/** 日志投影拒绝非法字段，普通异常不能伪装成可信诊断。 */
test('切图诊断仅投影可信类型的有界白名单字段', () => {
  const error = new SliceDiagnosticError({
    phase: 'fetch_node',
    reason: 'HTTP_ERROR',
    nodeId: '1:2',
    statusCode: 404,
    proxyUsed: true,
  });
  Object.assign(error.diagnostic, {
    url: 'https://private?token=secret',
    token: 'secret',
    body: 'private',
  });
  const report = diagnoseRunFailure(error);
  assert.deepEqual(report.diagnostics.slice, {
    phase: 'fetch_node',
    reason: 'HTTP_ERROR',
    nodeId: '1:2',
    statusCode: 404,
    proxyUsed: true,
  });
  assert.doesNotMatch(JSON.stringify(report), /private|secret/);
  assert.equal(diagnoseRunFailure({ diagnostic: error.diagnostic }).diagnostics.slice, undefined);
  for (const extra of [
    { statusCode: 999 },
    { bytes: -1 },
    { attempt: 4 },
    { nodeId: 'private' },
    { reason: 'secret' },
    { phase: 'secret' },
  ]) {
    const invalid = new SliceDiagnosticError({ phase: 'fetch_node', reason: 'HTTP_ERROR' });
    Object.assign(invalid.diagnostic, extra);
    assert.equal(diagnoseRunFailure(invalid).diagnostics.slice, undefined);
  }
});
