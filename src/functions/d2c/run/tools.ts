import { materializeExportImage } from './exportImage';
import { SliceDiagnosticError } from './sliceDiagnostics';
import { hasLocalImageUrl, modelImageConfig } from './imagePolicy';
import { invalidBlockDirectory } from '../utils/blockPaths';
import {
  inspectSliceManifest,
  designTarget,
  sliceDesignSchema,
  sliceScope,
  sliceHash,
  verifySliceEvidence,
  automaticSliceManifest,
  type SliceEvidence,
  type SliceFile,
} from './sliceCache';
import { scriptProcessPrelude } from './scriptProcess';
import { throwFigmaScriptFailure, type ScriptNetworkFailure } from './scriptFailure';
import type { SliceProgress } from './sliceProgress';
import { prepareSlices } from './slices';
import { createSliceNetwork } from './sliceNetwork';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createScriptNetworkPrelude } from './scriptNetwork';
import {
  assertArtifactPath,
  isExecutionDocument,
  normalizeRelativePath,
  resolveWorkspacePath as resolvePath,
} from '../utils/paths';
import type { GenerationTools, SliceDesign } from './types';
import { nativeRuleScanRevision, type NativeRuleScanResult } from './ruleScan/index';
import { nativeScanProblems } from './ruleScan/report';
import { englishSliceName, validateSliceNames } from './sliceNames';
import {
  executionError,
  RunExecutionError,
  type FailureCommand,
  type FailureContext,
  type FailureTool,
} from './errors';
import type { restoreExecutionWorkspace } from './workspace';

import { ToolIssue, toolFeedback, toolIssue } from './toolFeedback';
import { compressImage } from '../utils/compressImage';
import {
  compactFigmaCacheForStorage,
  compactFigmaNodeForModel,
  inspectFigmaNode,
  inspectFigmaSubtree,
} from './figmaNode';
import { createRulesWorkspace, mergeRulesReports } from './rulesWorkspace';
import { designReferencePaths, persistDesignReference } from './designReference';
import {
  requiredRnImages,
  imageSliceExpectations,
  appendImageCoverage,
  type ImageCoverageIssue,
} from './imageCoverage';
import { inspectRnImageReferences } from './rnImageReferences';
import { normalizeReadPath, resolveWorkspaceReadPath } from '../utils/readPath';
import { inspectGenerationDelivery } from './delivery';
import { editFileText } from './editFile';
import { generationPlan } from './generationPlan';
const executeFile = promisify(execFile);
const figmaCommands: FailureCommand[] = [
  'verify-token',
  'cache-check',
  'fetch-node',
  'inspect-node',
  'export-image',
  'screenshot',
];

const networkPrelude = createScriptNetworkPrelude();

/**
 * 基于已恢复工作区装配文件及固定脚本能力，并在本轮内跟踪 Figma、切图和规则证据。
 * 文本/二进制通过调用方持久化，临时目录仅供执行；不开放 shell 或生成代码执行能力。
 * @param input 私有执行目录、限额、取消/租约检查及可信存储与凭据回调。
 * @returns SDK 工具和最终校验器；后续 mutation 会使已有 merge 报告失效。
 */
export async function createGenerationTools(input: {
  restored: Omit<Awaited<ReturnType<typeof restoreExecutionWorkspace>>, 'bundle'>;
  assetUrls?: () => Record<string, string>;
  savedFiles?: ReadonlyArray<{ path: string; sha256: string; kind?: string; size?: number }>;
  reusableLegacyManifests?: string[];
  figmaUrl: string | null;
  target: 'h5' | 'rn';
  proxyUrl: string;
  allowedHosts: string[];
  textFileBytes: number;
  uploadBytes: number;
  signal: AbortSignal;
  progress?: (value: SliceProgress) => Promise<void>;
  token: () => Promise<string>;
  redact: (value: string) => string;
  save: (relative: string, content: string, internal: boolean) => Promise<void>;
  saveBinary: (relative: string, content: Buffer) => Promise<void>;
  remove: (relative: string) => Promise<void>;
  assertLease: () => Promise<void>;
  onFigmaRoot?: (name: string) => Promise<void>;
}) {
  const { restored } = input;
  const readImages = new Map<string, { mimeType: string; data: Buffer }>();
  const skillRoot = `templates/skills/${input.target === 'h5' ? 'pp-d2c' : 'pp-d2c-rn'}`;
  const scriptHashes = new Map<string, string>();
  /** Figma与规则脚本按同一资源修订读取，切图由服务端函数实现。 */
  function scriptPath(name: string) {
    return path.join(restored.resources, skillRoot, 'bin', name);
  }
  /** 记录固定脚本摘要，调用前复核；网络前置代码独占写入本轮目录供可信子进程加载。 */
  for (const name of ['figma.mjs', 'check-rules.mjs']) {
    scriptHashes.set(
      name,
      createHash('sha256')
        .update(await fs.readFile(scriptPath(name)))
        .digest('hex'),
    );
  }

  const processPrelude = path.join(restored.directory, 'process.mjs');
  await fs.writeFile(processPrelude, scriptProcessPrelude, { flag: 'wx', mode: 0o400 });
  const prelude = path.join(restored.directory, 'network.mjs');
  await fs.writeFile(prelude, networkPrelude, { flag: 'wx', mode: 0o400 });
  const fileKey = input.figmaUrl?.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9_-]+)/)?.[1];
  let defaultNode: string | undefined;
  let sessionNameRead = false;
  try {
    defaultNode = input.figmaUrl
      ? new URL(input.figmaUrl).searchParams.get('node-id')?.replace(/-/g, ':')
      : undefined;
  } catch (error) {
    throw executionError(error, 'FIGMA_ADDRESS_MISSING', { stage: 'prepare', tool: 'figma' });
  }
  const boundDesign = input.figmaUrl
    ? { figmaUrl: designTarget(input.figmaUrl).figmaUrl }
    : undefined;
  const activeSlices = new Map<string, SliceDesign>();
  const sliceClaims = new Map<string, SliceDesign>();
  const exportOwners = new Map<string, Set<string>>();
  /** 节点身份含文件，不能用跨文件碰巧相同的 nodeId 授权覆盖。 */
  function claimImage(relative: string, key: string, nodeId: string) {
    const owners = exportOwners.get(relative) ?? new Set<string>();
    owners.add(`${key}/${nodeId}`);
    exportOwners.set(relative, owners);
  }
  /** 目标身份不包含命名和基线；同 slug 不能跨文件或跨根覆盖图片目录。 */
  function sameTarget(a: SliceDesign, b: SliceDesign) {
    return designTarget(a.figmaUrl).figmaUrl === designTarget(b.figmaUrl).figmaUrl;
  }
  let mutation = 0;
  const changedSources = new Set<string>();
  let validationAttempted = false;
  let report: { path: string; mutation: number; passed: boolean; reportPath: string } | undefined;
  const synced = new Map((input.savedFiles ?? []).map((file) => [file.path, file.sha256]));
  let syncQueue: Promise<void> = Promise.resolve();
  const assetFiles = new Map(
    (input.savedFiles ?? [])
      .filter((file) => file.kind === 'asset')
      .map((file) => [file.path, file]),
  );
  /** 平台使用原包的自动切图策略；这只调整临时执行配置，不修改固定资源及工作区配置。 */
  const configFile = path.join(restored.workspace, 'pp-d2c.config.json');
  const executionConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
  executionConfig.slice = { ...executionConfig.slice, confirmBeforeContinue: false };
  await fs.chmod(configFile, 0o600);
  try {
    await fs.writeFile(configFile, JSON.stringify(executionConfig, null, 2));
  } finally {
    await fs.chmod(configFile, 0o400);
  }
  /** cache-check 的真实设计稿版本参与摘要，远端更新后旧图片不能继续复用。 */
  async function currentScope(design: SliceDesign = boundDesign!) {
    const target = designTarget(design.figmaUrl);
    const scope = sliceScope(
      target.figmaUrl,
      input.target,
      restored.configHash,
      restored.bundleHash,
      design,
    );
    let revision: unknown = null;
    try {
      revision =
        JSON.parse(
          await fs.readFile(
            await resolvePath(restored.workspace, `.d2c-cache/${target.fileKey}/meta.json`),
            'utf8',
          ),
        ).lastModified ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let baseRevision: unknown = null;
    if (design.baseUrl) {
      const base = designTarget(design.baseUrl);
      try {
        baseRevision =
          JSON.parse(
            await fs.readFile(
              await resolvePath(restored.workspace, `.d2c-cache/${base.fileKey}/meta.json`),
              'utf8',
            ),
          ).lastModified ?? null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return sliceHash(
      JSON.stringify(design.baseUrl ? [scope, revision, baseRevision] : [scope, revision]),
    );
  }
  /** 缓存路径由设计稿和 slug 确定，不接受模型指定的证据位置。 */
  function slicePaths(slug: string, design: SliceDesign = boundDesign!) {
    const { fileKey } = designTarget(design.figmaUrl);
    return {
      manifest: `.d2c-cache/${fileKey}/slice-manifest-${slug}.json`,
      evidence: `.d2c-cache/${fileKey}/slice-evidence-${slug}.json`,
    };
  }
  /** 只有提交稳定存储后的图片才参与复用，复核临时副本字节与摘要。 */
  async function currentSliceFiles(): Promise<SliceFile[]> {
    const result = [];
    for (const file of assetFiles.values()) {
      const content = await fs.readFile(await resolvePath(restored.workspace, file.path));
      result.push({
        path: file.path,
        kind: 'asset',
        sha256: sliceHash(content),
        size: content.length,
      });
    }
    return result;
  }
  /** 缓存及证据由服务端保存，写成功后才推进本轮摘要。 */
  async function saveCacheText(relative: string, content: string) {
    const digest = sliceHash(content);
    if (synced.get(relative) === digest) return;
    await input.assertLease();
    input.signal.throwIfAborted();
    await input.save(relative, content, true);
    const filename = await resolvePath(restored.workspace, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, content, { mode: 0o600 });
    synced.set(relative, digest);
  }
  /** 校验通过的旧清单按自动策略适配原包 gate，并记录纯缓存完整性证据。 */
  async function storeSliceCache(
    slug: string,
    inspected: ReturnType<typeof inspectSliceManifest>,
    design: SliceDesign = boundDesign!,
  ) {
    const paths = slicePaths(slug, design);
    const content = automaticSliceManifest(inspected.value);
    await saveCacheText(paths.manifest, content);
    const evidence: SliceEvidence = {
      version: 1,
      scope: await currentScope(design),
      slug,
      manifestHash: sliceHash(content),
      design,
      images: inspected.images,
    };
    await saveCacheText(paths.evidence, JSON.stringify(evidence));
    activeSlices.set(slug, design);
    sliceClaims.set(slug, design);
    for (const theme of inspected.value.themes)
      for (const entry of theme.entries)
        claimImage(entry.filepath, designTarget(design.figmaUrl).fileKey, entry.nodeId);
    return inspected;
  }
  /** 复用严格核对固定输入及图片；缺证据的旧确认轮次只按数据库核实的清单迁移。 */
  async function reuseSlices(slug: string, design: SliceDesign = boundDesign!) {
    const paths = slicePaths(slug, design);
    let inspected: ReturnType<typeof inspectSliceManifest>;
    try {
      const content = await fs.readFile(
        await resolvePath(restored.workspace, paths.manifest),
        'utf8',
      );
      const files = await currentSliceFiles();
      let raw: unknown;
      try {
        raw = JSON.parse(
          await fs.readFile(await resolvePath(restored.workspace, paths.evidence), 'utf8'),
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          !input.reusableLegacyManifests?.includes(paths.manifest) ||
          synced.get(paths.manifest) !== sliceHash(content)
        )
          return null;
      }
      inspected = raw
        ? verifySliceEvidence(raw, content, await currentScope(design), slug, files)
        : inspectSliceManifest(content, slug, files);
    } catch (error) {
      if (input.signal.aborted) input.signal.throwIfAborted();
      return null;
    }
    return storeSliceCache(slug, inspected, design);
  }

  const assetUrlsPath = fileKey ? `.d2c-cache/${fileKey}/asset-urls.json` : undefined;
  /** 由可信存储定位生成只读地址表，模型不能自行写入或覆盖该映射。 */
  async function publishAssetUrls(force = false, key = fileKey) {
    const assetUrlsPath = key ? `.d2c-cache/${key}/asset-urls.json` : undefined;
    if (!assetUrlsPath || !input.assetUrls) return;
    const images = input.assetUrls();
    if (!force && !Object.keys(images).length && !synced.has(assetUrlsPath)) return;
    const content = input.redact(JSON.stringify({ images }, null, 2));
    const digest = createHash('sha256').update(content).digest('hex');
    if (synced.get(assetUrlsPath) === digest) return;
    await input.assertLease();
    input.signal.throwIfAborted();
    await input.save(assetUrlsPath, content, true);
    const filename = await resolvePath(restored.workspace, assetUrlsPath);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, content, { mode: 0o600 });
    synced.set(assetUrlsPath, digest);
  }
  await publishAssetUrls();
  /** 只恢复稳定的内部证据，不从聊天文本或未受保护文件恢复主题上下文。 */
  for (const file of input.savedFiles ?? []) {
    const match = file.path.match(
      /^\.d2c-cache\/([a-zA-Z0-9_-]+)\/slice-(evidence|partial|manifest)-([a-z0-9][a-z0-9-]{0,63})\.json$/,
    );
    const exports = file.path.match(/^\.d2c-cache\/([a-zA-Z0-9_-]+)\/image-exports\.json$/);
    if (exports) {
      const raw = JSON.parse(
        await fs.readFile(await resolvePath(restored.workspace, file.path), 'utf8'),
      );
      for (const entry of raw.images ?? []) {
        if (typeof entry.nodeId !== 'string' || !/^\d+:\d+$/.test(entry.nodeId)) continue;
        claimImage(assertArtifactPath(entry.path), exports[1], entry.nodeId);
      }
    }
    if (!match) continue;
    let design: SliceDesign | undefined;
    try {
      const raw = JSON.parse(
        await fs.readFile(await resolvePath(restored.workspace, file.path), 'utf8'),
      );
      design = raw.design
        ? sliceDesignSchema.parse(raw.design)
        : match[1] === fileKey
          ? boundDesign
          : undefined;
      if (!design || designTarget(design.figmaUrl).fileKey !== match[1]) continue;
      designTarget(design.figmaUrl);
      if (design.baseUrl) designTarget(design.baseUrl);
      validateSliceNames(design.names ?? {});
      const entries =
        match[2] === 'partial'
          ? raw.entries?.map((item: { entry: unknown }) => item.entry)
          : raw.themes?.flatMap((theme: { entries: unknown[] }) => theme.entries);
      for (const entry of entries ?? []) {
        if (typeof entry.nodeId === 'string')
          claimImage(assertArtifactPath(entry.filepath), match[1], entry.nodeId);
      }
    } catch {
      continue;
    }
    const slug = match[3];
    const claimed = sliceClaims.get(slug);
    if (claimed && !sameTarget(claimed, design))
      throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
    if (!claimed || match[2] === 'partial') sliceClaims.set(slug, design);
  }
  for (const [slug, design] of sliceClaims) await reuseSlices(slug, design);
  for (const manifest of input.reusableLegacyManifests ?? []) {
    const match = manifest.match(/\/slice-manifest-([a-z0-9][a-z0-9-]{0,63})\.json$/);
    if (match && manifest.startsWith(`.d2c-cache/${fileKey}/`)) await reuseSlices(match[1]);
  }

  /** 路径和证据结构违规使用固定分类，不把解析器的原始消息送给 SDK。 */
  function validate<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      throw executionError(error, 'VALIDATION_FAILED', { stage: 'validation' });
    }
  }
  /** 路径边界含符号链接检查，拒绝时保留原始校验异常。 */
  async function resolveWorkspacePath(root: string, relative: string) {
    try {
      return await resolvePath(root, relative);
    } catch (error) {
      throw executionError(error, 'VALIDATION_FAILED', { stage: 'validation' });
    }
  }

  /** 读取有界 UTF-8，拒绝符号链接；资源读取限于固定包，不执行生成代码。 */
  async function read(relative: string, resource: boolean, offset = 0, length = 8000) {
    const requestedPath = relative;
    /** 先拒绝无效参数并交回模型纠正，文件系统及符号链接错误仍按运行异常处理。 */
    try {
      relative = normalizeReadPath(relative);
    } catch {
      throw toolIssue(
        'INVALID_ARGUMENT',
        'VALIDATION_FAILED',
        { stage: 'tool', tool: 'read_file' },
        {
          path: requestedPath.slice(0, 1024),
          resource,
          detail:
            '读取路径须位于当前工作区或固定资源包内。请用 list_files 核对真实路径后重新读取；本次未读取文件。',
        },
      );
    }
    let filename: string;
    try {
      filename = await resolveWorkspaceReadPath(
        resource ? restored.resources : restored.workspace,
        requestedPath,
      );
    } catch (error) {
      throw executionError(error, 'VALIDATION_FAILED', { stage: 'validation' });
    }
    try {
      const info = await fs.stat(filename);
      const imageType = !resource
        ? (
            {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.webp': 'image/webp',
            } as Record<string, string>
          )[path.extname(relative).toLowerCase()]
        : undefined;
      if (
        !info.isFile() ||
        info.size >
          (imageType ? Math.min(input.uploadBytes, 10 * 1024 * 1024) : input.textFileBytes)
      )
        throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
      const bytes = await fs.readFile(filename);
      if (imageType) {
        const valid =
          imageType === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
            : imageType === 'image/jpeg'
              ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
              : bytes.toString('ascii', 0, 4) === 'RIFF' &&
                bytes.toString('ascii', 8, 12) === 'WEBP';
        if (!valid)
          return input.redact(
            JSON.stringify(toolFeedback('NON_TEXT_FILE', { path: relative, resource })),
          );
        const imageRef = `artifact://${createHash('sha256').update(bytes).digest('hex')}`;
        readImages.delete(imageRef);
        readImages.set(imageRef, { mimeType: imageType, data: bytes });
        if (readImages.size > 4) readImages.delete(readImages.keys().next().value!);
        return input.redact(
          JSON.stringify({
            ok: true,
            path: relative,
            imageRef,
            mimeType: imageType,
            size: bytes.length,
            message: '工作区图片已读取，视觉输入在模型请求时载入；图片不使用文本分页。',
          }),
        );
      }
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return input.redact(
          JSON.stringify(toolFeedback('NON_TEXT_FILE', { path: relative, resource })),
        );
      }
      const text =
        !resource && relative === 'pp-d2c.config.json'
          ? JSON.stringify(modelImageConfig(JSON.parse(raw)), null, 2)
          : raw;
      return input.redact(
        JSON.stringify({
          sha256: createHash('sha256').update(bytes).digest('hex'),
          totalCharacters: text.length,
          offset,
          content: text.slice(offset, offset + length),
          nextOffset: offset + length < text.length ? offset + length : null,
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      /** 缺失是可纠正的读取结果；不创建文件、不绕过路径及租约校验。 */
      return input.redact(
        JSON.stringify(toolFeedback('FILE_NOT_FOUND', { path: relative, resource })),
      );
    }
  }
  /** 只遍历普通文件且不跟随链接，配置和临时截图不作为产物。 */
  async function list() {
    const result: string[] = [];
    /** 递归范围固定为当前随机执行目录。 */
    async function walk(directory: string, prefix = '') {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (relative === '.d2c-tmp') continue;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
        else if (entry.isFile() && relative !== 'pp-d2c.config.json') result.push(relative);
        else if (!entry.isFile())
          throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
      }
    }
    await walk(restored.workspace);
    return result.sort();
  }
  /**
   * 将可信脚本写入工作区的文件逐份同步到稳定存储，按摘要跳过本轮已同步的内容。
   * 缓存保存为内部 UTF-8 文本，已列出的图片/字体扩展名走二进制上传，其余按源码保存。
   * 同步不跨文件原子提交，也不镜像删除；中途失败保留先前已提交文件并向上抛错。
   */
  async function syncFiles() {
    for (const relative of await list()) {
      const filename = await resolveWorkspacePath(restored.workspace, relative);
      let content: Buffer = await fs.readFile(filename);
      if (
        !sessionNameRead &&
        input.onFigmaRoot &&
        fileKey &&
        defaultNode &&
        relative === `.d2c-cache/${fileKey}/nodes/${defaultNode.replace(':', '_')}.json`
      ) {
        let cache;
        try {
          cache = JSON.parse(content.toString('utf8'));
        } catch {
          /** 无效缓存交给原工具校验。 */
        }
        if (cache?.node?.id === defaultNode && typeof cache.node.name === 'string') {
          await input.onFigmaRoot(cache.node.name);
          sessionNameRead = true;
        }
      }
      let digest = createHash('sha256').update(content).digest('hex');
      if (synced.get(relative) === digest) continue;
      if (/^\.d2c-cache\/[^/]+\/nodes\/\d+_\d+\.json$/.test(relative)) {
        const original = new TextDecoder('utf-8', { fatal: true }).decode(content);
        const compact = Buffer.from(compactFigmaCacheForStorage(original));
        if (compact.length < content.length) {
          content = compact;
          await fs.writeFile(filename, content, { mode: 0o600 });
          digest = createHash('sha256').update(content).digest('hex');
        }
      }
      if (/\.(?:png|jpe?g)$/i.test(relative)) {
        const compressed = await compressImage(relative, content, input.signal);
        if (compressed.status === 'compressed') {
          content = compressed.content;
          await fs.writeFile(filename, content, { mode: 0o600 });
          digest = createHash('sha256').update(content).digest('hex');
        }
      }
      if (relative.startsWith('.d2c-cache/') || isExecutionDocument(relative))
        await input.save(relative, new TextDecoder('utf-8', { fatal: true }).decode(content), true);
      else {
        validate(() => assertArtifactPath(relative));
        if (/\.(?:png|jpe?g|svg|webp|gif|ico|woff2?|ttf)$/i.test(relative)) {
          await input.saveBinary(relative, content);
          assetFiles.set(relative, {
            path: relative,
            sha256: digest,
            kind: 'asset',
            size: content.length,
          });
        } else
          await input.save(
            relative,
            new TextDecoder('utf-8', { fatal: true }).decode(content),
            false,
          );
      }
      synced.set(relative, digest);
    }
    await publishAssetUrls(true);
  }
  /** RN贴图覆盖独立于原规则报告，防止空View、缺清单或错误URI被机械零违规放行。 */
  async function checkRnImageCoverage(product?: string): Promise<ImageCoverageIssue[]> {
    if (input.target !== 'rn') return [];
    const missing: ImageCoverageIssue = {
      nodeId: defaultNode ?? '-',
      name: '页面根',
      reason: 'missing_cache',
    };
    if (!fileKey || !defaultNode) return [missing];
    let cache;
    try {
      cache = JSON.parse(
        await fs.readFile(
          await resolveWorkspacePath(
            restored.workspace,
            `.d2c-cache/${fileKey}/nodes/${defaultNode.replace(':', '_')}.json`,
          ),
          'utf8',
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [missing];
      throw error;
    }
    const required = requiredRnImages(cache, defaultNode);
    if (!required.length) return [];
    const entries: Array<{ nodeId?: unknown; filename?: unknown; filepath?: unknown }> = [];
    for (const [slug, design] of activeSlices) {
      if (!boundDesign || !sameTarget(design, boundDesign)) continue;
      const inspected = await reuseSlices(slug, design);
      if (inspected)
        entries.push(
          ...inspected.value.themes.flatMap(
            (theme: {
              entries: Array<{ nodeId?: unknown; filename?: unknown; filepath?: unknown }>;
            }) => theme.entries,
          ),
        );
    }
    const result = imageSliceExpectations(required, entries, input.assetUrls?.() ?? {});
    if (!result.expected.length) return result.issues;
    const paths = (await list()).filter(
      (relative) =>
        !relative.startsWith('.') &&
        /\.[jt]sx?$/.test(relative) &&
        (!product || relative.startsWith(product + '/')),
    );
    const sources = await Promise.all(
      paths.map(async (relative) => ({
        path: relative,
        content: await fs.readFile(
          await resolveWorkspacePath(restored.workspace, relative),
          'utf8',
        ),
      })),
    );
    const references = inspectRnImageReferences(sources, result.expected);
    return [
      ...result.issues,
      ...references.map((issue) => ({
        ...issue,
        name: required.find((node) => node.nodeId === issue.nodeId)!.name,
      })),
    ];
  }
  /** 并行工具产生的同步按顺序核对摘要；先前同步失败时不再追加未知副作用。 */
  function sync() {
    syncQueue = syncQueue.then(syncFiles);
    return syncQueue;
  }
  /**
   * 核对租约及固定脚本摘要后，用最小环境运行 Node 子进程，前后均检查执行权限。
   * 按需注入 Token，限制代理、超时和输出量；取消会终止实际子进程。
   * @returns 脱敏 stdout 和退出码；规则退出码 1 保留报告，Figma 失败信封转换为分类反馈。
   */
  async function script(
    name: string,
    args: string[],
    needsToken: boolean,
    cwd = restored.workspace,
  ) {
    const context: FailureContext = {
      stage: 'tool',
      tool:
        name === 'figma.mjs'
          ? 'figma'
          : name === 'check-rules.mjs'
            ? 'check_rules'
            : 'prepare_slices',
      ...(name === 'figma.mjs'
        ? { command: figmaCommands.find((value) => value === args[0]) }
        : {}),
    };
    await input.assertLease();
    input.signal.throwIfAborted();
    const filename = scriptPath(name);
    if (
      createHash('sha256')
        .update(await fs.readFile(filename))
        .digest('hex') !== scriptHashes.get(name)
    )
      throw new RunExecutionError('VALIDATION_FAILED', context);
    const token = needsToken ? await input.token() : '';
    const diagnosticFile = path.join(restored.directory, `network-${randomUUID()}.json`);
    await fs.rm(diagnosticFile, { force: true });
    /** 读取本次独立网络诊断；原始响应和地址不进入故障投影。 */
    async function readNetworkFailure(): Promise<ScriptNetworkFailure | undefined> {
      try {
        return JSON.parse(await fs.readFile(diagnosticFile, 'utf8'));
      } catch {
        return undefined;
      }
    }
    /** 网络前置的失败优先于脚本正文，成功后的其他请求不会抹掉未解决故障。 */
    async function networkIssue(cause?: unknown) {
      const network = await readNetworkFailure();
      if (network) throwFigmaScriptFailure({ args, output: '', context, network, cause });
    }
    let stdout = '',
      code = 0;
    try {
      const pending = executeFile(
        process.execPath,
        [
          '--use-system-ca',
          '--use-env-proxy',
          '--import',
          prelude,
          ...(name === 'figma.mjs' ? ['--import', processPrelude] : []),
          filename,
          ...args,
        ],
        {
          cwd,
          env: {
            HTTPS_PROXY: input.proxyUrl,
            HTTP_PROXY: input.proxyUrl,
            NO_PROXY: '',
            PIXELPRINT_ALLOWED_HOSTS: JSON.stringify(input.allowedHosts),
            PIXELPRINT_NETWORK_BYTES: String(input.uploadBytes),
            PIXELPRINT_NETWORK_DIAGNOSTIC: diagnosticFile,
            ...(token ? { FIGMA_TOKEN: token } : {}),
          },
          signal: input.signal,
          timeout: 120000,
          killSignal: 'SIGKILL',
          maxBuffer: input.textFileBytes,
        },
      );
      ({ stdout } = await pending);
    } catch (error) {
      const failure = error as {
        code?: unknown;
        stdout?: string;
        killed?: boolean;
        signal?: unknown;
      };
      if (input.signal.aborted) {
        const reason = input.signal.reason;
        throw executionError(
          error,
          reason instanceof RunExecutionError ? reason.code : 'WORKER_INTERRUPTED',
          { ...context, ...(reason instanceof RunExecutionError ? reason.context : {}) },
        );
      }
      if (error instanceof RunExecutionError && error.code === 'STORAGE_FAILED') throw error;
      await input.assertLease();
      input.signal.throwIfAborted();
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw executionError(error, 'SCRIPT_FAILED', context);
      if (failure.code === null && failure.killed === true && failure.signal === 'SIGKILL')
        throw executionError(error, 'SCRIPT_TIMEOUT', context);
      await networkIssue(error);
      if (name === 'figma.mjs' && failure.code === 1 && !failure.killed && !failure.signal)
        throwFigmaScriptFailure({ args, output: failure.stdout ?? '', context, cause: error });
      if (name !== 'check-rules.mjs' || failure.code !== 1)
        throw executionError(error, 'SCRIPT_FAILED', context);
      stdout = failure.stdout ?? '';
      code = 1;
    }
    await input.assertLease();
    await networkIssue();
    return { output: input.redact(stdout), code };
  }
  /** 只计算当前恢复副本的规则命中；不运行脚本、不联网、不保存报告或推进 mutation。 */
  async function scanRules(relative: string, nodeId?: string): Promise<NativeRuleScanResult> {
    /** 计算与读取前后均复查；取消和租约失效不能被可纠正的缓存错误掩盖。 */
    async function check() {
      input.signal.throwIfAborted();
      await input.assertLease();
      input.signal.throwIfAborted();
    }
    await check();
    try {
      const normalized = validate(() => assertArtifactPath(normalizeRelativePath(relative)));
      if (
        path.posix.basename(normalized) !== 'rule-hits.json' ||
        (nodeId !== undefined && typeof nodeId !== 'string')
      )
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      await resolveWorkspacePath(restored.workspace, normalized);
      if (input.target !== 'h5' && input.target !== 'rn')
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      if (!fileKey || !defaultNode)
        throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_ADDRESS_MISSING', {
          stage: 'tool',
          tool: 'check_rules',
        });
      let cache: unknown;
      try {
        cache = JSON.parse(
          await fs.readFile(
            await resolveWorkspacePath(
              restored.workspace,
              `.d2c-cache/${fileKey}/nodes/${defaultNode.replace(':', '_')}.json`,
            ),
            'utf8',
          ),
        );
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
        throw toolIssue('FIGMA_CACHE_INCOMPLETE', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      }
      if (
        !cache ||
        typeof cache !== 'object' ||
        Array.isArray(cache) ||
        ('_depth' in cache && cache._depth !== null)
      )
        throw toolIssue('FIGMA_CACHE_INCOMPLETE', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      const config: unknown = JSON.parse(
        await fs.readFile(
          await resolveWorkspacePath(restored.workspace, 'pp-d2c.config.json'),
          'utf8',
        ),
      );
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      const ruleSources: Record<string, string> = {};
      const rulesRelative = `${skillRoot}/rules`;
      const rulesDirectory = await resolveWorkspacePath(restored.resources, rulesRelative);
      for (const name of (await fs.readdir(rulesDirectory)).sort()) {
        if (!name.endsWith('.md')) continue;
        ruleSources[name] = await fs.readFile(
          await resolveWorkspacePath(restored.resources, `${rulesRelative}/${name}`),
          'utf8',
        );
      }
      await check();
      const { scanDesignRules } = await import('./ruleScan/index');
      return await scanDesignRules({
        cache,
        rootNodeId: nodeId ?? defaultNode,
        target: input.target,
        config: config as Record<string, unknown>,
        ruleSources,
        block: path.posix.dirname(normalized),
        cacheKey: fileKey,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ['RULE_SCAN_INVALID_CACHE', 'RULE_SCAN_CACHE_INCOMPLETE'].includes(error.message)
      )
        throw toolIssue('FIGMA_CACHE_INCOMPLETE', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      if (
        error instanceof Error &&
        ['RULE_SCAN_INVALID_INPUT', 'RULE_SCAN_INVALID_CONFIG'].includes(error.message)
      )
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      if (error instanceof Error && error.message === 'RULE_SCAN_ROOT_NOT_FOUND')
        throw toolIssue(
          nodeId === undefined ? 'FIGMA_CACHE_INCOMPLETE' : 'INVALID_ARGUMENT',
          'VALIDATION_FAILED',
          {
            stage: 'tool',
            tool: 'check_rules',
          },
        );
      throw error;
    } finally {
      await check();
    }
  }

  /** 新旧规则报告沿同一保存回调落库，程序扫描门禁失败也必须使本轮验收失败。 */
  async function saveRuleResult(
    normalized: string,
    checkedMutation: number,
    result: { code: number; output: string },
  ) {
    const reportPath = `.d2c-cache/${fileKey}/check-report.json`;
    const content = input.redact(result.output.replaceAll(restored.workspace + '/', ''));
    await input.save(reportPath, content, true);
    const filename = await resolveWorkspacePath(restored.workspace, reportPath);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await fs.writeFile(filename, content, { mode: 0o600 });
    synced.set(reportPath, createHash('sha256').update(content).digest('hex'));
    report = { path: normalized, mutation: checkedMutation, passed: result.code === 0, reportPath };
  }

  const tools: GenerationTools = {
    list,
    read,
    /** 先提交稳定文件，再写临时副本；后者失败会中止本轮，已提交内容仍保留。 */
    async write(relative, content) {
      const reject = (
        code: 'INVALID_ARGUMENT' | 'FILE_WRITE_NOT_ALLOWED' | 'BLOCK_DIRECTORY_INVALID',
      ): never => {
        throw toolIssue(
          code,
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'write_file' },
          {
            path: relative.slice(0, 1024),
            resource: false,
          },
        );
      };
      try {
        if (normalizeRelativePath(relative) !== relative) reject('INVALID_ARGUMENT');
      } catch {
        reject('INVALID_ARGUMENT');
      }
      if (invalidBlockDirectory(relative)) reject('BLOCK_DIRECTORY_INVALID');
      if (relative.startsWith('design-reference/')) reject('FILE_WRITE_NOT_ALLOWED');
      const document = isExecutionDocument(relative);
      const internal = relative.startsWith('.d2c-cache/') || document;
      if (internal && !document) {
        if (!/^\.d2c-cache\/[^/]+\/slice-manifest-[^/]+\.json$/.test(relative))
          reject('FILE_WRITE_NOT_ALLOWED');
        let value;
        try {
          value = JSON.parse(content);
        } catch {
          reject('INVALID_ARGUMENT');
        }
        if (JSON.stringify(value).match(/"confirmed"\s*:\s*true/)) reject('FILE_WRITE_NOT_ALLOWED');
      } else if (!document) {
        try {
          assertArtifactPath(relative);
        } catch {
          reject('FILE_WRITE_NOT_ALLOWED');
        }
      }
      if (/check-report|validation-report/i.test(relative)) reject('FILE_WRITE_NOT_ALLOWED');
      if (hasLocalImageUrl(relative, content))
        throw toolIssue(
          'INVALID_ASSET_URL',
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'write_file' },
          { path: relative },
        );
      const filename = await resolveWorkspacePath(restored.workspace, relative);
      await input.save(relative, content, internal);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename, content, { mode: 0o600 });
      synced.set(relative, createHash('sha256').update(content).digest('hex'));
      if (/\.[cm]?[jt]sx?$/.test(relative) && !internal) changedSources.add(relative);
      if (!document) mutation++;
      return `已保存：${relative}`;
    },
    /** 精确替换与完整写入共用保存、修订及验收失效逻辑；整个过程由同一短队列保护。 */
    async edit(relative, oldText, newText, expectedSha256) {
      try {
        if (normalizeRelativePath(relative) !== relative) throw new Error('INVALID_PATH');
      } catch {
        throw toolIssue(
          'INVALID_ARGUMENT',
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'edit_file' },
          { path: relative.slice(0, 1024) },
        );
      }
      if (relative.startsWith('.d2c-cache/') || relative.startsWith('design-reference/'))
        throw toolIssue('FILE_WRITE_NOT_ALLOWED', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'edit_file',
        });
      if (!isExecutionDocument(relative)) {
        try {
          assertArtifactPath(relative);
        } catch {
          throw toolIssue('FILE_WRITE_NOT_ALLOWED', 'VALIDATION_FAILED', {
            stage: 'tool',
            tool: 'edit_file',
          });
        }
      }
      const filename = await resolveWorkspacePath(restored.workspace, relative);
      let current: string;
      try {
        current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          await fs.readFile(filename),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw toolIssue(
            'FILE_NOT_FOUND',
            'VALIDATION_FAILED',
            { stage: 'tool', tool: 'edit_file' },
            { path: relative },
          );
        throw error;
      }
      const content = editFileText(relative, current, oldText, newText, expectedSha256);
      await tools.write(relative, content);
      return JSON.stringify({
        ok: true,
        path: relative,
        sha256: createHash('sha256').update(content).digest('hex'),
        message: '片段已替换并保存',
      });
    },
    /** 受保护图片先返回纠错；源码先提交删除再移除临时副本，存储异常仍终止。 */
    async remove(relative) {
      validate(() => assertArtifactPath(relative));
      if (relative.startsWith('design-reference/'))
        throw toolIssue('FILE_DELETE_NOT_ALLOWED', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'delete_file',
        });
      if (assetFiles.has(relative))
        throw toolIssue(
          'FILE_DELETE_NOT_ALLOWED',
          'VALIDATION_FAILED',
          { stage: 'tool', tool: 'delete_file' },
          { path: relative },
        );
      const filename = await resolveWorkspacePath(restored.workspace, relative);
      await input.remove(relative);
      await fs.unlink(filename);
      synced.delete(relative);
      mutation++;
      return `已删除：${relative}`;
    },
    /** 将工具参数映射为固定 Figma 脚本参数；成功后同步真实文件并更新本轮证据。 */
    async figma(command, args) {
      if (!figmaCommands.some((value) => value === command))
        throw new RunExecutionError('VALIDATION_FAILED', { stage: 'tool', tool: 'figma' });
      let target;
      try {
        if (!args.figmaUrl && !input.figmaUrl) throw new Error('Missing design');
        target = designTarget(args.figmaUrl ?? input.figmaUrl!, args.rootNodeId);
      } catch {
        throw toolIssue('INVALID_ARGUMENT', 'FIGMA_ADDRESS_MISSING', {
          stage: 'tool',
          tool: 'figma',
        });
      }
      const { fileKey, rootNodeId: defaultNode } = target;
      const assetUrlsPath = `.d2c-cache/${fileKey}/asset-urls.json`;
      if (
        (args.subtree === true || args.offset !== undefined || args.limit !== undefined) &&
        command !== 'inspect-node'
      )
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', { stage: 'tool', tool: 'figma' });
      if ((args.offset !== undefined || args.limit !== undefined) && args.subtree !== true)
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', { stage: 'tool', tool: 'figma' });
      const nodeId = args.nodeId ?? defaultNode;
      if (
        nodeId &&
        (command === 'inspect-node'
          ? nodeId.length > 200 || !/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(nodeId)
          : !/^\d+:\d+$/.test(nodeId))
      )
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', { stage: 'tool', tool: 'figma' });
      if (command === 'inspect-node') {
        if (!defaultNode || !nodeId)
          throw toolIssue('INVALID_ARGUMENT', 'FIGMA_REQUEST_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command,
          });
        const relative = `.d2c-cache/${fileKey}/nodes/${defaultNode.replace(':', '_')}.json`;
        const page = JSON.parse(await read(relative, false, 0, input.textFileBytes));
        if (page?.ok === false) return JSON.stringify(page);
        let view;
        try {
          const cache = JSON.parse(page.content);
          if (cache && Object.hasOwn(cache, '_depth') && cache._depth !== null)
            return JSON.stringify(toolFeedback('FIGMA_CACHE_INCOMPLETE'));
          view =
            args.subtree === true
              ? inspectFigmaSubtree(cache, nodeId, args.offset, args.limit)
              : inspectFigmaNode(cache, nodeId, args.depth ?? 1);
        } catch (error) {
          throw toolIssue('INVALID_ARGUMENT', 'FIGMA_REQUEST_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command,
          });
        }
        return input.redact(
          JSON.stringify(
            view
              ? {
                  ok: true,
                  data: {
                    cachePath: relative,
                    ...view,
                    nodes: view.nodes.map(({ attributes, childIds }) => ({
                      attributes: compactFigmaNodeForModel(attributes),
                      childIds,
                    })),
                  },
                }
              : {
                  ok: false,
                  type: 'tool_feedback',
                  code: 'INVALID_ARGUMENT',
                  action: 'adjust',
                  retryable: false,
                  message:
                    '完整根缓存中没有该节点，请核对节点编号；必要时先 fetch-node 获取完整根节点。',
                },
          ),
        );
      }
      let filename = args.filename;
      let exportPath: string | undefined;
      const sliceSlug = [...activeSlices]
        .reverse()
        .find(([, design]) => sameTarget(design, target))?.[0];
      const sliceDesign = sliceSlug ? activeSlices.get(sliceSlug)! : undefined;
      const existingSlices =
        command === 'export-image' && sliceSlug ? await reuseSlices(sliceSlug, sliceDesign) : null;
      if (command === 'export-image') {
        const format = args.format ?? 'png';
        if (!filename || !['png', 'jpg', 'svg'].includes(format))
          throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command: 'export-image',
          });
        /** 原脚本自动添加扩展名；允许模型传入常见的带后缀名称，避免双重扩展名。 */
        if (filename.toLowerCase().endsWith(`.${format}`))
          filename = filename.slice(0, -(format.length + 1));
        if (!filename)
          throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command: 'export-image',
          });
        const normalized = validate(() => normalizeRelativePath(filename!));
        if (normalized !== filename)
          throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command: 'export-image',
          });
        /** 文件名相对于配置的图片目录；在脚本写入前核对完整目标及已存在的符号链接。 */
        const root = String(executionConfig.images?.assetsDir ?? 'static/')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '');
        if (root && filename.startsWith(root + '/')) filename = filename.slice(root.length + 1);
        if (!filename || (root && filename.startsWith(root + '/')))
          throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
            stage: 'tool',
            tool: 'figma',
            command,
          });
        const basename = path.posix.basename(filename);
        const english = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(basename)
          ? basename
          : englishSliceName(basename);
        if (!english || english.length > 160)
          return JSON.stringify({
            ...toolFeedback('INVALID_ARGUMENT'),
            message:
              '请为 filename 提供不超过160字符的英文、数字、连字符或下划线名称；未识别中文需翻译，尚未导出图片。',
          });
        filename = path.posix.join(path.posix.dirname(filename), english);
        exportPath = validate(() =>
          assertArtifactPath(`${root ? root + '/' : ''}${filename}.${format}`),
        );
        const owners = exportOwners.get(exportPath);
        const caseConflict = [...assetFiles.keys(), ...exportOwners.keys()].some(
          (relative) =>
            relative !== exportPath && relative.toLowerCase() === exportPath!.toLowerCase(),
        );
        if (
          caseConflict ||
          (owners && [...owners].some((owner) => owner !== `${fileKey}/${nodeId}`)) ||
          (!owners && assetFiles.has(exportPath))
        )
          return JSON.stringify({
            ...toolFeedback('INVALID_ARGUMENT'),
            message: '图片路径已被其他节点占用或缺少来源证据，请提供不同的英文 filename。',
          });
        await resolveWorkspacePath(restored.workspace, exportPath);
      }
      const argv =
        command === 'verify-token'
          ? [command]
          : command === 'cache-check'
            ? [command, fileKey]
            : [command, fileKey, nodeId ?? ''];
      /** 会话根节点必须完整拉取，覆盖历史带 depth 的缓存；其他节点保留按需深度。 */
      if (args.depth && !(command === 'fetch-node' && nodeId === defaultNode))
        argv.push(`--depth=${args.depth}`);
      if (filename) argv.push(`--filename=${filename}`);
      if (args.format) argv.push(`--format=${args.format}`);
      const rootScreenshot =
        command === 'screenshot' &&
        nodeId === defaultNode &&
        !!boundDesign &&
        sameTarget(target, boundDesign);
      if (rootScreenshot) {
        argv.push('--tag=whole', `--scale=${args.scale ?? 1}`);
        /** 删除准确临时目标，失败脚本不能借旧同名图报告本次保存成功。 */
        await fs.rm(
          await resolveWorkspacePath(
            restored.workspace,
            designReferencePaths(fileKey, nodeId!).temporary,
          ),
          { force: true },
        );
      } else {
        if (command === 'screenshot') argv.push(`--tag=design-${fileKey}`);
        if (args.scale) argv.push(`--scale=${args.scale}`);
      }
      const result = await script('figma.mjs', argv, true);
      let invalidated = false;
      let payload;
      try {
        payload = JSON.parse(result.output);
        invalidated = command === 'cache-check' && payload?.data?.status === 'miss';
        if (payload?.ok === false)
          throwFigmaScriptFailure({
            args: argv,
            output: result.output,
            context: {
              stage: 'tool',
              tool: 'figma',
              command: figmaCommands.find((value) => value === command),
            },
          });
        if (!payload || payload.ok !== true)
          throw new RunExecutionError('SCRIPT_OUTPUT_INVALID', { stage: 'tool' });
      } catch (error) {
        if (error instanceof ToolIssue || error instanceof RunExecutionError) throw error;
        throw executionError(error, 'SCRIPT_OUTPUT_INVALID', { stage: 'tool' });
      }
      if (invalidated) {
        for (const [slug, design] of activeSlices)
          if (
            designTarget(design.figmaUrl).fileKey === fileKey ||
            (design.baseUrl && designTarget(design.baseUrl).fileKey === fileKey)
          )
            activeSlices.delete(slug);
        report = undefined;
        for (const key of synced.keys())
          if (key.startsWith(`.d2c-cache/${fileKey}/`)) synced.delete(key);
      }
      if (exportPath)
        await materializeExportImage({
          workspace: restored.workspace,
          target: exportPath,
          returnedPath: payload.data?.path,
          reused: payload.data?.reused === true,
          maxBytes: input.uploadBytes,
          sourceHash: (relative) =>
            exportOwners.get(relative)?.has(`${fileKey}/${nodeId}`)
              ? assetFiles.get(relative)?.sha256
              : undefined,
          signal: input.signal,
          assertLease: input.assertLease,
        });
      if (rootScreenshot) {
        let reference;
        try {
          reference = await persistDesignReference({
            workspace: restored.workspace,
            fileKey,
            nodeId: nodeId!,
            figmaUrl: target.figmaUrl,
            outputPath: payload.data?.path,
            scale: args.scale ?? 1,
            maxBytes: input.uploadBytes,
            save: input.save,
            saveBinary: input.saveBinary,
          });
        } catch (error) {
          throw executionError(error, 'STORAGE_FAILED', {
            stage: 'storage',
            tool: 'figma',
            command: 'screenshot',
          });
        }
        assetFiles.set(reference.imagePath, {
          path: reference.imagePath,
          sha256: reference.sha256,
          kind: 'asset',
          size: reference.size,
        });
        synced.set(reference.imagePath, reference.sha256);
        const metadata = await fs.readFile(
          await resolveWorkspacePath(restored.workspace, reference.metadataPath),
        );
        synced.set(reference.metadataPath, createHash('sha256').update(metadata).digest('hex'));
        await sync();
        mutation++;
        return JSON.stringify({
          ok: true,
          data: {
            ...reference,
            path: reference.imagePath,
            url: input.assetUrls?.()[reference.imagePath] ?? null,
            saved: true,
            message: '完整根设计基准已保存；这是设计参考附件，不是页面切图或视觉通过结论。',
          },
        });
      }
      await sync();
      await publishAssetUrls(true, fileKey);
      if (
        !sessionNameRead &&
        command === 'fetch-node' &&
        nodeId === defaultNode &&
        (!boundDesign || sameTarget(target, boundDesign)) &&
        payload.data?.node?.id === nodeId &&
        typeof payload.data.node.name === 'string'
      ) {
        await input.onFigmaRoot?.(payload.data.node.name);
        sessionNameRead = true;
      }
      mutation++;
      if (exportPath) {
        if (!assetFiles.has(exportPath))
          throw toolIssue(
            'FIGMA_EXPORT_FILE_MISSING',
            'FIGMA_REQUEST_FAILED',
            { stage: 'tool', tool: 'figma', command: 'export-image' },
            { path: exportPath },
          );
        claimImage(exportPath, fileKey, nodeId!);
        await saveCacheText(
          `.d2c-cache/${fileKey}/image-exports.json`,
          JSON.stringify({
            images: [...exportOwners].flatMap(([relative, owners]) =>
              [...owners]
                .filter((owner) => owner.startsWith(fileKey + '/'))
                .map((owner) => ({ path: relative, nodeId: owner.slice(fileKey.length + 1) })),
            ),
          }),
        );
        /** 补切只扩展已核实的完整批次，不能将缺图的前置清单伪装成完成。 */
        let manifest: string | null = null;
        if (existingSlices && sliceSlug) {
          const theme = existingSlices.value.themes[0];
          const previous = theme.entries.find(
            (entry: { nodeId?: string }) => entry.nodeId === nodeId,
          );
          const entries = theme.entries.filter(
            (entry: { nodeId?: string }) => entry.nodeId !== nodeId,
          );
          entries.push({
            ...previous,
            nodeId,
            name: previous?.name ?? nodeId,
            filename: path.posix.basename(exportPath),
            filepath: exportPath,
            supplemental: true,
          });
          theme.entries = entries;
          theme.hit = entries.length;
          await storeSliceCache(
            sliceSlug,
            inspectSliceManifest(
              JSON.stringify(existingSlices.value),
              sliceSlug,
              await currentSliceFiles(),
            ),
            sliceDesign,
          );
          manifest = slicePaths(sliceSlug, sliceDesign).manifest;
        }
        /** 成功回执只在上传、文件提交和地址表同步完成后返回。 */
        return JSON.stringify({
          ok: true,
          data: {
            ...payload.data,
            path: exportPath,
            nodeId,
            uploaded: true,
            url: input.assetUrls?.()[exportPath] ?? null,
            assetUrls: input.assetUrls ? assetUrlsPath : null,
            assetUrlsUpdated: !!input.assetUrls && !!assetUrlsPath,
            manifest,
            manifestUpdated: !!manifest,
            message:
              '图片已保存；请使用返回的地址或读取 assetUrls 地址表，不要仅凭旧读取结果判断补切图片缺失。',
          },
        });
      }
      if (command === 'fetch-node' && payload.data?.node) {
        return JSON.stringify({
          ...payload,
          data: { ...payload.data, node: compactFigmaNodeForModel(payload.data.node) },
        });
      }
      return result.output;
    },
    /** 执行规则检查并返回修复报告；仅 merge 报告用于最终结论，并绑定当前 mutation。 */
    async rules(relative, mode) {
      const normalized = validate(() => assertArtifactPath(relative));
      const product = await resolveWorkspacePath(restored.workspace, normalized);
      if (!fileKey) throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
      let isDirectory: boolean;
      try {
        isDirectory = (await fs.stat(product)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        throw toolIssue('FILE_NOT_FOUND', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      }
      if (!isDirectory)
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'check_rules',
        });
      for (const file of await list()) {
        if (
          !file.startsWith(normalized + '/') ||
          !/\.(?:[cm]?[jt]sx?|css|scss|sass|less|styl|html|vue|svelte)$/i.test(file)
        )
          continue;
        if (
          hasLocalImageUrl(
            file,
            await fs.readFile(await resolveWorkspacePath(restored.workspace, file), 'utf8'),
          )
        )
          throw toolIssue(
            'INVALID_ASSET_URL',
            'VALIDATION_FAILED',
            { stage: 'tool', tool: 'check_rules' },
            { path: file },
          );
      }
      if (mode === 'merge') validationAttempted = true;
      /** 新原生报告必须对应当前输入并完成疑难项，文件存在本身不是有效扫描。 */
      for (const file of await list()) {
        if (!file.startsWith(normalized + '/') || path.posix.basename(file) !== 'rule-hits.json')
          continue;
        const content = await fs.readFile(
          await resolveWorkspacePath(restored.workspace, file),
          'utf8',
        );
        let savedReport;
        try {
          savedReport = JSON.parse(content);
        } catch {
          continue;
        }
        if (
          !savedReport?.nativeScan &&
          savedReport?.generated_by !== 'native-rule-scan' &&
          savedReport?.context?.scan_kind !== 'design_triggers'
        )
          continue;
        const current = await scanRules(file, savedReport.context?.rootNodeId);
        const problems = nativeScanProblems(current, content);
        if (!problems.length) continue;
        const output = JSON.stringify({
          ok: false,
          violations: problems.map((message) => ({ rule: 'GATE-native-rule-scan', file, message })),
        });
        if (mode === 'merge') await saveRuleResult(normalized, mutation, { code: 1, output });
        return JSON.stringify({ ...toolFeedback('RULES_FAILED'), report: output });
      }
      /** 拒绝以已知截断的根缓存验收；缺失缓存仍交给原规则脚本报告。 */
      if (defaultNode) {
        const root = await resolveWorkspacePath(
          restored.workspace,
          `.d2c-cache/${fileKey}/nodes/${defaultNode.replace(':', '_')}.json`,
        );
        let cache;
        try {
          cache = JSON.parse(await fs.readFile(root, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          if (input.target === 'rn' && mode === 'merge')
            return JSON.stringify(toolFeedback('FIGMA_CACHE_INCOMPLETE'));
        }
        if (cache && Object.hasOwn(cache, '_depth') && cache._depth !== null)
          return JSON.stringify(toolFeedback('FIGMA_CACHE_INCOMPLETE'));
      }
      const checkedMutation = mutation;
      const urls = input.assetUrls?.() ?? {};
      const images = new Map<string, string>();
      for (const [slug, design] of activeSlices) {
        const inspected = await reuseSlices(slug, design);
        if (!inspected) throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
        for (const theme of inspected.value.themes) {
          for (const entry of theme.entries) {
            if (path.posix.basename(entry.filepath) !== entry.filename)
              throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
            const url = urls[entry.filepath];
            if (!url) continue;
            if (images.has(url) && images.get(url) !== entry.filepath)
              throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
            images.set(url, entry.filepath);
          }
        }
      }
      let result = await script(
        'check-rules.mjs',
        [`--${mode}`, product, '--cache-key', fileKey],
        false,
      );
      if (images.size) {
        const view = await createRulesWorkspace({
          workspace: restored.workspace,
          directory: restored.directory,
          product: normalized,
          files: ['pp-d2c.config.json', ...(await list())],
          images,
          signal: input.signal,
        });
        try {
          if (view.references) {
            const mapped = await script(
              'check-rules.mjs',
              [`--${mode}`, view.product, '--cache-key', fileKey],
              false,
              view.directory,
            );
            const checked = mergeRulesReports(
              result.output,
              mapped.output.replaceAll(view.directory, view.workspace),
              view.references,
            );
            result = { code: checked.ok ? 0 : 1, output: input.redact(JSON.stringify(checked)) };
          }
          await view.assertUnchanged(['pp-d2c.config.json', ...(await list())]);
        } finally {
          await view.dispose();
        }
      }
      if (input.target === 'rn' && mode === 'merge') {
        const checked = appendImageCoverage(result.output, await checkRnImageCoverage(normalized));
        result = { code: checked.ok ? 0 : 1, output: input.redact(JSON.stringify(checked)) };
      }
      await input.assertLease();
      input.signal.throwIfAborted();
      if (
        mutation !== checkedMutation ||
        JSON.stringify(input.assetUrls?.() ?? {}) !== JSON.stringify(urls)
      )
        throw new RunExecutionError('VALIDATION_FAILED', { stage: 'validation' });
      if (mode === 'merge') {
        await saveRuleResult(normalized, checkedMutation, result);
      }
      if (result.code === 1)
        return JSON.stringify({ ...toolFeedback('RULES_FAILED'), report: result.output });
      return result.output;
    },
    /** 优先复用完整切图；尺寸告警交由模型对话处理，不设置人工审批门禁。 */
    async slices(slug, options = {}) {
      if (!options.figmaUrl && !input.figmaUrl)
        throw toolIssue('RESOURCE_UNAVAILABLE', 'FIGMA_ADDRESS_MISSING', {
          stage: 'tool',
          tool: 'prepare_slices',
        });
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'prepare_slices',
        });
      let design: SliceDesign;
      try {
        design = {
          figmaUrl: designTarget(options.figmaUrl ?? input.figmaUrl!).figmaUrl,
          ...(options.baseUrl !== undefined
            ? { baseUrl: designTarget(options.baseUrl).figmaUrl }
            : {}),
          ...(options.names ? { names: { ...options.names } } : {}),
        };
        validateSliceNames(design.names ?? {});
      } catch {
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'prepare_slices',
        });
      }
      /** 显式基线优先；省略参数时沿用原 last-page 约定，并纳入缓存范围。 */
      if (!design.baseUrl) {
        try {
          const last = JSON.parse(
            await fs.readFile(
              await resolvePath(restored.workspace, '.d2c-cache/last-page.json'),
              'utf8',
            ),
          );
          if (last.fileKey && (last.rootNodeId || last.nodeId))
            design.baseUrl = designTarget(
              `https://www.figma.com/design/${last.fileKey}/?node-id=${(last.rootNodeId ?? last.nodeId).replace(':', '-')}`,
            ).figmaUrl;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const claimed = sliceClaims.get(slug);
      if (claimed && !sameTarget(claimed, design))
        throw toolIssue('INVALID_ARGUMENT', 'VALIDATION_FAILED', {
          stage: 'tool',
          tool: 'prepare_slices',
        });
      sliceClaims.set(slug, design);
      const { fileKey } = designTarget(design.figmaUrl);
      const assetUrlsPath = `.d2c-cache/${fileKey}/asset-urls.json`;
      const reused = await reuseSlices(slug, design);
      if (reused) {
        await publishAssetUrls(true, fileKey);
        return JSON.stringify({
          manifest: slicePaths(slug, design).manifest,
          assetUrls: assetUrlsPath,
          reused: true,
          total: reused.total,
          failed: 0,
          warningCount: reused.warningCount,
          confirmationPolicy: 'conversation',
          message: '已复用完整切图；告警及业务确认通过普通对话处理。',
        });
      }
      activeSlices.delete(slug);
      mutation++;
      const relative = slicePaths(slug, design).manifest;
      const manifest = await resolveWorkspacePath(restored.workspace, relative);
      await input.assertLease();
      input.signal.throwIfAborted();
      const network = createSliceNetwork({
        proxyUrl: input.proxyUrl,
        allowedHosts: input.allowedHosts,
        token: await input.token(),
        signal: input.signal,
        uploadBytes: input.uploadBytes,
      });
      try {
        await prepareSlices({
          workspace: restored.workspace,
          figmaUrl: design.figmaUrl,
          baseUrl: design.baseUrl,
          names: design.names,
          slug,
          assetsDir: executionConfig.images?.assetsDir || 'static/',
          scope: await currentScope(design),
          signal: input.signal,
          request: network.request,
          assertLease: input.assertLease,
          saveText: saveCacheText,
          async saveBinary(relative, content) {
            await input.assertLease();
            input.signal.throwIfAborted();
            const filename = await resolveWorkspacePath(restored.workspace, relative);
            await input.saveBinary(relative, content);
            await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await fs.writeFile(filename, content, { mode: 0o600 });
            const digest = sliceHash(content);
            synced.set(relative, digest);
            assetFiles.set(relative, {
              path: relative,
              kind: 'asset',
              sha256: digest,
              size: content.length,
            });
            await publishAssetUrls(true, fileKey);
          },
          async progress(value) {
            if (!input.progress) return;
            try {
              await input.progress(value);
            } catch (error) {
              throw executionError(error, 'STORAGE_FAILED', { stage: 'storage' });
            }
          },
        });
      } finally {
        await network.close();
      }
      mutation++;
      const content = await fs.readFile(manifest, 'utf8');
      let inspected: ReturnType<typeof inspectSliceManifest>;
      try {
        inspected = inspectSliceManifest(content, slug, await currentSliceFiles());
      } catch (error) {
        throw toolIssue(
          'RESOURCE_UNAVAILABLE',
          'FIGMA_REQUEST_FAILED',
          {
            stage: 'tool',
            tool: 'prepare_slices',
          },
          {},
          new SliceDiagnosticError({
            phase: 'manifest',
            reason: 'MANIFEST_INVALID',
            bytes: Buffer.byteLength(content),
          }),
        );
      }
      await storeSliceCache(slug, inspected, design);
      return JSON.stringify({
        manifest: relative,
        assetUrls: assetUrlsPath,
        reused: false,
        total: inspected.total,
        failed: 0,
        warningCount: inspected.warningCount,
        confirmationPolicy: 'conversation',
        message: '切图已完成；告警及业务确认通过普通对话处理。',
      });
    },
  };
  /** 对外只抛固定类型；原始文件、脚本和存储异常仅留在内存 cause 链。 */
  function guarded<T extends unknown[], R>(
    tool: FailureTool,
    action: (...args: T) => Promise<R>,
    command?: (...args: T) => FailureCommand | undefined,
  ) {
    return async (...args: T) => {
      try {
        return await action(...args);
      } catch (error) {
        if (error instanceof ToolIssue) throw error;
        if (
          error instanceof RunExecutionError &&
          ['CREDENTIAL_UNAVAILABLE', 'FIGMA_ADDRESS_MISSING'].includes(error.code)
        )
          throw new ToolIssue(
            toolFeedback('RESOURCE_UNAVAILABLE'),
            new RunExecutionError(
              error.code,
              { ...error.context, tool, requiresUser: true },
              error,
            ),
          );
        throw executionError(error, 'TOOL_FAILED', {
          stage: 'tool',
          tool,
          ...(command ? { command: command(...args) } : {}),
        });
      }
    };
  }
  let scriptQueue: Promise<unknown> = Promise.resolve();
  /** 文件副作用与缓存脚本共用短临界区；模型循环及普通 list/read 不持锁。 */
  function runScriptAction<T>(action: () => Promise<T>): Promise<T> {
    const pending = scriptQueue.then(action);
    scriptQueue = pending.catch(() => {});
    return pending;
  }
  const scriptTools = {
    edit: (relative: string, oldText: string, newText: string, expectedSha256: string) =>
      runScriptAction(() => tools.edit!(relative, oldText, newText, expectedSha256)),
    write: (relative: string, content: string) =>
      runScriptAction(() => tools.write(relative, content)),
    remove: (relative: string) => runScriptAction(() => tools.remove(relative)),
    figma: (...[command, args]: Parameters<GenerationTools['figma']>) =>
      runScriptAction(() => tools.figma(command, args)),
    rules: (...[relative, mode]: Parameters<GenerationTools['rules']>) =>
      runScriptAction(() => tools.rules(relative, mode)),
    slices: (...[slug, options]: Parameters<GenerationTools['slices']>) =>
      runScriptAction(() => tools.slices(slug, options)),
  };
  /** 设计缓存和图片地址变化时隔离子任务上下文，避免复用过期扫描。 */
  async function subagentContext(role?: string) {
    const entries = [];
    if (role === 'rule_scan') entries.push(['native-rule-scan', nativeRuleScanRevision]);
    for (const relative of [
      'pp-d2c.config.json',
      `.d2c-cache/${fileKey}/nodes/${defaultNode?.replace(':', '_')}.json`,
      `.d2c-cache/${fileKey}/meta.json`,
      ...(role === 'rule_scan' ? [] : [`.d2c-cache/${fileKey}/asset-urls.json`]),
    ]) {
      try {
        entries.push([
          relative,
          sliceHash(await fs.readFile(await resolvePath(restored.workspace, relative))),
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries.push([relative, null]);
      }
    }
    if (role === 'design' || role === 'review')
      entries.push([
        'source',
        JSON.stringify(
          [...synced.entries()]
            .filter(([path]) => !path.startsWith('.'))
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]);
    return sliceHash(JSON.stringify(entries));
  }
  return {
    /** 只核对真实保存的文件；普通问答不会因为会话里有旧产物而被强制生成。 */
    async delivery(required: boolean) {
      return runScriptAction(async () => {
        if (!required && !changedSources.size) return { signature: '', problems: [] };
        const files = [];
        for (const [relative, sha256] of synced) {
          if (relative.startsWith('.') || isExecutionDocument(relative)) continue;
          files.push({
            path: relative,
            sha256,
            ...(/\.[cm]?[jt]sx?$/.test(relative)
              ? {
                  content: await fs.readFile(
                    await resolvePath(restored.workspace, relative),
                    'utf8',
                  ),
                }
              : {}),
          });
        }
        return inspectGenerationDelivery(files, required, changedSources);
      });
    },
    /** 显式复查需要保存新结论；普通讨论不覆盖历史产物状态。 */
    validationRequested: () => validationAttempted,
    /** 图片字节仅保留在本轮内存中，历史和检查点保存短引用。 */
    async resolveImage(reference: string) {
      input.signal.throwIfAborted();
      await input.assertLease();
      return readImages.get(reference) ?? null;
    },
    tools: {
      subagentContext,
      outputPlan: generationPlan(executionConfig, await list()),
      edit: guarded('edit_file', scriptTools.edit),
      list: guarded('list_files', tools.list),
      read: guarded('read_file', tools.read),
      write: guarded('write_file', scriptTools.write),
      remove: guarded('delete_file', scriptTools.remove),
      figma: guarded('figma', scriptTools.figma, (command) =>
        figmaCommands.find((value) => value === command),
      ),
      rules: guarded('check_rules', scriptTools.rules),
      scanRules: guarded('check_rules', (relative: string, nodeId?: string) =>
        runScriptAction(() => scanRules(relative, nodeId)),
      ),
      slices: guarded('prepare_slices', scriptTools.slices),
    },
    /**
     * 汇总本轮证据：切图完整或缓存校验通过、最新 merge 通过且其后未变更，源码均在检查目录内。
     * @returns passed/failed/not_checked/stale、源码数量及实际报告路径；未检查不能表示通过。
     */
    async validation() {
      return runScriptAction(async () => {
        const source = (await list()).filter(
          (relative) => /\.(?:jsx|tsx)$/.test(relative) && !relative.startsWith('.'),
        );
        let cacheValid = activeSlices.size > 0 && activeSlices.size === sliceClaims.size;
        for (const [slug, design] of activeSlices)
          cacheValid = !!(await reuseSlices(slug, design)) && cacheValid;
        const imagesValid = input.target !== 'rn' || (await checkRnImageCoverage()).length === 0;
        const passed =
          imagesValid &&
          cacheValid &&
          !!report?.passed &&
          report.mutation === mutation &&
          source.length > 0 &&
          source.every((relative) => relative.startsWith(report!.path + '/'));
        return {
          status: passed
            ? 'passed'
            : !report
              ? 'not_checked'
              : report.mutation !== mutation
                ? 'stale'
                : 'failed',
          sourceFiles: source.length,
          ...(report ? { reportPath: report.reportPath } : {}),
        };
      });
    },
  };
}
