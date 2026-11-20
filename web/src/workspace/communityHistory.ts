import { data } from './api';
import type { TimelinePage } from './types';

/** 串行补读公开历史；每页立即交付，取消后不交付迟到响应，也不启动下一页。 */
export async function readPublicHistory(
  root: string,
  beforeSeq: number,
  signal: AbortSignal,
  onPage: (page: TimelinePage, nextCursor: number) => void,
  request: typeof data = data,
): Promise<void> {
  let cursor = beforeSeq;
  while (!signal.aborted) {
    const page = await request<TimelinePage>(`${root}/timeline?beforeSeq=${cursor}&limit=500`, {
      signal,
    });
    if (signal.aborted) return;
    if (!Array.isArray(page.entries) || typeof page.hasMore !== 'boolean')
      throw new Error('历史记录响应无效');
    const before = page.previousSeq ?? page.entries[0]?.seq ?? 0;
    if (
      page.hasMore &&
      (!Number.isSafeInteger(before) || before <= 0 || (cursor > 0 && before >= cursor))
    )
      throw new Error('历史记录游标无效，请稍后重试');
    onPage(page, before);
    if (!page.hasMore) return;
    cursor = before;
  }
}
