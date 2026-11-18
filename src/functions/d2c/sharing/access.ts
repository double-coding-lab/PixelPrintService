import type { Sequelize, Transaction } from 'sequelize';
import type { D2cSessionShare } from '../../../models/D2cSessionShare';
import type { D2cSession } from '../../../models/D2cSession';
import type { D2cWorkspace } from '../../../models/D2cWorkspace';
import { requireIdentifier, SessionError } from '../session/access';

/** 身份必须由登录中间件提供；空身份在公开读取入口同样拒绝。 */
export function requireSharingIdentity(eid: string) {
  if (typeof eid !== 'string' || !eid.trim())
    throw new SessionError(401, 'LOGIN_REQUIRED', '请先登录');
  requireIdentifier(eid);
}

/** 发布令牌只接受 UUID，不接受 sessionId 或空值作为旁路。 */
export function requireShareId(shareId: string) {
  if (
    typeof shareId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shareId)
  )
    throw new SessionError(422, 'INVALID_SHARE_ID', '公开会话标识无效');
}

/** 使用统一 404，避免失效链接泄漏发布状态或私有会话。 */
export function sharingNotFound(): never {
  throw new SessionError(404, 'SHARE_NOT_FOUND', '公开会话不存在或已撤销');
}

/** 每次访问重新读取发布、存活会话和工作区；不模拟 owner，也不修改私有鉴权。 */
export async function publishedSession(
  mysql: Sequelize,
  eid: string,
  shareId: string,
  transaction?: Transaction,
) {
  requireSharingIdentity(eid);
  requireShareId(shareId);
  const shares = mysql.models.D2cSessionShare as typeof D2cSessionShare;
  const sessions = mysql.models.D2cSession as typeof D2cSession;
  const workspaces = mysql.models.D2cWorkspace as typeof D2cWorkspace;
  if (!shares || !sessions || !workspaces)
    throw new SessionError(503, 'MODELS_UNAVAILABLE', '公开会话模型尚未注册');
  const share = await shares.findOne({ where: { shareId, enabled: true }, transaction });
  if (!share || share.shareId !== shareId || !share.enabled || !share.sessionId) sharingNotFound();
  const session = await sessions.findOne({
    where: { sessionId: share.sessionId },
    attributes: [
      'sessionId',
      'workspaceId',
      'createdUserId',
      'creatorName',
      'name',
      'target',
      'fileRevision',
      'timelineSeq',
      'activeRunId',
      'createdAt',
      'deletedAt',
    ],
    transaction,
  });
  if (
    !session ||
    session.sessionId !== share.sessionId ||
    session.deletedAt ||
    !session.workspaceId
  )
    sharingNotFound();
  const workspace = await workspaces.findOne({
    where: { workspaceId: session.workspaceId },
    attributes: ['workspaceId', 'deletedAt'],
    transaction,
  });
  if (!workspace || workspace.workspaceId !== session.workspaceId || workspace.deletedAt)
    sharingNotFound();
  return { session, workspace };
}
