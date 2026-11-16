import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import type { FileService } from './files/service';

const params = z.object({ id: z.string().min(1).max(64), fileId: z.string().min(1).max(64) });
const revision = z.number().int().min(1).max(4294967294);

/**
 * 注册稳定文本文件的查询与写入接口，使用注入的 FileService 校验用户和会话归属。
 * 继承会话插件的登录、同源、禁用缓存、隐私日志及错误处理 hook，本插件不重复注册。
 * 新增传会话文件修订 baseFileRevision，编辑和删除传单文件 baseRevision；
 * 路径保护、文本限制、修订冲突和执行中写入限制交由服务处理。
 */
export default async function fileRoutes(app: FastifyInstance, options: { service: FileService }) {
  const { service } = options;
  /**
   * GET /sessions/:id/files：列出当前用户会话的文件信息。
   * 仅接收 1～64 字符的会话 id，服务校验归属；此接口不读取单文件正文。
   */
  app.get('/sessions/:id/files', async (request) => {
    const { id } = params.omit({ fileId: true }).parse(request.params);
    return responseData.success({
      data: await service.list((await request.getUser()).userId, id),
    });
  });
  /**
   * GET /sessions/:id/files/:fileId：读取当前用户会话内的稳定文本文件。
   * id、fileId 均为 1～64 字符；文件归属及可读取范围由服务检查。
   */
  app.get('/sessions/:id/files/:fileId', async (request) => {
    const { id, fileId } = params.parse(request.params);
    return responseData.success({
      data: await service.get((await request.getUser()).userId, id, fileId),
    });
  });
  /**
   * POST /sessions/:id/files：为当前用户会话新增稳定文本文件，成功返回 201。
   * 仅接受 path（1～1024 字符）、content 和 baseFileRevision（0～4294967294）；
   * 基础会话文件修订、路径及写入状态由服务校验，content 允许空字符串。
   */
  app.post('/sessions/:id/files', async (request, reply) => {
    const { id } = params.omit({ fileId: true }).parse(request.params);
    const input = z
      .object({
        path: z.string().min(1).max(1024),
        content: z.string(),
        baseFileRevision: z.number().int().min(0).max(4294967294),
      })
      .strict()
      .parse(request.body);
    return reply.code(201).send(
      responseData.success({
        data: await service.create((await request.getUser()).userId, id, input),
      }),
    );
  });
  /**
   * PUT /sessions/:id/files/:fileId：更新当前用户会话中指定文本文件的正文。
   * 仅接受 baseRevision（1～4294967294）和 content（可为空），由服务检查单文件修订、
   * 文件归属及可写状态；此接口不接收重命名路径。
   */
  app.put('/sessions/:id/files/:fileId', async (request) => {
    const { id, fileId } = params.parse(request.params);
    const { baseRevision, content } = z
      .object({ baseRevision: revision, content: z.string() })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.update(
        (await request.getUser()).userId,
        id,
        fileId,
        baseRevision,
        content,
      ),
    });
  });
  /**
   * DELETE /sessions/:id/files/:fileId：删除当前用户会话中的指定稳定文本文件。
   * 请求体仅接受 baseRevision（1～4294967294），由服务检查归属、单文件修订及可写状态。
   */
  app.delete('/sessions/:id/files/:fileId', async (request) => {
    const { id, fileId } = params.parse(request.params);
    const { baseRevision } = z.object({ baseRevision: revision }).strict().parse(request.body);
    return responseData.success({
      data: await service.remove((await request.getUser()).userId, id, fileId, baseRevision),
    });
  });
}
