import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertArtifactPath, resolveWorkspacePath } from '../utils/paths';

/** 只接受已校验清单范围、稳定文件和当前字节后的可信图片身份。 */
export type RuleImage = { url: string; path: string; sha256: string; size: number };

/** 错误只保存相对路径和固定原因，不把URL、查询凭据或完整摘要写入反馈。 */
export class RuleImageMappingError extends Error {
  constructor(
    public readonly reason:
      | 'IMAGE_URL_CONTENT_CONFLICT'
      | 'IMAGE_IDENTITY_MISSING'
      | 'IMAGE_PATH_INVALID',
    public readonly paths: string[],
  ) {
    super('图片地址映射校验失败');
    this.name = 'RuleImageMappingError';
  }
}

/** 相同地址的多个已验证副本共享确定性代表路径；内容不一致仍拒绝，遍历顺序不影响结果。 */
export function createRuleImageMap(entries: readonly RuleImage[]): Map<string, string> {
  const identities = new Map<string, RuleImage>();
  for (const entry of entries) {
    try {
      if (assertArtifactPath(entry.path) !== entry.path) throw new Error('Noncanonical image path');
    } catch {
      throw new RuleImageMappingError('IMAGE_PATH_INVALID', [entry.path]);
    }
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    )
      throw new RuleImageMappingError('IMAGE_IDENTITY_MISSING', [entry.path]);
    const previous = identities.get(entry.url);
    if (previous && (previous.sha256 !== entry.sha256 || previous.size !== entry.size))
      throw new RuleImageMappingError('IMAGE_URL_CONTENT_CONFLICT', [previous.path, entry.path]);
    if (!previous || entry.path < previous.path) identities.set(entry.url, entry);
  }
  return new Map([...identities].map(([url, entry]) => [url, entry.path]));
}

/** 冲突成为可读取的失败检查报告，保持真实失败状态，不能据此跳过图片对账。 */
export function ruleImageMappingReport(error: RuleImageMappingError) {
  const paths = [...error.paths].sort();
  return {
    ok: false,
    checked: ['IMG-reconcile'],
    passed: [],
    failed: ['IMG-reconcile'],
    skipped: [],
    warnings: [],
    violations: [
      {
        rule: 'IMG-reconcile',
        code: error.reason,
        nodeId: '-',
        name: '图片URL映射',
        type: 'IMG',
        file: paths[0],
        paths,
        line: 0,
        snippet: '',
        expected: '同一平台图片URL的本地别名须有相同且有效的当前文件SHA-256与字节数',
        actual: `${
          error.reason === 'IMAGE_URL_CONTENT_CONFLICT'
            ? '同一图片地址对应不同内容或字节数；请核对真实图片及地址映射，不要重写规则报告。'
            : '图片缺少有效身份或规范路径；请核对真实文件及切图清单后重查。'
        } 路径：${paths.join('，')}`,
      },
    ],
  };
}

/** 仅在完整字面量精确命中时回映；query、片段、前后缀或动态拼接均不猜测。 */
export function mapPublishedImages(content: string, images: ReadonlyMap<string, string>) {
  let references = 0;
  const quoted = content.replace(
    /(['"`])(https?:\/\/[^\r\n]*?)\1/g,
    (literal, quote, url, offset) => {
      const before = content.slice(0, offset).trimEnd();
      const after = content.slice(offset + literal.length).trimStart();
      const cssUrl = /url\(\s*$/.test(before);
      if (
        before.endsWith('*/') ||
        /\/\//.test(before.split(/\r?\n/).at(-1) ?? '') ||
        after.startsWith('/*') ||
        after.startsWith('//') ||
        (!cssUrl && (before.endsWith('(') || after.startsWith(')'))) ||
        before.endsWith('+') ||
        content
          .slice(offset + literal.length)
          .trimStart()
          .startsWith('+')
      )
        return literal;
      const local = images.get(url);
      if (!local) return literal;
      references++;
      return quote + local.replace(/\\/g, '\\\\').replaceAll(quote, '\\' + quote) + quote;
    },
  );
  const text = quoted.replace(/url\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (literal, url) => {
    const local = images.get(url);
    if (!local) return literal;
    references++;
    return `url(${JSON.stringify(local)})`;
  });
  return { text, references };
}

/**
 * 创建仅供固定检查器读取的独立副本；清单、配置及证据原样复制，不使用链接。
 * images 必须来自调用方已校验 scope、manifest、图片摘要的可信映射，不读取模型地址表。
 */
export async function createRulesWorkspace(input: {
  workspace: string;
  directory: string;
  product: string;
  files: string[];
  images: ReadonlyMap<string, string>;
  signal: AbortSignal;
}) {
  const workspace = await fs.realpath(input.workspace);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(input.directory, 'rules-')));
  const hashes = new Map<string, string>();
  let references = 0;
  try {
    for (const relative of input.files) {
      input.signal.throwIfAborted();
      const source = await resolveWorkspacePath(input.workspace, relative);
      const target = await resolveWorkspacePath(directory, relative);
      const data = await fs.readFile(source);
      hashes.set(relative, createHash('sha256').update(data).digest('hex'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (
        relative.startsWith(input.product + '/') &&
        /\.(?:[jt]sx?|css|scss|less)$/.test(relative)
      ) {
        const view = mapPublishedImages(
          new TextDecoder('utf-8', { fatal: true }).decode(data),
          input.images,
        );
        references += view.references;
        await fs.writeFile(target, view.text, { mode: 0o600 });
      } else await fs.writeFile(target, data, { mode: 0o600 });
    }
    return {
      directory,
      workspace,
      product: await resolveWorkspacePath(directory, input.product),
      references,
      /** 检查后复核原始内容，不能把并发变化后的数据绑定到旧报告。 */
      async assertUnchanged(files: string[]) {
        if (JSON.stringify([...files].sort()) !== JSON.stringify([...hashes.keys()].sort()))
          throw new Error('RULES_INPUT_CHANGED');
        for (const [relative, hash] of hashes) {
          input.signal.throwIfAborted();
          const bytes = await fs.readFile(await resolveWorkspacePath(input.workspace, relative));
          if (createHash('sha256').update(bytes).digest('hex') !== hash)
            throw new Error('RULES_INPUT_CHANGED');
        }
      },
      /** 副本永不参与 stable 文件同步，完成或失败后均释放。 */
      dispose: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** 合并原始非图片违规和副本完整报告，未知报告格式不能转为通过。 */
export function mergeRulesReports(original: string, mapped: string, references: number) {
  const source = JSON.parse(original);
  const view = JSON.parse(mapped);
  for (const report of [source, view]) {
    if (
      typeof report?.ok !== 'boolean' ||
      !Array.isArray(report.violations) ||
      !report.violations.every((value: { rule?: unknown }) => typeof value?.rule === 'string') ||
      !Array.isArray(report.checked) ||
      !report.checked.every((value: unknown) => typeof value === 'string') ||
      !Array.isArray(report.skipped) ||
      !report.skipped.every((value: unknown) => typeof value === 'string') ||
      !Array.isArray(report.warnings) ||
      report.ok !== (report.violations.length === 0)
    )
      throw new Error('RULES_REPORT_INVALID');
  }
  if (
    JSON.stringify(source.checked) !== JSON.stringify(view.checked) ||
    JSON.stringify(source.skipped) !== JSON.stringify(view.skipped)
  )
    throw new Error('RULES_REPORT_INVALID');
  const violations = [
    ...new Map(
      [
        ...view.violations,
        ...source.violations.filter((value: { rule: string }) => value.rule !== 'IMG-reconcile'),
      ].map((value) => [JSON.stringify(value), value]),
    ).values(),
  ];
  const failed = [...new Set(violations.map((value) => value.rule))];
  return {
    ...view,
    ok: violations.length === 0,
    violations,
    warnings: [
      ...new Map(
        [
          ...view.warnings,
          ...source.warnings.filter(
            (value: { rule?: string } | null) => value?.rule !== 'IMG-reconcile',
          ),
        ].map((value) => [JSON.stringify(value), value]),
      ).values(),
    ],
    failed,
    passed: view.checked.filter(
      (rule: string) => !failed.includes(rule) && !view.skipped.includes(rule),
    ),
    platformAssetView: {
      references,
      message: '仅在临时校验副本中回映已核实的完整图片URL；原源码和所有非图片违规保留。',
    },
  };
}
