/** 冻结封面仅保存不带鉴权信息的图片地址，不从生成配置读取任意资源。 */
export function safeRuntimeCoverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value))
    return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.href
      : null;
  } catch {
    return null;
  }
}
