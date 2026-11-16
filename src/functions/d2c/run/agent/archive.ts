import { maxReadCharacters } from './context';
import { createHash } from 'node:crypto';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { StateBackend, type BackendProtocolV2, type FileData } from 'deepagents';
import type { D2cMySQLCheckpointSaver } from './checkpoint';

export const archivePrefix = '/history/';
const namespace = '__pixelprint_internal_history';
const maxBytes = 8 * 1024 * 1024;

/** 内部历史只写检查点表的独立 namespace；工具得到读取能力，不能改写或作为产物列出。 */
export function createHistoryArchive(input: {
  checkpoint: Pick<D2cMySQLCheckpointSaver, 'config' | 'getTuple' | 'put'>;
  guard: () => Promise<void>;
}) {
  let failure: unknown;
  /** 允许 SDK 生成的历史文件和平台生成的工具归档，拒绝目录穿越与其他虚拟根。 */
  function location(path: string) {
    if (!/^\/history\/(?:tools\/)?[A-Za-z0-9_-]+\.(?:md|json)$/.test(path))
      throw new Error('DEEP_ARCHIVE_PATH');
    return createHash('sha256').update(path).digest('hex');
  }
  /** 每次操作检查取消和租约；存储失败锁住本轮后续摘要，SDK 的容错不能吞掉失败。 */
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    await input.guard();
    if (failure) throw new Error('DEEP_ARCHIVE_FAILED');
    try {
      const result = await action();
      await input.guard();
      return result;
    } catch (error) {
      failure = error;
      throw new Error('DEEP_ARCHIVE_FAILED');
    }
  }
  /** hash 命中继续核对原路径，内部载荷也检查大小和正文类型。 */
  async function load(path: string) {
    const row = await input.checkpoint.getTuple(input.checkpoint.config(namespace, location(path)));
    if (!row) return undefined;
    const file = row.checkpoint.channel_values.archive as
      | { path?: unknown; content?: unknown }
      | undefined;
    if (
      file?.path !== path ||
      typeof file.content !== 'string' ||
      Buffer.byteLength(file.content) > maxBytes
    )
      throw new Error('DEEP_ARCHIVE_INVALID');
    return file.content;
  }
  /** 仅平台/中间件持有写方法，模型的 write_file 继续走业务文件工具。 */
  async function save(path: string, content: string, createOnly = false) {
    return operation(async () => {
      const id = location(path);
      if (Buffer.byteLength(content) > maxBytes) throw new Error('DEEP_ARCHIVE_LIMIT');
      if (createOnly && (await load(path)) !== undefined) throw new Error('DEEP_ARCHIVE_EXISTS');
      const checkpoint = emptyCheckpoint();
      checkpoint.id = id;
      checkpoint.channel_values = { archive: { path, content } };
      await input.checkpoint.put(
        input.checkpoint.config(namespace),
        checkpoint,
        { source: 'update', step: 0, parents: {} },
        {},
      );
      return { path };
    });
  }
  /** 复用 SDK 的行号/分页实现，镜像只含当前文件，不把内部历史塞回图 files。 */
  async function source(path: string) {
    const content = await load(path);
    const files: Record<string, FileData> =
      content === undefined
        ? {}
        : {
            [path]: {
              content,
              mimeType: 'text/plain',
              created_at: '1970-01-01T00:00:00.000Z',
              modified_at: '1970-01-01T00:00:00.000Z',
            },
          };
    return new StateBackend({ state: { files } });
  }
  const backend: BackendProtocolV2 = {
    ls: async () => ({ files: [], error: '内部历史按已知路径读取' }),
    glob: async () => ({ files: [], error: '内部历史按已知路径读取' }),
    grep: async () => ({ matches: [], error: '内部历史按已知路径读取' }),
    read: (path, offset, limit) =>
      operation(async () => (await source(path)).read(path, offset, limit)),
    readRaw: (path) => operation(async () => (await source(path)).readRaw(path)),
    write: (path, content) => save(path, content, true),
    edit: async () => ({ error: '内部历史仅允许平台保存' }),
    delete: async () => ({ error: '内部历史仅允许平台保存' }),
    uploadFiles: async (files) => {
      const result = [];
      for (const [path, bytes] of files) {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        await save(path, content);
        result.push({ path, error: null });
      }
      return result;
    },
    downloadFiles: (paths) =>
      operation(async () => {
        const result = [];
        for (const path of paths) {
          const content = await load(path);
          result.push(
            content === undefined
              ? { path, content: null, error: 'file_not_found' as const }
              : { path, content: new TextEncoder().encode(content), error: null },
          );
        }
        return result;
      }),
  };
  return {
    backend,
    save,
    /** 平台读取可选的私有摘要缓存；未命中正常返回，存储损坏仍中止。 */
    load: (path: string) => operation(() => load(path)),
    /** 中间件可能捕获后端异常；进入下一次模型请求前必须再次检查。 */
    assertHealthy() {
      if (failure) throw new Error('DEEP_ARCHIVE_FAILED');
    },
    /** 保持平台 read_file 的字符分页协议；目录不出现在用户文件列表。 */
    async readText(path: string, offset: number, length: number) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > maxReadCharacters
      )
        throw new Error('DEEP_ARCHIVE_PAGE');
      return operation(async () => {
        const content = await load(path);
        if (content === undefined) throw new Error('DEEP_ARCHIVE_MISSING');
        return JSON.stringify({
          path,
          offset,
          totalCharacters: content.length,
          content: content.slice(offset, offset + length),
          nextOffset: offset + length < content.length ? offset + length : null,
        });
      });
    },
  };
}

export type HistoryArchive = ReturnType<typeof createHistoryArchive>;
