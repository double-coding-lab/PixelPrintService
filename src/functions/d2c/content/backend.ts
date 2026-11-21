import type { TextContentBackend } from './store';
import { TextContentError } from './store';

/** 只依赖可信普通文件客户端；定位、主机和对象摘要仍由客户端校验。 */
export type BinaryTextClient = {
  uploadFile(input: {
    content: Uint8Array;
    fileName: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  downloadFile(
    locator: unknown,
    options?: { signal?: AbortSignal; maxBytes?: number },
  ): Promise<Uint8Array>;
};

/** 取消使用固定错误，不透传调用方reason或存储服务异常正文。 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('正文操作已取消', 'AbortError');
}

/**
 * 为加密正文复用普通文件传输；调用方只传正文协议产生的密文和.bin对象键。
 * maxObjectBytes声明实际传输上限，由正文工厂检查明文限额加36字节封装是否可用。
 * 不装配客户端、不读取配置，也不提供对象公开地址。
 */
export function createBinaryTextBackend(
  client: BinaryTextClient,
  maxObjectBytes: number,
): TextContentBackend {
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1)
    throw new TextContentError('INVALID_CONFIG');
  return {
    maxObjectBytes,
    /** 仅传输加密字节，不参与图片上传或重命名冲突策略。 */
    async put({ key, bytes, signal }) {
      checkAbort(signal);
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > maxObjectBytes)
        throw new TextContentError('INVALID_TEXT');
      try {
        const locator = await client.uploadFile({
          fileName: key,
          content: bytes,
          contentType: 'application/octet-stream',
          signal,
        });
        checkAbort(signal);
        return locator;
      } catch {
        checkAbort(signal);
        throw new TextContentError('UPLOAD_FAILED');
      }
    },
    /** 请求前检查声明大小，客户端在流中执行相同限额及完整定位校验。 */
    async get(locator, { maxBytes, signal }) {
      checkAbort(signal);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        !Number.isSafeInteger(locator.size) ||
        (locator.size as number) < 1 ||
        (locator.size as number) > Math.min(maxBytes, maxObjectBytes)
      )
        throw new TextContentError('INVALID_REFERENCE');
      let bytes: Uint8Array;
      try {
        bytes = await client.downloadFile(locator, {
          signal,
          maxBytes: Math.min(maxBytes, maxObjectBytes),
        });
      } catch {
        checkAbort(signal);
        throw new TextContentError('DOWNLOAD_FAILED');
      }
      checkAbort(signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== locator.size)
        throw new TextContentError('INTEGRITY_FAILED');
      return bytes;
    },
  };
}
