import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertArtifactPath } from '../utils/paths';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sliceDesignSchema = z.object({
  figmaUrl: z.string(),
  baseUrl: z.string().optional(),
  names: z.record(z.string(), z.string()).optional(),
});
const evidenceSchema = z.object({
  version: z.literal(1),
  scope: hashSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  manifestHash: hashSchema,
  design: sliceDesignSchema.optional(),
  images: z
    .array(z.object({ path: z.string(), sha256: hashSchema, size: z.number().int().positive() }))
    .max(500),
});
export type SliceEvidence = z.infer<typeof evidenceSchema>;
export type SliceFile = { path: string; kind: string; sha256: string; size: number };

/** 仅接受无凭据的官方 HTTPS 设计链接；规范地址不保存分享参数或凭据。 */
export function designTarget(address: string, rootNodeId?: string) {
  const url = new URL(address);
  const fileKey = /^\/(?:design|file)\/([a-zA-Z0-9_-]+)(?:\/[^/]*)?\/?$/.exec(url.pathname)?.[1];
  const linkedNode = url.searchParams.get('node-id')?.replace(/-/g, ':');
  const root = rootNodeId?.replace(/-/g, ':') ?? linkedNode;
  if (
    url.protocol !== 'https:' ||
    !['figma.com', 'www.figma.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !fileKey ||
    !linkedNode ||
    !/^\d+:\d+$/.test(linkedNode) ||
    !root ||
    !/^\d+:\d+$/.test(root) ||
    [...url.searchParams.keys()].some((key) =>
      /token|password|secret|credential|authorization/i.test(key),
    )
  )
    throw new Error('Invalid Figma design URL');
  return {
    fileKey,
    rootNodeId: root,
    figmaUrl: `https://www.figma.com/design/${fileKey}/?node-id=${root.replace(':', '-')}`,
  };
}

/** 切图缓存绑定设计节点、固定配置和资源内容，不绑定对话轮次或用户确认状态。 */
export function sliceScope(
  figmaUrl: string,
  target: string,
  configHash: string,
  bundleHash: string,
  design?: { baseUrl?: string; names?: Record<string, string> },
) {
  const url = new URL(figmaUrl);
  return sliceHash(
    JSON.stringify([
      url.pathname.split('/')[2],
      url.searchParams.get('node-id')?.replace(/-/g, ':'),
      target,
      configHash,
      bundleHash,
      ...(design?.baseUrl || Object.keys(design?.names ?? {}).length
        ? [
            design?.baseUrl ? designTarget(design.baseUrl).figmaUrl : null,
            Object.entries(design?.names ?? {}).sort(([a], [b]) => a.localeCompare(b)),
          ]
        : []),
    ]),
  );
}

/** 与稳定文件的 SHA-256 约定保持一致。 */
export function sliceHash(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

/** 缺图及不完整清单不能当作成功；尺寸告警只提供给模型，不构成人工审批状态。 */
export function inspectSliceManifest(content: string, slug: string, files: SliceFile[]) {
  const value = JSON.parse(content);
  if (!Array.isArray(value?.themes) || value.themes.length !== 1) throw new Error('切图主题无效');
  const theme = value.themes[0];
  if (
    theme.slug !== slug ||
    theme.miss !== 0 ||
    !Number.isInteger(theme.hit) ||
    theme.hit < 0 ||
    !Array.isArray(theme.entries) ||
    theme.entries.length !== theme.hit
  )
    throw new Error('切图清单不完整');
  const images = new Map<string, { path: string; sha256: string; size: number }>();
  for (const entry of theme.entries) {
    const path = assertArtifactPath(entry.filepath);
    const file = files.find((file) => file.path === path && file.kind === 'asset');
    if (!file || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('切图图片缺失');
    images.set(path, { path, size: file.size, sha256: file.sha256 });
  }
  return {
    value,
    images: [...images.values()],
    total: theme.hit as number,
    warningCount: theme.entries.filter((entry: { sizeWarning?: unknown }) => !!entry.sizeWarning)
      .length,
  };
}

/** 服务端缓存证据只能证明配置、清单和图片未变化，不表示用户批准。 */
export function verifySliceEvidence(
  raw: unknown,
  content: string,
  scope: string,
  slug: string,
  files: SliceFile[],
) {
  const evidence = evidenceSchema.parse(raw);
  if (
    evidence.scope !== scope ||
    evidence.slug !== slug ||
    evidence.manifestHash !== sliceHash(content)
  )
    throw new Error('切图缓存已失效');
  const inspected = inspectSliceManifest(content, slug, files);
  if (
    inspected.images.length !== evidence.images.length ||
    evidence.images.some(
      (expected) =>
        !inspected.images.some(
          (image) =>
            image.path === expected.path &&
            image.sha256 === expected.sha256 &&
            image.size === expected.size,
        ),
    )
  )
    throw new Error('切图图片已变化');
  return { evidence, ...inspected };
}

/** 自动执行策略兼容原包的 merge gate；不写用户身份、确认时间或人工批准记录。 */
export function automaticSliceManifest(value: {
  themes: Array<Record<string, unknown>>;
  [key: string]: unknown;
}) {
  return JSON.stringify(
    {
      ...value,
      confirmationPolicy: 'conversation',
      themes: value.themes.map((theme) => ({ ...theme, confirmed: true })),
    },
    null,
    2,
  );
}
