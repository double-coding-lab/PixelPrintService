import { projectConfig } from '@/config/project';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StorageFileObject = {
  provider: 'local' | 's3';
  fileName: string;
  url: string;
  sha256: string;
  size: number;
  mimeType: string;
};
export type StorageFileClient = {
  uploadFile(input: {
    content: Uint8Array;
    fileName: string;
    contentType: string;
    /** 同名不同内容时追加数字后缀，同内容直接复用。 */
    renameOnConflict?: boolean;
    signal?: AbortSignal;
  }): Promise<StorageFileObject>;
  downloadFile(locator: unknown): Promise<Buffer>;
};
export type StorageFailure =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'ACCESS_DENIED'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'INTEGRITY'
  | 'UNAVAILABLE'
  | 'INVALID_CONFIG';

/** 固定错误分类，不把凭据、对象内容和供应商错误正文带入日志。 */
export class StorageError extends Error {
  readonly code?: number;
  readonly networkCode?: string;
  constructor(
    public readonly stage: 'config' | 'upload' | 'download',
    public readonly reason: StorageFailure,
    public readonly statusCode: number,
  ) {
    super(`Storage ${reason.toLowerCase()}`);
    this.name = 'StorageError';
    if (reason === 'TIMEOUT') this.networkCode = 'ETIMEDOUT';
  }
}

/** 摘要使用实际内容计算，不信任客户端或 S3 ETag。 */
function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 仅接受相对对象键，拒绝 URL 编码、路径穿越及 Windows 路径。 */
function validKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    Buffer.byteLength(key) <= 512 &&
    !/[\\%?#:\u0000-\u001f\u007f]/u.test(key) &&
    key.split('/').every((part) => part.trim() && part !== '.' && part !== '..')
  );
}

/** 按实际系统和 HTTP 状态分类；只有明确不存在才允许创建新对象。 */
function failure(error: unknown, stage: 'upload' | 'download'): StorageError {
  if (error instanceof StorageError)
    return error.stage === stage ? error : new StorageError(stage, error.reason, error.statusCode);
  const value = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
  const status = value?.$metadata?.httpStatusCode;
  if (value?.name === 'NoSuchBucket') return new StorageError('config', 'INVALID_CONFIG', 503);
  if (value?.name === 'AbortError') return new StorageError(stage, 'ABORTED', 499);
  if (value?.name === 'TimeoutError' || value?.code === 'ETIMEDOUT')
    return new StorageError(stage, 'TIMEOUT', 504);
  if (value?.code === 'ENOENT' || status === 404 || value?.name === 'NoSuchKey')
    return new StorageError(stage, 'NOT_FOUND', 404);
  if (['EACCES', 'EPERM'].includes(value?.code ?? '') || status === 401 || status === 403)
    return new StorageError(stage, 'ACCESS_DENIED', 403);
  if (value?.code === 'EEXIST' || status === 409 || status === 412)
    return new StorageError(stage, 'CONFLICT', 409);
  if (value?.code === 'ELOOP') return new StorageError(stage, 'INVALID_INPUT', 400);
  return new StorageError(stage, 'UNAVAILABLE', 503);
}

/** 创建通用存储边界；第二参数仅保留调用兼容，不再参与环境或通道选择。 */
export function createStorageFileClient(
  readConfig: () => unknown,
  _environment?: string,
): StorageFileClient {
  const settings = projectConfig.storage;
  let client: S3Client | undefined;

  /** 校验服务器配置，公开 URL 必须是前端能直接请求的 HTTP(S) 地址。 */
  function config() {
    try {
      const raw = readConfig() as {
        d2c?: { storage?: { enabled?: boolean }; limits?: { uploadBytes?: number } };
      };
      if (raw?.d2c?.storage?.enabled === false) throw new Error();
      const maxBytes = raw?.d2c?.limits?.uploadBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes! <= 0) throw new Error();
      if (!['local', 's3'].includes(settings.driver)) throw new Error();
      const base = new URL(
        settings.publicUrl || new URL('/files/', projectConfig.server.publicUrl).href,
      );
      if (
        !['http:', 'https:'].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        (settings.driver === 'local' && !settings.directory) ||
        (settings.driver === 's3' && (!settings.bucket || !settings.region || !settings.publicUrl))
      )
        throw new Error();
      if (!base.pathname.endsWith('/')) base.pathname += '/';
      return { maxBytes: maxBytes!, base, root: path.resolve(settings.directory) };
    } catch {
      throw new StorageError('config', 'INVALID_CONFIG', 503);
    }
  }

  /** 对象 URL 只由已配置前缀和安全对象键构造，从不请求定位里的任意 URL。 */
  function locator(key: string, content: Buffer, mimeType: string): StorageFileObject {
    return {
      provider: settings.driver,
      fileName: key,
      url: new URL(key.split('/').map(encodeURIComponent).join('/'), config().base).href,
      sha256: digest(content),
      size: content.length,
      mimeType,
    };
  }

  /** 每层拒绝符号链接并复核真实父路径，根目录由服务端配置控制。 */
  async function localPath(key: string, create: boolean) {
    const { root } = config();
    if (create) await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink())
      throw new StorageError('download', 'INVALID_INPUT', 400);
    const canonicalRoot = await realpath(root);
    let parent = root;
    for (const piece of key.split('/').slice(0, -1)) {
      parent = path.join(parent, piece);
      if (create)
        await mkdir(parent).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink())
        throw new StorageError('download', 'INVALID_INPUT', 400);
      const relative = path.relative(canonicalRoot, await realpath(parent));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new StorageError('download', 'INVALID_INPUT', 400);
    }
    return path.join(parent, path.basename(key));
  }

  /** S3 使用服务端凭据，SDK 自带有界重试；不向前端返回签名或密钥。 */
  function s3() {
    return (client ??= new S3Client({
      region: settings.region,
      endpoint: settings.endpoint || undefined,
      forcePathStyle: settings.forcePathStyle,
      credentials:
        settings.accessKeyId && settings.secretAccessKey
          ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey }
          : undefined,
      maxAttempts: 3,
    }));
  }

  /** 流式限额读取 S3，提前拒绝过大对象且不保留部分结果。 */
  async function read(key: string, max: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (settings.driver === 'local') {
      const file = await open(
        await localPath(key, false),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > max) throw new StorageError('download', 'INTEGRITY', 422);
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== bytes.length || (await file.stat()).size !== stat.size)
          throw new StorageError('download', 'INTEGRITY', 422);
        return bytes;
      } finally {
        await file.close();
      }
    }
    const result = await s3().send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }), {
      abortSignal: signal,
    });
    const body = result.Body;
    if (!body) throw new StorageError('download', 'INTEGRITY', 422);
    try {
      if ((result.ContentLength ?? 0) > max) throw new StorageError('download', 'INTEGRITY', 422);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        signal?.throwIfAborted();
        total += chunk.length;
        if (total > max) throw new StorageError('download', 'INTEGRITY', 422);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    } finally {
      (body as { destroy?: () => void }).destroy?.();
    }
  }

  return {
    /** 先读取摘要比较，再以排他写入创建；任何故障均不会覆盖已有稳定键。 */
    async uploadFile(input) {
      const { maxBytes } = config();
      if (
        !validKey(input.fileName) ||
        !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.contentType) ||
        !(input.content instanceof Uint8Array) ||
        !input.content.length
      )
        throw new StorageError('upload', 'INVALID_INPUT', 400);
      if (input.content.length > maxBytes) throw new StorageError('upload', 'INVALID_INPUT', 413);
      const content = Buffer.from(input.content);
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      try {
        for (let suffix = 1; suffix <= 101; suffix++) {
          signal.throwIfAborted();
          const extension = path.posix.extname(input.fileName);
          const key =
            suffix === 1
              ? input.fileName
              : `${input.fileName.slice(0, input.fileName.length - extension.length)}_${suffix}${extension}`;
          if (!validKey(key)) throw new StorageError('upload', 'INVALID_INPUT', 400);
          const result = locator(key, content, input.contentType);
          let exists = false;
          try {
            const previous = await read(key, maxBytes, signal);
            exists = true;
            if (previous.length === content.length && digest(previous) === result.sha256)
              return result;
          } catch (error) {
            if (error instanceof StorageError && error.reason === 'INTEGRITY') exists = true;
            else if (failure(error, 'upload').reason !== 'NOT_FOUND') throw error;
          }
          if (exists) {
            if (input.renameOnConflict) continue;
            throw new StorageError('upload', 'CONFLICT', 409);
          }
          try {
            if (settings.driver === 'local') {
              const destination = await localPath(key, true);
              const temporary = path.join(path.dirname(destination), `.upload-${randomUUID()}`);
              try {
                await writeFile(temporary, content, { flag: 'wx', signal });
                signal.throwIfAborted();
                await link(temporary, destination);
              } finally {
                await unlink(temporary).catch(() => {});
              }
            } else {
              await s3().send(
                new PutObjectCommand({
                  Bucket: settings.bucket,
                  Key: key,
                  Body: content,
                  ContentType: input.contentType,
                  IfNoneMatch: '*',
                  Metadata: { sha256: result.sha256 },
                }),
                { abortSignal: signal },
              );
            }
            return result;
          } catch (error) {
            if (failure(error, 'upload').reason !== 'CONFLICT') throw error;
            const previous = await read(key, maxBytes, signal);
            if (previous.length === content.length && digest(previous) === result.sha256)
              return result;
            if (!input.renameOnConflict) throw new StorageError('upload', 'CONFLICT', 409);
          }
        }
        throw new StorageError('upload', 'CONFLICT', 409);
      } catch (error) {
        if (signal.aborted) throw failure(signal.reason, 'upload');
        throw failure(error, 'upload');
      }
    },
    /** 仅接收业务数据库已登记的完整定位；限定 provider、公开前缀和键，复核字节及摘要。 */
    async downloadFile(value) {
      const { maxBytes, base } = config();
      const object = value as StorageFileObject;
      if (
        !object ||
        object.provider !== settings.driver ||
        !validKey(object.fileName) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 1 ||
        object.size > maxBytes ||
        !/^[a-f0-9]{64}$/.test(object.sha256) ||
        typeof object.mimeType !== 'string' ||
        object.url !==
          new URL(object.fileName.split('/').map(encodeURIComponent).join('/'), base).href
      )
        throw new StorageError('download', 'INVALID_INPUT', 400);
      try {
        const bytes = await read(object.fileName, object.size, AbortSignal.timeout(60_000));
        if (bytes.length !== object.size || digest(bytes) !== object.sha256)
          throw new StorageError('download', 'INTEGRITY', 422);
        return bytes;
      } catch (error) {
        throw failure(error, 'download');
      }
    },
  };
}
