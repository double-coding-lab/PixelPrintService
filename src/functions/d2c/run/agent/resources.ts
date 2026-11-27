import { markdownOutline } from './markdownOutline';
import { createHash } from 'node:crypto';
import { maxReadCharacters } from './context';
import { StateBackend, type BackendProtocolV2, type FileData } from 'deepagents';
import { validateResourceBundle, type ResourceBundle } from '../../workspace/resources';
import { resolveTarget, type PixelPrintTarget } from '../../utils/targets';
import { normalizeReadPath } from '../../utils/readPath';
import type { SubagentRole } from '../subagent';
import { fixedResourceReadGuidance } from './readPolicy';

export const resourcePrefix = '/resources/';

/** 将 Skill 原有相对路径与原生发现的虚拟路径统一为包内路径，拒绝主机绝对路径。 */
export function resourceRelativePath(value: string) {
  const relative = value.startsWith(resourcePrefix)
    ? value.slice(resourcePrefix.length).replace(/^\/+/, '')
    : value;
  try {
    return normalizeReadPath(relative);
  } catch {
    throw new Error('固定资源路径无效');
  }
}

/**
 * 将已固定的完整资源包挂载为原生 Skill Backend；只读内存镜像来自稳定资源包，
 * 不读取平台最新模板、宿主文件系统或模型检查点中的 files。
 */
export function createFixedResourceBackend(input: {
  bundle: ResourceBundle;
  bundleHash: string;
  target: PixelPrintTarget;
  role?: SubagentRole;
  assertLease: () => Promise<void>;
  signal: AbortSignal;
}) {
  const bundle = validateResourceBundle(input.bundle);
  if (bundle.hash !== input.bundleHash) throw new Error('固定资源摘要不匹配');
  if (input.target !== 'h5' && input.target !== 'rn') throw new Error('固定资源目标无效');
  const files: Record<string, Extract<FileData, { mimeType: string }>> = Object.create(null);
  const implementationPaths = new Set<string>();
  for (const file of bundle.files) {
    // 角色视图在构造内存Backend前完成；搜索和下载也不能接触UI受限实现的原字节。
    const guidance = fixedResourceReadGuidance(file.path, input.role);
    let content: string | Uint8Array;
    if (guidance) {
      content = guidance;
      implementationPaths.add(resourcePrefix + file.path);
    } else {
      const bytes = Buffer.from(file.content, 'base64');
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        content = Uint8Array.from(bytes);
      }
    }
    files[resourcePrefix + file.path] = {
      content,
      mimeType: typeof content === 'string' ? 'text/plain' : 'application/octet-stream',
      created_at: '1970-01-01T00:00:00.000Z',
      modified_at: '1970-01-01T00:00:00.000Z',
    };
  }
  /** 原生 StateBackend 仅复用其读取、分页和搜索协议，不让它接收图状态或写入。 */
  const source = new StateBackend({ state: { files } });
  // 发现接口仅展示可阅读资料；直接请求实现路径时，source返回普通阅读引导。
  const visibleFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => !implementationPaths.has(path)),
  );
  const discovery = implementationPaths.size
    ? new StateBackend({ state: { files: visibleFiles } })
    : source;
  const denied = '固定 Skill 资源只读';
  /** 每次读取重新检查取消与执行资格；返回副本，调用方不能修改包内字节。 */
  async function read<T>(action: () => T | Promise<T>) {
    input.signal.throwIfAborted();
    await input.assertLease();
    input.signal.throwIfAborted();
    const result = structuredClone(await action());
    input.signal.throwIfAborted();
    await input.assertLease();
    input.signal.throwIfAborted();
    return result;
  }
  /** Backend 的路径只属于资源虚拟根，普通执行文件由原有受控能力负责。 */
  function location(value: string, directory = false) {
    if (value === '/resources' || /^\/resources\/+$/u.test(value)) return resourcePrefix;
    if (directory && value.endsWith('/')) value = value.slice(0, -1);
    return resourcePrefix + resourceRelativePath(value);
  }
  const backend: BackendProtocolV2 = {
    ls: (value) => read(() => discovery.ls(location(value, true))),
    read: (value, offset, limit) => read(() => source.read(location(value), offset, limit)),
    readRaw: (value) => read(() => source.readRaw(location(value))),
    glob: (pattern, root) =>
      read(() => discovery.glob(pattern, location(root ?? resourcePrefix, true))),
    grep: (pattern, root, glob, maxCount) =>
      read(() => discovery.grep(pattern, location(root ?? resourcePrefix, true), glob, maxCount)),
    write: async () => ({ error: denied }),
    edit: async () => ({ error: denied }),
    delete: async () => ({ error: denied }),
    uploadFiles: async (values) => values.map(([path]) => ({ path, error: 'permission_denied' })),
    downloadFiles: (values) =>
      read(() =>
        values.map((value) => {
          const file = files[location(value)];
          return file
            ? {
                path: value,
                content:
                  typeof file.content === 'string'
                    ? new TextEncoder().encode(file.content)
                    : file.content,
                error: null,
              }
            : { path: value, content: null, error: 'file_not_found' as const };
        }),
      ),
  };
  return {
    backend,
    bundleHash: bundle.hash,
    target: input.target,
    skillPath: resourcePrefix + resolveTarget(input.target).skillFile,
    skills: [
      resourcePrefix + resolveTarget(input.target).skillFile.replace(/SKILL\.md$/, ''),
      ...(files[resourcePrefix + 'platform-skills/pp-reskin/SKILL.md']
        ? [resourcePrefix + 'platform-skills/pp-reskin/']
        : []),
    ],
    /** 列出固定包内目录的真实文件路径；与会话产物隔离，仍受取消和租约保护。 */
    async listFiles(value = resourcePrefix) {
      const root = location(value, true).replace(/\/$/, '') + '/';
      return read(() =>
        Object.keys(visibleFiles)
          .filter((path) => path.startsWith(root))
          .sort(),
      );
    },
    /** 显式目录视图按章节条目分页；完整正文和原字符分页接口继续可用。 */
    async readOutline(value: string, offset = 0, limit = 32) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 64
      )
        throw new Error('固定资源分页参数无效');
      const result = await backend.readRaw(location(value));
      if (result.error || !result.data) throw new Error('固定资源不存在');
      const text = result.data.content;
      if (typeof text !== 'string') throw new Error('固定资源不是文本');
      return JSON.stringify({
        view: 'outline',
        path: value,
        sha256: createHash('sha256').update(text).digest('hex'),
        totalCharacters: text.length,
        ...markdownOutline(text, offset, limit),
        message:
          '本结果只有目录，不表示已读正文或规则。sections中的offset/end为正文字符位置，用view=full、offset=章节offset、length=end-offset按需读取；完整章节仍按nextOffset接续。目录自身offset/length按条目计数。',
      });
    },
    /** 保留旧工具的字符分页约定；原生 Skill 路径在这里映射，不访问本机目录。 */
    async readText(value: string, offset = 0, length = 8000) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > maxReadCharacters
      )
        throw new Error('固定资源分页参数无效');
      const filename = location(value);
      if (!files[filename] && Object.keys(files).some((path) => path.startsWith(filename + '/')))
        throw new Error('固定资源不是文本');
      const result = await backend.readRaw(filename);
      if (result.error || !result.data) throw new Error('固定资源不存在');
      const text = result.data.content;
      if (typeof text !== 'string') throw new Error('固定资源不是文本');
      return JSON.stringify({
        path: value,
        sha256: createHash('sha256').update(text).digest('hex'),
        totalCharacters: text.length,
        offset,
        content: text.slice(offset, offset + length),
        nextOffset: offset + length < text.length ? offset + length : null,
      });
    },
  };
}

export type FixedResources = ReturnType<typeof createFixedResourceBackend>;
