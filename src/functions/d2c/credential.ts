import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import modelCredentialRoutes from './credential/modelRoutes';
import responseData from '@/common/response';
import { secretKeysSchema } from '@/config/d2c';
import { createFigmaCredentialService } from './credential/service';
import { checkWriteRequest } from './utils/request';

/**
 * 注册当前用户的 Figma Token 保存与状态查询接口，响应只包含安全元数据。
 * preHandler 禁用缓存、检查用户登录，并对 POST 检查同源标记；
 * 错误处理器将参数、身份及其他故障分别映射为 422、401、503，隐藏底层异常。
 * 加密配置从 RuntimeConfig 读取并校验，Token 保存和归属检查由凭据服务负责。
 */
export default async function credentialRoutes(app: FastifyInstance) {
  const service = createFigmaCredentialService(app.mysql, () => {
    const raw = app.runtimeConfig.get<{ d2c?: { secrets?: unknown } }>();
    const parsed = secretKeysSchema.safeParse(raw?.d2c?.secrets);
    if (!parsed.success) throw new Error('凭据加密配置无效');
    return parsed.data;
  });
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await request.getUser())?.userId)
      return reply.code(401).send(responseData.error({ message: '登录失效' }));
    if (request.method === 'POST' && !checkWriteRequest(request)) {
      return reply.code(403).send(responseData.error({ message: '请通过同源页面提交请求' }));
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 422
        : error instanceof Error && 'statusCode' in error && error.statusCode === 401
          ? 401
          : 503;
    return reply.code(status).send(
      responseData.error({
        message:
          status === 422
            ? 'Figma Token 无效'
            : status === 401
              ? '登录失效'
              : '凭据操作失败，请检查加密配置或数据库',
      }),
    );
  });
  app.register(modelCredentialRoutes);
  /**
   * POST /credentials/figma：以当前用户 userId 保存 Figma Token，返回凭据元数据。
   * 请求体仅接受 token：去除首尾空白后 1～8192 字符，拒绝控制字符；
   * 加密与新凭据修订交由服务保存，响应不回传 Token。
   */
  app.post('/credentials/figma', async (request) => {
    const { token } = z
      .object({
        token: z
          .string()
          .trim()
          .min(1)
          .max(8192)
          .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
      })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await service.save((await request.getUser()).userId, token),
    });
  });
  /**
   * GET /credentials/figma/status：查询当前用户的 Figma 凭据状态元数据。
   * 无业务输入，身份取服务端 userId；此接口不返回明文 Token 或密文。
   */
  app.get('/credentials/figma/status', async (request) =>
    responseData.success({ data: await service.getStatus((await request.getUser()).userId) }),
  );
}
