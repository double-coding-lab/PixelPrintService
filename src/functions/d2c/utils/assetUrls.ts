import { appConfig } from '@/config';

/** 将真实上传对象标识映射到本地配置的访问前缀；兼容只有 URL 的历史定位。 */
export function assetUrl(
  locator: Record<string, unknown>,
  baseUrl: string = appConfig.storage.imagePreviewBaseUrl,
): string | null {
  try {
    const fileName = locator.fileName;
    let value: string;
    if (typeof fileName === 'string' && fileName.includes('/')) {
      const parts = fileName.split('/');
      if (
        parts.some(
          (part) =>
            !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f%?#]/u.test(part),
        )
      )
        return null;
      const prefix = baseUrl.replace(/\/?$/, '/');
      value = prefix + parts.map(encodeURIComponent).join('/');
    } else value = String(locator.url ?? '');
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
