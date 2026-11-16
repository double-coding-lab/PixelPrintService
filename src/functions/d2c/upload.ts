import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { projectConfig } from '@/config/project';
import responseData from '@/common/response';
import { createStorageFileClient, StorageError } from '@/hooks/tools/storage';
import type { FastifyInstance } from 'fastify';

/**
 * 注册服务端 multipart 上传；沿用父模块鉴权，并在读文件前复查已验证的用户身份。
 * 旧令牌接口不再存在，浏览器不得直接获得存储凭据；成功返回完整对象定位及公开 URL。
 */
export default async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: 30_000_000 },
    throwFileSizeLimit: true,
  });
  const readConfig = () => app.runtimeConfig.get();
  const storage = createStorageFileClient(readConfig);

  /** POST /api/d2c/upload：单个 file 表单字段，Cookie/Bearer 身份由服务端鉴权。 */
  app.post('/upload', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await request.getUser();
    if (!user?.userId) return reply.code(401).send(responseData.error({ message: '请先登录' }));
    const origin = request.headers.origin;
    if (origin && origin !== new URL(projectConfig.server.publicUrl).origin)
      return reply.code(403).send(responseData.error({ message: '请求来源无效' }));
    try {
      const config = readConfig() as { d2c?: { limits?: { uploadBytes?: number } } };
      const limit = config?.d2c?.limits?.uploadBytes;
      if (!Number.isSafeInteger(limit) || limit! <= 0)
        throw new StorageError('config', 'INVALID_CONFIG', 503);
      let content: Buffer | undefined;
      let mimeType = '';
      for await (const part of request.parts({
        limits: { fileSize: Math.min(limit!, 30_000_000) },
      })) {
        if (part.type !== 'file' || part.fieldname !== 'file' || content)
          return reply.code(400).send(responseData.error({ message: '需要单个 file 文件字段' }));
        mimeType = part.mimetype;
        content = await part.toBuffer();
      }
      if (!content?.length)
        return reply.code(400).send(responseData.error({ message: '上传文件不能为空' }));
      /** 不信任原名作为路径，也不允许主动内容通过同源静态服务执行。 */
      const extensions: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
        'application/zip': 'zip',
        'application/octet-stream': 'bin',
        'text/plain': 'txt',
      };
      const extension = extensions[mimeType];
      if (!extension)
        return reply.code(415).send(responseData.error({ message: '不支持的文件类型' }));
      const object = await storage.uploadFile({
        content,
        contentType: mimeType,
        fileName: `uploads/${randomUUID()}.${extension}`,
      });
      return responseData.success({ data: object });
    } catch (error) {
      const multipartStatus = (error as { statusCode?: number }).statusCode;
      const status =
        error instanceof StorageError
          ? error.statusCode
          : multipartStatus === 413
            ? 413
            : multipartStatus === 400 || multipartStatus === 406
              ? 400
              : 503;
      return reply.code(status).send(
        responseData.error({
          message:
            error instanceof StorageError
              ? error.message
              : status === 413
                ? '文件超过上传限制'
                : '文件上传失败',
        }),
      );
    }
  });
}
