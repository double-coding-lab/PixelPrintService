import { installImageVariants } from '@/hooks/tools/imageVariants';
import { installSharingEditors } from '../sharing/runtime';
import { previewAssetBase } from './assetPolicy';
import { createD2cConfigReader } from '@/config/d2c';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { startEditCleanup } from '../edit/cleanup';
import type { EditService } from '../edit/service';
import { SessionError } from '../session/access';
import { previewDebuggerAsset, readPreviewDebugger } from './debugger';
import { injectPreviewInspector } from './inspector';
import { createPreviewService, startPreviewWorker, type PreviewService } from './service';

declare module 'fastify' {
  interface FastifyInstance {
    getPreviewService(): Promise<PreviewService>;
    getEditService(notifyFiles?: (sessionId: string, seq: number) => void): Promise<EditService>;
  }
}

/** 安装同域静态网关与后台消费者，模块资源依靠短票据匿名读取而不传递用户凭据。 */
export function installPreview(
  app: FastifyInstance,
  options: {
    service?: PreviewService;
    editService?: EditService;
    worker?: false;
    notify?: (sessionId: string) => void;
  } = {},
) {
  installImageVariants(app);
  installSharingEditors(app);
  let service: Promise<PreviewService> | undefined;
  let edits: Promise<EditService> | undefined;
  let notifyEditedFiles: ((sessionId: string, seq: number) => void) | undefined;
  let worker: ReturnType<typeof startPreviewWorker> | undefined;
  let editCleanup: ReturnType<typeof startEditCleanup> | undefined;
  app.decorate('getPreviewService', async () => {
    if (options.service) return options.service;
    service ??= Promise.all([import('@/hooks/tools/imageVariants'), import('./runner')])
      .then(([{ createImageFileClient }, { runPreviewBuild }]) => {
        const readConfig = createD2cConfigReader(() => app.runtimeConfig.get());
        const binary = createImageFileClient(app, readConfig, 'pro');
        return createPreviewService(app.mysql, {
          binary: () => binary,
          run: runPreviewBuild,
          notify: options.notify,
          readLimits: () => readConfig().d2c.limits,
          report: (phase, reason, details) =>
            app.logging.error({
              title: 'D2C 预览构建',
              message: '预览构建失败',
              addInfo: { phase, reason, ...details },
            }),
        });
      })
      .catch((error) => {
        service = undefined;
        throw error;
      });
    return service;
  });
  /** 编辑副本只在首次进入时装配，沿用平台 Redis 与隔离构建器，不创建持久业务版本。 */
  app.decorate('getEditService', async (notifyFiles) => {
    if (notifyFiles) notifyEditedFiles = notifyFiles;
    if (options.editService) return options.editService;
    edits ??= Promise.all([
      import('@/hooks/tools/imageVariants'),
      import('../edit/service'),
      import('../edit/store'),
    ])
      .then(([{ createImageFileClient }, { createEditService }, { createRedisEditStore }]) => {
        const readConfig = createD2cConfigReader(() => app.runtimeConfig.get());
        const binary = createImageFileClient(app, readConfig, 'pro');
        return createEditService(app.mysql, {
          store: createRedisEditStore(app.redis),
          report: (details) =>
            app.logging.error({
              title: 'D2C 临时预览',
              message: '临时预览构建失败',
              addInfo: details,
            }),
          binary: () => binary,
          readLimits: () => readConfig().d2c.limits,
          /** 只发布应用回原文件后已提交的事件，临时保存不污染会话时间线。 */
          notify: (sessionId, seq) => {
            if (seq !== undefined) notifyEditedFiles?.(sessionId, seq);
          },
        });
      })
      .catch((error) => {
        edits = undefined;
        throw error;
      });
    return edits;
  });
  app.addHook('onReady', async () => {
    if (options.worker !== false) {
      worker = startPreviewWorker(await app.getPreviewService());
      editCleanup = startEditCleanup();
    }
  });
  app.addHook('preClose', async () => {
    await worker?.close();
    if (edits) await (await edits).close();
    if (options.editService) await options.editService.close();
    await editCleanup?.close();
  });
  for (const [prefix, target] of [
    ['H5_Preview', 'h5'],
    ['RN_Preview', 'rn'],
  ] as const) {
    app.get(
      `/${prefix}/:previewId/:ticket/*`,
      { config: { privatePayload: true } },
      async (request, reply) => {
        reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Referrer-Policy', 'no-referrer')
          .header('Access-Control-Allow-Origin', '*')
          .header('Cross-Origin-Resource-Policy', 'cross-origin');
        try {
          const {
            previewId,
            ticket,
            '*': path,
          } = request.params as { previewId: string; ticket: string; '*': string };
          if (
            !path ||
            path.startsWith('/') ||
            path.includes('\\') ||
            path.split('/').some((part) => !part || part === '..' || part.startsWith('.'))
          )
            throw new SessionError(404, 'PREVIEW_FILE_NOT_FOUND', '预览资源不存在');
          const html = path.endsWith('.html');
          // if (html && request.headers['sec-fetch-dest'] !== 'iframe')
          //   return reply.code(403).type('text/plain; charset=utf-8').send('请在工作台内打开预览');
          const base = new URL(
            `/${prefix}/${previewId}/${ticket}/`,
            `${request.protocol}://${request.host}`,
          ).href;
          const nonce = html ? randomBytes(24).toString('base64url') : undefined;
          reply.header(
            'Content-Security-Policy',
            `sandbox allow-scripts; default-src 'none'; script-src ${base}${nonce ? ` 'nonce-${nonce}'` : ''}; style-src 'unsafe-inline' ${base}; img-src ${base} data: blob: ${previewAssetBase()}; font-src ${base} data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
          );
          const debuggerAsset = path === previewDebuggerAsset;
          const asset = await (
            previewId.startsWith('plazaedit-')
              ? await app.getPlazaEditService()
              : previewId.startsWith('workedit-')
                ? await app.getSavedWorkEditService()
                : previewId.startsWith('edit-')
                  ? await app.getEditService()
                  : await app.getPreviewService()
          ).asset(target, previewId, ticket, debuggerAsset ? 'index.html' : path);
          /** 调试资源同样核对预览票据；固定 JS 不作为生成文件或上传产物保存。 */
          if (debuggerAsset)
            return reply.type('text/javascript; charset=utf-8').send(await readPreviewDebugger());
          return reply
            .type(asset.mimeType)
            .send(
              html
                ? injectPreviewInspector(
                    asset.content,
                    new URL(base).origin,
                    nonce!,
                    new URL(previewDebuggerAsset, base).href,
                  )
                : asset.content,
            );
        } catch (error) {
          return reply
            .code(error instanceof SessionError ? error.statusCode : 503)
            .type('text/plain; charset=utf-8')
            .send(error instanceof SessionError ? error.message : '预览暂不可用');
        }
      },
    );
    app.get(`/${prefix}`, { config: { privatePayload: true } }, async (_request, reply) =>
      reply.code(404).type('text/plain; charset=utf-8').send('请从作品库打开预览'),
    );
  }
}
