import { Op, literal, type Sequelize } from 'sequelize';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cSessionShare } from '@/models/D2cSessionShare';
import type { D2cMessageAttachment } from '@/models/D2cMessageAttachment';
import { attachmentMaxBytes } from '../session/attachments';
import { requireSharingIdentity } from './access';
import { assetUrl } from '../utils/assetUrls';
import { safeRuntimeCoverUrl } from '../utils/runtimeCover';

/** 按当前页会话一次查询，每会话只返回最早截图 ID，不传输时间线/附件大字段。
 * 无专用 screenshot 标记：联合校验 screenshots.ts 的助手消息、修订文件名、
 * SHA-256 身份及首个附件代理引用；用户上传的 UUID 即使同名也不能命中。
 */
export async function runtimeCoverIds(mysql: Sequelize, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, string>();
  const rows = (await (mysql.models.D2cSession as typeof D2cSession).findAll({
    where: { sessionId: { [Op.in]: sessionIds } },
    attributes: [
      'sessionId',
      [
        literal(`(
        SELECT a.attachmentId FROM d2c_timeline AS t
        INNER JOIN d2c_message_attachment AS a
          ON a.sessionId = t.sessionId AND a.messageId = t.messageId
        WHERE t.sessionId = D2cSession.sessionId AND t.kind = 'message'
          AND t.runId IS NOT NULL AND t.seq > 0
          AND JSON_UNQUOTE(JSON_EXTRACT(t.displayPayload, '$.role')) = 'assistant'
          AND a.expiresAt IS NULL AND a.objectLocator IS NOT NULL
          AND a.attachmentId REGEXP '^[a-f0-9]{64}$'
          AND a.fileName REGEXP '^preview-r[0-9]+[.]png$'
          AND a.mimeType = 'image/png' AND a.size BETWEEN 1 AND ${attachmentMaxBytes}
          AND a.width > 0 AND a.height > 0
          AND JSON_LENGTH(JSON_EXTRACT(t.displayPayload, '$.attachments')) = 1
          AND JSON_UNQUOTE(JSON_EXTRACT(t.displayPayload, '$.attachments[0].attachmentId')) = a.attachmentId
          AND JSON_UNQUOTE(JSON_EXTRACT(t.displayPayload, '$.attachments[0].url')) =
            CONCAT('/api/d2c/sessions/', t.sessionId, '/attachments/', a.attachmentId)
          AND SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(t.displayPayload, '$.text')), 1,
            CHAR_LENGTH(CONCAT('运行截图 · 文件修订 r', SUBSTRING(a.fileName, 10, CHAR_LENGTH(a.fileName) - 13), CHAR(10), CHAR(10), '入口：'))) =
            CONCAT('运行截图 · 文件修订 r', SUBSTRING(a.fileName, 10, CHAR_LENGTH(a.fileName) - 13), CHAR(10), CHAR(10), '入口：')
        ORDER BY t.seq ASC, a.attachmentId ASC LIMIT 1
      )`),
        'coverAttachmentId',
      ],
    ],
    limit: sessionIds.length,
    raw: true,
  })) as unknown as Array<{ sessionId: string; coverAttachmentId: string | null }>;
  return new Map(
    rows.flatMap((row) =>
      sessionIds.includes(row.sessionId) &&
      typeof row.coverAttachmentId === 'string' &&
      /^[a-f0-9]{64}$/.test(row.coverAttachmentId)
        ? [[row.sessionId, row.coverAttachmentId] as const]
        : [],
    ),
  );
}

/** 只批量读取仍公开且源工作区存活的运行截图直链，用于个人快照冻结封面。 */
export async function publishedRuntimeCoverUrls(
  mysql: Sequelize,
  user: string,
  sourceIds: string[],
) {
  requireSharingIdentity(user);
  const ids = [...new Set(sourceIds)]
    .filter((id) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id),
    )
    .slice(0, 50);
  const result = new Map<string, string>();
  if (!ids.length) return result;
  const shares = mysql.models.D2cSessionShare as typeof D2cSessionShare;
  const where = {
    enabled: true,
    shareId: { [Op.in]: ids },
    [Op.and]: literal(
      'EXISTS (SELECT 1 FROM `d2c_session` AS `plaza_session` INNER JOIN `d2c_workspace` AS `plaza_workspace` ON `plaza_workspace`.`workspaceId` = `plaza_session`.`workspaceId` AND `plaza_workspace`.`deletedAt` IS NULL WHERE `plaza_session`.`sessionId` = `D2cSessionShare`.`sessionId` AND `plaza_session`.`deletedAt` IS NULL)',
    ),
  };
  const rows = await shares.findAll({ where, attributes: ['sessionId', 'shareId'] });
  if (!rows.length) return result;
  const covers = await runtimeCoverIds(
    mysql,
    rows.map((row) => row.sessionId),
  );
  const pairs = rows.flatMap((row) =>
    covers.has(row.sessionId)
      ? [{ sessionId: row.sessionId, attachmentId: covers.get(row.sessionId)! }]
      : [],
  );
  if (!pairs.length) return result;
  const attachments = await (
    mysql.models.D2cMessageAttachment as typeof D2cMessageAttachment
  ).findAll({
    where: { [Op.or]: pairs, expiresAt: null },
    attributes: ['sessionId', 'attachmentId', 'objectLocator', 'size', 'mimeType'],
  });
  // 读取完成后复查公开状态；撤回、源会话或工作区删除均不回读历史附件。
  const current = await shares.findAll({ where, attributes: ['sessionId', 'shareId'] });
  for (const row of rows) {
    if (
      !current.some(
        (active) => active.shareId === row.shareId && active.sessionId === row.sessionId,
      )
    )
      continue;
    const file = attachments.find(
      (a) => a.sessionId === row.sessionId && a.attachmentId === covers.get(row.sessionId),
    );
    if (
      !file?.objectLocator ||
      file.mimeType !== 'image/png' ||
      file.objectLocator.size !== file.size ||
      (file.objectLocator.mimeType && file.objectLocator.mimeType !== 'image/png')
    )
      continue;
    const url = safeRuntimeCoverUrl(assetUrl(file.objectLocator));
    if (url) result.set(row.shareId, url);
  }
  return result;
}
