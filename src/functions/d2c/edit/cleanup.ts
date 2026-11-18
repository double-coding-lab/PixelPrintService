import { createPreviewCache, type PreviewCache } from '../preview/cache';
import { EDIT_TTL_MS } from './store';
import { createEditAssetCache } from './assetCache';

/** 启动即回收上次进程遗留文件；没有新的编辑写入时也每分钟清理到期编译缓存。 */
export function startEditCleanup(
  cache: Pick<PreviewCache, 'cleanup'> = {
    /** 输出及输入图片都按相同临时期限回收，清理各自独立的受控目录。 */
    async cleanup() {
      await Promise.all([
        createPreviewCache('.runtime/edit-previews', { ttlMs: EDIT_TTL_MS }).cleanup(),
        createPreviewCache('.runtime/plaza-edit-previews', { ttlMs: EDIT_TTL_MS }).cleanup(),
        createPreviewCache('.runtime/work-edit-previews', { ttlMs: EDIT_TTL_MS }).cleanup(),
        createEditAssetCache().cleanup(),
      ]);
    },
  },
) {
  let running: Promise<void> | undefined;
  let closed = false;
  /** 单实例不重叠扫描，底层缓存锁保护正在读取和原子发布的文件。 */
  function clean() {
    if (running || closed) return;
    running = cache
      .cleanup()
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
      });
  }
  clean();
  const timer = setInterval(clean, 60000);
  timer.unref();
  return {
    /** 停止调度并等待已开始的回收，关闭后不会触发新的磁盘操作。 */
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
