import { Op, Transaction, type Sequelize } from 'sequelize';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cRun } from '@/models/D2cRun';
import type { ActiveSessionSummary } from '../../../../shared/activeSessions';
import { visibleWorkspaceWhere } from '../team/access';
import { requireIdentifier, SessionError } from './access';

/** 一致读内跨工作区汇总活动会话，显式排除源码、问题正文与模型快照等大字段。 */
export async function listActiveSessions(
  mysql: Sequelize,
  userId: string,
  page = 1,
  pageSize = 20,
) {
  requireIdentifier(userId);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 50
  )
    throw new SessionError(422, 'INVALID_PAGE', '分页参数无效');
  return mysql.transaction(
    { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
    async (transaction) => {
      const workspaces = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findAll({
        where: await visibleWorkspaceWhere(mysql, userId, {}, transaction),
        attributes: ['workspaceId', 'name', 'teamId'],
        transaction,
      });
      if (!workspaces.length) return { items: [], total: 0 };
      const sessions = await (mysql.models.D2cSession as typeof D2cSession).findAll({
        where: {
          workspaceId: {
            [Op.in]: workspaces
              .map((row) => row.workspaceId)
              .filter((id): id is string => Boolean(id)),
          },
          activeRunId: { [Op.ne]: null },
        },
        attributes: ['sessionId', 'workspaceId', 'name', 'target', 'activeRunId'],
        transaction,
      });
      if (!sessions.length) return { items: [], total: 0 };
      const model = mysql.models.D2cRun as typeof D2cRun;
      const where = {
        status: { [Op.in]: ['queued', 'running', 'waiting_input', 'stopping'] },
        [Op.or]: sessions.map((row) => ({ runId: row.activeRunId, sessionId: row.sessionId })),
      };
      const result = await model.findAndCountAll({
        where,
        attributes: ['runId', 'sessionId', 'status', 'updatedAt'],
        order: [
          ['updatedAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
        transaction,
      });
      const sessionById = new Map(sessions.map((row) => [row.sessionId, row]));
      const workspaceById = new Map(workspaces.map((row) => [row.workspaceId, row]));
      const items: ActiveSessionSummary[] = result.rows.map((run) => {
        const session = sessionById.get(run.sessionId)!;
        const workspace = workspaceById.get(session.workspaceId)!;
        return {
          sessionId: session.sessionId!,
          workspaceId: session.workspaceId!,
          name: session.name!,
          workspaceName: workspace.name || '未命名工作区',
          teamId: workspace.teamId || null,
          target: session.target!,
          runId: run.runId!,
          status: run.status as ActiveSessionSummary['status'],
          updatedAt: run.updatedAt?.toISOString() ?? null,
        };
      });
      return { items, total: result.count };
    },
  );
}
