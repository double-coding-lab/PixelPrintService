import type { GenerationTools } from '../types';
import { toolIssue } from '../toolFeedback';

/** UI委派必须指向真实sub图层；页面根的Rule-Scan虚拟block不能成为UI委派依据。 */
export async function assertUiDelegation(tools: GenerationTools, nodeId?: string | null) {
  const reject = () =>
    toolIssue('UI_DELEGATION_NOT_APPLICABLE', 'VALIDATION_FAILED', {
      stage: 'tool',
      tool: 'delegate_agent',
    });
  if (!nodeId || !/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(nodeId)) throw reject();
  const page = JSON.parse(await tools.read('pp-d2c.config.json', false, 0, 64000));
  if (typeof page.content !== 'string' || page.nextOffset != null) throw reject();
  const config = JSON.parse(page.content);
  const prefix =
    typeof config.layers?.sub === 'string' && config.layers.sub ? config.layers.sub : 'sub-';
  const result = JSON.parse(await tools.figma('inspect-node', { nodeId, depth: 1 }));
  const node = result?.data?.nodes?.find(
    (item: { attributes?: { id?: unknown } }) => item.attributes?.id === nodeId,
  )?.attributes;
  if (result.ok !== true || typeof node?.name !== 'string' || !node.name.startsWith(prefix))
    throw reject();
}
