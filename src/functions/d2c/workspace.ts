import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import { createWorkspaceService, WorkspaceError, type WorkspaceService } from './workspace/service';
import { TeamError } from './team/access';
import { checkWriteRequest } from './utils/request';
import { createStorageFileClient } from '@/hooks/tools/storage';
import { createStorageResourceStore } from './workspace/storage';

const id = z.string().min(1).max(64);
const paramsSchema = z.object({ id });
const nameSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const createSchema = nameSchema.extend({ teamId: id.nullable().optional() });
const revision = z.number().int().min(1).max(4294967294);
const pageSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    scope: z.literal('personal').optional(),
    teamId: id.optional(),
  })
  .refine((value) => !(value.scope && value.teamId !== undefined));

/**
 * 注册工作区、配置与模板资源接口，使用服务端用户 userId 传递归属。
 * preHandler 禁用响应缓存、检查登录及写请求的同源标记；错误处理器映射服务错误、
 * 参数错误（422）和未知故障（503）。配置与模板写入分别传递基础修订用于冲突检查。
 * 可注入工作区服务；默认装配 MySQL 与 Storage 资源存储。
 */
export default async function workspaceRoutes(
  app: FastifyInstance,
  options: { templateRoot: string; environment: string; workspaceService?: WorkspaceService },
) {
  const service =
    options.workspaceService ??
    createWorkspaceService(app.mysql, {
      templateRoot: options.templateRoot,
      resourceStore: createStorageResourceStore(
        createStorageFileClient(() => app.runtimeConfig.get(), options.environment),
      ),
    });
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await request.getUser())?.userId)
      return reply.code(401).send(responseData.error({ message: '登录失效' }));
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !checkWriteRequest(request)
    ) {
      return reply.code(403).send(
        responseData.error({
          message: '请通过同源页面提交请求',
          data: { reason: 'CROSS_SITE_REQUEST' },
        }),
      );
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof WorkspaceError || error instanceof TeamError
        ? error.statusCode
        : error instanceof z.ZodError
          ? 422
          : error instanceof Error && 'statusCode' in error && error.statusCode === 401
            ? 401
            : 503;
    const message =
      error instanceof WorkspaceError || error instanceof TeamError
        ? error.message
        : status === 422
          ? '请求参数无效'
          : status === 401
            ? '登录失效'
            : '工作区操作失败';
    const reason =
      error instanceof WorkspaceError || error instanceof TeamError
        ? error.reason
        : status === 422
          ? 'INVALID_INPUT'
          : status === 401
            ? 'LOGIN_REQUIRED'
            : 'WORKSPACE_UNAVAILABLE';
    return reply.code(status).send(responseData.error({ message, data: { reason } }));
  });

  /**
   * POST /workspaces：以当前用户归属创建工作区，返回 202 和服务结果。
   * 请求体仅接受去除首尾空白后 1～200 字符的 name；等待服务保存并激活资源后返回，不启动模型。
   */
  app.post('/workspaces', async (request, reply) => {
    const user = await request.getUser();
    const { name, teamId } = createSchema.parse(request.body);
    const display = user as unknown as { name?: string; cname?: string };
    const owner = {
      userId: user.userId,
      ...((display.name ?? display.cname) ? { name: display.name ?? display.cname } : {}),
    };
    const result =
      teamId === undefined
        ? await service.create(owner, name)
        : await service.create(owner, name, teamId);
    return reply.code(202).send(responseData.success({ data: result }));
  });
  /**
   * GET /workspaces：分页查询当前用户的工作区，返回 rows/total。
   * 查询 page 默认 1、上限 1000000，pageSize 默认 20、上限 100。
   */
  app.get('/workspaces', async (request) => {
    const user = await request.getUser();
    const { page, pageSize, scope, teamId } = pageSchema.parse(request.query);
    const result =
      scope === undefined && teamId === undefined
        ? await service.list(user.userId, page, pageSize)
        : await service.list(user.userId, page, pageSize, { scope, teamId });
    return responseData.pagination({ rows: result.items, total: result.total });
  });
  /**
   * GET /workspaces/:id：按 1～64 字符的 id 获取工作区详情。
   * 服务使用当前用户 userId 校验归属，客户端不提供 ownerUserId。
   */
  app.get('/workspaces/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return responseData.success({ data: await service.get((await request.getUser()).userId, id) });
  });
  /** PUT /workspaces/:id/team：仅原创建者调整团队分享，NULL 恢复个人工作区。 */
  app.put('/workspaces/:id/team', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { teamId } = z
      .object({ teamId: z.string().min(1).max(64).nullable() })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.setTeam((await request.getUser()).userId, id, teamId),
    });
  });
  /**
   * DELETE /workspaces/:id：请求软删除当前用户的工作区，底层数据保留。
   * 路径 id 必填，服务决定当前状态是否允许删除；成功返回删除结果。
   */
  app.delete('/workspaces/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return responseData.success({
      message: '工作区已删除，数据保留',
      data: await service.remove((await request.getUser()).userId, id),
    });
  });
  /**
   * PATCH /workspaces/:id：重命名当前用户的工作区。
   * 请求体仅接受去除首尾空白后 1～200 字符的 name；此接口不接收配置或资源修订。
   */
  app.patch('/workspaces/:id', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { name } = nameSchema.parse(request.body);
    return responseData.success({
      data: await service.rename((await request.getUser()).userId, id, name),
    });
  });
  /**
   * GET /workspaces/:id/config：读取当前用户工作区的配置，由服务校验归属。
   * 仅接收路径 id，返回服务提供的配置及修订信息供后续写入使用。
   */
  app.get('/workspaces/:id/config', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return responseData.success({
      data: await service.getConfig((await request.getUser()).userId, id),
    });
  });
  /**
   * PUT /workspaces/:id/config：保存当前用户工作区的配置。
   * 请求体仅接受 baseRevision（1～4294967294）与 configs；配置结构及修订冲突由服务校验。
   */
  app.put('/workspaces/:id/config', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { baseRevision, configs } = z
      .object({ baseRevision: revision, configs: z.unknown() })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.saveConfig((await request.getUser()).userId, id, baseRevision, configs),
    });
  });
  /**
   * POST /workspaces/:id/config/reset：重置当前用户工作区指定目标的配置。
   * 请求体仅接受 baseRevision（正整数修订）与 target（h5/rn），服务检查基础修订。
   */
  app.post('/workspaces/:id/config/reset', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { baseRevision, target } = z
      .object({ baseRevision: revision, target: z.enum(['h5', 'rn']) })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.resetConfig((await request.getUser()).userId, id, baseRevision, target),
    });
  });
  /**
   * GET /workspaces/:id/template-update：查询当前用户工作区的模板更新信息。
   * 仅接收路径 id；查询本身不调用模板升级操作。
   */
  app.get('/workspaces/:id/template-update', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return responseData.success({
      data: await service.getTemplateUpdate((await request.getUser()).userId, id),
    });
  });
  /**
   * POST /workspaces/:id/template-update：请求升级当前用户工作区的模板资源。
   * 仅接受 baseResourceRevisionId（1～64 字符）与 expectedBundleHash（64 位小写十六进制）；
   * 交由服务核对基础资源修订和预期资源包摘要，避免按过期更新信息写入。
   */
  app.post('/workspaces/:id/template-update', async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const { baseResourceRevisionId, expectedBundleHash } = z
      .object({
        baseResourceRevisionId: z.string().min(1).max(64),
        expectedBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.updateTemplate(
        (await request.getUser()).userId,
        id,
        baseResourceRevisionId,
        expectedBundleHash,
      ),
    });
  });
}
