import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import responseData from '@/common/response';
import type { EditService } from './service';

const id = z.string().min(1).max(64);
const params = z.object({ id, editId: id });
const revision = z.number().int().min(1).max(4294967294);
const entryPath = z.string().min(1).max(1024).optional();

/**
 * 主 agent 接线：await app.register(editRoutes, { service: editService })。
 * 必须在 sessionRoutes 作用域内注册，继承 账号认证、checkWriteRequest、no-store 和安全错误处理。
 * 不注册静态路由；edit-* 预览仍通过现有 sandbox CSP 与 inspector 网关。
 */
export default async function editRoutes(
  app: FastifyInstance,
  options: { service: EditService | (() => Promise<EditService>) },
) {
  /** 只在请求内延迟装配；离线 session 路由注册不要求 Redis 可用。 */
  const getService = async () =>
    typeof options.service === 'function' ? options.service() : options.service;
  const config = { privatePayload: true };
  /** POST /sessions/:id/edit：从最新生成源码重新创建唯一临时副本，完全替换旧副本。 */
  app.post('/sessions/:id/edit', { config }, async (request, reply) => {
    const { id } = params.omit({ editId: true }).parse(request.params);
    const input = z
      .object({ entryPath })
      .strict()
      .parse(request.body ?? {});
    const draft = await (await getService()).create((await request.getUser()).userId, id, input);
    return reply.code(201).send(responseData.success({ data: draft }));
  });
  /** GET /sessions/:id/edit/:editId：读取本人 active draft，ready 自动签发五分钟票据。 */
  app.get('/sessions/:id/edit/:editId', { config }, async (request) => {
    const { id, editId } = params.parse(request.params);
    return responseData.success({
      data: await (await getService()).get((await request.getUser()).userId, id, editId),
    });
  });
  /** PUT /sessions/:id/edit/:editId：CAS 保存已有源码子集并异步构建，不修改稳定文件。 */
  /** 与副本总文本限额一致；服务层继续检查单文件与实际UTF-8字节，其他接口不扩大限制。 */
  app.put(
    '/sessions/:id/edit/:editId',
    { config, bodyLimit: 64 * 1024 * 1024 },
    async (request) => {
      const { id, editId } = params.parse(request.params);
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
        data: await (await getService()).save((await request.getUser()).userId, id, editId, input),
      });
    },
  );
  /** POST /sessions/:id/edit/:editId/apply：核对副本和原会话修订后原子写回变更源码。 */
  app.post('/sessions/:id/edit/:editId/apply', { config }, async (request) => {
    const { id, editId } = params.parse(request.params);
    const input = z.object({ baseRevision: revision }).strict().parse(request.body);
    return responseData.success({
      data: await (await getService()).apply((await request.getUser()).userId, id, editId, input),
    });
  });
  /** DELETE /sessions/:id/edit/:editId：仅丢弃当前 active 副本，旧 editId 不得删除新稿。 */
  app.delete('/sessions/:id/edit/:editId', { config }, async (request) => {
    const { id, editId } = params.parse(request.params);
    return responseData.success({
      data: await (await getService()).remove((await request.getUser()).userId, id, editId),
    });
  });
}
