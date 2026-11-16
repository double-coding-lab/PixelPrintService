import type { Sequelize } from 'sequelize';
import { initD2cTeam } from './D2cTeam';
import { initD2cTeamMember } from './D2cTeamMember';
import { initD2cWorkspace } from './D2cWorkspace';
import { initD2cWorkspaceRevision } from './D2cWorkspaceRevision';
import { initD2cSession } from './D2cSession';
import { initD2cRun } from './D2cRun';
import { initD2cTimeline } from './D2cTimeline';
import { initD2cFile } from './D2cFile';
import { initD2cVersion } from './D2cVersion';
import { initD2cVersionFile } from './D2cVersionFile';
import { initD2cPreview } from './D2cPreview';
import { initD2cCredential } from './D2cCredential';
import { initD2cAgentCheckpoint } from './D2cAgentCheckpoint';
import { initD2cAgentWrite } from './D2cAgentWrite';
import { initD2cMessageAttachment } from './D2cMessageAttachment';

/** 模型注册器：连库后由 应用连接器 调用，把每个模型 init 到 sequelize.models。 */
/** 新增表时，在此 import 对应的 init 函数并加入 registry。 */
const registry = [
  initD2cTeam,
  initD2cTeamMember,
  initD2cWorkspace,
  initD2cWorkspaceRevision,
  initD2cSession,
  initD2cRun,
  initD2cTimeline,
  initD2cFile,
  initD2cVersion,
  initD2cVersionFile,
  initD2cPreview,
  initD2cCredential,
  initD2cAgentCheckpoint,
  initD2cAgentWrite,
  initD2cMessageAttachment,
];

/** 仅初始化并返回模型注册表，不连接、认证或自动建表。 */
export function initModels(sequelize: Sequelize) {
  for (const init of registry) init(sequelize);
  return sequelize.models;
}
