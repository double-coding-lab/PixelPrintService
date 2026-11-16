import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '../../common/response';
import {
  attachmentBodyLimit,
  attachmentFailureDetails,
  type AttachmentService,
} from './session/attachments';

const params = z.object({ id: z.string().min(1).max(64), attachmentId: z.string().min(1).max(64) });

/** 注册于 session 插件内，继承 账号认证、同源写入、SessionError 和 privatePayload hook。 */
export default async function attachmentRoutes(
  app: FastifyInstance,
  options: { service: AttachmentService | (() => AttachmentService | Promise<AttachmentService>) },
) {
  /** 为私有上传/读取补充安全诊断；请求正文和原始异常仍由全局日志省略。 */
  app.addHook('onError', async (request, _reply, error) => {
    app.logging?.error(
      {
        title: 'D2C 图片附件',
        message: request.method === 'POST' ? '图片附件上传失败' : '图片附件读取失败',
        addInfo: {
          operation: request.method === 'POST' ? 'upload' : 'read',
          ...attachmentFailureDetails(error),
        },
      },
      request,
    );
  });
  /** 主接线可延迟构造 Storage 客户端，不让未配置上传影响纯文本会话。 */
  async function service() {
    return typeof options.service === 'function' ? options.service() : options.service;
  }
  /** JSON base64 接口使用独立有界 bodyLimit；服务层另校验实际字节和通道上限。 */
  app.post(
    '/sessions/:id/attachments',
    { bodyLimit: attachmentBodyLimit, config: { privatePayload: true } },
    async (request, reply) => {
      const { id } = params.omit({ attachmentId: true }).parse(request.params);
      const input = z
        .object({
          fileName: z.string().min(1).max(200),
          mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
          base64: z.string().min(1),
        })
        .strict()
        .parse(request.body);
      const result = await (await service()).upload((await request.getUser()).userId, id, input);
      return reply.code(201).send(responseData.success({ data: result }));
    },
  );
  /** 图片二进制响应供展示，归属和摘要由服务验证，禁止浏览器嗅探其他媒体类型。 */
  app.get(
    '/sessions/:id/attachments/:attachmentId',
    { config: { privatePayload: true } },
    async (request, reply) => {
      const { id, attachmentId } = params.parse(request.params);
      const result = await (
        await service()
      ).read((await request.getUser()).userId, id, attachmentId);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline')
        .type(result.mimeType)
        .send(result.data);
    },
  );
}
