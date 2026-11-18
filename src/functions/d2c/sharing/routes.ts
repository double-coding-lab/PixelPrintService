import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import { SessionError } from '../session/access';
import { checkWriteRequest } from '../utils/request';
import type { EditService } from '../edit/service';
import type { createSharingService } from './service';
import type { createSavedWorkService } from '../savedWork/service';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const parameters = z.object({ id: identifier, editId: identifier });
const revision = z.number().int().min(1).max(4294967294);
const entryPath = z.string().min(1).max(1024).optional();
const cursor = z.coerce.number().int().min(0).max(4294967294);
const paging = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
const timelineQuery = z.object({
  afterSeq: cursor.default(0),
  beforeSeq: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

type Sharing = ReturnType<typeof createSharingService>;
type Works = ReturnType<typeof createSavedWorkService>;
type Services = {
  sharing: () => Promise<Sharing>;
  works: () => Promise<Works>;
  plazaEditor: () => Promise<EditService>;
  workEditor: () => Promise<EditService>;
};

/** 登录继承 D2C 模块；写请求同源，公开授权与个人归属均在服务层逐次复查。 */
export default async function sharingRoutes(app: FastifyInstance, options: Partial<Services> = {}) {
  const services: Services = {
    sharing: options.sharing ?? (() => app.getSharingService()),
    works: options.works ?? (() => app.getSavedWorkService()),
    plazaEditor: options.plazaEditor ?? (() => app.getPlazaEditService()),
    workEditor: options.workEditor ?? (() => app.getSavedWorkEditService()),
  };
  app.addHook('onRoute', (route) => {
    route.config = { ...route.config, privatePayload: true };
  });
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!(await request.getUser())?.userId)
      throw new SessionError(401, 'LOGIN_REQUIRED', '请先登录');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !checkWriteRequest(request))
      throw new SessionError(403, 'CROSS_SITE_REQUEST', '请通过同源页面提交请求');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof SessionError ? error.statusCode : error instanceof z.ZodError ? 422 : 503;
    return reply.code(status).send(
      responseData.error({
        message:
          error instanceof SessionError
            ? error.message
            : status === 422
              ? '请求参数无效'
              : '作品服务暂不可用',
        data: {
          reason:
            error instanceof SessionError
              ? error.reason
              : status === 422
                ? 'INVALID_INPUT'
                : 'SHARING_UNAVAILABLE',
        },
      }),
    );
  });
  app.get('/sessions/:id/sharing', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    return responseData.success({
      data: await (await services.sharing()).status((await request.getUser()).userId, id),
    });
  });
  app.put('/sessions/:id/sharing', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    const input = z.object({ public: z.boolean() }).strict().parse(request.body);
    return responseData.success({
      data: await (
        await services.sharing()
      ).set((await request.getUser()).userId, id, input.public),
    });
  });
  app.get('/plaza/sessions', async (request) => {
    const { page, pageSize } = paging.parse(request.query);
    return responseData.success({
      data: await (await services.sharing()).list((await request.getUser()).userId, page, pageSize),
    });
  });
  app.get('/plaza/sessions/:id', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    return responseData.success({
      data: await (await services.sharing()).get((await request.getUser()).userId, id),
    });
  });
  app.get('/plaza/sessions/:id/usage', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    return responseData.success({
      data: await (await services.sharing()).usage((await request.getUser()).userId, id),
    });
  });
  app.get('/plaza/sessions/:id/timeline', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    const { afterSeq, beforeSeq, limit } = timelineQuery.parse(request.query);
    return responseData.success({
      data: await (
        await services.sharing()
      ).timeline((await request.getUser()).userId, id, afterSeq, limit, beforeSeq),
    });
  });
  app.get('/plaza/sessions/:id/subagents/:agentId/events', async (request) => {
    const { id, agentId } = z
      .object({ id: identifier, agentId: z.string().uuid() })
      .parse(request.params);
    const { afterSeq, limit } = timelineQuery.parse(request.query);
    return responseData.success({
      data: await (
        await services.sharing()
      ).timeline((await request.getUser()).userId, id, afterSeq, limit, undefined, agentId),
    });
  });
  app.get('/plaza/sessions/:id/files', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    return responseData.success({
      data: await (await services.sharing()).files((await request.getUser()).userId, id),
    });
  });
  app.get('/plaza/sessions/:id/files/:fileId', async (request, reply) => {
    const { id, fileId } = z.object({ id: identifier, fileId: identifier }).parse(request.params);
    const file = await (
      await services.sharing()
    ).file((await request.getUser()).userId, id, fileId);
    if ('data' in file && Buffer.isBuffer(file.data))
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Content-Disposition', 'inline')
        .type(file.mimeType ?? 'application/octet-stream')
        .send(file.data);
    return responseData.success({ data: file });
  });
  app.get('/plaza/sessions/:id/attachments/:attachmentId', async (request, reply) => {
    const { id, attachmentId } = z
      .object({ id: identifier, attachmentId: identifier })
      .parse(request.params);
    const file = await (
      await services.sharing()
    ).attachment((await request.getUser()).userId, id, attachmentId);
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .type(file.mimeType)
      .send(file.data);
  });
  app.get('/my-works', async (request) => {
    const { page, pageSize } = paging.parse(request.query);
    return responseData.success({
      data: await (await services.works()).list((await request.getUser()).userId, page, pageSize),
    });
  });
  app.get('/my-works/:id', async (request) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    return responseData.success({
      data: await (await services.works()).get((await request.getUser()).userId, id),
    });
  });
  app.get('/my-works/:id/archive', async (request, reply) => {
    const { id } = parameters.omit({ editId: true }).parse(request.params);
    const archive = await (await services.works()).archive((await request.getUser()).userId, id);
    return reply
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(archive.fileName)}"`,
      )
      .type('application/zip')
      .send(archive.data);
  });
  /** 两种副本复用相同编辑契约，服务端没有注册原工作区 apply 路由。 */
  for (const [root, editor, ownWork] of [
    ['/plaza/sessions/:id/edit', services.plazaEditor, false],
    ['/my-works/:id/edit', services.workEditor, true],
  ] as const) {
    app.post(root, async (request, reply) => {
      const { id } = parameters.omit({ editId: true }).parse(request.params);
      const input = z
        .object({ entryPath })
        .strict()
        .parse(request.body ?? {});
      return reply.code(201).send(
        responseData.success({
          data: await (await editor()).create((await request.getUser()).userId, id, input),
        }),
      );
    });
    app.get(`${root}/:editId`, async (request) => {
      const { id, editId } = parameters.parse(request.params);
      return responseData.success({
        data: await (await editor()).get((await request.getUser()).userId, id, editId),
      });
    });
    app.put(`${root}/:editId`, { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
      const { id, editId } = parameters.parse(request.params);
      const input = z
        .object({
          baseRevision: revision,
          files: z.array(
            z.object({ path: z.string().min(1).max(1024), content: z.string() }).strict(),
          ),
          entryPath,
        })
        .strict()
        .parse(request.body);
      return responseData.success({
        data: await (await editor()).save((await request.getUser()).userId, id, editId, input),
      });
    });
    app.delete(`${root}/:editId`, async (request) => {
      const { id, editId } = parameters.parse(request.params);
      return responseData.success({
        data: await (await editor()).remove((await request.getUser()).userId, id, editId),
      });
    });
    app.post(`${root}/:editId/save`, async (request) => {
      const { id, editId } = parameters.parse(request.params);
      const { baseRevision, name } = z
        .object({ baseRevision: revision, name: z.string().trim().min(1).max(200).optional() })
        .strict()
        .parse(request.body);
      const eid = (await request.getUser()).userId;
      const editService = await editor();
      const draft = await editService.exportSnapshot(eid, id, editId, baseRevision);
      const work = await (
        await services.works()
      ).save(eid, {
        draft,
        name,
        ...(ownWork ? { workId: id, expectedRevision: draft.baseFileRevision } : {}),
      });
      /** 持久保存幂等后推进副本基线；重试可补做 Redis 确认，后续编辑不误报冲突。 */
      if (ownWork) await editService.advanceBaseline(eid, id, editId, baseRevision, work.revision);
      return responseData.success({ data: work });
    });
    app.get(`${root}/:editId/download`, async (request, reply) => {
      const { id, editId } = parameters.parse(request.params);
      const eid = (await request.getUser()).userId;
      const service = await editor();
      const current = await service.get(eid, id, editId);
      const draft = await service.exportSnapshot(eid, id, editId, current.revision);
      const archive = await (await services.works()).archiveDraft(draft);
      return reply
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(archive.fileName)}"`,
        )
        .type('application/zip')
        .send(archive.data);
    });
  }
}
