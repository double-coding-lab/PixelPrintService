import type { Sequelize } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import { ownedSession } from '../session/access';
import { appendSessionEvent } from '../session/service';

/** 构建状态提交后追加可补读事件；通知丢失不会丢失数据库中的预览结果。 */
export async function recordPreviewUpdate(
  mysql: Sequelize,
  sessionId: string,
  notify: (sessionId: string, seq: number) => void,
) {
  const session = await (mysql.models.D2cSession as typeof D2cSession).findOne({
    where: { sessionId },
    attributes: ['sessionId', 'workspaceId'],
  });
  if (!session?.workspaceId) return;
  const workspace = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
    where: { workspaceId: session.workspaceId },
    attributes: ['workspaceId', 'createdUserId'],
  });
  if (!workspace?.createdUserId) return;
  const userId = workspace.createdUserId;
  await mysql.transaction(async (transaction) => {
    const owned = await ownedSession(mysql, userId, sessionId, transaction);
    await appendSessionEvent(mysql, owned.session, transaction, {
      kind: 'preview_changed',
      displayPayload: { status: 'changed' },
    });
    const seq = owned.session.timelineSeq;
    transaction.afterCommit(() => {
      notify(sessionId, seq);
    });
  });
}
