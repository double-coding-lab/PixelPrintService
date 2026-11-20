import type { GenerationTools } from '../types';
import { nativeScanProblems } from '../ruleScan/report';
import { scanReportProblem } from './scanReport';
import { subagentBlockDirectory } from './subagentTools';
import { readToolFeedback } from '../toolFeedback';

/** 在启动 UI 模型前验证区块报告；只读原报告，不代写验收依据或消耗子模型请求。 */
export async function uiPrerequisites(
  tools: GenerationTools,
  writePaths: string[],
  nodeId?: string | null,
  target: 'h5' | 'rn' = 'h5',
) {
  const directories = [...new Set(writePaths.map(subagentBlockDirectory).filter(Boolean))];
  const files = new Set(await tools.list());
  const missing: Array<{ path: string; reason: 'missing' | 'incomplete' | 'invalid' }> = [];
  for (const directory of directories) {
    const path = `${directory}/rule-hits.json`;
    if (!files.has(path)) {
      missing.push({ path, reason: 'missing' });
      continue;
    }
    const raw = await tools.read(path, false, 0, Number.MAX_SAFE_INTEGER);
    if (readToolFeedback(raw)) {
      missing.push({ path, reason: 'incomplete' });
      continue;
    }
    let content: string;
    try {
      const page = JSON.parse(raw);
      if (typeof page.content !== 'string' || page.nextOffset !== null) throw new Error();
      content = page.content;
      if (scanReportProblem(content, target)) throw new Error();
    } catch {
      missing.push({ path, reason: 'invalid' });
      continue;
    }
    if (tools.scanRules) {
      const current = await tools.scanRules(path, nodeId ?? undefined);
      if (nativeScanProblems(current, content).length) missing.push({ path, reason: 'incomplete' });
    }
  }
  return missing;
}
