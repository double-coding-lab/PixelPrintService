import { databaseDiagnostics } from '@/common/databaseDiagnostics';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    privatePayload?: boolean;
  }
}

/** 只记录路由、耗时与状态码，不输出正文、查询、密码、Cookie 或原始异常。 */
export function registerAccessLog(app: FastifyInstance) {
  app.addHook('preValidation', async (request) => {
    await request.getUid();
  });
  app.addHook('onError', async (request, _reply, error) => {
    app.logging.error(
      { message: 'HTTP request failed', errorName: error.name, ...databaseDiagnostics(error) },
      request,
    );
  });
  app.addHook('onResponse', async (request, reply) => {
    app.logging.info(
      {
        message: 'HTTP request completed',
        method: request.method,
        statusCode: reply.statusCode,
        elapsedMs: reply.elapsedTime,
      },
      request,
    );
  });
}
