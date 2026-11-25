import { createHash, randomUUID } from 'node:crypto';
import { createPreviewCache } from '../preview/cache';
import { createWebpThumbnail } from '../utils/webpThumbnail';
import { variantId, type ImageVariantStore, type VariantClaim } from './variantStore';
import type { StorageFileClient, StorageFileObject } from '@/hooks/tools/storage';

const sha = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const supported = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/x-icon',
]);
type Report = (phase: string, imageId?: string) => void;

/** 只接受已上传对象的完整定位；失败不发布派生地址，也不会覆盖原图。 */
function validLocator(value: unknown): value is StorageFileObject {
  if (!value || typeof value !== 'object') return false;
  const item = value as StorageFileObject;
  try {
    const url = new URL(item.url);
    return (
      ['local', 's3'].includes(item.provider) &&
      typeof item.fileName === 'string' &&
      typeof item.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.size) &&
      item.size > 0 &&
      item.size <= 30_000_000 &&
      typeof item.mimeType === 'string' &&
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Redis 记录待办与结果；单进程串行处理，其他实例通过租约竞争，停机后待办可重领。 */
export function createImageVariants(options: {
  store: ImageVariantStore;
  binary: StorageFileClient;
  convert?: typeof createWebpThumbnail;
  report?: Report;
  cache?: ReturnType<typeof createPreviewCache>;
  autoStart?: boolean;
  enabled?: () => boolean;
}) {
  const cache =
    options.cache ??
    createPreviewCache('.runtime/image-webp', {
      requireIndex: false,
      maxBytes: 256 * 1024 ** 2,
      ttlMs: 7 * 86400000,
    });
  const inFlight = new Map<string, Promise<Buffer>>();
  let stopped = false;
  let failureDelay = 1000;
  let nextDelay = 1000;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const report = (phase: string, imageId?: string) => {
    try {
      options.report?.(phase, imageId);
    } catch {}
  };
  const enabled = () => {
    try {
      return options.enabled?.() ?? true;
    } catch {
      report('config');
      return false;
    }
  };

  /** 磁盘缓存损坏/缺失只导致重新读取；缓存写失败不影响已上传图片。 */
  async function read(locator: StorageFileObject, signal?: AbortSignal): Promise<Buffer> {
    const key = sha(Buffer.from(`${locator.url}\n${locator.sha256}`));
    if (inFlight.has(key)) return inFlight.get(key)!;
    const task = (async () => {
      try {
        const hit = await cache.read(key, 'image');
        if (hit.content.length === locator.size && sha(hit.content) === locator.sha256)
          return hit.content;
      } catch {}
      const content = await options.binary.downloadFile(locator, {
        signal,
        maxBytes: locator.size,
      });
      if (content.length !== locator.size || sha(content) !== locator.sha256)
        throw new Error('IMAGE_VARIANT_CONTENT');
      try {
        await cache.write(key, [{ path: 'image', mimeType: locator.mimeType, content }]);
      } catch {
        report('cache');
      }
      return content;
    })();
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  /** 后台失败最多重试三次；仅成功上传的真实 WebP 回执进入结果索引。 */
  async function process(claim: VariantClaim) {
    if (!claim.job.required && !enabled()) {
      await options.store.discard(claim);
      return;
    }
    const { source, fileName, attempts } = claim.job;
    if (
      !validLocator(source) ||
      variantId(source.url) !== claim.id ||
      !supported.has(source.mimeType) ||
      typeof fileName !== 'string' ||
      !Number.isInteger(attempts) ||
      attempts < 0 ||
      attempts > 3
    )
      throw new Error('IMAGE_VARIANT_JOB');
    controller = new AbortController();
    const deadline = setTimeout(() => controller?.abort(), 90000);
    deadline.unref?.();
    try {
      const input = await read(source, controller.signal);
      const content = await (options.convert ?? createWebpThumbnail)(input, controller.signal);
      const locator = await options.binary.uploadFile({
        content,
        contentType: 'image/webp',
        fileName:
          Buffer.byteLength(fileName) <= 500 ? `${fileName}_.webp` : `webp-${claim.id}.webp`,
        renameOnConflict: true,
        signal: controller.signal,
      });
      if (
        !validLocator(locator) ||
        locator.mimeType !== 'image/webp' ||
        locator.size !== content.length ||
        locator.sha256 !== sha(content)
      )
        throw new Error('IMAGE_VARIANT_UPLOAD');
      await options.store.complete(claim, { sourceSha: source.sha256, locator });
      try {
        await cache.write(sha(Buffer.from(`${locator.url}\n${locator.sha256}`)), [
          { path: 'image', mimeType: locator.mimeType, content },
        ]);
      } catch {
        report('cache');
      }
    } finally {
      clearTimeout(deadline);
      controller = undefined;
    }
  }

  /** 队列指向固定存储对象，不把大量原图字节堆积在 Node 或 Redis 内存中。 */
  function wake() {
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void runOnce(), 0);
    timer.unref?.();
  }
  async function runOnce() {
    if (stopped || running) return running;
    running = (async () => {
      try {
        const claim = await options.store.claim(randomUUID());
        failureDelay = 1000;
        nextDelay = claim ? 0 : 1000;
        if (claim) {
          try {
            await process(claim);
          } catch {
            if (!stopped) {
              report('generate', claim.id);
              await options.store.retry(claim);
            }
          }
        }
      } catch {
        failureDelay = Math.min(30000, failureDelay * 2);
        nextDelay = failureDelay;
        if (!stopped) report('queue');
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
      if (!stopped && options.autoStart !== false) {
        timer = setTimeout(() => void runOnce(), nextDelay);
        timer.unref?.();
      }
    }
  }

  /** 不返回待办 Promise 给上传调用方；Redis 故障也不能延迟或拒绝原图成功响应。 */
  function enqueue(source: StorageFileObject, fileName = source.fileName, required = false) {
    if (stopped || !validLocator(source) || !supported.has(source.mimeType)) return;
    setImmediate(() => {
      if (stopped) return;
      const id = variantId(source.url);
      void (async () => {
        await options.store.remember(id, source);
        if (required || enabled())
          await options.store.enqueue(id, { source, fileName, attempts: 0, required });
      })().then(
        () => {
          if (options.autoStart !== false) wake();
        },
        () => report('enqueue', variantId(source.url)),
      );
    });
  }

  /** 地址索引可以跨实例复用，但读取前后的业务鉴权由调用服务执行。 */
  async function find(source: StorageFileObject) {
    try {
      const [hit] = await options.store.get([variantId(source.url)]);
      if (
        hit?.sourceSha === source.sha256 &&
        validLocator(hit.locator) &&
        hit.locator.mimeType === 'image/webp'
      )
        return hit.locator;
      if (hit) await options.store.invalidate(variantId(source.url));
    } catch {
      report('lookup');
    }
    enqueue(source, source.fileName, true);
    return null;
  }
  async function preferredUrls(urls: string[]) {
    const result = new Map<string, string>();
    try {
      const ids = urls.map(variantId);
      const [rows, sources] = await Promise.all([
        options.store.get(ids),
        options.store.sources(ids),
      ]);
      for (const [i, url] of urls.entries()) {
        const hit = rows[i];
        if (
          hit &&
          (!sources[i] || sources[i]?.sha256 === hit.sourceSha) &&
          /^[a-f0-9]{64}$/.test(hit.sourceSha) &&
          validLocator(hit.locator) &&
          hit.locator.mimeType === 'image/webp'
        )
          result.set(url, hit.locator.url);
        else {
          const source = sources[i];
          if (validLocator(source) && source.url === url) {
            // 作品封面不受普通图片开关影响；旧上传可按保存的真实回执补生成。
            if (hit) await options.store.invalidate(ids[i]);
            enqueue(source, source.fileName, true);
          }
        }
      }
    } catch {
      report('lookup');
    }
    return result;
  }
  if (options.autoStart !== false) wake();
  return {
    enqueue,
    find,
    read,
    preferredUrls,
    async invalidate(source: StorageFileObject) {
      try {
        await options.store.invalidate(variantId(source.url));
      } catch {
        report('lookup');
      }
      enqueue(source, source.fileName, true);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      await running;
    },
    runOnce,
  };
}
export type ImageVariants = ReturnType<typeof createImageVariants>;

/** 包装只等待原图上传，派生上传使用原始 client，不递归生成 WebP 的 WebP。 */
export function withImageVariants(
  binary: StorageFileClient,
  variants: () => Pick<ImageVariants, 'enqueue'> | undefined,
): StorageFileClient {
  return {
    downloadFile: (...args) => binary.downloadFile(...args),
    async uploadFile(input) {
      const original = await binary.uploadFile(input);
      const source = { ...original };
      const fileName = input.fileName;
      const required = input.webpRequired === true;
      setImmediate(() => {
        try {
          variants()?.enqueue(source, fileName, required);
        } catch {}
      });
      return original;
    },
  };
}
