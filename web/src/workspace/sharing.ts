import { createContext } from 'react';
import { data, id } from './api';
import type { TimelineEntry } from './types';

export type Sharing = { public: boolean; shareId: string | null; canManage: boolean };
export type SharedSession = {
  shareId: string;
  coverUrl?: string | null;
  coverOriginalUrl?: string | null;
  sessionId: string;
  name: string;
  target: 'h5' | 'rn';
  creatorName: string | null;
  createdEid: string | null;
  createdAt: string;
  fileRevision: number;
  timelineSeq: number;
  canManage?: boolean;
  sourceSession?: { workspaceId: string; sessionId: string } | null;
};
export type PersonalWork = {
  coverUrl?: string | null;
  coverOriginalUrl?: string | null;
  workId: string;
  name: string;
  target: 'h5' | 'rn';
  revision: number;
  createdAt: string;
  updatedAt?: string;
  canManage?: boolean;
};
export type CollectionPage<T> = { items: T[]; total: number; page: number; pageSize: number };
export const SessionReadRoot = createContext<string | undefined>(undefined);

/** 新集合独立遵循 items 分页契约，不改变现有 versions 的 rows 协议。 */
export async function readCollection<T>(path: string, signal?: AbortSignal) {
  const value = await data<CollectionPage<T>>(path, { signal });
  if (!Array.isArray(value?.items) || !Number.isSafeInteger(value.total) || value.total < 0)
    throw new Error('列表响应无效');
  return value;
}

/** 副本只使用公开资源或本人作品命名空间。 */
export function detachedEditOptions(kind: 'plaza' | 'my-works', resourceId: string) {
  return {
    detached: true,
    root:
      kind === 'plaza'
        ? `/plaza/sessions/${id(resourceId)}/edit`
        : `/my-works/${id(resourceId)}/edit`,
  };
}

/** 附件重新定位到广场鉴权路径，不能回退访问原私有会话。 */
export function publicTimelineEntry(entry: TimelineEntry, shareId: string): TimelineEntry {
  return {
    ...entry,
    data: {
      ...entry.data,
      attachments: entry.data.attachments?.map((attachment) => ({
        ...attachment,
        url: `/api/d2c/plaza/sessions/${id(shareId)}/attachments/${id(attachment.attachmentId)}`,
      })),
    },
  };
}
