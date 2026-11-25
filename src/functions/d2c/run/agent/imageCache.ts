/** 仅供单个 Run 的附件 resolver 持有；键由当前已鉴权行的 SHA 和输入版本组成。 */
export function createRunImageCache(maxBytes = 40 * 1024 * 1024, maxEntries = 4) {
  const entries = new Map<string, Buffer>();
  let bytes = 0;
  return {
    /** 返回副本，调用方不能改写已校验缓存。 */
    get(version: string): Buffer | undefined {
      const data = entries.get(version);
      if (!data) return;
      entries.delete(version);
      entries.set(version, data);
      return Buffer.from(data);
    },
    /** 只在下载及所有完整性检查成功后写入；失败和缺图均不缓存。 */
    set(version: string, data: Buffer) {
      const previous = entries.get(version);
      if (previous) bytes -= previous.length;
      entries.delete(version);
      if (!data.length || data.length > maxBytes) return;
      entries.set(version, Buffer.from(data));
      bytes += data.length;
      while (bytes > maxBytes || entries.size > maxEntries) {
        const oldest = entries.keys().next().value!;
        bytes -= entries.get(oldest)!.length;
        entries.delete(oldest);
      }
    },
  };
}
export type RunImageCache = ReturnType<typeof createRunImageCache>;
