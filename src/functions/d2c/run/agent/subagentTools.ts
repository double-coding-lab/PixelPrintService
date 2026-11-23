import { normalizeFigmaArguments } from '../figmaArguments';
import { invalidBlockDirectory } from '../../utils/blockPaths';
import { assertArtifactPath, normalizeRelativePath } from '../../utils/paths';
import type { SubagentRole } from '../subagent';
import { readToolFeedback, toolIssue } from '../toolFeedback';
import type { GenerationTools } from '../types';

/** 返回 LangChain 工具名称，主入口据此过滤子 Agent 可见能力。 */
export function subagentToolsForRole(role: SubagentRole): string[] {
  return role === 'ui'
    ? [
        'list_files',
        'read_file',
        'write_file',
        'edit_file',
        'figma',
        'check_rules',
        'report_progress',
      ]
    : role === 'rule_scan'
      ? ['list_files', 'read_file', 'write_file', 'figma', 'report_progress']
      : ['list_files', 'read_file', 'report_progress'];
}

/** 权限拒绝可由模型纠正，但不会调用底层工具或扩大白名单。 */
function denied(path?: string): never {
  throw toolIssue(
    'INVALID_ARGUMENT',
    'VALIDATION_FAILED',
    { stage: 'validation' },
    path ? { path: path.slice(0, 1024), resource: false } : {},
  );
}

/** 校验精确会话文件路径，不接受目录、别名、隐藏路径或固定资源。 */
function writablePath(role: SubagentRole, value: string): string {
  try {
    if (normalizeRelativePath(value) !== value) return denied(value);
    assertArtifactPath(value);
  } catch {
    return denied(value);
  }
  if (invalidBlockDirectory(value))
    throw toolIssue(
      'BLOCK_DIRECTORY_INVALID',
      'VALIDATION_FAILED',
      { stage: 'validation' },
      { path: value.slice(0, 1024), resource: false },
    );
  const name = value.split('/').at(-1)!;
  if (role === 'rule_scan') return name === 'rule-hits.json' ? value : denied();
  if (role !== 'ui') return denied(value);
  if (name === 'rule-hits.json')
    throw toolIssue(
      'FILE_WRITE_NOT_ALLOWED',
      'VALIDATION_FAILED',
      { stage: 'validation' },
      {
        path: value,
        detail: 'UI不能修改规则报告。将缺失报告交回主Agent，由rule_scan保存并收取结果后继续UI。',
      },
    );
  if (
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(
      name,
    ) ||
    !(
      /\.(?:[cm]?[jt]sx?|css|scss|sass|less|styl|html|vue|svelte|json)$/i.test(name) ||
      name === 'assets.txt'
    )
  )
    return denied();
  return value;
}

/** 只从真实 blocks/<alias>/ 文件路径推导区块，不把文件授权扩大为页面或任意祖先目录。 */
export function subagentBlockDirectory(relative: string): string | undefined {
  const parts = relative.split('/');
  const index = parts.lastIndexOf('blocks');
  if (index < 0 || index >= parts.length - 2) return undefined;
  const name = parts[index + 1];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.startsWith('sub-')) return undefined;
  return parts.slice(0, index + 2).join('/');
}

/** 将 UI 检查范围纳入原调度互斥；只预留目录，不授予目录写权限。 */
export function subagentReservations(role: SubagentRole, writePaths: string[]): string[] {
  if (role !== 'ui') return writePaths;
  if (!Array.isArray(writePaths)) return denied();
  for (const [index, value] of writePaths.entries()) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return denied();
    writablePath(role, value);
    if (
      writePaths
        .slice(0, index)
        .some(
          (other) =>
            other === value || other.startsWith(value + '/') || value.startsWith(other + '/'),
        )
    )
      return denied(value);
  }
  const paths = [...new Set(writePaths.map((value) => subagentBlockDirectory(value) ?? value))];
  return paths.filter(
    (value) => !paths.some((other) => other !== value && value.startsWith(other + '/')),
  );
}

/** 校验整个委派白名单后封装能力；实际读写复用主工具的路径、租约和持久化检查。 */
export function createSubagentTools(
  tools: GenerationTools,
  role: SubagentRole,
  writePaths: string[] = [],
): GenerationTools & {
  pendingRuleChecks: () => string[];
  requiredRuleChecks: () => string[];
} {
  const execution = role === 'ui' || role === 'rule_scan';
  if (execution && writePaths.length === 0) return denied();
  const allowed = new Set(writePaths.map((value) => writablePath(role, value)));
  const directories = new Set(
    role === 'ui' ? [...allowed].map((value) => subagentBlockDirectory(value) ?? value) : [],
  );
  const checked = new Set<string>();
  const attempted = new Set<string>();
  let mutation = 0;
  /** 新写入立即使区块检查失效，失败写入也不能复用旧通过记录。 */
  function invalidate(relative: string) {
    mutation++;
    const directory = subagentBlockDirectory(relative) ?? relative;
    checked.delete(directory);
    attempted.delete(directory);
  }
  return {
    pendingRuleChecks: () => [...directories].filter((value) => !checked.has(value)),
    requiredRuleChecks: () => [...directories].filter((value) => !attempted.has(value)),
    list: tools.list,
    read:
      role !== 'ui'
        ? tools.read
        : async (relative, resource, offset, length) => {
            if (resource && /(?:^|\/)bin\//.test(relative))
              throw toolIssue(
                'INVALID_ARGUMENT',
                'VALIDATION_FAILED',
                { stage: 'tool', tool: 'read_file' },
                {
                  path: relative,
                  resource: true,
                  detail:
                    'UI实现请读取本区块rule-hits.json、rules中的规则说明和真实节点。检查器实现由主Agent排查，不通过阅读程序源码修复缺失报告。',
                },
              );
            return tools.read(relative, resource, offset, length);
          },
    outputPlan: tools.outputPlan,
    ...(role === 'ui' && tools.edit
      ? {
          async edit(relative: string, oldText: string, newText: string, expectedSha256: string) {
            const normalized = writablePath(role, relative);
            if (!allowed.has(normalized)) return denied(relative);
            const result = await tools.edit!(normalized, oldText, newText, expectedSha256);
            if (!readToolFeedback(result)) invalidate(normalized);
            return result;
          },
        }
      : {}),
    async write(relative, content) {
      const normalized = writablePath(role, relative);
      if (!allowed.has(normalized)) return denied(relative);
      invalidate(normalized);
      return tools.write(normalized, content);
    },
    async figma(command, args) {
      if (
        !execution ||
        command !== 'inspect-node' ||
        Object.keys(args).some(
          (key) => !['nodeId', 'depth', 'subtree', 'offset', 'limit'].includes(key),
        ) ||
        (args.depth != null && args.depth !== 1 && args.depth !== 2)
      )
        return denied();
      return tools.figma(command, normalizeFigmaArguments(command, args));
    },
    async remove() {
      return denied();
    },
    async rules(relative, mode) {
      try {
        relative = normalizeRelativePath(relative);
      } catch {
        return denied(relative);
      }
      if (role !== 'ui' || mode !== 'block' || !directories.has(relative)) return denied(relative);
      attempted.add(relative);
      checked.delete(relative);
      try {
        if (normalizeRelativePath(relative) !== relative) return denied(relative);
        assertArtifactPath(relative);
      } catch {
        return denied(relative);
      }
      /** 固定检查器接收目录；只认 blocks/<alias>，且目录中不能混入其他执行者的文件。 */
      if (subagentBlockDirectory(relative + '/index.tsx') !== relative) return denied(relative);
      const files = await tools.list();
      if (
        files.some(
          (file) =>
            file.startsWith(relative + '/') &&
            !allowed.has(file) &&
            file !== relative + '/rule-hits.json',
        )
      )
        return denied(relative);
      checked.delete(relative);
      const revision = mutation;
      const result = await tools.rules(relative, 'block');
      if (readToolFeedback(result)) return result;
      let report;
      try {
        report = JSON.parse(result);
      } catch {
        /** 未知报告不构成真实检查通过，交由同一可纠错流程处理。 */
      }
      if (
        revision !== mutation ||
        report?.ok !== true ||
        !Array.isArray(report.checked) ||
        !report.checked.length ||
        !report.checked.every((rule: unknown) => typeof rule === 'string') ||
        !Array.isArray(report.skipped) ||
        !report.checked.some((rule: string) => !report.skipped.includes(rule)) ||
        !Array.isArray(report.violations) ||
        report.violations.length !== 0
      )
        throw toolIssue(
          'RULES_FAILED',
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'check_rules' },
          { path: relative },
        );
      checked.add(relative);
      return result;
    },
    async slices() {
      return denied();
    },
  };
}
