import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import { checkWriteRequest } from './utils/request';
import { TeamError } from './team/access';
import { createTeamService, type TeamService } from './team/service';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const params = z.object({ id });

/** 注册团队路由；复用请求 账号认证 和同源写入校验，不修改 SDK，也不注册主入口。 */
export default async function teamRoutes(
  app: FastifyInstance,
  options: { teamService?: TeamService },
) {
  const service = options.teamService ?? createTeamService(app.mysql);
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await request.getUser())?.userId)
      return reply.code(401).send(responseData.error({ message: '登录失效' }));
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !checkWriteRequest(request))
      return reply.code(403).send(
        responseData.error({
          message: '请通过同源页面提交请求',
          data: { reason: 'CROSS_SITE_REQUEST' },
        }),
      );
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof TeamError
        ? error.statusCode
        : error instanceof z.ZodError
          ? 422
          : error instanceof Error && 'statusCode' in error && error.statusCode === 401
            ? 401
            : 503;
    return reply.code(status).send(
      responseData.error({
        message:
          error instanceof TeamError
            ? error.message
            : status === 422
              ? '请求参数无效'
              : status === 401
                ? '登录失效'
                : '团队操作失败',
        data: {
          reason:
            error instanceof TeamError
              ? error.reason
              : status === 422
                ? 'INVALID_INPUT'
                : status === 401
                  ? 'LOGIN_REQUIRED'
                  : 'TEAM_UNAVAILABLE',
        },
      }),
    );
  });
  /** GET /teams：分页返回当前所属团队，rows/total 位于响应顶层。 */
  app.get('/teams', async (request) => {
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(100),
      })
      .parse(request.query);
    const result = await service.list((await request.getUser()).userId, page, pageSize);
    return responseData.pagination(result);
  });
  /** POST /teams：创建者使用服务端 账号认证，客户端仅可传团队名称。 */
  app.post('/teams', async (request, reply) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .parse(request.body);
    const user = await request.getUser();
    const display = user as unknown as { name?: string; cname?: string };
    return reply.code(201).send(
      responseData.success({
        data: await service.create(
          { userId: user.userId, name: display.name ?? display.cname },
          name,
        ),
      }),
    );
  });
  /** GET /teams/:id：当前成员读取团队摘要与成员角色。 */
  app.get('/teams/:id', async (request) => {
    const { id } = params.parse(request.params);
    return responseData.success({ data: await service.get((await request.getUser()).userId, id) });
  });
  /** POST /teams/:id/members：仅创建者可按 userId 添加成员，重复添加幂等。 */
  app.post('/teams/:id/members', async (request) => {
    const { id } = params.parse(request.params);
    const { userId } = z
      .object({ userId: z.string().trim().min(1).max(64) })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.addMember((await request.getUser()).userId, id, userId),
    });
  });
  /** DELETE /teams/:id/members/:userId：仅创建者管理，不能移除自己。 */
  app.delete('/teams/:id/members/:userId', async (request) => {
    const { id, userId } = params
      .extend({ userId: z.string().min(1).max(64) })
      .parse(request.params);
    return responseData.success({
      data: await service.removeMember((await request.getUser()).userId, id, userId),
    });
  });
}
