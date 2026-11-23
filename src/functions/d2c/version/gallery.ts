import { workCoverAttributes, workCoverPattern, workCoverUrl } from '../utils/workCover';
import { contentModel, resolveTextContent } from '../content/runtime';
import { findOrderedRows } from '../utils/orderedRead';
import { createHash } from 'node:crypto';
import { Op, type Sequelize } from 'sequelize';
import type { D2cVersion } from '@/models/D2cVersion';
import type { D2cVersionFile } from '@/models/D2cVersionFile';
import type { D2cPreview } from '@/models/D2cPreview';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { StorageFileClient } from '@/hooks/tools/storage';
import { ownedWorkspace, requireIdentifier, SessionError } from '../session/access';
import type { D2cSession } from '@/models/D2cSession';
import { assertArtifactPath } from '../utils/paths';
import { assetUrl } from '../utils/assetUrls';
import { requireTeamMember, sameUser, TeamError } from '../team/access';

export type GalleryScope = 'mine' | 'all' | 'team';

/** 公开投影只取展示字段，不返回配置、会话定位、内部报告或存储参数。 */
function metadata(row: D2cVersion, userId: string) {
  const state = row.validationSummary?.status;
  return {
    versionId: row.versionId,
    canDelete: sameUser(row.createdUserId, userId),
    name: row.name,
    target: row.target,
    createdUserId: row.createdUserId,
    creatorName: row.creatorName,
    createdAt: row.createdAt,
    status: 'ready' as const,
    sourceFileRevision: row.sourceFileRevision,
    validationSummary: {
      status: ['passed', 'failed', 'stale', 'not_checked'].includes(String(state))
        ? state
        : 'not_checked',
    },
  };
}

/** 用户共享已暂存版本；读取版本两表，不依赖仍存活的源工作区或会话。 */
export function createGalleryService(
  mysql: Sequelize,
  binary: () => Pick<StorageFileClient, 'downloadFile'>,
) {
  const versions = mysql.models.D2cVersion as typeof D2cVersion;
  const files = mysql.models.D2cVersionFile as typeof D2cVersionFile;

  /** 登录身份由外层 账号认证 提供，只暴露已完成的不可变版本。 */
  async function ready(userId: string, versionId: string) {
    requireIdentifier(userId);
    requireIdentifier(versionId);
    const row = await versions.findOne({ where: { versionId, status: 'ready' } });
    if (!row || !row.archiveObject)
      throw new SessionError(404, 'VERSION_NOT_FOUND', '暂存版本不存在');
    return row;
  }

  /** 来源跳转复用工作区读权限，只查询存活会话的定位，不影响孤立版本读取。 */
  async function sourceSession(row: D2cVersion, userId: string) {
    if (!row.sessionId || !row.workspaceId) return null;
    try {
      requireIdentifier(row.sessionId);
      requireIdentifier(row.workspaceId);
      const session = await (mysql.models.D2cSession as typeof D2cSession).findOne({
        where: { sessionId: row.sessionId, workspaceId: row.workspaceId },
        attributes: ['sessionId', 'workspaceId'],
      });
      if (!session) return null;
      await ownedWorkspace(mysql, userId, row.workspaceId, undefined, 'read');
      return { sessionId: row.sessionId, workspaceId: row.workspaceId };
    } catch (error) {
      if (error instanceof SessionError && [404, 422].includes(error.statusCode)) return null;
      throw error;
    }
  }

  /** 检查冻结文件路径和摘要键，不允许内部文件混入共享资源。 */
  function fileMetadata(row: D2cVersionFile) {
    try {
      if (
        !row.path ||
        assertArtifactPath(row.path) !== row.path ||
        !row.pathHash ||
        createHash('sha256').update(row.path).digest('hex') !== row.pathHash ||
        !['source', 'asset', 'attachment'].includes(row.kind ?? '') ||
        !Number.isSafeInteger(row.size) ||
        row.size! < 0
      )
        throw new Error();
    } catch {
      throw new SessionError(503, 'VERSION_FILE_INVALID', '版本文件信息无效');
    }
    return {
      fileId: row.pathHash!,
      path: row.path!,
      kind: row.kind!,
      size: row.size!,
      mimeType: row.mimeType,
      revision: 1,
      url: row.kind !== 'source' && row.objectLocator ? assetUrl(row.objectLocator) : null,
    };
  }

  return {
    /** 团队范围按工作区归属筛选并保留软删工作区版本，不以版本操作者推断团队。 */
    async list(userId: string, scope: GalleryScope, page = 1, pageSize = 12, teamId?: string) {
      requireIdentifier(userId);
      if (
        !['mine', 'all', 'team'].includes(scope) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 50
      )
        throw new SessionError(422, 'INVALID_PAGE', '作品查询参数无效');
      let workspaceIds: string[] | undefined;
      if (scope === 'team') {
        if (teamId === undefined)
          throw new SessionError(422, 'TEAM_ID_REQUIRED', '请选择要查看的团队');
        try {
          await requireTeamMember(mysql, userId, teamId);
        } catch (error) {
          if (error instanceof TeamError)
            throw new SessionError(error.statusCode, error.reason, error.message);
          throw error;
        }
        const workspaces = await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findAll({
          where: { teamId },
          attributes: ['workspaceId'],
          paranoid: false,
        });
        workspaceIds = workspaces.map((workspace) => workspace.workspaceId!);
      }
      const where = {
        status: 'ready',
        ...(scope === 'mine' ? { createdUserId: userId } : {}),
        ...(workspaceIds ? { workspaceId: { [Op.in]: workspaceIds } } : {}),
      };
      const rows = await findOrderedRows(versions, 'versionId', {
        where,
        attributes: [
          'versionId',
          'name',
          'target',
          'createdUserId',
          'creatorName',
          'createdAt',
          'sourceFileRevision',
          'validationSummary',
        ],
        order: [
          ['createdAt', 'DESC'],
          ['versionId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const coverFiles = rows.length
        ? await files.findAll({
            where: {
              versionId: { [Op.in]: rows.map((row) => row.versionId!) },
              kind: { [Op.in]: ['asset', 'attachment'] },
              path: { [Op.regexp]: workCoverPattern },
            },
            attributes: ['versionId', ...workCoverAttributes],
          })
        : [];
      return {
        rows: rows.map((row) => ({
          ...metadata(row, userId),
          coverUrl: workCoverUrl(coverFiles.filter((file) => file.versionId === row.versionId)),
        })),
        total: await versions.count({ where }),
        page,
        pageSize,
      };
    },
    /** 冻结文件保持独立，只为有源会话权限的用户提供来源跳转定位。 */
    async get(userId: string, versionId: string) {
      const row = await ready(userId, versionId);
      const rows = await findOrderedRows(files, 'pathHash', {
        where: { versionId },
        order: [['pathHash', 'ASC']],
      });
      return {
        ...metadata(row, userId),
        sourceSession: await sourceSession(row, userId),
        files: rows.filter((file) => file.kind !== 'internal').map(fileMetadata),
      };
    },
    /** 与预览创建共用版本锁；仅移除冻结行，不清理共享对象或源会话。 */
    async remove(userId: string, versionId: string) {
      requireIdentifier(userId);
      requireIdentifier(versionId);
      return mysql.transaction(async (transaction) => {
        const row = await versions.findOne({
          where: { versionId },
          attributes: ['versionId', 'createdUserId', 'status'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!row || !sameUser(row.createdUserId, userId))
          throw new SessionError(404, 'VERSION_NOT_FOUND', '暂存版本不存在');
        if (row.status !== 'ready')
          throw new SessionError(409, 'VERSION_NOT_READY', '仅可删除已完成的暂存版本');
        /** 删除登记预览，使旧固定链接及旧票据均无法再次读取。 */
        await (mysql.models.D2cPreview as typeof D2cPreview).destroy({
          where: { versionId },
          transaction,
        });
        await files.destroy({ where: { versionId }, transaction });
        const count = await versions.destroy({
          where: { versionId, status: 'ready' },
          transaction,
        });
        if (count !== 1)
          throw new SessionError(409, 'VERSION_CONFLICT', '暂存版本状态已变化，请刷新后重试');
        return { versionId, deleted: true as const };
      });
    },
    /** 源码只读展示，先校验冻结字节，不返回二进制定位和私有配置。 */
    async file(userId: string, versionId: string, pathHash: string) {
      await ready(userId, versionId);
      if (!/^[a-f0-9]{64}$/.test(pathHash))
        throw new SessionError(422, 'INVALID_FILE', '文件标识无效');
      const row = await contentModel(mysql, files).findOne({ where: { versionId, pathHash } });
      if (!row || row.kind !== 'source')
        throw new SessionError(404, 'VERSION_FILE_NOT_FOUND', '源码文件不存在');
      const info = fileMetadata(row);
      let content: string | null;
      try {
        /** Frozen references retain the originating scope; authorization is on the version. */
        content = await resolveTextContent(mysql, row);
        if (
          typeof content !== 'string' ||
          row.objectLocator !== null ||
          Buffer.byteLength(content) !== row.size ||
          createHash('sha256').update(content).digest('hex') !== row.sha256
        )
          throw new Error();
      } catch {
        throw new SessionError(503, 'VERSION_FILE_INVALID', '版本文件校验失败');
      }
      return { ...info, content };
    },
    /** 所有登录用户可下载固定 ZIP；源会话删除不影响版本定位。 */
    async archive(userId: string, versionId: string) {
      const row = await ready(userId, versionId);
      try {
        const content = await binary().downloadFile(row.archiveObject!);
        if (
          content.length !== row.archiveObject!.size ||
          createHash('sha256').update(content).digest('hex') !== row.archiveObject!.sha256
        )
          throw new Error();
        return { content, fileName: `pixelprint-${row.versionId}.zip` };
      } catch {
        throw new SessionError(503, 'VERSION_DOWNLOAD_FAILED', '版本包读取失败，请稍后重试');
      }
    },
  };
}
