import { inspectFigmaNode } from './figmaNode';

export type RequiredImage = { nodeId: string; name: string };
export type ImageCoverageIssue = RequiredImage & {
  reason:
    | 'missing_cache'
    | 'missing_slice'
    | 'missing_url'
    | 'invalid_slice'
    | 'missing_image'
    | 'unresolved_source'
    | 'wrong_asset';
};

type Node = {
  id: string;
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  fills?: Array<{ type?: string; visible?: boolean; opacity?: number }>;
  children?: Node[];
};

/**
 * 从完整根中取RN必须保留的可见RECTANGLE IMAGE填充；忽略隐藏/x-及已烤入bg/img祖先的后代。
 * 不把节点占位、节点ID或切图前缀等同于图片内容，也不承担所有Figma视觉语义检测。
 */
export function requiredRnImages(cache: unknown, rootId: string): RequiredImage[] {
  const view = inspectFigmaNode(cache, rootId, 0);
  if (!view || view.rootNodeId !== rootId) throw new Error('IMAGE_COVERAGE_CACHE_INVALID');
  const root = (cache as { node: Node }).node;
  const result: RequiredImage[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const name = (node.name ?? '').trim();
    if (node.visible === false || node.opacity === 0 || name === 'x' || name.startsWith('x-'))
      continue;
    if (
      node.type === 'RECTANGLE' &&
      Array.isArray(node.fills) &&
      node.fills.some(
        (paint) => paint.type === 'IMAGE' && paint.visible !== false && paint.opacity !== 0,
      )
    )
      result.push({ nodeId: node.id, name });
    const baked =
      name === 'bg' || name === 'img' || name.startsWith('bg-') || name.startsWith('img-');
    if (!baked) pending.push(...(node.children ?? []));
  }
  return result;
}

/** 仅使用已由调用方核对scope、manifest及图片摘要的条目；缺条目/地址均不能当作有效图片。 */
export function imageSliceExpectations(
  required: RequiredImage[],
  entries: Array<{ nodeId?: unknown; filename?: unknown; filepath?: unknown }>,
  urls: Readonly<Record<string, string>>,
) {
  const expected: Array<{ nodeId: string; url: string }> = [];
  const issues: ImageCoverageIssue[] = [];
  for (const image of required) {
    const hits = entries.filter((entry) => entry.nodeId === image.nodeId);
    if (!hits.length) {
      issues.push({ ...image, reason: 'missing_slice' });
      continue;
    }
    const paths = new Set(hits.map((entry) => entry.filepath));
    const entry = hits[0];
    if (
      paths.size !== 1 ||
      typeof entry.filepath !== 'string' ||
      hits.some(
        (hit) =>
          typeof hit.filepath !== 'string' ||
          typeof hit.filename !== 'string' ||
          hit.filepath.split('/').at(-1) !== hit.filename,
      )
    ) {
      issues.push({ ...image, reason: 'invalid_slice' });
      continue;
    }
    const url = urls[entry.filepath];
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      issues.push({ ...image, reason: 'missing_url' });
      continue;
    }
    expected.push({ nodeId: image.nodeId, url });
  }
  return { expected, issues };
}

/** 将覆盖失败添加到真实规则报告，保留原检查结果；不重写业务状态或伪造扫描证据。 */
export function appendImageCoverage(output: string, issues: ImageCoverageIssue[]) {
  const report = JSON.parse(output);
  if (
    typeof report?.ok !== 'boolean' ||
    !Array.isArray(report.violations) ||
    !Array.isArray(report.checked) ||
    !Array.isArray(report.skipped) ||
    !Array.isArray(report.warnings) ||
    report.ok !== (report.violations.length === 0)
  )
    throw new Error('IMAGE_COVERAGE_REPORT_INVALID');
  const messages: Record<ImageCoverageIssue['reason'], string> = {
    missing_cache: '缺少完整根节点缓存，请先fetch-node完整根后再检查图片覆盖。',
    missing_slice:
      '完整设计节点含可见IMAGE填充，但有效切图清单缺少该nodeId；需正式补切。固定包不支持定点补切时报告能力缺口，不能手工绕过或用空View替代。',
    missing_url: '该节点没有可信平台图片地址，不能用本地占位或猜测URL替代。',
    invalid_slice: '该节点切图条目不唯一或文件名与路径不一致。',
    missing_image:
      '未找到该节点对应的原生Image/ImageBackground/FastImage，节点ID或空View不代表图片内容。',
    unresolved_source: '该节点图片source无法静态确认；使用完整可信URI字面量或可解析的静态映射。',
    wrong_asset: '该节点图片source与该节点清单中的可信图片URL不一致。',
  };
  const rule = 'RN-IMAGE-COVERAGE';
  const violations = [
    ...report.violations,
    ...issues.map((issue) => ({
      rule,
      nodeId: issue.nodeId,
      name: issue.name,
      type: 'IMAGE',
      expected: '保留真实图片内容并使用该节点有效切图对应的完整平台URI',
      actual: messages[issue.reason],
      reason: issue.reason,
      file: '(product)',
      line: 0,
      snippet: '',
    })),
  ];
  const checked = [...new Set<string>([...report.checked, rule])];
  const failed = [...new Set<string>(violations.map((value) => value.rule))];
  return {
    ...report,
    ok: violations.length === 0,
    checked,
    violations,
    failed,
    passed: checked.filter((value) => !failed.includes(value) && !report.skipped.includes(value)),
    imageCoverage: { requiredFailures: issues.length },
  };
}
