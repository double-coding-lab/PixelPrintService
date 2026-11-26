import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import { modelConfigsSchema, secretKeysSchema } from '@/config/d2c';
import {
  createModelCredentialService,
  modelTokenSchema,
  personalModelConnectionSchema,
} from './model';

/** 登录、同源写入和 no-store 继承父凭据路由；响应只含安全元数据。 */
export default async function modelCredentialRoutes(app: FastifyInstance) {
  const service = createModelCredentialService(
    app.mysql,
    () => {
      const raw = app.runtimeConfig.get<{ d2c?: { secrets?: unknown } }>();
      return secretKeysSchema.parse(raw?.d2c?.secrets);
    },
    () =>
      modelConfigsSchema.parse(app.runtimeConfig.get<{ modelConfigs?: unknown }>()?.modelConfigs),
  );
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof z.ZodError ? 422 : 503).send(
      responseData.error({
        message:
          error instanceof z.ZodError
            ? '模型地址、名称或 Token 参数无效'
            : '模型凭据操作失败，请检查配置或数据库',
      }),
    ),
  );
  app.get('/credentials/model/status', async (request) =>
    responseData.success({
      data: await service.getStatus((await request.getUser()).userId),
    }),
  );
  app.post('/credentials/model', async (request) => {
    const input = z
      .object({
        token: modelTokenSchema,
        baseUrl: personalModelConnectionSchema.shape.baseUrl.optional(),
        modelName: personalModelConnectionSchema.shape.modelName.optional(),
      })
      .strict()
      .refine(
        (value) => (value.baseUrl === undefined) === (value.modelName === undefined),
        '模型地址与名称需要同时填写',
      )
      .parse(request.body);
    const { token, baseUrl, modelName } = input;
    return responseData.success({
      data: await service.save(
        (await request.getUser()).userId,
        token,
        baseUrl !== undefined && modelName !== undefined ? { baseUrl, modelName } : undefined,
      ),
    });
  });
}
