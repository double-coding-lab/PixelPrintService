import type { Sequelize, Transaction } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import { requireTeamMember, sameUser, TeamError } from '../team/access';

/** 会话接口只暴露稳定错误，不透传数据库、凭据或对象存储诊断。 */
export class SessionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SessionError';
  }
}

/** 仅接受可存储的业务标识，用户身份必须来自服务端 账号认证。 */
export function requireIdentifier(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new SessionError(422, 'INVALID_IDENTIFIER', '身份或业务标识无效');
  }
}

/** 验证数据库修订，避免无符号整型溢出或把非法游标转换为零。 */
export function requireRevision(value: number, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 4294967294) {
    throw new SessionError(422, 'INVALID_REVISION', '修订或游标无效');
  }
}

/** 本人或当前团队成员访问；写事务先锁工作区，再锁团队/成员与会话。 */
export async function ownedWorkspace(
  mysql: Sequelize,
  userId: string,
  id: string,
  transaction?: Transaction,
  mode: 'read' | 'write' = 'write',
) {
  requireIdentifier(userId);
  requireIdentifier(id);
  const model = mysql.models.D2cWorkspace as typeof D2cWorkspace;
  const row = await model.findOne({
    where: { workspaceId: id },
    transaction,
    ...(transaction && mode === 'write' ? { lock: transaction.LOCK.UPDATE } : {}),
    ...(mode === 'read' ? { attributes: ['workspaceId', 'createdUserId', 'teamId'] } : {}),
  });
  if (!row || row.workspaceId !== id) {
    throw new SessionError(404, 'WORKSPACE_NOT_FOUND', '工作区不存在');
  }
  if (!sameUser(row.createdUserId, userId)) {
    if (!row.teamId) throw new SessionError(404, 'WORKSPACE_NOT_FOUND', '工作区不存在');
    try {
      await requireTeamMember(mysql, userId, row.teamId, transaction, mode);
    } catch (error) {
      if (error instanceof TeamError) {
        if (error.statusCode === 404)
          throw new SessionError(404, 'WORKSPACE_NOT_FOUND', '工作区不存在');
        throw new SessionError(error.statusCode, error.reason, error.message);
      }
      throw error;
    }
  }
  return row;
}

/** 通过工作区归属校验私有会话；事务锁后复查关联，不凭 sessionId 推断访问权。 */
export async function ownedSession(
  mysql: Sequelize,
  userId: string,
  id: string,
  transaction?: Transaction,
  mode: 'read' | 'write' = 'write',
) {
  requireIdentifier(userId);
  requireIdentifier(id);
  const model = mysql.models.D2cSession as typeof D2cSession;
  const initial = await model.findOne({
    where: { sessionId: id },
    transaction,
    ...(mode === 'read' ? { attributes: { exclude: ['contextSummary'] } } : {}),
  });
  if (!initial || initial.sessionId !== id || !initial.workspaceId) {
    throw new SessionError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }
  const workspace = await ownedWorkspace(mysql, userId, initial.workspaceId, transaction, mode);
  const session =
    transaction && mode === 'write'
      ? await model.findOne({
          where: { sessionId: id, workspaceId: workspace.workspaceId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : initial;
  if (!session || session.workspaceId !== workspace.workspaceId) {
    throw new SessionError(404, 'SESSION_NOT_FOUND', '会话不存在');
  }
  return { workspace, session };
}
