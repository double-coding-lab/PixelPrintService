/** 可信上传回执优先提供二进制类型；兼容历史通用类型，缺失时沿用合法存量类型。 */
export function binaryMimeType(
  locator: Record<string, unknown> | null | undefined,
  stored?: string | null,
): string {
  const normalize = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 200) return undefined;
    const mime = value.trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : undefined;
  };
  const uploaded = normalize(locator?.mimeType);
  return uploaded && uploaded !== 'application/octet-stream'
    ? uploaded
    : (normalize(stored) ?? 'application/octet-stream');
}
