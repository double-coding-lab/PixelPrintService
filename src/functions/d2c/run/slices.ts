import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { planSlices, requiredSliceNames, type FigmaSliceNode } from './slicePlan';
import { resolveWorkspacePath, assertArtifactPath } from '../utils/paths';
import { ToolIssue, toolIssue } from './toolFeedback';
import type { SliceProgress } from './sliceProgress';
import { designTarget, sliceDesignSchema } from './sliceCache';
import { validateSliceNames } from './sliceNames';
import { compressImage } from '../utils/compressImage';

const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const context = { stage: 'tool', tool: 'prepare_slices' } as const;
const entrySchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  parentName: z.string().nullable(),
  filename: z.string(),
  filepath: z.string(),
  renderWidth: z.number().nullable(),
  renderHeight: z.number().nullable(),
  bboxWidth: z.number().nullable(),
  bboxHeight: z.number().nullable(),
  sizeWarning: z.string().nullable(),
  sharedFrom: z.string().optional(),
  sharedFromReason: z.string().optional(),
});
type Entry = z.infer<typeof entrySchema>;
const checkpointSchema = z.object({
  scope: z.string(),
  design: sliceDesignSchema.optional(),
  entries: z.array(
    z.object({ entry: entrySchema, sha256: z.string(), size: z.number().positive() }),
  ),
});

/** 服务端切图直接调用入口；每张先保存资产再保存进度，失败不会把部分清单标记为完整缓存。 */
export async function prepareSlices(options: {
  workspace: string;
  figmaUrl: string;
  baseUrl?: string;
  names?: Record<string, string>;
  slug: string;
  assetsDir: string;
  scope: string;
  signal: AbortSignal;
  request: (url: string, kind: 'json' | 'image') => Promise<Buffer>;
  assertLease: () => Promise<void>;
  saveText: (relative: string, content: string) => Promise<void>;
  saveBinary: (relative: string, content: Buffer) => Promise<void>;
  progress?: (value: SliceProgress) => Promise<void>;
}) {
  let target: ReturnType<typeof designTarget>;
  let base: ReturnType<typeof designTarget> | undefined;
  try {
    target = designTarget(options.figmaUrl);
    base = options.baseUrl !== undefined ? designTarget(options.baseUrl) : undefined;
    validateSliceNames(options.names ?? {});
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.slug)) throw new Error('Invalid slug');
  } catch {
    throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', context);
  }
  const { fileKey, rootNodeId: nodeId } = target;
  let total = 0,
    completed = 0,
    failed = 0,
    reused = 0;
  const compression = {
    beforeBytes: 0,
    afterBytes: 0,
    compressed: 0,
    unchanged: 0,
    unavailable: 0,
  };
  /** 租约及取消在网络、文件保存和进度提交边界均检查。 */
  async function guard() {
    options.signal.throwIfAborted();
    await options.assertLease();
  }
  /** 直接发送结构化计数，前端不再从终端输出解析进度。 */
  async function progress(phase: SliceProgress['phase']) {
    await guard();
    await options.progress?.({ stage: 'slices', phase, total, completed, failed, reused });
  }
  /** 完整读取设计根节点，版本及节点树摘要参与断点复用范围。 */
  async function fetchTree(key: string, node: string) {
    await guard();
    const response = JSON.parse(
      (
        await options.request(
          `https://api.figma.com/v1/files/${key}/nodes?${new URLSearchParams({ ids: node })}`,
          'json',
        )
      ).toString(),
    );
    const root = response.nodes?.[node]?.document as FigmaSliceNode | undefined;
    if (!root || root.id !== node)
      throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
    return { root, revision: response.lastModified ?? response.version ?? null };
  }
  await progress('fetching');
  const current = await fetchTree(fileKey, nodeId);
  let baseline: FigmaSliceNode | undefined;
  if (base) {
    baseline =
      base.fileKey === fileKey && base.rootNodeId === nodeId
        ? current.root
        : (await fetchTree(base.fileKey, base.rootNodeId)).root;
  } else
    try {
      const file = await resolveWorkspacePath(options.workspace, '.d2c-cache/last-page.json');
      const last = JSON.parse(await fs.readFile(file, 'utf8'));
      if (last.fileKey && (last.rootNodeId || last.nodeId)) {
        if (
          !/^[a-zA-Z0-9_-]+$/.test(last.fileKey) ||
          !/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(last.rootNodeId ?? last.nodeId)
        )
          throw new Error('Invalid baseline');
        baseline =
          last.fileKey === fileKey && (last.rootNodeId ?? last.nodeId) === nodeId
            ? current.root
            : (await fetchTree(last.fileKey, last.rootNodeId ?? last.nodeId)).root;
        base = designTarget(
          `https://www.figma.com/design/${last.fileKey}/?node-id=${(last.rootNodeId ?? last.nodeId).replace(':', '-')}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  const design = {
    figmaUrl: target.figmaUrl,
    ...(base ? { baseUrl: base.figmaUrl } : {}),
    ...(options.names ? { names: options.names } : {}),
  };
  const needsNames = requiredSliceNames(current.root, baseline, options.names);
  if (needsNames.length) {
    const issue = toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', context);
    const feedback = {
      ...issue.feedback,
      hint: '以下中文图层需要英文语义名称；请根据needsNames提供names映射后重试，尚未导出或保存图片。键使用基线nodeId或原图层名，值使用简短英文文件名。',
      needsNames,
    };
    throw new ToolIssue(feedback, issue.failure);
  }
  const plan = planSlices(current.root, baseline, options.names);
  total = plan.items.length + plan.missing.length;
  failed = plan.missing.length;
  const outDir = assertArtifactPath(
    path.posix.join(options.assetsDir.replace(/^\//, ''), `theme-${options.slug}`),
  );
  const prefix = `.d2c-cache/${fileKey}`;
  const partialPath = `${prefix}/slice-partial-${options.slug}.json`;
  const scope = hash(
    JSON.stringify([
      'server-slices-v1',
      options.scope,
      design,
      current,
      baseline ?? null,
      plan,
      outDir,
    ]),
  );
  let previous: z.infer<typeof checkpointSchema>['entries'] = [];
  try {
    const parsed = checkpointSchema.parse(
      JSON.parse(
        await fs.readFile(await resolveWorkspacePath(options.workspace, partialPath), 'utf8'),
      ),
    );
    if (parsed.scope === scope) previous = parsed.entries;
  } catch (error) {
    options.signal.throwIfAborted();
    if (
      !(error instanceof z.ZodError) &&
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw error;
  }
  const entries: Entry[] = [];
  const saved: typeof previous = [];
  const contents = new Map<string, Entry>();
  const groups = new Map<string, Entry>();
  let failure: unknown;
  /** 成功项已持久化后才记录断点；重启恢复时逐项复核图片摘要。 */
  async function checkpoint(entry: Entry, bytes: Buffer) {
    entries.push(entry);
    saved.push({ entry, sha256: hash(bytes), size: bytes.length });
    const processed = new Set(saved.map((item) => item.entry.nodeId));
    await options.saveText(
      partialPath,
      JSON.stringify({
        scope,
        design,
        entries: [...saved, ...previous.filter((item) => !processed.has(item.entry.nodeId))],
      }),
    );
    completed++;
    await progress('exporting');
  }
  /** 即使第一张导出失败，恢复时也保留 slug 的设计归属，避免另一主题覆盖同目录。 */
  await options.saveText(partialPath, JSON.stringify({ scope, design, entries: previous }));
  await progress('exporting');
  for (const item of plan.items) {
    await guard();
    const destination = assertArtifactPath(`${outDir}/${item.filename}.png`);
    const bbW = item.boundingBox ? Math.round(item.boundingBox.width) : null;
    const bbH = item.boundingBox ? Math.round(item.boundingBox.height) : null;
    const group =
      item.listAncestor && item.imageRefKey && bbW !== null
        ? `${item.listAncestor}|${item.imageRefKey}|${bbW}x${bbH}`
        : null;
    const old = previous.find(({ entry }) => entry.nodeId === item.nodeId);
    if (old && (old.entry.filepath === destination || old.entry.sharedFrom)) {
      assertArtifactPath(old.entry.filepath);
      let bytes: Buffer | undefined;
      try {
        bytes = await fs.readFile(
          await resolveWorkspacePath(options.workspace, old.entry.filepath),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (bytes && bytes.length === old.size && hash(bytes) === old.sha256) {
        reused++;
        await checkpoint(old.entry, bytes);
        contents.set(hash(bytes), old.entry);
        if (group) groups.set(group, old.entry);
        continue;
      }
    }
    let bytes: Buffer;
    let shared = group ? groups.get(group) : undefined;
    try {
      if (shared)
        bytes = await fs.readFile(await resolveWorkspacePath(options.workspace, shared.filepath));
      else {
        const response = JSON.parse(
          (
            await options.request(
              `https://api.figma.com/v1/images/${fileKey}?${new URLSearchParams({ ids: item.nodeId, format: 'png', scale: '2', use_absolute_bounds: 'true' })}`,
              'json',
            )
          ).toString(),
        );
        const address = response.images?.[item.nodeId];
        if (typeof address !== 'string')
          throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
        bytes = await options.request(address, 'image');
        if (
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.readUInt32BE(16) < 1 ||
          bytes.readUInt32BE(20) < 1
        )
          throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
        const optimized = await compressImage(destination, bytes, options.signal);
        bytes = optimized.content;
        compression.beforeBytes += optimized.beforeBytes;
        compression.afterBytes += optimized.afterBytes;
        if (optimized.status !== 'unsupported') compression[optimized.status]++;
        shared = contents.get(hash(bytes));
      }
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof ToolIssue)) throw error;
      failed++;
      failure ??= error;
      await progress('exporting');
      if (error.feedback.action === 'user') break;
      continue;
    }
    await guard();
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    const entry: Entry = {
      nodeId: item.nodeId,
      name: item.name,
      parentName: item.parentName ?? null,
      filename: shared?.filename ?? `${item.filename}.png`,
      filepath: shared?.filepath ?? destination,
      renderWidth: item.renderBounds ? Math.round(item.renderBounds.width) : null,
      renderHeight: item.renderBounds ? Math.round(item.renderBounds.height) : null,
      bboxWidth: bbW,
      bboxHeight: bbH,
      sizeWarning:
        bbW !== null &&
        bbH !== null &&
        (Math.abs(width - bbW * 2) > 4 || Math.abs(height - bbH * 2) > 4)
          ? '切图尺寸与节点边界不一致'
          : null,
      ...(shared
        ? {
            sharedFrom: shared.nodeId,
            sharedFromReason: group && groups.has(group) ? 'list-isomorphic' : 'content-md5',
          }
        : {}),
    };
    if (!shared) await options.saveBinary(destination, bytes);
    await checkpoint(entry, bytes);
    contents.set(hash(bytes), entry);
    if (group) groups.set(group, entry);
  }
  await progress('saving');
  const manifest = {
    design,
    generatedAt: new Date().toISOString(),
    mode: baseline ? 'aligned-to-base' : 'standalone',
    compression,
    themes: [
      {
        slug: options.slug,
        outDir,
        hit: entries.length,
        miss: total - entries.length,
        confirmed: true,
        entries,
      },
    ],
  };
  await options.saveText(`${prefix}/slice-manifest-${options.slug}.json`, JSON.stringify(manifest));
  if (failure) throw failure;
  if (entries.length !== total)
    throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_REQUEST_FAILED', context);
  return { reused: previous.length > 0, total, manifest };
}
