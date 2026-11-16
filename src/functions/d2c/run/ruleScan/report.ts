import type { NativeRuleScanResult } from './index';
import { ScanReportError } from '../agent/scanReport';
import { isDeepStrictEqual } from 'node:util';

type Review = {
  rule: string;
  nodeId: string;
  decision: 'hit' | 'not_applicable';
  reason: string;
};

/** 疑难项只按算法授予的规则与节点匹配，不将完整缓存范围自动交给模型重扫。 */
function candidates(scan: NativeRuleScanResult) {
  return new Set(
    scan.pending.flatMap((item) => item.nodeIds.map((id) => JSON.stringify([item.rule, id]))),
  );
}

/** 变更规则由模型复核整个授权范围，其命中仍只能绑定真实范围内节点。 */
function hitCandidates(scan: NativeRuleScanResult) {
  const allowed = candidates(scan);
  const context = scan.report.context as { scope_nodeIds?: unknown } | undefined;
  if (Array.isArray(context?.scope_nodeIds))
    for (const rule of scan.unsupportedRules)
      for (const nodeId of context.scope_nodeIds)
        if (typeof nodeId === 'string') allowed.add(JSON.stringify([rule, nodeId]));
  return allowed;
}

/** 读取模型保留的逐项判断；无效或越界说明不能构成完成证据。 */
function reviews(value: unknown, allowed: Set<string>): Review[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Review =>
      item &&
      typeof item === 'object' &&
      typeof item.rule === 'string' &&
      typeof item.nodeId === 'string' &&
      allowed.has(JSON.stringify([item.rule, item.nodeId])) &&
      ['hit', 'not_applicable'].includes(item.decision) &&
      typeof item.reason === 'string' &&
      item.reason.trim().length > 0 &&
      item.reason.length <= 2000,
  );
}

/** 新补充必须绑定本次扫描；不能把旧报告或失效批次重新盖上当前指纹。 */
export function assertNativeScanInput(scan: NativeRuleScanResult, content: string): void {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ScanReportError('SCAN_REPORT_INVALID', '扫描补充不是合法JSON。');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ScanReportError('SCAN_REPORT_INVALID', '扫描补充必须是报告对象。');
  if (Object.hasOwn(value, 'hits') && !Array.isArray(value.hits))
    throw new ScanReportError(
      'SCAN_REPORT_INVALID',
      'hits 必须是数组；仅追加nativeReview可省略hits，已有命中由平台保留。',
    );
  if (Object.hasOwn(value, 'nativeReview') && !Array.isArray(value.nativeReview))
    throw new ScanReportError('SCAN_REPORT_INVALID', 'nativeReview 必须是判断数组。');
  const semantic =
    (Array.isArray(value.nativeReview) && value.nativeReview.length > 0) ||
    (Array.isArray(value.hits) &&
      value.hits.some(
        (hit: { rule?: string; nodeId?: string }) =>
          hit && hitCandidates(scan).has(JSON.stringify([hit.rule, hit.nodeId])),
      ));
  if (
    (semantic || value.nativeScan !== undefined) &&
    value.nativeScan?.fingerprint !== scan.fingerprint
  )
    throw new ScanReportError(
      'SCAN_REPORT_SCOPE_MISMATCH',
      '补交须携带当前报告的nativeScan.fingerprint；旧输入或未绑定的疑难判断不能认领。',
    );
}

/** 保留程序确定性命中，只接纳疑难范围内的模型补充；固定报告头和输入指纹由程序提供。 */
export function nativeScanReport(
  scan: NativeRuleScanResult,
  content?: string,
  previous?: string,
): string {
  if (content) assertNativeScanInput(scan, content);
  const allowed = candidates(scan);
  const allowedHits = hitCandidates(scan);
  let before: Record<string, any> = {};
  let incoming: Record<string, any> = {};
  try {
    if (previous) before = JSON.parse(previous) ?? {};
  } catch {
    /** 旧报告无当前指纹时重新计算，不能将损坏JSON认领为有效分析。 */
  }
  try {
    if (content) incoming = JSON.parse(content);
  } catch {
    throw new ScanReportError('SCAN_REPORT_INVALID', '扫描补充不是合法JSON。');
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
    throw new ScanReportError('SCAN_REPORT_INVALID', '扫描补充必须是报告对象。');
  const compatible = before?.nativeScan?.fingerprint === scan.fingerprint;
  const reviewMap = new Map<string, Review>();
  for (const item of [
    ...reviews(compatible ? before.nativeReview : [], allowed),
    ...reviews(incoming.nativeReview, allowed),
  ])
    reviewMap.set(JSON.stringify([item.rule, item.nodeId]), item);
  const hits = new Map<string, NativeRuleScanResult['report']['hits'][number]>();
  for (const hit of [
    ...(compatible && Array.isArray(before.hits) ? before.hits : []),
    ...(Array.isArray(incoming.hits) ? incoming.hits : []),
  ]) {
    if (!hit || typeof hit !== 'object' || !allowedHits.has(JSON.stringify([hit.rule, hit.nodeId])))
      continue;
    const scopeReview = scan.unsupportedRules.includes(hit.rule)
      ? scan.pending
          .find((item) => item.rule === hit.rule)
          ?.nodeIds.map((id) => reviewMap.get(JSON.stringify([hit.rule, id])))
          .find((item) => item?.decision === 'not_applicable')
      : undefined;
    if (
      scopeReview ||
      reviewMap.get(JSON.stringify([hit.rule, hit.nodeId]))?.decision === 'not_applicable'
    )
      continue;
    if (
      typeof hit.trigger !== 'string' ||
      !hit.trigger.trim() ||
      typeof hit.expected !== 'string' ||
      !hit.expected.trim() ||
      !hit.context ||
      typeof hit.context !== 'object' ||
      Array.isArray(hit.context)
    )
      throw new ScanReportError(
        'SCAN_REPORT_INVALID',
        '疑难项命中须包含完整rule/nodeId/trigger/expected及对象context。',
      );
    hits.set(JSON.stringify([hit.rule, hit.nodeId, hit.trigger]), hit);
  }
  for (const hit of scan.report.hits)
    hits.set(JSON.stringify([hit.rule, hit.nodeId, hit.trigger]), hit);
  return JSON.stringify({
    ...scan.report,
    generated_at:
      compatible && typeof before.generated_at === 'string'
        ? before.generated_at
        : scan.report.generated_at,
    hits: [...hits.values()],
    nativeScan: {
      fingerprint: scan.fingerprint,
      pending: scan.pending,
      deterministicRules: scan.deterministicRules,
      unsupportedRules: scan.unsupportedRules,
    },
    nativeReview: [...reviewMap.values()],
  });
}

/** 零命中也须明确说明；结构正确及complete=true不能代替疑难项实际交接。 */
export function nativeScanProblems(scan: NativeRuleScanResult, content: string): string[] {
  let report;
  try {
    report = JSON.parse(content);
  } catch {
    return ['原生扫描报告不是合法JSON'];
  }
  if (
    !report ||
    typeof report !== 'object' ||
    !Array.isArray(report.hits) ||
    report.hits.some((hit: unknown) => !hit || typeof hit !== 'object')
  )
    return ['原生扫描报告缺少有效hits数组'];
  if (report?.nativeScan?.fingerprint !== scan.fingerprint)
    return ['程序扫描输入指纹不一致，需重新取得当前扫描结果'];
  const decisions = new Map(
    reviews(report.nativeReview, candidates(scan)).map((item) => [
      JSON.stringify([item.rule, item.nodeId]),
      item,
    ]),
  );
  const problems: string[] = [];
  for (const expected of scan.report.hits) {
    if (!report.hits.some((hit: unknown) => isDeepStrictEqual(hit, expected)))
      problems.push(`程序命中缺失或改变：${expected.rule} ${expected.nodeId}`);
  }
  for (const item of scan.pending)
    for (const id of item.nodeIds) {
      const review = decisions.get(JSON.stringify([item.rule, id]));
      if (!review) problems.push(`疑难项未完成：${item.rule} ${id}，请补nativeReview判断和理由`);
      else if (
        review.decision === 'hit' &&
        !report.hits.some(
          (hit: { rule: string; nodeId: string }) =>
            hit.rule === item.rule &&
            (hit.nodeId === id ||
              (scan.unsupportedRules.includes(item.rule) &&
                hitCandidates(scan).has(JSON.stringify([hit.rule, hit.nodeId])))),
        )
      )
        problems.push(`疑难项缺少实际命中：${item.rule} ${id}`);
    }
  return problems;
}

/** 新旧Skill规则保持冻结，平台仅替换确定性扫描，疑难项继续按对应原规则判断。 */
export function nativeScanInstructions(paths: string[]) {
  return [
    `平台已完成确定性规则扫描并保存${JSON.stringify(paths)}。先读这些报告的nativeScan.pending；只对其中的规则和节点补充判断，不重新全量扫描。`,
    '程序命中及报告头由平台保护；读取pending对应的真实规则和必要节点，不逐条重抄已计算的尺寸、填充、布局。未知或变更规则按原文完整判断，不能视为通过。',
    '每个pending中的nodeId都须在报告nativeReview中保存{rule,nodeId,decision:"hit"或"not_applicable",reason:"真实判断理由"}；hit还须保存对应hits项，未命中也要明确理由。分批用write_file(merge=true,complete=false)，最后complete=true。',
    '疑难项每批补交必须携带nativeScan:{fingerprint:当前报告的原值}，包括只追加hits的批次；不使用旧报告指纹或省略当前输入绑定。',
    '只补疑难判断时，content仅提交{"nativeScan":{"fingerprint":"从当前报告复制原值"},"nativeReview":[{"rule":"实际规则","nodeId":"实际节点","decision":"not_applicable","reason":"真实理由"}]}。无需复制报告头、程序hits或完整报告；新增命中才追加hits数组。content须用JSON序列化，不能拼接未转义的引号或换行。',
    'unsupportedRules表示新增或变化的规则：pending根节点是整范围复核任务，读取该规则并检查scope_nodeIds内真实节点；nativeReview按根节点汇总，hits按实际命中节点保存。只修改已授权范围，不能因为规则变化而扩大范围。',
    '这些是生成前约束，代码生成后仍须执行对应端check_rules；deferredChecks是生成后待检查项，不代表已经通过。',
  ].join('\n');
}
