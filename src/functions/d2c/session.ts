import { imageVariantsFor } from '@/hooks/tools/imageVariants';
import { createMessageQueueService } from './session/queue';
import { recordPreviewUpdate } from './preview/events';
import attachmentRoutes from './attachments';
import { createAttachmentService, type AttachmentService } from './session/attachments';
import { readRunDiagnostics } from './run/diagnostics';
import { readSessionErrors } from './run/errorDiagnostics';
import responseData from '@/common/response';
import { createD2cConfigReader } from '@/config/d2c';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fileRoutes from './files';
import versionRoutes from './version';
import previewRoutes from './preview';
import editRoutes from './edit/routes';
import type { PreviewService } from './preview/service';
import { createVersionService, type VersionService } from './version/service';
import { createFileService, type FileService } from './files/service';
import { SessionError } from './session/access';
import { followTimeline, type TimelineTiming } from './session/events';
import { createMessageService, messageMaxBytes, type MessageService } from './session/messages';
import {
  createTimelineNotifications,
  createTimelineWakeup,
  type TimelineNotifications,
} from './session/notifications';
import { createSessionService, type SessionService } from './session/service';
import { checkWriteRequest } from './utils/request';

const params = z.object({ id: z.string().min(1).max(64) });
const cursor = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(4294967294));

/**
 * 注册会话、消息、时间线及文件子插件，使用当前用户 userId 交由服务校验归属。
 * preHandler 检查登录与写请求同源标记并禁用缓存；onRoute 标记 privatePayload，
 * 错误处理器保留 SessionError 状态并对参数、请求体大小和未知错误返回统一响应。
 * onReady 启动通知和默认 Worker（worker=false 可停用消费者）；preClose 中止流订阅，
 * 关闭 Worker 与通知。消息服务延迟装配，文件子插件继承本作用域 hook。
 */
export default async function sessionRoutes(
  app: FastifyInstance,
  options: {
    sessionService?: SessionService;
    fileService?: FileService;
    versionService?: VersionService;
    previewService?: PreviewService;
    messageService?: MessageService;
    attachmentService?: AttachmentService;
    notifications?: TimelineNotifications;
    streamTiming?: TimelineTiming;
    /** 离线 HTTP 测试可显式停用消费者；正式应用默认启动。 */
    worker?: false;
  } = {},
) {
  const service = options.sessionService ?? createSessionService(app.mysql);
  const notifications =
    options.notifications ??
    createTimelineNotifications({
      connect: app.hasDecorator('redis')
        ? async (receive, signal) => {
            const { connectTimelineRedis } = await import('./session/redis');
            return connectTimelineRedis(receive, signal);
          }
        : undefined,
      onUnavailable: () =>
        app.logging.warn({
          title: 'D2C 时间线通知',
          message: '实时通知不可用，已降级为低频数据库补读',
        }),
    });
  const files =
    options.fileService ??
    createFileService(
      app.mysql,
      () =>
        app.runtimeConfig.get<{
          d2c?: { limits?: { textFileBytes: number; filesPerSession: number } };
        }>()?.d2c?.limits,
      notifications.publish,
      () => imageVariantsFor(app),
    );
  const subscriptions = new Set<AbortController>();
  const readConfig = createD2cConfigReader(
    () => app.runtimeConfig.get(),
    () => app.logging.warn({ title: 'D2C 执行配置', message: '配置更新无效，保留最后有效参数' }),
  );
  let messages = options.messageService;
  let queue: ReturnType<typeof createMessageQueueService> | undefined;
  /** Queue routes share the normal runtime reader and committed timeline notifications. */
  function messageQueue() {
    return (queue ??= createMessageQueueService(app.mysql, {
      readConfig,
      notify: notifications.publish,
    }));
  }
  let worker: { close(): Promise<void> } | undefined;
  let unsubscribePreview: (() => void) | undefined;
  /** 按首次消息请求装配，不让尚未配置执行器影响已有会话和文件读取。 */
  function messageService() {
    messages ??= createMessageService(app.mysql, {
      readConfig,
      notify: notifications.publish,
    });
    return messages;
  }
  app.addHook('onReady', async () => {
    notifications.start();
    if (options.worker !== false) {
      const [
        { createGenerationWorker },
        { createImageFileClient },
        { createStorageResourceStore },
        { getProxyUrl },
      ] = await Promise.all([
        import('./run/worker'),
        import('@/hooks/tools/imageVariants'),
        import('./workspace/storage'),
        import('@/config'),
      ]);
      const previews = options.previewService ?? (await app.getPreviewService());
      unsubscribePreview = previews.subscribe?.((sessionId) => {
        void recordPreviewUpdate(app.mysql, sessionId, notifications.publish).catch(() => {
          app.logging.warn({
            title: 'D2C 预览通知',
            message: '预览通知保存失败，页面可重新查询构建结果',
          });
        });
      });
      const binary = createImageFileClient(app, readConfig, 'pro');
      const consumer = createGenerationWorker({
        mysql: app.mysql,
        preview: previews,
        readConfig,
        binary,
        store: createStorageResourceStore(binary),
        proxyUrl: getProxyUrl(),
        notify: notifications.publish,
        report: (message, details) =>
          app.logging.error({
            title: 'D2C 后台执行',
            message,
            addInfo: details,
          }),
      });
      worker = consumer;
      consumer.start();
      (await getVersions()).start();
    }
  });
  app.addHook('onRoute', (route) => {
    route.config = { ...route.config, privatePayload: true };
  });
  app.addHook('preClose', async () => {
    for (const controller of subscriptions) controller.abort();
    unsubscribePreview?.();
    await worker?.close();
    if (versions) await (await versions).close();
    await notifications.close();
  });
  app.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await request.getUser())?.userId)
      return reply.code(401).send(responseData.error({ message: '登录失效' }));
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !checkWriteRequest(request)
    ) {
      return reply.code(403).send(
        responseData.error({
          message: '请通过同源页面提交请求',
          data: { reason: 'CROSS_SITE_REQUEST' },
        }),
      );
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const requestStatus =
      error instanceof Error &&
      'statusCode' in error &&
      [400, 401, 413].includes(Number(error.statusCode))
        ? Number(error.statusCode)
        : 503;
    const status =
      error instanceof SessionError
        ? error.statusCode
        : error instanceof z.ZodError
          ? 422
          : requestStatus;
    return reply.code(status).send(
      responseData.error({
        message:
          error instanceof SessionError
            ? error.message
            : status === 422 || status === 400
              ? '请求参数无效'
              : status === 413
                ? '请求体超过大小限制'
                : status === 401
                  ? '登录失效'
                  : '会话操作失败',
        data: {
          reason:
            error instanceof SessionError
              ? error.reason
              : status === 422 || status === 400
                ? 'INVALID_INPUT'
                : status === 413
                  ? 'PAYLOAD_TOO_LARGE'
                  : status === 401
                    ? 'LOGIN_REQUIRED'
                    : 'SESSION_UNAVAILABLE',
        },
      }),
    );
  });
  app.register(fileRoutes, { service: files });
  /** 临时编辑副本继承当前会话鉴权；保存副本与应用回原文件是两个独立接口。 */
  app.register(editRoutes, { service: () => app.getEditService(notifications.publish) });
  let attachments: Promise<AttachmentService> | undefined;
  app.register(attachmentRoutes, {
    service: async () => {
      if (options.attachmentService) return options.attachmentService;
      attachments ??= import('@/hooks/tools/imageVariants')
        .then(({ createImageFileClient }) =>
          createAttachmentService(app.mysql, {
            binary: createImageFileClient(app, readConfig, 'pro'),
            readUploadBytes: () => readConfig().d2c.limits.uploadBytes,
          }),
        )
        .catch((error) => {
          attachments = undefined;
          throw error;
        });
      return attachments;
    },
  });
  app.register(previewRoutes, {
    service: async () => options.previewService ?? app.getPreviewService(),
  });
  let versions: Promise<VersionService> | undefined;
  /** 延迟装配版本存储，后台恢复与HTTP入口共享同一实例。 */
  async function getVersions() {
    if (options.versionService) return options.versionService;
    versions ??= import('@/hooks/tools/imageVariants')
      .then(({ createImageFileClient }) => {
        const binary = createImageFileClient(app, readConfig, 'pro');
        return createVersionService(app.mysql, {
          readLimits: () => readConfig().d2c.limits,
          binary: () => binary,
          notify: notifications.publish,
          onBackgroundError: () =>
            app.logging.error({
              title: 'D2C 版本暂存',
              message: '后台打包未完成，冻结快照已保留，可重试',
            }),
        });
      })
      .catch((error) => {
        versions = undefined;
        throw error;
      });
    return versions;
  }
  app.register(versionRoutes, { service: getVersions });
  /** GET /sessions/:id/diagnostics：本人执行元数据，只有读取、没有恢复或回放操作。 */
  app.get('/sessions/:id/diagnostics', async (request) => {
    const { id } = params.parse(request.params);
    const { runId } = z
      .object({ runId: z.string().min(1).max(64).optional() })
      .strict()
      .parse(request.query);
    return responseData.success({
      data: await readRunDiagnostics(app.mysql, (await request.getUser()).userId, id, runId),
    });
  });

  /** GET /sessions/:id/errors：会话全部轮次的安全错误统计与冻结快照分页。 */
  app.get('/sessions/:id/errors', async (request) => {
    const { id } = params.parse(request.params);
    const query = z
      .object({
        runId: z.string().min(1).max(64).optional(),
        category: z
          .enum([
            'model',
            'tool',
            'subagent',
            'storage',
            'preview',
            'database',
            'execution',
            'rule',
          ])
          .optional(),
        scope: z.enum(['main', 'subagent', 'unknown']).optional(),
        before: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        snapshotSeq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        snapshotToken: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .parse(request.query);
    return responseData.success({
      data: await readSessionErrors(app.mysql, (await request.getUser()).userId, id, query),
    });
  });

  /** Durable pending inputs share session ownership and committed timeline notifications. */
  app.get('/sessions/:id/message-queue', async (request) => {
    const { id } = params.parse(request.params);
    return responseData.success({
      data: await messageQueue().list((await request.getUser()).userId, id),
    });
  });
  app.post('/sessions/:id/message-queue', async (request, reply) => {
    const { id } = params.parse(request.params);
    const input = z
      .object({
        clientRequestId: z.string().min(1).max(64),
        content: z.string().max(messageMaxBytes),
        attachmentIds: z.array(z.string().min(1).max(64)).max(4).optional(),
        mode: z.enum(['queue', 'guidance']),
      })
      .strict()
      .parse(request.body);
    return reply.code(202).send(
      responseData.success({
        data: await messageQueue().enqueue((await request.getUser()).userId, id, input),
      }),
    );
  });
  app.delete('/sessions/:id/message-queue/:queueId', async (request) => {
    const { id, queueId } = params
      .extend({ queueId: z.string().min(1).max(64) })
      .parse(request.params);
    return responseData.success({
      data: await messageQueue().remove((await request.getUser()).userId, id, queueId),
    });
  });
  app.post('/sessions/:id/message-queue/:queueId/send-now', async (request, reply) => {
    const { id, queueId } = params
      .extend({ queueId: z.string().min(1).max(64) })
      .parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return reply.code(202).send(
      responseData.success({
        data: await messageQueue().sendNow((await request.getUser()).userId, id, queueId),
      }),
    );
  });
  /**
   * POST /sessions/:id/messages：为当前用户会话保存消息并入队，或返回已保存的请求结果。
   * 接受 clientRequestId、文字 content 与可选截图 attachmentIds；至少提供文字或一张截图。
   * 幂等与执行状态由 enqueue 判断，响应为 202，不代表本轮执行完成。
   */
  app.post('/sessions/:id/messages', async (request, reply) => {
    const { id } = params.parse(request.params);
    const input = z
      .object({
        clientRequestId: z.string().min(1).max(64),
        content: z.string().max(messageMaxBytes),
        attachmentIds: z.array(z.string().min(1).max(64)).max(4).optional(),
      })
      .strict()
      .parse(request.body);
    const result = await messageService().enqueue((await request.getUser()).userId, id, input);
    return reply.code(202).send(
      responseData.success({
        message: result.status === 'queued' ? '消息已保存，等待后台执行' : '返回已保存的请求结果',
        data: result,
      }),
    );
  });
  /**
   * POST /sessions/:id/cancel：请求取消当前用户会话中的排队轮次。
   * 请求体仅接受 runId（1～64 字符）；调用 cancelQueued，由服务判断轮次状态是否允许取消。
   */
  app.post('/sessions/:id/cancel', async (request) => {
    const { id } = params.parse(request.params);
    const { runId } = z
      .object({ runId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await messageService().cancelQueued((await request.getUser()).userId, id, runId),
    });
  });
  /** POST /sessions/:id/answer：保存业务问题回答并重新排队原轮次。 */
  app.post('/sessions/:id/answer', async (request, reply) => {
    const { id } = params.parse(request.params);
    const input = z
      .object({
        runId: z.string().min(1).max(64),
        questionId: z.string().uuid(),
        clientRequestId: z.string().min(1).max(64),
        answer: z.string().min(1).max(messageMaxBytes),
      })
      .strict()
      .parse(request.body);
    return reply.code(202).send(
      responseData.success({
        data: await messageService().answer((await request.getUser()).userId, id, input),
      }),
    );
  });
  /** POST /sessions/:id/end-waiting：放弃本人当前问题并释放会话。 */
  app.post('/sessions/:id/end-waiting', async (request) => {
    const { id } = params.parse(request.params);
    const { runId, questionId } = z
      .object({ runId: z.string().min(1).max(64), questionId: z.string().uuid() })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await messageService().endWaiting(
        (await request.getUser()).userId,
        id,
        runId,
        questionId,
      ),
    });
  });
  /** POST /sessions/:id/stop：持久化停止请求，关闭页面不会替代此操作。 */
  app.post('/sessions/:id/stop', async (request) => {
    const { id } = params.parse(request.params);
    const { runId } = z
      .object({ runId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return responseData.success({
      data: await messageService().requestStop((await request.getUser()).userId, id, runId),
    });
  });
  /** POST /sessions/:id/resume：在同一会话幂等创建继续轮次。 */
  app.post('/sessions/:id/resume', async (request, reply) => {
    const { id } = params.parse(request.params);
    const { runId, clientRequestId } = z
      .object({ runId: z.string().min(1).max(64), clientRequestId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return reply.code(202).send(
      responseData.success({
        data: await messageService().resume(
          (await request.getUser()).userId,
          id,
          runId,
          clientRequestId,
        ),
      }),
    );
  });
  /**
   * POST /sessions/:id/end-interrupted：明确结束本人已中断轮次，保留文件及历史。
   * 请求体仅含 runId；同事务补齐工具结果、取消轮次并解锁，运行中轮次返回冲突。
   */
  app.post('/sessions/:id/end-interrupted', async (request) => {
    const { id } = params.parse(request.params);
    const { runId } = z
      .object({ runId: z.string().min(1).max(64) })
      .strict()
      .parse(request.body);
    return responseData.success({
      message: '中断轮次已结束，可以继续对话或删除会话',
      data: await messageService().endInterrupted((await request.getUser()).userId, id, runId),
    });
  });
  /**
   * POST /workspaces/:id/sessions：在当前用户工作区内创建会话，成功返回 201。
   * 仅接受可选 name（最多200字符，留空自动生成）、target（h5/rn），以及可选 figmaUrl、
   * credentialId；有设计稿时与首条生成消息在同一事务内保存，由 Worker 后台执行。
   */
  app.post('/workspaces/:id/sessions', async (request, reply) => {
    const { id } = params.parse(request.params);
    const input = z
      .object({
        name: z.string().max(200).optional(),
        target: z.enum(['h5', 'rn']),
        figmaUrl: z.string().optional(),
        credentialId: z.string().min(1).max(64).optional(),
      })
      .strict()
      .parse(request.body);
    const userId = (await request.getUser()).userId;
    return reply.code(201).send(
      responseData.success({
        data: await service.create(userId, id, input, undefined, async (session, transaction) => {
          await messageService().enqueue(
            userId,
            session.sessionId!,
            {
              clientRequestId: session.sessionId!,
              content: `请根据设计稿开始 D2C，按当前会话目标生成并保存页面代码：${session.figmaUrl}`,
            },
            undefined,
            undefined,
            false,
            transaction,
          );
        }),
      }),
    );
  });
  /** 全局快捷入口仅返回有权工作区中的活动会话元信息。 */
  app.get('/sessions/active', async (request) => {
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);
    const result = await service.active((await request.getUser()).userId, page, pageSize);
    return responseData.pagination({ rows: result.items, total: result.total });
  });

  /** 分页查询当前用户有权工作区下的会话。 */
  app.get('/workspaces/:id/sessions', async (request) => {
    const { id } = params.parse(request.params);
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query);
    const result = await service.list((await request.getUser()).userId, id, page, pageSize);
    return responseData.pagination({ rows: result.items, total: result.total });
  });
  /**
   * GET /sessions/:id：读取当前用户会话详情。
   * 路径 id 为 1～64 字符，归属与可见状态由服务校验，不接受客户端指定用户身份。
   */
  app.get('/sessions/:id', async (request) => {
    const { id } = params.parse(request.params);
    return responseData.success({ data: await service.get((await request.getUser()).userId, id) });
  });
  /** PATCH /sessions/:id：按当前用户编辑权限修改名称，提交后通知所有在线查看者。 */
  app.patch('/sessions/:id', async (request) => {
    const { id } = params.parse(request.params);
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(request.body);
    const session = await service.rename((await request.getUser()).userId, id, name);
    notifications.publish(id, session.timelineSeq);
    return responseData.success({ data: session });
  });
  /**
   * DELETE /sessions/:id：请求软删除当前用户的会话并保留底层数据。
   * 仅需路径 id，服务校验归属及是否可删除；成功响应明确数据仍保留。
   */
  app.delete('/sessions/:id', async (request) => {
    const { id } = params.parse(request.params);
    return responseData.success({
      message: '会话已删除，数据保留',
      data: await service.remove((await request.getUser()).userId, id),
    });
  });
  /**
   * GET /sessions/:id/timeline：分页读取当前用户会话在 afterSeq 之后的时间线。
   * afterSeq 默认 0 向后补读；beforeSeq=0 取最新页，大于零取其之前的历史，二者互斥。
   * limit 默认 100、范围 1～500，返回始终按 seq 升序；hasMore 表示当前方向还有记录；
   * 会话归属与时间线返回内容由服务校验和投影。
   */
  app.get('/sessions/:id/timeline', async (request) => {
    const { id } = params.parse(request.params);
    const { afterSeq, beforeSeq, limit } = z
      .object({
        afterSeq: cursor.optional(),
        beforeSeq: cursor.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .refine((value) => value.afterSeq === undefined || value.beforeSeq === undefined, {
        message: '不能同时指定向前和向后游标',
      })
      .parse(request.query);
    return responseData.success({
      data: await service.timeline(
        (await request.getUser()).userId,
        id,
        afterSeq ?? 0,
        limit,
        beforeSeq,
      ),
    });
  });
  /** 只读子会话分页；每次先验证会话归属，过滤当前 Agent，不返回 SDK 私有历史。 */
  app.get('/sessions/:id/subagents/:agentId/events', async (request) => {
    const { id, agentId } = params.extend({ agentId: z.string().uuid() }).parse(request.params);
    const { afterSeq, limit } = z
      .object({
        afterSeq: cursor.default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const page = await service.timeline(
      (await request.getUser()).userId,
      id,
      afterSeq,
      limit,
      undefined,
      agentId,
    );
    return responseData.success({ data: { agentId, ...page } });
  });
  /**
   * GET /sessions/:id/events：订阅当前用户会话的 SSE 时间线。
   * Last-Event-ID 存在时优先于查询 afterSeq，缺省游标为 0；二者均使用非负整数校验。
   * 先注册唤醒再读取首批 100 条并校验归属，后续推送委托 followTimeline；
   * 关闭期间首读后返回 503，退出时释放唤醒与订阅记录，连接清理不调用轮次取消接口。
   */
  app.get('/sessions/:id/events', async (request, reply) => {
    const { id } = params.parse(request.params);
    const query = z.object({ afterSeq: cursor.optional() }).parse(request.query);
    const afterSeq =
      request.headers['last-event-id'] === undefined
        ? (query.afterSeq ?? 0)
        : cursor.parse(request.headers['last-event-id']);
    const userId = (await request.getUser()).userId;
    const controller = new AbortController();
    const wakeup = createTimelineWakeup(notifications, id, controller.signal);
    subscriptions.add(controller);
    try {
      const first = await service.timeline(userId, id, afterSeq, 100);
      if (controller.signal.aborted)
        return reply.code(503).send(responseData.error({ message: '服务正在关闭' }));
      await followTimeline(
        reply,
        service,
        userId,
        id,
        first,
        controller,
        wakeup,
        options.streamTiming,
      );
    } finally {
      wakeup.close();
      subscriptions.delete(controller);
    }
    return reply;
  });
}
