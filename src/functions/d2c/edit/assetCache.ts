import { createHash } from 'node:crypto';
import { createPreviewCache, type PreviewCache } from '../preview/cache';
import { EDIT_TTL_MS } from './store';

export const EDIT_ASSET_CACHE_ROOT = '.runtime/edit-inputs';

/** 只缓存已校验的构建输入图片；使用磁盘摘要缓存，不将副本或业务正文放入内存。 */
export function createEditAssetCache(
  cache: Pick<PreviewCache, 'read' | 'write' | 'cleanup'> = createPreviewCache(
    EDIT_ASSET_CACHE_ROOT,
    { ttlMs: EDIT_TTL_MS, requireIndex: false },
  ),
) {
  return {
    /** 命中与下载均复核实际大小和SHA，损坏/淘汰缓存可重取；不缓存失败或不完整图片。 */
    async read(
      file: { sha256: string; size: number },
      download: () => Promise<Buffer>,
      signal: AbortSignal,
    ) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0)
        throw new Error('EDIT_INPUT_CORRUPT');
      /** 与稳定快照核对，不把缓存存在当作内容正确的证明。 */
      function valid(content: Buffer) {
        return (
          content.length === file.size &&
          createHash('sha256').update(content).digest('hex') === file.sha256
        );
      }
      signal.throwIfAborted();
      try {
        const value = await cache.read(file.sha256, 'asset');
        signal.throwIfAborted();
        if (valid(value.content)) return value.content;
      } catch {
        /** 缓存不可用回退可信下载，后续仍使用相同快照摘要校验。 */
      }
      signal.throwIfAborted();
      const content = await download();
      signal.throwIfAborted();
      if (!valid(content)) throw new Error('EDIT_INPUT_CORRUPT');
      try {
        await cache.write(file.sha256, [
          { path: 'asset', content, mimeType: 'application/octet-stream' },
        ]);
      } catch {
        /** 缓存写失败不能把已经核对的真实下载变成业务保存失败。 */
      }
      signal.throwIfAborted();
      return content;
    },
    cleanup: () => cache.cleanup(),
  };
}
