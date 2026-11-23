import type { SubagentRole } from '../subagent';

export const uiResourceReadInstructions =
  '先读取本区块 rule-hits.json 的 hits、constraints、deferredChecks，以及命中规则的 Markdown 文档；按具体违规补读对应 nodeId、文件和代码位置的证据。固定检查器及其依赖是平台实现资料；需要核实检查器实现时，将规则编号、具体违规和已核对的证据交回父 Agent 排查，不继续换路径或分页读取实现脚本。配置、模板和授权业务源码仍可按需读取。';

/** 仅识别真实生成Skill的bin实现脚本及源码映射，调用方先规范化并核对包内路径。 */
export function fixedResourceReadGuidance(relativePath: string, role?: SubagentRole) {
  if (role !== 'ui') return;
  const implementation = /^templates\/skills\/(pp-d2c|pp-d2c-rn)\/bin\//.exec(relativePath);
  if (!implementation || !/\.(?:[cm]?[jt]sx?|py|sh)(?:\.map)?$/i.test(relativePath)) return;
  return `${uiResourceReadInstructions}\n规则入口：/resources/templates/skills/${implementation[1]}/rules/README.md。`;
}
