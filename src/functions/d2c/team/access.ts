import { PUBLIC_TEAM_ID, PUBLIC_TEAM_NAME } from '../../../shared/publicTeam';
import { Op, col, fn, where, type Sequelize, type Transaction, type WhereOptions } from 'sequelize';
import type { D2cTeam } from '@/models/D2cTeam';
import type { D2cTeamMember } from '@/models/D2cTeamMember';

/** 团队接口及复用授权帮助统一使用稳定错误，不泄露数据库诊断。 */
export class TeamError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamError';
  }
}

/** 用户 ID 仅接受 ASCII 业务标识，去首尾空白后统一小写；账号认证 SDK 不作修改。 */
export function normalizeUserId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim()))
    throw new TeamError(422, 'INVALID_USER_ID', '用户 ID 无效');
  return value.trim().toLowerCase();
}

/** 历史 createdUserId 原样保留，权限比较与新成员存储采用相同的大小写规则。 */
export function sameUser(stored: string | null | undefined, userId: string): boolean {
  return typeof stored === 'string' && stored.trim().toLowerCase() === normalizeUserId(userId);
}

/** 团队 ID 不作大小写或空白转换，避免悄悄指向另一个业务标识。 */
export function requireTeamId(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
    throw new TeamError(422, 'INVALID_TEAM_ID', '团队标识无效');
}

/** 延迟获取团队模型；个人工作区访问无需注册或查询这两张模型。 */
export function teamModels(mysql: Sequelize) {
  const teams = mysql.models.D2cTeam as typeof D2cTeam;
  const members = mysql.models.D2cTeamMember as typeof D2cTeamMember;
  if (!teams || !members) throw new TeamError(503, 'TEAM_MODELS_UNAVAILABLE', '团队模型尚未注册');
  return { teams, members };
}

/**
 * 每次从数据库验证当前成员资格，成功返回团队行，非成员或团队不存在统一 404。
 * 写事务先锁工作区再调用本帮助；帮助按团队→成员锁序与增删成员串行化。
 * 不缓存 membership；事务外读取只核对当前请求，不承诺撤销已在途请求。
 * read 模式沿用调用方只读快照，不取得团队/成员 UPDATE 锁。
 */
export async function requireTeamMember(
  mysql: Sequelize,
  userId: string,
  teamId: string,
  transaction?: Transaction,
  mode: 'read' | 'write' = 'write',
) {
  const user = normalizeUserId(userId);
  requireTeamId(teamId);
  if (teamId === PUBLIC_TEAM_ID)
    return {
      teamId: PUBLIC_TEAM_ID,
      name: PUBLIC_TEAM_NAME,
      createdUserId: '',
      creatorName: null,
    } as D2cTeam;
  const { teams, members } = teamModels(mysql);
  const lock = transaction && mode === 'write' ? { lock: transaction.LOCK.UPDATE } : {};
  const team = await teams.findOne({ where: { teamId }, transaction, ...lock });
  if (team?.teamId === teamId) {
    const member = await members.findOne({
      where: { teamId, userId: user },
      transaction,
      ...lock,
    });
    if (member?.teamId === teamId && member.userId === user) return team;
  }
  throw new TeamError(404, 'TEAM_NOT_FOUND', '团队不存在或无权访问');
}

export interface WorkspaceVisibility {
  scope?: 'personal';
  teamId?: string;
}

/**
 * 返回可直接与其他业务条件用 Op.and 合并的工作区 where。
 * 创建者查询与详情统一按去空白、小写账号比较，兼容旧表的大小写敏感排序。
 * 默认本人创建 OR 当前所属团队；personal 仅本人且无团队，兼容历史空字符串；teamId 先验证成员。
 * 没有团队模型的旧个人测试/调用方仍可查询个人归属；团队查询始终失败关闭。
 */
export async function visibleWorkspaceWhere(
  mysql: Sequelize,
  userId: string,
  filter: WorkspaceVisibility = {},
  transaction?: Transaction,
): Promise<WhereOptions> {
  const user = normalizeUserId(userId);
  const owner = where(fn('LOWER', fn('TRIM', col('createdUserId'))), user);
  if (filter.scope && filter.scope !== 'personal')
    throw new TeamError(422, 'INVALID_SCOPE', '工作区范围无效');
  if (filter.scope && filter.teamId !== undefined)
    throw new TeamError(422, 'INVALID_SCOPE', '个人范围不能同时指定团队');
  if (filter.teamId !== undefined) {
    await requireTeamMember(mysql, user, filter.teamId, transaction);
    return { teamId: filter.teamId };
  }
  if (filter.scope === 'personal')
    return { [Op.and]: [owner, { [Op.or]: [{ teamId: null }, { teamId: '' }] }] };
  if (!mysql.models.D2cTeam && !mysql.models.D2cTeamMember)
    return { [Op.or]: [owner, { teamId: PUBLIC_TEAM_ID }] };
  const { members } = teamModels(mysql);
  const rows = await members.findAll({
    where: { userId: user },
    attributes: ['teamId'],
    transaction,
  });
  const ids = [
    ...new Set([
      PUBLIC_TEAM_ID,
      ...rows.map((row) => row.teamId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  return ids.length ? { [Op.or]: [owner, { teamId: { [Op.in]: ids } }] } : { [Op.and]: [owner] };
}
