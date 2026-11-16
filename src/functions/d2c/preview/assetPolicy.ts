import { projectConfig } from '@/config/project';

/** 与存储公开地址一致；只允许该路径下的图片，不开放整个服务或任意外部来源。 */
export function previewAssetBase(): string {
  const base = new URL(
    projectConfig.storage.publicUrl || new URL('/files/', projectConfig.server.publicUrl).href,
  );
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('PREVIEW_ASSET_CONFIG_INVALID');
  base.pathname = base.pathname.replace(/\/?$/, '/');
  return base.href;
}
