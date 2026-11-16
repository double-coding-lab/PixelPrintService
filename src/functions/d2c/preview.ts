import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import type { PreviewService } from './preview/service';

/** 预览控制接口继承会话插件的账号认证、同源与私有日志约束。 */
export default async function previewRoutes(
  app: FastifyInstance,
  options: { service: () => Promise<PreviewService> },
) {
  for (const method of ['get', 'post'] as const) {
    app[method]('/sessions/:id/previews', async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      const inputSchema = z
        .object({
          entryPath: z.string().min(1).max(1024).optional(),
          ...(method === 'post' ? { retry: z.boolean().optional() } : {}),
        })
        .strict();
      const input = inputSchema.parse((method === 'get' ? request.query : request.body) ?? {});
      const { entryPath } = input;
      const service = await options.service();
      const userId = (await request.getUser()).userId;
      const data =
        method === 'get'
          ? await service.existingSession(userId, id, entryPath)
          : await service.createSession(
              userId,
              id,
              entryPath,
              'retry' in input && input.retry === true,
            );
      return reply.code(method === 'post' ? 202 : 200).send(responseData.success({ data }));
    });
  }
  app.get('/versions/:versionId/previews', async (request) => {
    const { versionId } = z.object({ versionId: z.string().min(1).max(64) }).parse(request.params);
    const { entryPath } = z
      .object({ entryPath: z.string().min(1).max(1024) })
      .strict()
      .parse(request.query);
    return responseData.success({
      data: await (
        await options.service()
      ).existing((await request.getUser()).userId, versionId, entryPath),
    });
  });
  app.post('/versions/:versionId/previews', async (request, reply) => {
    const { versionId } = z.object({ versionId: z.string().min(1).max(64) }).parse(request.params);
    const { entryPath } = z
      .object({ entryPath: z.string().min(1).max(1024) })
      .strict()
      .parse(request.body);
    return reply.code(202).send(
      responseData.success({
        data: await (
          await options.service()
        ).create((await request.getUser()).userId, versionId, entryPath),
      }),
    );
  });
  app.get('/previews/:previewId', async (request) => {
    const { previewId } = z.object({ previewId: z.string().min(1).max(64) }).parse(request.params);
    return responseData.success({
      data: await (await options.service()).get((await request.getUser()).userId, previewId),
    });
  });
  app.post('/previews/:previewId/ticket', async (request) => {
    const { previewId } = z.object({ previewId: z.string().min(1).max(64) }).parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return responseData.success({
      data: await (await options.service()).ticket((await request.getUser()).userId, previewId),
    });
  });
}
