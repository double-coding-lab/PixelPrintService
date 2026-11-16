/** 判断 JSON 值是否为对象，排除 null 和数组。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 返回固定 Skill 扫描报告的首个结构缺口；结构有效时返回 undefined。
 * H5 要求完整 envelope 和 context，RN 允许省略 metadata 和 context。
 * 允许零命中与扩展字段，不证明扫描覆盖、节点真实性或语义命中正确性。
 */
export function scanReportProblem(content: string, target: 'h5' | 'rn' = 'h5'): string | undefined {
  let report: unknown;
  try {
    report = JSON.parse(content);
  } catch {
    return 'rule-hits.json 不是合法 JSON';
  }
  if (!isObject(report)) return '扫描报告必须是 JSON 对象';
  for (const field of ['block', 'cache_key', 'generated_at', 'generated_by']) {
    if (target === 'rn' && !Object.hasOwn(report, field)) continue;
    if (typeof report[field] !== 'string' || !report[field].trim())
      return `${field} 必须是非空字符串`;
  }
  if (typeof report.generated_by === 'string' && /fallback/i.test(report.generated_by))
    return 'fallback 报告不能作为扫描完成依据';
  if (!Array.isArray(report.hits)) return 'hits 必须是数组';
  for (const [index, hit] of report.hits.entries()) {
    if (!isObject(hit)) return `hits[${index}] 必须是对象`;
    for (const field of ['rule', 'nodeId', 'trigger', 'expected']) {
      if (typeof hit[field] !== 'string' || !hit[field].trim())
        return `hits[${index}].${field} 必须是非空字符串`;
    }
    if ((target === 'h5' || Object.hasOwn(hit, 'context')) && !isObject(hit.context))
      return `hits[${index}].context 必须是对象；定位 ${JSON.stringify({
        rule: (hit.rule as string).slice(0, 80),
        nodeId: (hit.nodeId as string).slice(0, 80),
        trigger: (hit.trigger as string).slice(0, 240),
      })}。${[hit.rule, hit.nodeId, hit.trigger].some((value, index) => (value as string).length > [80, 80, 240][index]) ? '定位字段已截短，先读取原条目取得完整rule、nodeId、trigger，不得用截短键补交。' : ''}${Object.hasOwn(hit, 'context') ? '按定位修正现有报告中的该项context；非法旧context不能直接merge。' : '使用原始完整 rule、nodeId、trigger 补交可替换该项，无需重写整份报告。'}`;
  }
  return undefined;
}

type ScanReport = Record<string, unknown> & {
  block: string;
  cache_key: string;
  hits: Array<Record<string, unknown> & { rule: string; nodeId: string; trigger: string }>;
};

/** 保存固定错误分类与本地结构校验原因，不携带整份报告。 */
export class ScanReportError extends Error {
  constructor(
    code: 'SCAN_REPORT_INVALID' | 'SCAN_REPORT_SCOPE_MISMATCH',
    public readonly detail: string,
  ) {
    super(code);
  }
}

/** 解析报告对象，语法错误只返回固定说明，不回传原始 JSON。 */
function parseReport(content: string, source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (isObject(value)) return value;
  } catch {
    throw new ScanReportError('SCAN_REPORT_INVALID', `${source}不是合法 JSON`);
  }
  throw new ScanReportError('SCAN_REPORT_INVALID', `${source}必须是 JSON 对象`);
}

/**
 * 合并同一区块、同一缓存的合法批次；同 key 后项更新，原有顺序保持稳定。
 * 首批要求完整 envelope，后续批次可继承省略的头字段；hit 最终按目标再核对。
 * 顶层扩展字段保留，冲突字段采用 batch 值；不验证规则语义或扫描覆盖。
 * @throws Error 固定 SCAN_REPORT_INVALID 或 SCAN_REPORT_SCOPE_MISMATCH，供调用方映射。
 */
export function mergeScanReport(previous: string | undefined, batch: string): string {
  const before = previous === undefined ? undefined : parseReport(previous, '已有报告');
  const incoming = parseReport(batch, '当前批次');
  const next = { ...incoming };
  if (before)
    for (const field of ['block', 'cache_key', 'generated_at', 'generated_by'])
      if (!Object.hasOwn(next, field)) next[field] = before[field];
  for (const value of [next, ...(before ? [before] : [])]) {
    const source = value === next ? '当前批次' : '已有报告';
    const problem = scanReportProblem(JSON.stringify(value), 'rn');
    if (problem) throw new ScanReportError('SCAN_REPORT_INVALID', `${source}：${problem}`);
    for (const field of ['block', 'cache_key', 'generated_at', 'generated_by'])
      if (typeof value[field] !== 'string' || !(value[field] as string).trim())
        throw new ScanReportError(
          'SCAN_REPORT_INVALID',
          `${source}：${field} 必须是非空字符串；首批须提供完整报告头，追加批次可省略继承。`,
        );
  }
  if (before && (before.block !== next.block || before.cache_key !== next.cache_key))
    throw new ScanReportError(
      'SCAN_REPORT_SCOPE_MISMATCH',
      `${before.block !== next.block ? 'block' : 'cache_key'} 与已有报告不一致，请核对目标区块和设计缓存，不能合并不同范围的报告。`,
    );
  const hits = new Map<string, ScanReport['hits'][number]>();
  for (const hit of [
    ...((before as ScanReport | undefined)?.hits ?? []),
    ...(next as ScanReport).hits,
  ]) {
    hits.set(JSON.stringify([hit.rule, hit.nodeId, hit.trigger]), hit);
  }
  return JSON.stringify({ ...before, ...next, hits: [...hits.values()] }, null, 2);
}
