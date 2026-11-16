import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import type { VersionService } from './version/service';

const params = z.object({ id: z.string().min(1).max(64) });

/** 版本接口继承会话插件的登录、同源、日志隐私与统一错误处理。 */
export default async function versionRoutes(
  app: FastifyInstance,
  options: { service: () => Promise<VersionService> },
) {
  /** 运行中也可冻结当前已保存文件；可选基础修订用于严格核对，后台打包重试沿用原请求ID。 */
  app.post('/sessions/:id/versions', async (request, reply) => {
    const { id } = params.parse(request.params);
    const input = z
      .object({
        clientRequestId: z.string().min(1).max(64),
        name: z.string().trim().max(200).optional(),
        baseFileRevision: z.number().int().min(0).max(4294967294).optional(),
      })
      .strict()
      .parse(request.body);
    return reply.code(202).send(
      responseData.success({
        data: await (await options.service()).enqueue((await request.getUser()).userId, id, input),
      }),
    );
  });
  /** 查询当前会话版本及失败快照，供查看、下载和手动重试。 */
  app.get('/sessions/:id/versions', async (request) => {
    const { id } = params.parse(request.params);
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(10),
      })
      .parse(request.query);
    return responseData.success({
      data: await (
        await options.service()
      ).list((await request.getUser()).userId, id, page, pageSize),
    });
  });
  /** 返回已保存的固定ZIP附件，不从当前会话文件重新生成。 */
  app.get('/sessions/:id/versions/:versionId/archive', async (request, reply) => {
    const { id, versionId } = params
      .extend({ versionId: z.string().min(1).max(64) })
      .parse(request.params);
    const result = await (
      await options.service()
    ).archive((await request.getUser()).userId, id, versionId);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .send(result.content);
  });
  /** 独立作品列表仅展示ready版本，不以源会话是否存在决定可见性。 */
  app.get('/versions', async (request) => {
    const query = z
      .object({
        scope: z.enum(['mine', 'all', 'team']).default('mine'),
        teamId: z.string().min(1).max(64).optional(),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(12),
      })
      .refine((query) => query.scope !== 'team' || query.teamId !== undefined, {
        path: ['teamId'],
        message: '团队范围必须指定 teamId',
      })
      .parse(request.query);
    return responseData.success({
      data: await (
        await options.service()
      ).gallery.list(
        (await request.getUser()).userId,
        query.scope,
        query.page,
        query.pageSize,
        query.teamId,
      ),
    });
  });
  /** 共享版本详情不返回私有配置和对话。 */
  app.get('/versions/:versionId', async (request) => {
    const { versionId } = z.object({ versionId: z.string().min(1).max(64) }).parse(request.params);
    return responseData.success({
      data: await (
        await options.service()
      ).gallery.get((await request.getUser()).userId, versionId),
    });
  });
  /** 共享冻结源码，通过文件摘要键读取并校验完整正文。 */
  app.get('/versions/:versionId/files/:fileId', async (request) => {
    const { versionId, fileId } = z
      .object({ versionId: z.string().min(1).max(64), fileId: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.params);
    return responseData.success({
      data: await (
        await options.service()
      ).gallery.file((await request.getUser()).userId, versionId, fileId),
    });
  });
  /** 固定版本下载不需要原工作区和会话。 */
  app.get('/versions/:versionId/archive', async (request, reply) => {
    const { versionId } = z.object({ versionId: z.string().min(1).max(64) }).parse(request.params);
    const result = await (
      await options.service()
    ).gallery.archive((await request.getUser()).userId, versionId);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .send(result.content);
  });
}
