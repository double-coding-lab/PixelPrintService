import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveWorkspacePath } from '../utils/paths';

/** 基准图与切图分目录，避免被当成页面运行素材或补切清单。 */
export function designReferencePaths(fileKey: string, nodeId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(fileKey) || !/^\d+:\d+$/.test(nodeId))
    throw new Error('DESIGN_REFERENCE_PATH_INVALID');
  const safe = nodeId.replace(':', '_');
  return {
    temporary: `.d2c-tmp/screenshots/whole-${safe}.png`,
    image: `design-reference/root-${safe}.png`,
    metadata: `.d2c-cache/${fileKey}/design-reference-${safe}.json`,
  };
}

/**
 * 只持久化本次命令在约定位置生成的真实 PNG，不接受脚本返回的任意文件路径。
 * 图片上传成功后保存来源摘要；中途失败保留临时原图，调用方不得报告保存成功。
 */
export async function persistDesignReference(input: {
  workspace: string;
  fileKey: string;
  nodeId: string;
  outputPath: unknown;
  figmaUrl: string;
  scale: number;
  maxBytes: number;
  saveBinary: (relative: string, content: Buffer) => Promise<void>;
  save: (relative: string, content: string, internal: boolean) => Promise<void>;
}) {
  const paths = designReferencePaths(input.fileKey, input.nodeId);
  const temporary = await resolveWorkspacePath(input.workspace, paths.temporary);
  if (
    typeof input.outputPath !== 'string' ||
    ![temporary, path.resolve(input.workspace, paths.temporary)].includes(
      path.resolve(input.outputPath),
    )
  )
    throw new Error('DESIGN_REFERENCE_PATH_INVALID');
  const handle = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  let image: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 33 || stat.size > input.maxBytes)
      throw new Error('DESIGN_REFERENCE_IMAGE_INVALID');
    image = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (
    image.length > input.maxBytes ||
    !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    image.toString('ascii', 12, 16) !== 'IHDR' ||
    image.readUInt32BE(16) === 0 ||
    image.readUInt32BE(20) === 0
  )
    throw new Error('DESIGN_REFERENCE_IMAGE_INVALID');
  let designLastModified: string | null = null;
  try {
    const cache = JSON.parse(
      await fs.readFile(
        await resolveWorkspacePath(input.workspace, `.d2c-cache/${input.fileKey}/meta.json`),
        'utf8',
      ),
    );
    if (typeof cache.lastModified === 'string') designLastModified = cache.lastModified;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const source = new URL(input.figmaUrl);
  const requestedVersion = source.searchParams.get('version-id');
  source.search = '';
  source.hash = '';
  source.searchParams.set('node-id', input.nodeId.replace(':', '-'));
  if (requestedVersion) source.searchParams.set('version-id', requestedVersion);
  const metadata = {
    fileKey: input.fileKey,
    rootNodeId: input.nodeId,
    sourceUrl: source.href,
    imagePath: paths.image,
    capturedAt: new Date().toISOString(),
    scale: input.scale,
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    size: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
    designLastModified,
    requestedVersion,
    versionVerified: false,
  };
  const content = JSON.stringify(metadata, null, 2);
  await input.saveBinary(paths.image, image);
  await input.save(paths.metadata, content, true);
  for (const [relative, bytes] of [
    [paths.image, image],
    [paths.metadata, content],
  ] as const) {
    const destination = await resolveWorkspacePath(input.workspace, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { mode: 0o600 });
  }
  return { ...metadata, metadataPath: paths.metadata };
}
