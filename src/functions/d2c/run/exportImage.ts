import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertArtifactPath, resolveWorkspacePath } from '../utils/paths';
import { ToolIssue, toolIssue } from './toolFeedback';
import { executionError, RunExecutionError } from './errors';

/** 将旧 CLI 的已登记缓存图片落实到请求路径；只复制当前节点的已核实字节，保留原图。 */
export async function materializeExportImage(input: {
  workspace: string;
  target: string;
  returnedPath: unknown;
  reused: boolean;
  maxBytes: number;
  /** 仅返回当前 fileKey/nodeId 已登记图片的摘要，其他节点或未知文件返回 undefined。 */
  sourceHash: (relative: string) => string | undefined;
  signal: AbortSignal;
  assertLease: () => Promise<void>;
}) {
  const context = { stage: 'tool', tool: 'figma', command: 'export-image' } as const;
  function unavailable(detail: string): never {
    throw toolIssue('FIGMA_EXPORT_FILE_MISSING', 'FIGMA_REQUEST_FAILED', context, {
      path: input.target,
      detail,
    });
  }
  async function guard() {
    input.signal.throwIfAborted();
    await input.assertLease();
    input.signal.throwIfAborted();
  }
  /** 取消、失租及可信反馈保留原分类，真实文件系统异常沿存储故障处理。 */
  function fileError(error: unknown): never {
    if (input.signal.aborted) input.signal.throwIfAborted();
    if (error instanceof ToolIssue || error instanceof RunExecutionError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      unavailable('脚本返回成功，但图片文件不存在；请核对节点与导出参数。');
    throw executionError(error, 'STORAGE_FAILED', { ...context, stage: 'storage' });
  }
  await guard();
  if (typeof input.returnedPath !== 'string') unavailable('导图结果缺少文件路径。');
  const realRoot = await fs.realpath(input.workspace);
  let source: string;
  let destination: string;
  try {
    // macOS 的 /tmp、/var 可指向真实根；两种表示仍须落在当前工作区。
    const returned = input.returnedPath;
    let relative = returned;
    if (path.isAbsolute(returned)) {
      relative = path.relative(path.resolve(input.workspace), returned);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        relative = path.relative(realRoot, returned);
    }
    source = assertArtifactPath(relative);
    destination = assertArtifactPath(input.target);
    if (
      source !== relative ||
      destination !== input.target ||
      path.extname(source).toLowerCase() !== path.extname(destination).toLowerCase()
    )
      unavailable('导图返回路径或格式与请求不符，未读取或覆盖文件。');
    await resolveWorkspacePath(input.workspace, source);
    await resolveWorkspacePath(input.workspace, destination);
  } catch (error) {
    if (input.signal.aborted) input.signal.throwIfAborted();
    // 此处仅做路径检查，原始绝对路径和宿主异常不进入模型反馈。
    if (
      (error as NodeJS.ErrnoException).code &&
      !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code!)
    )
      fileError(error);
    unavailable('导图路径不属于当前工作区的有效产物，未读取或覆盖文件。');
  }
  const filename = await resolveWorkspacePath(input.workspace, source);
  let bytes: Buffer;
  try {
    const info = await fs.stat(filename);
    if (!info.isFile() || !info.size || info.size > input.maxBytes)
      unavailable('导图文件为空、不是普通文件或超过图片大小限制。');
    if (source === destination) {
      await guard();
      return;
    }
    const expected = input.sourceHash(source);
    if (!input.reused || !expected)
      unavailable('返回的旧图片未登记为当前节点的缓存，不能用其他图片代替。');
    bytes = await fs.readFile(filename);
    if (
      bytes.length > input.maxBytes ||
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      unavailable('缓存图片内容已变化，请核对已保存图片后重新导出。');
  } catch (error) {
    fileError(error);
  }
  await guard();
  const target = await resolveWorkspacePath(input.workspace, destination);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }).catch(fileError);
  await guard();
  try {
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fileError(error);
    const current = await resolveWorkspacePath(input.workspace, destination);
    const info = await fs.stat(current).catch(fileError);
    if (!info.isFile() || info.size !== bytes.length)
      unavailable('目标文件已存在且内容不同，未覆盖；请核对或更换文件名。');
    const existing = await fs.readFile(current).catch(fileError);
    if (!existing.equals(bytes))
      unavailable('目标文件已存在且内容不同，未覆盖；请核对或更换文件名。');
  }
  await guard();
}
