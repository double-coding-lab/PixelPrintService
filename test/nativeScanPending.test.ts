import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeScanPending, nativeScanReport } from '../src/functions/d2c/run/ruleScan/report';
import type { NativeRuleScanResult } from '../src/functions/d2c/run/ruleScan';

/** 长确定性报告与少量疑难项并存，视图不能重复传输完整命中证据。 */
function fixture(): NativeRuleScanResult {
  return {
    fingerprint: 'current-scan',
    report: {
      block: 'pages/page',
      cache_key: 'design',
      generated_at: '2026-11-25T00:00:00Z',
      generated_by: 'platform-native-rules',
      hits: Array.from({ length: 80 }, (_, index) => ({
        rule: 'R01',
        nodeId: `1:${index}`,
        trigger: 'fixed-',
        expected: 'position:fixed',
        context: { name: `fixed-${index}`, evidence: 'e'.repeat(600) },
      })),
    },
    pending: [{ rule: 'R11', nodeIds: ['2:1', '2:2', '2:3'], reason: '需要判断几何' }],
    deterministicRules: ['R01'],
    unsupportedRules: [],
  };
}

test('待判断视图按条目分页，保存后的回执只返回未完成项且保留全部确定性命中', () => {
  const scan = fixture();
  const original = nativeScanReport(scan);
  const first = nativeScanPending(scan, original, 0, 2);
  assert.equal(first.remaining, 3);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(
    first.pending.map((x) => x.nodeId),
    ['2:1', '2:2'],
  );
  assert.deepEqual(
    nativeScanPending(scan, original, 2, 2).pending.map((x) => x.nodeId),
    ['2:3'],
  );
  assert.ok(JSON.stringify(first).length < original.length / 10);
  const content = nativeScanReport(
    scan,
    JSON.stringify({
      nativeScan: { fingerprint: scan.fingerprint },
      nativeReview: [
        { rule: 'R11', nodeId: '2:1', decision: 'not_applicable', reason: '真实圆形' },
      ],
    }),
    original,
  );
  const second = nativeScanPending(scan, content);
  assert.equal(second.reviewed, 1);
  assert.equal(second.remaining, 2);
  assert.equal(second.complete, false);
  assert.deepEqual(
    second.pending.map((x) => x.nodeId),
    ['2:2', '2:3'],
  );
  assert.deepEqual(JSON.parse(content).hits, scan.report.hits);
});

test('hit判断缺少实际命中不能成为已完成项，补齐真实命中后才能交付', () => {
  const scan = fixture();
  scan.pending[0].nodeIds = ['2:1'];
  const review = { rule: 'R11', nodeId: '2:1', decision: 'hit', reason: '真实复杂几何' };
  const incomplete = nativeScanReport(
    scan,
    JSON.stringify({
      nativeScan: { fingerprint: scan.fingerprint },
      nativeReview: [review],
    }),
  );
  assert.equal(nativeScanPending(scan, incomplete).remaining, 1);
  assert.equal(nativeScanPending(scan, incomplete).complete, false);
  const complete = nativeScanReport(
    scan,
    JSON.stringify({
      nativeScan: { fingerprint: scan.fingerprint },
      hits: [
        {
          rule: 'R11',
          nodeId: '2:1',
          trigger: 'geometry',
          expected: '完整切图',
          context: { name: 'shape' },
        },
      ],
    }),
    incomplete,
  );
  assert.equal(nativeScanPending(scan, complete).remaining, 0);
  assert.equal(nativeScanPending(scan, complete).complete, true);
  assert.equal(nativeScanPending(scan, complete).hitCount, 81);
});

test('旧指纹、越界或无理由判断不能消除当前疑难项', () => {
  const scan = fixture();
  const original = nativeScanReport(scan);
  assert.throws(
    () => nativeScanPending({ ...scan, fingerprint: 'new' }, original),
    /SCOPE_MISMATCH/,
  );
  const content = nativeScanReport(
    scan,
    JSON.stringify({
      nativeScan: { fingerprint: scan.fingerprint },
      nativeReview: [
        { rule: 'R11', nodeId: '9:9', decision: 'not_applicable', reason: '越界' },
        { rule: 'R11', nodeId: '2:1', decision: 'not_applicable', reason: '' },
      ],
    }),
    original,
  );
  assert.equal(nativeScanPending(scan, content).remaining, 3);
});

test('变更规则按授权根汇总，范围内真实子节点命中可完成而越界命中不行', () => {
  const scan = fixture();
  scan.pending = [{ rule: 'R99', nodeIds: ['2:0'], reason: '变化规则整范围判断' }];
  scan.unsupportedRules = ['R99'];
  scan.report.context = { scope_nodeIds: ['2:0', '2:1'] };
  const review = { rule: 'R99', nodeId: '2:0', decision: 'hit', reason: '已检查授权范围' };
  for (const nodeId of ['2:1', '9:9']) {
    const content = nativeScanReport(
      scan,
      JSON.stringify({
        nativeScan: { fingerprint: scan.fingerprint },
        nativeReview: [review],
        hits: [
          {
            rule: 'R99',
            nodeId,
            trigger: 'new-rule',
            expected: '真实约束',
            context: { name: 'child' },
          },
        ],
      }),
    );
    assert.equal(nativeScanPending(scan, content).complete, nodeId === '2:1');
  }
});
