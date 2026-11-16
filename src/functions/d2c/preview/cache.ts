import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

export type CachedPreviewFile = { path: string; mimeType: string; content: Buffer };
type RecordFile = { path: string; mimeType: string; size: number; sha256: string };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const queues = new Map<string, Promise<unknown>>();

/** 所有目录由服务端摘要生成；串行文件操作同时保护读取、发布及容量清理。 */
export function createPreviewCache(
  root = path.resolve('.runtime/previews'),
  options: { ttlMs?: number; maxBytes?: number; now?: () => number; requireIndex?: boolean } = {},
) {
  root = path.resolve(root);
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxBytes = options.maxBytes ?? 2 * 1024 ** 3;
  const requireIndex = options.requireIndex !== false;
  const verified = new Map<string, string>();

  /** 同进程共享根目录互斥，进行中的读写不会被本实例清理。 */
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    const prior = queues.get(root) ?? Promise.resolve();
    const task = prior
      .catch(() => undefined)
      .then(async () => {
        await directory(root, true);
        const lease = path.join(root, '.lease');
        const token = randomUUID();
        const marker = path.join(lease, token);
        const started = Date.now();
        while (true) {
          try {
            await mkdir(lease, { mode: 0o700 });
            const handle = await open(
              marker,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            await handle.close();
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
              const info = await lstat(lease);
              if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CACHE_PATH');
              if (Date.now() - info.mtimeMs > 300000) {
                const stale = path.join(root, `.tmp-${randomUUID()}`);
                await rename(lease, stale);
                await rm(stale, { recursive: true, force: true });
                continue;
              }
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
            }
            if (Date.now() - started > 5000) throw new Error('CACHE_BUSY');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        try {
          return await action();
        } finally {
          /** 旧进程不能删除租约过期后新持有者的锁。 */
          if (
            await lstat(marker).then(
              () => true,
              () => false,
            )
          )
            await rm(lease, { recursive: true, force: true });
        }
      });
    queues.set(root, task);
    try {
      return await task;
    } finally {
      if (queues.get(root) === task) queues.delete(root);
    }
  }

  /** 逐层拒绝符号链接；缓存根及父目录不能借链接落到任意宿主位置。 */
  async function directory(value: string, create = false) {
    let current = path.parse(value).root;
    for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create)
        await mkdir(current, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CACHE_PATH');
    }
  }

  /** 最终文件用 O_NOFOLLOW 打开，拒绝符号链接、硬链接及非普通文件。 */
  async function bytes(file: string, limit: number) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('CACHE_FILE');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  /** 摘要必须完整匹配，不接受尾随换行或路径片段。 */
  function isHash(value: string) {
    return value.length === 64 && HASH.test(value);
  }

  /** 会话标识沿用业务 ID 边界，不允许路径分隔符或空白别名。 */
  function isSessionId(value: string) {
    return value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  }

  /** 新键固定为会话、入口和输入三级目录，同时兼容历史摘要目录。 */
  function isSessionKey(key: string) {
    const parts = key.split('/');
    return (
      parts.length === 4 &&
      parts[0] === 'sessions' &&
      isSessionId(parts[1]) &&
      isHash(parts[2]) &&
      isHash(parts[3])
    );
  }

  /** 只把完整验证后的服务端键映射到缓存根内，客户端路径不参与目录解析。 */
  function location(key: string) {
    if (!isHash(key) && !isSessionKey(key)) throw new Error('CACHE_KEY');
    return path.join(root, key);
  }

  /** 检查完整清单和每个文件的摘要，未完成、过期或损坏目录均不是 ready 命中。 */
  async function load(key: string, withContent = true): Promise<CachedPreviewFile[]> {
    const dir = location(key);
    await directory(dir);
    if (now() - (await lstat(dir)).mtimeMs > ttl) throw new Error('CACHE_EXPIRED');
    const records: RecordFile[] = JSON.parse(
      (await bytes(path.join(dir, 'manifest.json'), 1024 * 1024)).toString(),
    );
    if (!Array.isArray(records) || !records.length || records.length > 500)
      throw new Error('CACHE_MANIFEST');
    const files: CachedPreviewFile[] = [];
    let total = 0;
    for (const record of records) {
      if (
        typeof record.path !== 'string' ||
        !HASH.test(record.sha256) ||
        typeof record.mimeType !== 'string' ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        files.some((file) => file.path === record.path)
      )
        throw new Error('CACHE_MANIFEST');
      total += record.size;
      if (total > Math.min(maxBytes, 30000000)) throw new Error('CACHE_LIMIT');
      const filename = path.join(dir, hash(record.path));
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== record.size)
        throw new Error('CACHE_CORRUPT');
      const stamp = JSON.stringify([
        info.ino,
        info.mtimeMs,
        info.ctimeMs,
        info.size,
        record.sha256,
      ]);
      let content = Buffer.alloc(0);
      if (withContent || verified.get(filename) !== stamp) {
        content = await bytes(filename, record.size);
        if (content.length !== record.size || hash(content) !== record.sha256)
          throw new Error('CACHE_CORRUPT');
        verified.set(filename, stamp);
        if (verified.size > 10000) verified.delete(verified.keys().next().value!);
      }
      files.push({ path: record.path, mimeType: record.mimeType, content });
    }
    if (requireIndex && !files.some((file) => file.path === 'index.html'))
      throw new Error('CACHE_MANIFEST');
    await utimes(dir, now() / 1000, now() / 1000);
    return files;
  }

  /** 删除过期结果，再按最后读取时间腾出空间；临时目录在短租约到期后回收。 */
  async function clean(incoming = 0, preserve?: string) {
    if (incoming > maxBytes) throw new Error('CACHE_LIMIT');
    await directory(root, true);
    const entries: Array<{ name: string; time: number; size: number }> = [];
    /** 按固定层级下钻，只登记版本叶子；清理不会把同会话其他入口或版本一起删除。 */
    async function visit(relative = '', level = 0) {
      for (const name of await readdir(path.join(root, relative))) {
        const key = relative ? `${relative}/${name}` : name;
        const dir = path.join(root, key);
        const temporary = level === 0 && /^\.tmp-[a-f0-9-]+$/.test(name);
        const branch =
          (level === 0 && name === 'sessions') ||
          (level === 1 && isSessionId(name)) ||
          (level === 2 && isHash(name));
        const leaf = (level === 0 || level === 3) && isHash(name);
        if (!temporary && !branch && !leaf) continue;
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (temporary) {
          if (now() - info.mtimeMs > 300000) await rm(dir, { recursive: true, force: true });
          continue;
        }
        if (branch) {
          await visit(key, level + 1);
          continue;
        }
        let size = 0;
        for (const file of await readdir(dir)) {
          const item = await lstat(path.join(dir, file));
          if (item.isFile() && !item.isSymbolicLink()) size += item.size;
        }
        entries.push({ name: key, time: info.mtimeMs, size });
      }
    }
    await visit();
    let total = entries.reduce((sum, item) => sum + (item.name === preserve ? 0 : item.size), 0);
    for (const item of entries.sort((a, b) => a.time - b.time)) {
      if (item.name === preserve) continue;
      if (now() - item.time <= ttl && total + incoming <= maxBytes) continue;
      await rm(location(item.name), { recursive: true, force: true });
      total -= item.size;
    }
    if (total + incoming > maxBytes) throw new Error('CACHE_LIMIT');
  }

  return {
    /** 查询只读取已原子发布且完整的结果；缺失不修改数据库状态。 */
    has(key: string) {
      return locked(async () => {
        try {
          await load(key, false);
          return true;
        } catch {
          return false;
        }
      });
    },
    /** 内部截图执行器复用完整构建文件，调用方负责业务权限检查。 */
    readAll(key: string) {
      return locked(() => load(key));
    },
    /** 读取时复制完整结果，清理不会中断正在返回的资源。 */
    read(key: string, filePath: string) {
      return locked(async () => {
        await load(key, false);
        const dir = location(key);
        const records: RecordFile[] = JSON.parse(
          (await bytes(path.join(dir, 'manifest.json'), 1024 * 1024)).toString(),
        );
        const record = records.find((file) => file.path === filePath);
        if (!record) throw new Error('CACHE_FILE_NOT_FOUND');
        const content = await bytes(path.join(dir, hash(record.path)), record.size);
        if (content.length !== record.size || hash(content) !== record.sha256)
          throw new Error('CACHE_CORRUPT');
        return { content, mimeType: record.mimeType };
      });
    },
    /** 在私有临时目录写完并核验后原子发布，磁盘只保留可再生成的编译输出。 */
    write(key: string, files: CachedPreviewFile[]) {
      return locked(async () => {
        const destination = location(key);
        if (
          !files.length ||
          files.length > 500 ||
          (requireIndex && !files.some((file) => file.path === 'index.html'))
        )
          throw new Error('CACHE_MANIFEST');
        const records = files.map((file) => ({
          path: file.path,
          mimeType: file.mimeType,
          size: file.content.length,
          sha256: hash(file.content),
        }));
        if (new Set(files.map((file) => file.path)).size !== files.length)
          throw new Error('CACHE_MANIFEST');
        const manifest = Buffer.from(JSON.stringify(records));
        await directory(path.dirname(destination), true);
        await clean(
          files.reduce((sum, file) => sum + file.content.length, manifest.length),
          key,
        );
        const temporary = path.join(root, `.tmp-${randomUUID()}`);
        await mkdir(temporary, { mode: 0o700 });
        try {
          for (const file of [
            ...files.map((file) => ({ name: hash(file.path), content: file.content })),
            { name: 'manifest.json', content: manifest },
          ]) {
            const handle = await open(
              path.join(temporary, file.name),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              await handle.writeFile(file.content);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          await rm(destination, { recursive: true, force: true });
          await rename(temporary, destination);
          await utimes(destination, now() / 1000, now() / 1000);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      });
    },
    /** 验证旧产物后原子移动到会话固定目录；缺失、过期或损坏返回 false，不复制或编译。 */
    migrate(oldHashKey: string, newSessionKey: string): Promise<boolean> {
      return locked(async () => {
        if (!isHash(oldHashKey) || !isSessionKey(newSessionKey)) throw new Error('CACHE_KEY');
        const source = location(oldHashKey);
        const destination = location(newSessionKey);
        try {
          await load(newSessionKey, false);
          return true;
        } catch {
          /** 目标缺失或失效时，继续核验旧目录。 */
        }
        try {
          await load(oldHashKey, false);
        } catch {
          return false;
        }
        await directory(path.dirname(destination), true);
        await rm(destination, { recursive: true, force: true });
        await rename(source, destination);
        return true;
      });
    },
    /** 启动和定期清理共用容量、过期与临时目录规则。 */
    cleanup() {
      return locked(() => clean());
    },
  };
}
export type PreviewCache = ReturnType<typeof createPreviewCache>;
