import { randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cTeam } from '@/models/D2cTeam';
import { normalizeUserId, requireTeamMember, sameUser, teamModels, TeamError } from './access';

/** 校验团队名称，不将空白或控制字符存为可展示名称。 */
function teamName(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TeamError(422, 'INVALID_TEAM_NAME', '团队名称无效');
  return value.trim();
}

/** 团队服务只操作已注册模型；仅创建者管理成员，不修改 账号认证 或执行 DDL。 */
export function createTeamService(mysql: Sequelize) {
  const { teams, members } = teamModels(mysql);

  /** 管理入口统一复用当前 membership 校验，普通成员明确返回禁止管理。 */
  async function managed(userId: string, id: string, transaction: Transaction) {
    const row = await requireTeamMember(mysql, userId, id, transaction);
    if (!sameUser(row.createdUserId, userId))
      throw new TeamError(403, 'TEAM_OWNER_REQUIRED', '仅团队创建者可管理成员');
    return row;
  }

  /** 只返回团队公开摘要，成员数量在当前事务中统计。 */
  async function summary(row: D2cTeam, userId: string, transaction?: Transaction) {
    return {
      teamId: row.teamId,
      name: row.name,
      createdUserId: row.createdUserId,
      creatorName: row.creatorName,
      isOwner: sameUser(row.createdUserId, userId),
      memberCount: await members.count({ where: { teamId: row.teamId }, transaction }),
    };
  }

  /** 详情以创建者派生 owner 角色，成员表不接受客户端角色输入。 */
  async function detail(row: D2cTeam, userId: string, transaction?: Transaction) {
    const rows = await members.findAll({
      where: { teamId: row.teamId },
      order: [['userId', 'ASC']],
      transaction,
    });
    return {
      ...(await summary(row, userId, transaction)),
      members: rows.map((member) => ({
        userId: member.userId,
        role: sameUser(row.createdUserId, member.userId) ? ('owner' as const) : ('member' as const),
      })),
    };
  }

  return {
    /** 原子创建团队与创建者成员记录；业务 ID 和成员 userId 均由服务端确定。 */
    async create(owner: { userId: string; name?: string }, name: string) {
      const userId = normalizeUserId(owner.userId),
        cleanName = teamName(name);
      if (
        owner.name !== undefined &&
        (typeof owner.name !== 'string' ||
          owner.name.length > 100 ||
          /[\u0000-\u001f\u007f]/u.test(owner.name))
      )
        throw new TeamError(422, 'INVALID_CREATOR_NAME', '创建者姓名无效');
      return mysql.transaction(async (transaction) => {
        const teamId = randomUUID();
        const row = await teams.create(
          { teamId, name: cleanName, createdUserId: userId, creatorName: owner.name ?? null },
          { transaction },
        );
        await members.create({ teamId, userId }, { transaction });
        return summary(row, userId, transaction);
      });
    },
    /** 分页列出本人当前所属团队，响应路由映射顶层 rows/total。 */
    async list(userId: string, page = 1, pageSize = 100) {
      const user = normalizeUserId(userId);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100 ||
        !Number.isSafeInteger((page - 1) * pageSize)
      )
        throw new TeamError(422, 'INVALID_PAGE', '分页参数无效');
      const memberships = await members.findAll({
        where: { userId: user },
        attributes: ['teamId'],
      });
      const { rows, count } = await teams.findAndCountAll({
        where: { teamId: { [Op.in]: memberships.map((row) => row.teamId) } },
        order: [
          ['createdAt', 'DESC'],
          ['teamId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { rows: await Promise.all(rows.map((row) => summary(row, user))), total: count };
    },
    /** 详情只对当前成员开放，包含 userId 和派生角色。 */
    async get(userId: string, id: string) {
      return detail(await requireTeamMember(mysql, userId, id), userId);
    },
    /** 团队锁内幂等添加成员，数据库唯一键阻止重复 teamId/userId。 */
    async addMember(userId: string, id: string, target: string) {
      const user = normalizeUserId(target);
      return mysql.transaction(async (transaction) => {
        const row = await managed(userId, id, transaction);
        if (
          !(await members.findOne({
            where: { teamId: id, userId: user },
            transaction,
            lock: transaction.LOCK.UPDATE,
          }))
        )
          await members.create({ teamId: id, userId: user }, { transaction });
        return detail(row, userId, transaction);
      });
    },
    /** 仅创建者可移除成员；禁止移除创建者，包括大小写不同的同一 userId。 */
    async removeMember(userId: string, id: string, target: string) {
      const user = normalizeUserId(target);
      return mysql.transaction(async (transaction) => {
        const row = await managed(userId, id, transaction);
        if (sameUser(row.createdUserId, user))
          throw new TeamError(409, 'TEAM_OWNER_CANNOT_BE_REMOVED', '不能移除团队创建者');
        await members.destroy({ where: { teamId: id, userId: user }, transaction });
        return detail(row, userId, transaction);
      });
    },
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
