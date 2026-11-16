import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConfigSnapshot } from '../utils/config';
import { isExecutionDocument, assertArtifactPath, normalizeRelativePath } from '../utils/paths';
import { resolveTarget } from '../utils/targets';
import { validateResourceBundle, type ResourceBundleStore } from '../workspace/resources';

type ConfigSnapshot = ReturnType<typeof createConfigSnapshot>;

/** 调用方从同一稳定文件修订读取的清单；二进制只能经可信存储客户端读取。 */
export interface ExecutionFile {
  path: string;
  kind: 'source' | 'asset' | 'attachment' | 'internal';
  content: string | null;
  objectLocator: Record<string, unknown> | null;
  size: number;
  sha256: string;
}

/** 恢复只接受已固定的资源和配置，不读取平台当前模板或进程环境中的凭据。 */
export interface ExecutionWorkspaceInput {
  workRoot: string;
  resourceRevisionId: string;
  bundleHash: string;
  bundleObject: Record<string, unknown>;
  configSnapshot: ConfigSnapshot;
  files: ExecutionFile[];
  limits: { textFileBytes: number; filesPerSession: number; uploadBytes: number };
  store: Pick<ResourceBundleStore, 'load'>;
  readBinary?: (file: ExecutionFile) => Promise<Uint8Array>;
  assertLease: () => Promise<void>;
  signal?: AbortSignal;
}

/**
 * 从固定资源包、配置快照及稳定文件恢复本轮随机私有副本，不读取平台最新模板。
 * 调用方须先在租约事务中取得一致快照；恢复阶段核对路径、类型、字节数和 SHA-256。
 * @param input 固定修订、资源/二进制读取器、文件限额及执行权限检查。
 * @returns 资源与工作目录、Skill 内容和幂等 dispose；成功后由调用方负责释放目录。
 */
export async function restoreExecutionWorkspace(input: ExecutionWorkspaceInput) {
  const { limits } = input;
  if (
    !path.isAbsolute(input.workRoot) ||
    path.resolve(input.workRoot) === path.parse(input.workRoot).root ||
    !/^[a-f0-9]{64}$/.test(input.bundleHash) ||
    !Array.isArray(input.files) ||
    [limits.textFileBytes, limits.filesPerSession, limits.uploadBytes].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    input.files.length > limits.filesPerSession
  )
    throw new Error('执行目录或文件限额无效');

  /** 中止和租约检查位于外部读取前后，过期恢复不能返回可用的执行目录。 */
  async function check() {
    input.signal?.throwIfAborted();
    await input.assertLease();
    input.signal?.throwIfAborted();
  }

  await check();
  /** 先验证外部资源包，再重建配置摘要，防止修订关联正确但内容已被替换。 */
  const bundle = validateResourceBundle(await input.store.load(input.bundleObject));
  await check();
  if (bundle.hash !== input.bundleHash) throw new Error('固定资源摘要不匹配');
  const snapshot = input.configSnapshot;
  if (!snapshot || snapshot.resourceRevisionId !== input.resourceRevisionId)
    throw new Error('固定配置资源修订不匹配');
  const rebuilt = createConfigSnapshot(
    { ...bundle.defaultConfigs, [snapshot.target]: snapshot.config },
    snapshot.target,
    snapshot.configRevision,
    input.resourceRevisionId,
  );
  if (rebuilt.hash !== snapshot.hash) throw new Error('固定配置摘要不匹配');
  const target = resolveTarget(rebuilt.target);

  /** 落盘前检查整份清单，保留固定配置名，并拒绝重复路径及文件/父目录冲突。 */
  const seen = new Set(['pp-d2c.config.json']);
  const files = input.files.map((file) => {
    const relative = normalizeRelativePath(file.path);
    if (relative !== file.path || Buffer.byteLength(relative) > 1024 || seen.has(relative))
      throw new Error('稳定文件路径重复或无效');
    if (file.kind === 'internal') {
      if (!relative.startsWith('.d2c-cache/') && !isExecutionDocument(relative))
        throw new Error('内部文件超出缓存范围');
    } else if (['source', 'asset', 'attachment'].includes(file.kind)) {
      assertArtifactPath(relative);
    } else throw new Error('稳定文件类型无效');
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > (file.content === null ? limits.uploadBytes : limits.textFileBytes) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.content === null
        ? !file.objectLocator || !input.readBinary
        : file.objectLocator !== null)
    )
      throw new Error('稳定文件内容或元数据无效');
    seen.add(relative);
    return { file: structuredClone(file), relative };
  });
  for (const relative of seen) {
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('稳定文件路径冲突');
  }

  /** 在普通根目录下创建随机目录并记录 inode/dev，清理时据此避免删除被替换的路径。 */
  await fs.mkdir(input.workRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.lstat(input.workRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('执行根目录必须是普通目录');
  const root = await fs.realpath(input.workRoot);
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  const identity = await fs.lstat(directory);
  const resources = path.join(directory, 'resources');
  const workspace = path.join(directory, 'workspace');
  let disposed = false;

  /** 仅移除本次随机目录；重复调用安全，路径被替换时拒绝删除。 */
  async function dispose() {
    if (disposed) return;
    const current = await fs.lstat(directory);
    if (!current.isDirectory() || current.ino !== identity.ino || current.dev !== identity.dev)
      throw new Error('临时执行目录已被替换，拒绝清理');
    await fs.rm(directory, { recursive: true, force: true });
    disposed = true;
  }

  /** 新建目录内独占写入，固定权限，不继承资源包中的可执行位或链接。 */
  async function write(rootPath: string, relative: string, content: Uint8Array, mode: number) {
    const filename = path.join(rootPath, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, content, { flag: 'wx', mode });
  }

  try {
    /** 固定资源和配置只读，稳定文件可写；资源副本与产物副本分目录存放。 */
    await fs.mkdir(resources, { mode: 0o700 });
    await fs.mkdir(workspace, { mode: 0o700 });
    for (const file of bundle.files)
      await write(resources, file.path, Buffer.from(file.content, 'base64'), 0o400);
    await write(
      workspace,
      'pp-d2c.config.json',
      Buffer.from(JSON.stringify(rebuilt.config, null, 2) + '\n'),
      0o400,
    );
    /** 二进制从可信定位下载，文本使用 MySQL 正文；实际内容校验通过后才独占落盘。 */
    for (const { file, relative } of files) {
      await check();
      const content =
        file.content === null
          ? Buffer.from(await input.readBinary!(file))
          : Buffer.from(file.content, 'utf8');
      await check();
      if (
        (file.content !== null &&
          (content.toString('utf8') !== file.content || file.content.includes('\0'))) ||
        content.length !== file.size ||
        createHash('sha256').update(content).digest('hex') !== file.sha256
      )
        throw new Error('稳定文件字节或摘要不匹配');
      await write(workspace, relative, content, 0o600);
    }
    const skillFile = path.join(resources, target.skillFile);
    const skill = await fs.readFile(skillFile, 'utf8');
    await check();
    return {
      bundle,
      directory,
      resources,
      workspace,
      skillFile,
      skill,
      configHash: rebuilt.hash,
      bundleHash: bundle.hash,
      dispose,
    };
  } catch (error) {
    /** 恢复失败不交出半成品目录；只清理本次随机目录，稳定存储不受影响。 */
    await dispose();
    throw error;
  }
}
