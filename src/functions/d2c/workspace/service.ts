import { findOrderedPage } from '../utils/orderedRead';
import { randomUUID } from 'node:crypto';
import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { D2cWorkspace } from '@/models/D2cWorkspace';
import type { D2cWorkspaceRevision } from '@/models/D2cWorkspaceRevision';
import type { D2cSession } from '@/models/D2cSession';
import type { D2cRun } from '@/models/D2cRun';
import { ownedWorkspace, SessionError } from '../session/access';
import {
  normalizeUserId,
  requireTeamMember,
  sameUser,
  visibleWorkspaceWhere,
  type WorkspaceVisibility,
} from '../team/access';
import { parseWorkspaceConfigs } from '../utils/config';
import {
  readTemplateResources,
  validateResourceBundle,
  type ResourceBundle,
  type ResourceBundleStore,
} from './resources';

/** 路由根据稳定 reason 和 statusCode 返回统一错误，不泄露底层存储细节。 */
export class WorkspaceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceServiceOptions {
  templateRoot: string;
  resourceStore?: ResourceBundleStore;
}

/** 检查身份与业务标识，身份必须由服务端 账号认证 提供。 */
function identifier(value: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkspaceError(400, 'INVALID_IDENTIFIER', '用户身份或工作区标识无效');
  }
}

/** 工作区名称使用数据库可存储的非空文本。 */
function workspaceName(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WorkspaceError(400, 'INVALID_NAME', '工作区名称无效');
  }
  return value.trim();
}

/** 验证完整配置集并将校验错误映射为可识别的客户端错误。 */
function configs(value: unknown) {
  try {
    return structuredClone(parseWorkspaceConfigs(value));
  } catch {
    throw new WorkspaceError(422, 'INVALID_CONFIG', '工作区 H5/RN 配置无效');
  }
}

/**
 * 创建工作区业务服务，管理元数据、H5/RN 配置和固定资源修订。
 * MySQL 保存状态与定位，资源包由注入的持久存储保存；本方法不连接或建表。
 * @param mysql 已注册 D2C 模型的数据库连接。
 * @param options 平台模板目录及资源包存储实现。
 */
export function createWorkspaceService(mysql: Sequelize, options: WorkspaceServiceOptions) {
  const workspaces = mysql.models.D2cWorkspace as typeof D2cWorkspace;
  const revisions = mysql.models.D2cWorkspaceRevision as typeof D2cWorkspaceRevision;
  const sessions = mysql.models.D2cSession as typeof D2cSession;
  const runs = mysql.models.D2cRun as typeof D2cRun;
  if (!workspaces || !revisions || !sessions || !runs)
    throw new WorkspaceError(503, 'MODELS_UNAVAILABLE', '工作区模型尚未注册');

  /** 不用临时目录或伪造 URL 代替跨部署资源副本。 */
  function store() {
    if (!options.resourceStore)
      throw new WorkspaceError(503, 'RESOURCE_STORE_UNAVAILABLE', '工作区资源持久存储尚未接入');
    return options.resourceStore;
  }

  /** 平台发布资源不完整时明确失败，不以旧默认配置冒充新版。 */
  async function template() {
    try {
      return await readTemplateResources(options.templateRoot);
    } catch {
      throw new WorkspaceError(503, 'TEMPLATE_UNAVAILABLE', '平台模板资源不可用');
    }
  }

  /** 持久化后回读验证完整字节，资源保存过程不持有数据库事务。 */
  async function persist(bundle: ResourceBundle, workspaceId: string, resourceRevisionId: string) {
    const storage = store();
    try {
      const expectedHash = bundle.hash;
      const locator = await storage.save(structuredClone(bundle), {
        workspaceId,
        resourceRevisionId,
      });
      if (
        !locator ||
        typeof locator !== 'object' ||
        Array.isArray(locator) ||
        !Object.keys(locator).length
      )
        throw new Error('资源定位无效');
      const restored = validateResourceBundle(await storage.load(locator));
      if (restored.hash !== expectedHash) throw new Error('资源副本不一致');
      return locator;
    } catch {
      throw new WorkspaceError(503, 'RESOURCE_STORE_FAILED', '工作区资源保存或校验失败');
    }
  }

  /** 所有工作区服务复用会话授权入口，避免复制 owner 条件绕过团队授权。 */
  async function owned(userId: string, id: string, transaction?: Transaction) {
    identifier(userId);
    identifier(id);
    try {
      return await ownedWorkspace(mysql, userId, id, transaction);
    } catch (error) {
      if (error instanceof SessionError)
        throw new WorkspaceError(error.statusCode, error.reason, error.message);
      throw error;
    }
  }

  /** 分享只能由工作区原创建者调整，团队成员的共同编辑权不包含转移分享。 */
  function sharingOwner(row: D2cWorkspace, userId: string) {
    if (!sameUser(row.createdUserId, userId))
      throw new WorkspaceError(403, 'WORKSPACE_OWNER_REQUIRED', '仅工作区创建者可调整分享');
  }

  /** 准备或失败的工作区不能保存配置或发起资源更新。 */
  function ready(row: D2cWorkspace) {
    if (row.status !== 'ready' || !row.activeResourceRevisionId)
      throw new WorkspaceError(409, 'WORKSPACE_NOT_READY', '工作区尚未就绪');
  }

  /** CAS 修订为正整数，过期修订不能覆盖新编辑。 */
  function checkConfigRevision(row: D2cWorkspace, base: number) {
    if (!Number.isSafeInteger(base) || base < 1)
      throw new WorkspaceError(400, 'INVALID_REVISION', '配置修订无效');
    if (row.configRevision !== base)
      throw new WorkspaceError(409, 'CONFIG_CONFLICT', '工作区配置已更新，请重新读取');
    if (base >= 4294967295)
      throw new WorkspaceError(409, 'REVISION_EXHAUSTED', '配置修订已达到上限');
  }

  /** 仅返回工作区与当前资源元数据，不暴露存储定位或全部配置。 */
  function summary(row: D2cWorkspace, resource: D2cWorkspaceRevision | null, userId: string) {
    return {
      workspaceId: row.workspaceId,
      name: row.name,
      teamId: row.teamId || null,
      isOwner: sameUser(row.createdUserId, userId),
      createdUserId: row.createdUserId,
      creatorName: row.creatorName,
      status: row.status,
      activeResourceRevisionId: row.activeResourceRevisionId,
      configRevision: row.configRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resource: resource
        ? {
            resourceRevisionId: resource.resourceRevisionId,
            revision: resource.revision,
            sourceVersion: resource.sourceVersion,
            sourceCommit: resource.sourceCommit,
            bundleHash: resource.bundleHash,
            status: resource.status,
          }
        : null,
    };
  }

  /** 读取指定工作区内的资源修订，不能跨工作区借用默认配置。 */
  async function active(row: D2cWorkspace, transaction?: Transaction) {
    const revision = await revisions.findOne({
      where: { workspaceId: row.workspaceId, resourceRevisionId: row.activeResourceRevisionId },
      transaction,
    });
    if (!revision || revision.status !== 'ready')
      throw new WorkspaceError(503, 'RESOURCE_UNAVAILABLE', '工作区资源修订不可用');
    return revision;
  }

  /** 持有 workspace 锁时检查全部会话的旧轮次，暂停和等待输入也不算结束。 */
  async function noUnsettledRuns(row: D2cWorkspace, transaction: Transaction) {
    const children = await sessions.findAll({
      where: { workspaceId: row.workspaceId },
      attributes: ['sessionId', 'activeRunId'],
      paranoid: false,
      transaction,
    });
    if (children.some((session) => session.activeRunId))
      throw new WorkspaceError(409, 'UNSETTLED_RUNS', '请先完成或明确结束工作区内的所有轮次');
    const ids = children
      .map((session) => session.sessionId)
      .filter((id): id is string => Boolean(id));
    if (
      ids.length &&
      (await runs.count({
        where: {
          sessionId: { [Op.in]: ids },
          status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] },
        },
        transaction,
      }))
    ) {
      throw new WorkspaceError(409, 'UNSETTLED_RUNS', '请先完成或明确结束工作区内的所有轮次');
    }
  }

  return {
    /** 原创建者调整分享；事务前及锁内复查 owner，目标团队在写入前后复查成员资格。 */
    async setTeam(userId: string, id: string, teamId: string | null) {
      sharingOwner(await owned(userId, id), userId);
      if (teamId !== null) await requireTeamMember(mysql, userId, teamId);
      return mysql.transaction(async (transaction) => {
        const row = await owned(userId, id, transaction);
        sharingOwner(row, userId);
        if (teamId !== null) await requireTeamMember(mysql, userId, teamId, transaction);
        await row.update({ teamId }, { transaction });
        const confirmed = await owned(userId, id, transaction);
        sharingOwner(confirmed, userId);
        if (teamId !== null) await requireTeamMember(mysql, userId, teamId, transaction);
        return summary(
          confirmed,
          confirmed.activeResourceRevisionId ? await active(confirmed, transaction) : null,
          userId,
        );
      });
    },
    /** 工作区与其会话同事务软删除；源码、历史、版本和对象存储文件完整保留。 */
    async remove(userId: string, id: string) {
      return mysql.transaction(async (transaction) => {
        const row = await owned(userId, id, transaction);
        if (['preparing', 'updating'].includes(row.status))
          throw new WorkspaceError(409, 'WORKSPACE_BUSY', '工作区正在处理中，请稍后删除');
        await noUnsettledRuns(row, transaction);
        await sessions.destroy({ where: { workspaceId: id }, transaction });
        await row.destroy({ transaction });
        return { workspaceId: id, deleted: true };
      });
    },
    /**
     * 为用户创建拥有独立模板副本的工作区。
     * 先提交 preparing 记录，再在事务外上传并回读资源，最后短事务激活修订和默认配置。
     * 存储失败将准备记录标记 failed；不会以本地临时副本冒充创建成功。
     * @param owner 来自 账号认证 的用户身份及可选显示姓名。
     * @param name 用户填写的工作区名称。
     * @returns 不包含资源存储定位和配置正文的工作区摘要。
     */
    async create(
      owner: { userId: string; name?: string },
      name: string,
      teamId: string | null = null,
    ) {
      identifier(owner.userId);
      const cleanName = workspaceName(name);
      if (owner.name !== undefined && (typeof owner.name !== 'string' || owner.name.length > 100))
        throw new WorkspaceError(400, 'INVALID_OWNER', '用户姓名无效');
      const user = normalizeUserId(owner.userId);
      if (teamId !== null) await requireTeamMember(mysql, user, teamId);
      store();
      const bundle = await template();
      const workspaceId = randomUUID(),
        resourceRevisionId = randomUUID();
      /** 准备阶段先落库，跨服务上传期间不持续持有数据库锁。 */
      await mysql.transaction(async (transaction) => {
        if (teamId !== null) await requireTeamMember(mysql, user, teamId, transaction);
        await workspaces.create(
          {
            workspaceId,
            name: cleanName,
            createdUserId: user,
            teamId,
            creatorName: owner.name ?? null,
            status: 'preparing',
            activeResourceRevisionId: null,
            configRevision: 0,
            configJson: null,
          },
          { transaction },
        );
        await revisions.create(
          {
            workspaceId,
            resourceRevisionId,
            revision: 1,
            sourceVersion: bundle.sourceVersion,
            sourceCommit: bundle.sourceCommit,
            bundleHash: bundle.hash,
            bundleObject: null,
            defaultConfigs: bundle.defaultConfigs,
            status: 'preparing',
          },
          { transaction },
        );
      });
      try {
        /** 上传成功且回读摘要一致后，才允许把新副本设为当前资源。 */
        const locator = await persist(bundle, workspaceId, resourceRevisionId);
        return await mysql.transaction(async (transaction) => {
          const row = await owned(owner.userId, workspaceId, transaction);
          if (teamId !== null) await requireTeamMember(mysql, user, teamId, transaction);
          if (row.status !== 'preparing')
            throw new WorkspaceError(409, 'WORKSPACE_CONFLICT', '工作区状态已改变');
          await revisions.update(
            { status: 'ready', bundleObject: locator },
            { where: { workspaceId, resourceRevisionId, status: 'preparing' }, transaction },
          );
          await row.update(
            {
              status: 'ready',
              activeResourceRevisionId: resourceRevisionId,
              configRevision: 1,
              configJson: bundle.defaultConfigs,
            },
            { transaction },
          );
          return summary(row, await active(row, transaction), owner.userId);
        });
      } catch (error) {
        await mysql.transaction(async (transaction) => {
          const row = await owned(owner.userId, workspaceId, transaction);
          if (row.status === 'preparing') {
            await row.update({ status: 'failed' }, { transaction });
            await revisions.update(
              { status: 'failed' },
              { where: { workspaceId, resourceRevisionId, status: 'preparing' }, transaction },
            );
          }
        });
        throw error;
      }
    },

    /**
     * 分页列出本人创建或当前团队可访问的工作区，并附会话数量和最近创建会话的摘要。
     * 排序以创建时间和工作区 ID 稳定确定；响应不携带聊天、配置正文或对象定位。
     */
    async list(userId: string, page = 1, pageSize = 20, filter: WorkspaceVisibility = {}) {
      identifier(userId);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100 ||
        !Number.isSafeInteger((page - 1) * pageSize)
      )
        throw new WorkspaceError(400, 'INVALID_PAGE', '分页参数无效');
      const { rows, count } = await findOrderedPage(workspaces, 'workspaceId', {
        where: await visibleWorkspaceWhere(mysql, userId, filter),
        order: [
          ['createdAt', 'DESC'],
          ['workspaceId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const items = await Promise.all(
        rows.map(async (row) => {
          const [resource, sessionCount, latest] = await Promise.all([
            row.activeResourceRevisionId ? active(row) : null,
            sessions.count({ where: { workspaceId: row.workspaceId } }),
            sessions.findOne({
              where: { workspaceId: row.workspaceId },
              attributes: ['sessionId', 'name', 'target', 'activeRunId', 'updatedAt'],
              order: [
                ['createdAt', 'DESC'],
                ['sessionId', 'DESC'],
              ],
            }),
          ]);
          return {
            ...summary(row, resource, userId),
            sessionCount,
            latestSession: latest
              ? {
                  sessionId: latest.sessionId,
                  name: latest.name,
                  target: latest.target,
                  activeRunId: latest.activeRunId,
                  updatedAt: latest.updatedAt,
                }
              : null,
          };
        }),
      );
      return { items, total: count, page, pageSize };
    },

    /** 本人详情提供当前资源状态与配置修订。 */
    async get(userId: string, id: string) {
      const row = await owned(userId, id);
      return summary(row, row.activeResourceRevisionId ? await active(row) : null, userId);
    },

    /** 仅修改元数据，不影响任何已冻结执行快照。 */
    async rename(userId: string, id: string, name: string) {
      const cleanName = workspaceName(name);
      return mysql.transaction(async (transaction) => {
        const row = await owned(userId, id, transaction);
        await row.update({ name: cleanName }, { transaction });
        return summary(
          row,
          row.activeResourceRevisionId ? await active(row, transaction) : null,
          userId,
        );
      });
    },

    /** 返回独立复制的配置，调用方修改不能污染缓存或模型实例。 */
    async getConfig(userId: string, id: string) {
      const row = await owned(userId, id);
      ready(row);
      return { configRevision: row.configRevision, configs: configs(row.configJson) };
    },

    /**
     * 按配置修订保存完整 H5/RN 配置集，过期 baseRevision 返回冲突。
     * 更新仅影响后续入队快照，已入队或执行中的任务仍持有原配置。
     */
    async saveConfig(userId: string, id: string, baseRevision: number, value: unknown) {
      const validated = configs(value);
      return mysql.transaction(async (transaction) => {
        const row = await owned(userId, id, transaction);
        ready(row);
        checkConfigRevision(row, baseRevision);
        await row.update(
          { configRevision: baseRevision + 1, configJson: validated },
          { transaction },
        );
        return { configRevision: row.configRevision, configs: configs(row.configJson) };
      });
    },

    /** 仅重置指定目标，使用当前固定资源修订的默认配置而非最新发布模板。 */
    async resetConfig(userId: string, id: string, baseRevision: number, target: 'h5' | 'rn') {
      if (target !== 'h5' && target !== 'rn')
        throw new WorkspaceError(400, 'INVALID_TARGET', '目标必须为 h5 或 rn');
      return mysql.transaction(async (transaction) => {
        const row = await owned(userId, id, transaction);
        ready(row);
        checkConfigRevision(row, baseRevision);
        const defaults = configs((await active(row, transaction)).defaultConfigs);
        const current = configs(row.configJson);
        if (target === 'h5') current.h5 = defaults.h5;
        else current.rn = defaults.rn;
        await row.update(
          { configRevision: baseRevision + 1, configJson: current },
          { transaction },
        );
        return { configRevision: row.configRevision, configs: configs(row.configJson) };
      });
    },

    /** 比较发布包与固定资源包，返回配置兼容问题但不切换版本。 */
    async getTemplateUpdate(userId: string, id: string) {
      const row = await owned(userId, id);
      ready(row);
      const current = await active(row),
        latest = await template();
      const compatibilityIssues: string[] = [];
      try {
        configs(row.configJson);
      } catch {
        compatibilityIssues.push('当前工作区配置未通过 H5/RN 校验');
      }
      return {
        current: summary(row, current, userId).resource,
        latest: {
          sourceVersion: latest.sourceVersion,
          sourceCommit: latest.sourceCommit,
          bundleHash: latest.hash,
        },
        updateAvailable: current.bundleHash !== latest.hash,
        compatibilityIssues,
      };
    },

    /**
     * 将工作区显式升级到用户刚确认的平台资源包，保留工作区编辑后的配置。
     * 上传前检查旧修订和空闲状态，事务外复制资源，提交前再次锁行复查竞态。
     * @param baseResourceRevisionId 页面读取时的当前资源修订，用于检测并发升级。
     * @param expectedBundleHash 用户确认的新版摘要，平台模板再次变化时拒绝升级。
     * @returns 激活新资源后的工作区摘要；失败保持旧资源为当前版本。
     */
    async updateTemplate(
      userId: string,
      id: string,
      baseResourceRevisionId: string,
      expectedBundleHash: string,
    ) {
      identifier(baseResourceRevisionId);
      if (typeof expectedBundleHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBundleHash))
        throw new WorkspaceError(400, 'INVALID_HASH', '模板摘要无效');
      /** 上传前后均持有同一工作区行锁检查，入队服务必须遵循相同锁顺序。 */
      async function check(transaction: Transaction) {
        const row = await owned(userId, id, transaction);
        ready(row);
        if (row.activeResourceRevisionId !== baseResourceRevisionId)
          throw new WorkspaceError(409, 'RESOURCE_CONFLICT', '工作区资源已更新，请重新读取');
        await noUnsettledRuns(row, transaction);
        configs(row.configJson);
        return row;
      }
      await mysql.transaction(check);
      store();
      const bundle = await template();
      if (bundle.hash !== expectedBundleHash)
        throw new WorkspaceError(409, 'TEMPLATE_CONFLICT', '平台模板已改变，请重新确认');
      const resourceRevisionId = randomUUID();
      const locator = await persist(bundle, id, resourceRevisionId);
      return mysql.transaction(async (transaction) => {
        const row = await check(transaction);
        const previous = Number(
          (await revisions.max('revision', { where: { workspaceId: id }, transaction })) ?? 0,
        );
        if (!Number.isSafeInteger(previous) || previous < 1 || previous >= 4294967295)
          throw new WorkspaceError(409, 'REVISION_EXHAUSTED', '资源修订无效或达到上限');
        await revisions.create(
          {
            workspaceId: id,
            resourceRevisionId,
            revision: previous + 1,
            sourceVersion: bundle.sourceVersion,
            sourceCommit: bundle.sourceCommit,
            bundleHash: bundle.hash,
            bundleObject: locator,
            defaultConfigs: bundle.defaultConfigs,
            status: 'ready',
          },
          { transaction },
        );
        await row.update({ activeResourceRevisionId: resourceRevisionId }, { transaction });
        return summary(row, await active(row, transaction), userId);
      });
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
