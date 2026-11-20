import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PreviewService } from './service';
import { runPreviewCapture, PreviewCaptureError, type PreviewCaptureResult } from './capture';
import type { AgentImage } from '../run/agent/images';

/**
 * 把当前 Run 的源码变化接入共享预览队列；这里只持有取消句柄和截图缓存。
 * 构建状态与源码仍由预览服务和 MySQL 管理，不为预览创建暂存版本。
 */
export function createPreviewInspection(input: {
  service: PreviewService;
  userId: string;
  sessionId: string;
  signal: AbortSignal;
  assertLease: () => Promise<void>;
  capture?: typeof runPreviewCapture;
  saveCapture?: (value: {
    previewId: string;
    fileRevision: number;
    entryPath: string;
    capture: PreviewCaptureResult;
  }) => Promise<{ imageRef: string; image: AgentImage }>;
}) {
  let dirty = false;
  let selectedEntry: string | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown> | undefined;
  const images = new Map<string, AgentImage>();
  const checked = new Map<string, string>();
  const reportedBuildFailures = new Set<string>();

  /** 等待真实队列构建，保留取消和租约检查，不调用宿主编译或对象上传。 */
  async function ready(entryPath?: string) {
    await input.assertLease();
    input.signal.throwIfAborted();
    if (entryPath) selectedEntry = entryPath;
    const state = await input.service.createSession(input.userId, input.sessionId, selectedEntry);
    const current = state.current;
    if (!current) return { ok: false as const, status: 'waiting_entry', entries: state.entries };
    const end = Date.now() + 125_000;
    let row = current;
    while (row.status === 'queued' || row.status === 'building') {
      if (Date.now() >= end)
        return { ok: false as const, status: 'building', previewId: row.previewId };
      input.signal.throwIfAborted();
      await input.assertLease();
      await delay(1000, undefined, { signal: input.signal });
      row = await input.service.get(input.userId, current.previewId);
    }
    return row.status === 'ready'
      ? { ok: true as const, preview: row }
      : { ok: false as const, status: 'failed', diagnostic: row.error, previewId: row.previewId };
  }

  return {
    /** 文件提交后合并唤醒；客户端关闭也不影响当前 Run 的后台预览。 */
    changed() {
      dirty = true;
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        pending = input.service
          .createSession(input.userId, input.sessionId, selectedEntry)
          .catch(() => undefined)
          .finally(() => {
            pending = undefined;
          });
      }, 800);
      scheduled.unref();
    },
    tools: {
      /** 复用自动预览的真实失败结果；不轮询、不新增构建，也不使用旧修订猜测当前错误。 */
      async feedback() {
        if (!dirty) return;
        await input.assertLease();
        input.signal.throwIfAborted();
        const state = await input.service.existingSession(
          input.userId,
          input.sessionId,
          selectedEntry,
        );
        const current = state.current;
        if (!current || current.status !== 'failed' || !current.error) return;
        const key = JSON.stringify([
          current.previewId,
          current.validatedFileRevision,
          current.error,
        ]);
        if (reportedBuildFailures.has(key)) return;
        reportedBuildFailures.add(key);
        if (reportedBuildFailures.size > 64)
          reportedBuildFailures.delete(reportedBuildFailures.values().next().value!);
        return JSON.stringify({
          type: 'preview_feedback',
          previewId: current.previewId,
          entryPath: current.entryPath,
          fileRevision: current.validatedFileRevision,
          diagnostic: current.error,
          message:
            '现有自动预览尚未编译成功，请按真实诊断定点处理。源码检查通过不代表编译通过；环境故障如实说明，不为环境故障反复改源码。',
        });
      },
      /** 自动收尾仅检查本轮实际修改过的文件；普通聊天不重复截图。 */
      async needsInspection() {
        return dirty;
      },
      /** 返回真实构建状态与安全诊断，失败供模型调整，不误报为存储失败。 */
      async build(entryPath?: string) {
        return JSON.stringify(await ready(entryPath));
      },
      /** 同一不可变预览只截图一次；生产接线持久保存聊天附件，模型历史只保存短引用。 */
      async inspect(entryPath?: string) {
        dirty = false;
        const result = await ready(entryPath);
        if (!result.ok) return JSON.stringify(result);
        const preview = result.preview;
        if (preview.fileRevision === null) throw new Error('会话预览缺少源码修订');
        const cached = checked.get(preview.previewId);
        if (cached) return cached;
        try {
          const files = await input.service.captureInputs(input.userId, preview.previewId);
          const capture = await (input.capture ?? runPreviewCapture)({
            files: files.files,
            target: files.target,
            signal: input.signal,
            width: 375,
          });
          await input.assertLease();
          const id = createHash('sha256')
            .update(`${input.sessionId}:${preview.previewId}:375`)
            .digest('hex');
          const saved = await input.saveCapture?.({
            previewId: preview.previewId,
            fileRevision: preview.fileRevision,
            entryPath: preview.entryPath,
            capture,
          });
          const imageRef = saved?.imageRef ?? `preview://${id}`;
          images.set(imageRef, saved?.image ?? { mimeType: capture.mimeType, data: capture.image });
          /** 最近四张已够一次视觉请求，避免长任务在进程内积累全部截图。 */
          while (images.size > 4) images.delete(images.keys().next().value!);
          const output = JSON.stringify({
            ok: true,
            previewId: preview.previewId,
            fileRevision: preview.fileRevision,
            entryPath: preview.entryPath,
            imageRef,
            width: capture.width,
            height: capture.height,
            ...(capture.truncated ? { truncated: true } : {}),
            errors: capture.errors,
            missingAssets: capture.missingAssets,
            message:
              '已取得真实运行截图，请结合用户反馈检查并修改；截图不等于规则检查或视觉还原已通过。',
          });
          checked.set(preview.previewId, output);
          return output;
        } catch (error) {
          input.signal.throwIfAborted();
          await input.assertLease();
          if (!(error instanceof PreviewCaptureError)) throw error;
          const output = JSON.stringify({
            ok: false,
            status: 'capture_unavailable',
            previewId: preview.previewId,
            reason: error.reason,
            message:
              '页面已编译，但本地浏览器截图不可用。请如实报告，不能声称完成视觉检查；不要为环境问题修改页面源码。',
          });
          checked.set(preview.previewId, output);
          return output;
        }
      },
    },
    /** 仅识别本 Run 创建的截图，无法借用引用读取其他会话文件。 */
    async resolveImage(ref: string) {
      return images.get(ref) ?? null;
    },
    /** 收尾提交最后一次预览更新后释放截图，不停止共享预览 Worker。 */
    async close() {
      if (scheduled) {
        clearTimeout(scheduled);
        scheduled = undefined;
        await input.service
          .createSession(input.userId, input.sessionId, selectedEntry)
          .catch(() => {});
      }
      await pending;
      images.clear();
    },
  };
}
