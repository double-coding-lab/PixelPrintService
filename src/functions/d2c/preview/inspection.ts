import {
  previewInspectionOptionsSchema,
  type PreviewInspectionOptions,
  type PreviewLayoutCheck,
} from './interaction';
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
  layoutChecks?: () => Promise<PreviewLayoutCheck[]>;
  requireWholePage?: boolean;
  saveCapture?: (value: {
    previewId: string;
    fileRevision: number;
    entryPath: string;
    capture: PreviewCaptureResult;
    inspectionKey?: string;
  }) => Promise<{ imageRef: string; image: AgentImage }>;
}) {
  let dirty = false;
  const layoutProblems = new Map<string, string>();
  let wholePagePending = false;
  let selectedEntry: string | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown> | undefined;
  const images = new Map<string, AgentImage>();
  const checked = new Map<string, string>();
  const reportedBuildFailures = new Set<string>();

  /** Partial/action captures clear only the axes actually measured; unrelated failures survive. */
  function recordLayout(
    layout: PreviewCaptureResult['layout'],
    checks: PreviewLayoutCheck[],
    entry: string,
  ) {
    if (!layout) return;
    const blocked = new Set(
      layout.issues.filter((issue) => !/mismatch$/.test(issue.code)).map((issue) => issue.selector),
    );
    for (const check of checks) {
      if (blocked.has(check.selector) || (check.container && blocked.has(check.container)))
        continue;
      for (const [property, code] of [
        ['width', 'width_mismatch'],
        ['height', 'height_mismatch'],
        ['centerX', 'center_x_mismatch'],
        ['centerY', 'center_y_mismatch'],
      ] as const) {
        if (check[property] !== undefined && check[property] !== false && !layout.truncated)
          layoutProblems.delete(`${entry}:${check.selector}:${code}`);
      }
    }
    for (const issue of layout.issues) {
      if (!/mismatch$/.test(issue.code)) continue;
      const key = `${entry}:${issue.selector}:${issue.code}`;
      if (layoutProblems.size < 40 || layoutProblems.has(key))
        layoutProblems.set(
          key,
          `实际布局未通过：${entry} ${issue.selector} ${issue.code}，预期 ${issue.expected}，实际 ${issue.actual} CSS px；定点修复后复验，不重扫设计稿。`,
        );
    }
  }

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
      layoutProblems.clear();
      wholePagePending = input.requireWholePage === true;
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
    /** Only current-source geometry failures enter the existing bounded delivery repair loop. */
    problems() {
      return dirty ? [] : [...layoutProblems.values()].slice(0, 8);
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
        return dirty || wholePagePending;
      },
      /** 返回真实构建状态与安全诊断，失败供模型调整，不误报为存储失败。 */
      async build(entryPath?: string) {
        return JSON.stringify(await ready(entryPath));
      },
      /** 同一不可变预览只截图一次；生产接线持久保存聊天附件，模型历史只保存短引用。 */
      async inspect(entryPath?: string, options: PreviewInspectionOptions = {}) {
        const explicit = previewInspectionOptionsSchema.parse(options);
        const baseline =
          !explicit.actions?.length && !explicit.focusSelector
            ? ((await input.layoutChecks?.()) ?? [])
            : [];
        const inspection = previewInspectionOptionsSchema.parse({
          ...explicit,
          ...(explicit.layoutChecks?.length || baseline.length
            ? {
                layoutChecks: [
                  ...(explicit.layoutChecks ?? []),
                  ...baseline.filter(
                    (check) =>
                      !explicit.layoutChecks?.some((value) => value.selector === check.selector),
                  ),
                ].slice(0, 32),
              }
            : {}),
        });
        dirty = false;
        if (!explicit.actions?.length && !explicit.focusSelector) wholePagePending = false;
        const result = await ready(entryPath);
        if (!result.ok) return JSON.stringify(result);
        const preview = result.preview;
        if (preview.fileRevision === null) throw new Error('会话预览缺少源码修订');
        const inspectionKey = createHash('sha256').update(JSON.stringify(inspection)).digest('hex');
        const captureKey = `${preview.previewId}:${inspectionKey}`;
        const cached = checked.get(captureKey);
        if (cached) {
          recordLayout(JSON.parse(cached).layout, inspection.layoutChecks ?? [], preview.entryPath);
          return cached;
        }
        try {
          const files = await input.service.captureInputs(input.userId, preview.previewId);
          const capture = await (input.capture ?? runPreviewCapture)({
            files: files.files,
            target: files.target,
            signal: input.signal,
            width: 375,
            inspection,
          });
          await input.assertLease();
          const id = createHash('sha256')
            .update(`${input.sessionId}:${captureKey}:375`)
            .digest('hex');
          const saved = await input.saveCapture?.({
            previewId: preview.previewId,
            fileRevision: preview.fileRevision,
            entryPath: preview.entryPath,
            capture,
            inspectionKey,
          });
          const imageRef = saved?.imageRef ?? `preview://${id}`;
          images.set(imageRef, saved?.image ?? { mimeType: capture.mimeType, data: capture.image });
          /** 最近四张已够一次视觉请求，避免长任务在进程内积累全部截图。 */
          while (images.size > 4) images.delete(images.keys().next().value!);
          recordLayout(capture.layout, inspection.layoutChecks ?? [], preview.entryPath);
          const output = JSON.stringify({
            ok: true,
            previewId: preview.previewId,
            fileRevision: preview.fileRevision,
            entryPath: preview.entryPath,
            imageRef,
            width: capture.width,
            height: capture.height,
            ...(capture.truncated ? { truncated: true } : {}),
            ...(capture.interaction ? { interaction: capture.interaction } : {}),
            ...(capture.coverage ? { coverage: capture.coverage } : {}),
            ...(capture.layout ? { layout: capture.layout } : {}),
            errors: capture.errors,
            missingAssets: capture.missingAssets,
            message:
              '已取得当前修订的运行截图及请求的动作断言结果。仅有截图不能证明点击或滑动通过；coverage标明截取范围，未覆盖区域不能当作已验收。按本次需求检查，已通过后停止重复自检。',
          });
          checked.set(captureKey, output);
          while (checked.size > 32) checked.delete(checked.keys().next().value!);
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
          checked.set(captureKey, output);
          while (checked.size > 32) checked.delete(checked.keys().next().value!);
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
