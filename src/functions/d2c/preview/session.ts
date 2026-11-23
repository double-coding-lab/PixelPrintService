import { findOrderedRows } from '../utils/orderedRead';
import path from 'node:path';
import ts from 'typescript';
import type { PreviewDiagnostic } from './diagnostics';
import { createHash } from 'node:crypto';
import type { Sequelize, Transaction } from 'sequelize';
import type { D2cFile } from '../../../models/D2cFile';
import type { D2cWorkspace } from '../../../models/D2cWorkspace';
import { ownedSession, SessionError } from '../session/access';
import { createConfigSnapshot, parseWorkspaceConfigs } from '../utils/config';
import { assertArtifactPath } from '../utils/paths';
import { contentModel, copyTextStorage, resolveTextContent } from '../content/runtime';
import type { TextContentReference } from '../content/store';

export type PreviewSnapshotFile = {
  path: string;
  kind: 'source' | 'asset' | 'attachment';
  content: string | null;
  /** Private frozen reference; hydrate and remove it before entering an editor. */
  contentRef?: TextContentReference | null;
  objectLocator: Record<string, unknown> | null;
  size: number;
  sha256: string;
};
/** Frozen source contract shared by detached editors and personal works. */
export type EditSourceSnapshot = {
  fileRevision: number;
  target: 'h5' | 'rn';
  snapshot: PreviewSnapshotFile[];
  configSnapshot: Record<string, unknown>;
  entries: string[];
  entryPath: string | null;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** 授权调用方将冻结正文水合为编辑字符串，显式投影以剥离私有正文引用。 */
export async function hydratePreviewSnapshot(
  mysql: Sequelize,
  snapshot: PreviewSnapshotFile[],
  expectedScope?: string,
  signal?: AbortSignal,
): Promise<PreviewSnapshotFile[]> {
  const result: PreviewSnapshotFile[] = [];
  for (const file of snapshot) {
    signal?.throwIfAborted();
    const content =
      file.kind === 'source' ? await resolveTextContent(mysql, file, expectedScope, signal) : null;
    if (
      file.kind === 'source' &&
      (typeof content !== 'string' ||
        Buffer.byteLength(content) !== file.size ||
        sha(content) !== file.sha256)
    )
      throw new SessionError(503, 'FILE_CORRUPT', '预览源码校验失败');
    result.push({
      path: file.path,
      kind: file.kind,
      content,
      objectLocator: file.kind === 'source' ? null : structuredClone(file.objectLocator),
      size: file.size,
      sha256: file.sha256,
    });
  }
  return result;
}

/** 与隔离构建器保持相同模板边界，报告与内部配置不参与输入摘要。 */
function participates(file: Pick<D2cFile, 'kind' | 'path'>) {
  if (file.kind === 'internal' || !file.path) return false;
  if (file.path.startsWith('design-reference/')) return false;
  const parts = file.path.split('/');
  if (
    parts.some(
      (part) =>
        /^(?:node_modules|internal|__preview|config|configs|dist|build|coverage)$/i.test(part) ||
        /^(?:package(?:-lock)?\.json|(?:npm|pnpm|yarn|bun).*lock.*|(?:vite|postcss|babel|webpack|rollup|eslint|prettier|tailwind|next|metro|preview|tsconfig|jsconfig)(?:[.-].*)?|.*\.config\.[^.]+)$/i.test(
          part,
        ),
    )
  )
    return false;
  const asset = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i.test(
    file.path,
  );
  return (
    asset ||
    (!file.path.startsWith('public/') && /\.(?:tsx?|jsx?|css|scss|sass|json)$/i.test(file.path))
  );
}

/** 入口格式与不存在分别处理；尚未生成的合法入口返回等待状态。 */
export function validateSessionEntry(entryPath?: string) {
  if (entryPath === undefined) return;
  try {
    if (assertArtifactPath(entryPath) !== entryPath || !/\.(?:tsx|jsx)$/i.test(entryPath))
      throw new Error();
  } catch {
    throw new SessionError(422, 'INVALID_ENTRY', '请选择实际的 TSX 或 JSX 页面入口');
  }
}

/** 同一事务读取归属、修订、配置及所有持久文件，二进制定位也随快照冻结。 */
export async function sessionPreviewInput(
  mysql: Sequelize,
  userId: string,
  sessionId: string,
  entryPath: string | undefined,
  transaction: Transaction,
  limits: { textFileBytes: number; filesPerSession: number },
  write: boolean,
  authorizer: typeof ownedSession = ownedSession,
) {
  validateSessionEntry(entryPath);
  const { workspace: owned, session } = await authorizer(
    mysql,
    userId,
    sessionId,
    transaction,
    write ? 'write' : 'read',
  );
  const workspace = write
    ? owned
    : await (mysql.models.D2cWorkspace as typeof D2cWorkspace).findOne({
        where: { workspaceId: owned.workspaceId },
        transaction,
      });
  if (!session.target || !workspace?.activeResourceRevisionId)
    throw new SessionError(503, 'RESOURCE_UNAVAILABLE', '会话固定资源尚未就绪');
  const rows = await findOrderedRows(
    contentModel(mysql, mysql.models.D2cFile as typeof D2cFile),
    'pathHash',
    {
      where: { sessionId: session.sessionId },
      transaction,
      order: [['pathHash', 'ASC']],
      ...(write ? { lock: transaction.LOCK.UPDATE } : {}),
    },
  );
  const snapshot: PreviewSnapshotFile[] = [];
  let total = 0;
  for (const file of rows.filter(participates)) {
    let storage: ReturnType<typeof copyTextStorage>;
    try {
      storage = file.kind === 'source' ? copyTextStorage(mysql, file) : { content: null };
      if (
        !file.path ||
        assertArtifactPath(file.path) !== file.path ||
        sha(file.path) !== file.pathHash ||
        !['source', 'asset', 'attachment'].includes(file.kind ?? '') ||
        !Number.isSafeInteger(file.size) ||
        file.size! < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      )
        throw new Error();
      if (
        file.kind === 'source' &&
        (typeof storage.content === 'string'
          ? Buffer.byteLength(storage.content) !== file.size || sha(storage.content) !== file.sha256
          : !('contentRef' in storage) ||
            !storage.contentRef ||
            storage.contentRef.scope !== `session:${session.sessionId}` ||
            storage.contentRef.size !== file.size ||
            storage.contentRef.sha256 !== file.sha256)
      )
        throw new Error();
      if (file.kind !== 'source' && !file.objectLocator) throw new Error();
    } catch {
      throw new SessionError(503, 'FILE_CORRUPT', '会话预览文件校验失败');
    }
    total += file.size!;
    if (
      total > 64 * 1024 * 1024 ||
      snapshot.length >= limits.filesPerSession ||
      (file.kind === 'source' && file.size! > limits.textFileBytes)
    )
      throw new SessionError(422, 'PREVIEW_INPUT_LIMIT', '会话预览文件超出限额');
    snapshot.push({
      path: file.path!,
      kind: file.kind as PreviewSnapshotFile['kind'],
      ...storage,
      objectLocator: file.kind === 'source' ? null : structuredClone(file.objectLocator),
      size: file.size!,
      sha256: file.sha256!,
    });
  }
  snapshot.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = snapshot
    .filter((file) => file.kind === 'source' && /\.(?:tsx|jsx)$/i.test(file.path))
    .map((file) => file.path);
  const preferred = entries.filter((entry) =>
    /^(?:src\/)?pages\/[^/]+\/index\.(?:tsx|jsx)$/i.test(entry),
  );
  const conventional = [
    'src/App.tsx',
    'src/App.jsx',
    'App.tsx',
    'App.jsx',
    'src/index.tsx',
    'index.tsx',
  ].filter((entry) => entries.includes(entry));
  const selected =
    entryPath ??
    (preferred.length === 1
      ? preferred[0]
      : preferred.length === 0 && conventional.length === 1
        ? conventional[0]
        : entries.length === 1
          ? entries[0]
          : undefined);
  let config;
  try {
    config = createConfigSnapshot(
      parseWorkspaceConfigs(workspace.configJson),
      session.target,
      workspace.configRevision,
      workspace.activeResourceRevisionId,
    );
  } catch {
    throw new SessionError(503, 'RESOURCE_UNAVAILABLE', '会话预览配置尚未就绪');
  }
  return {
    session,
    entries,
    entryPath: selected && entries.includes(selected) ? selected : null,
    snapshot,
    configSnapshot: config as unknown as Record<string, unknown>,
    resourceRevisionId: workspace.activeResourceRevisionId,
    fingerprint: sha(
      JSON.stringify([
        session.target,
        config.hash,
        workspace.activeResourceRevisionId,
        snapshot.map((file) => [file.path, file.kind, file.size, file.sha256]),
      ]),
    ),
  };
}

/** 仅识别固定快照内导入者缺少的本地文件；包依赖和无法定位的诊断保持失败。 */
export function missingPreviewFile(diagnostic: PreviewDiagnostic, snapshot: PreviewSnapshotFile[]) {
  const { file, module } = diagnostic;
  if (diagnostic.code !== 'MODULE_NOT_FOUND' || !file || !module) return;
  if (!snapshot.some((item) => item.path === file && item.kind === 'source')) return;
  const relative = module.startsWith('./');
  /** 构建器将工作区绝对路径投影为 src/...；只接受导入者同目录下的明确文件路径。 */
  const normalized =
    module.startsWith(path.posix.dirname(file) + '/') &&
    /\.(?:[jt]sx?|s?css|sass|json)$/i.test(module);
  if (!relative && !normalized) return;
  const candidate = path.posix.normalize(
    relative ? path.posix.join(path.posix.dirname(file), module) : module,
  );
  try {
    if (assertArtifactPath(candidate) !== candidate) return;
  } catch {
    return;
  }
  const candidates = dependencyCandidates(candidate);
  if (path.posix.extname(candidate) && !participates({ path: candidate, kind: 'source' })) return;
  if (!candidates.some((path) => participates({ path, kind: 'source' }))) return;
  if (snapshot.some((item) => candidates.includes(item.path))) return;
  return candidate;
}

/** 同时排除 Vite 的 JS→TS 替代、目录入口及 RN web 入口；多候选时不猜解析优先级。 */
function dependencyCandidates(candidate: string) {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json'];
  const scripts = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', ...extensions];
  return [
    candidate,
    ...scripts.flatMap((extension) => [candidate + extension, candidate + '/index' + extension]),
    ...(/\.[jt]sx?$/.test(candidate)
      ? scripts.map((extension) => candidate.replace(/\.[jt]sx?$/, extension))
      : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

/** 仅接受可静态判定的脚本依赖；语法恢复、动态加载及 import.meta 都交给真实编译器。 */
function scriptDependencies(file: PreviewSnapshotFile) {
  if (!/\.[jt]sx?$/i.test(file.path) || typeof file.content !== 'string') return;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
      .length
  )
    return;
  const modules: string[] = [];
  const declarations: string[] = [];
  let uncertain = false;
  function add(value: ts.Expression | undefined, node: ts.Node) {
    if (!value || !ts.isStringLiteral(value)) uncertain = true;
    else {
      modules.push(value.text);
      declarations.push(node.getText(source));
    }
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, node);
      else if (ts.isExportDeclaration(node)) declarations.push(node.getText(source));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference))
        add(node.moduleReference.expression, node);
      else uncertain = true;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      if (node.arguments.length !== 1) uncertain = true;
      else add(node.arguments[0], node);
    } else if (ts.isMetaProperty(node)) uncertain = true;
    else if (
      ts.isIdentifier(node) &&
      node.text === 'require' &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      uncertain = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return uncertain ? undefined : { modules, signature: JSON.stringify(declarations) };
}

/** 只比较样式依赖声明，不验收正文；缺口补齐后仍须真实编译。
 * 不完整/动态声明交给编译器，注释或字符串中的疑似声明也保守比较。
 */
function changeDependencies(file: PreviewSnapshotFile) {
  if (/\.[jt]sx?$/i.test(file.path)) return scriptDependencies(file);
  if (!/\.(?:css|scss|sass)$/i.test(file.path) || typeof file.content !== 'string') return;
  const declarations: string[] = [];
  const marker = /@(?:use|import|forward)\b|url\s*\(/gi;
  for (let match; (match = marker.exec(file.content)); ) {
    const end = file.content.indexOf(/^url/i.test(match[0]) ? ')' : ';', marker.lastIndex);
    if (end < 0) return;
    const declaration = file.content.slice(match.index, end + 1);
    if (/[${}\\]/.test(declaration)) return;
    declarations.push(declaration);
    marker.lastIndex = end + 1;
  }
  return { signature: JSON.stringify(declarations) };
}

/** 从真实入口建立脚本静态依赖边；样式作为叶子，其变更另按依赖声明比较。 */
function dependencyGraph(snapshot: PreviewSnapshotFile[], entryPath: string) {
  const files = new Map(snapshot.map((file) => [file.path, file]));
  const graph = new Map<string, Array<{ module: string; candidate?: string; resolved?: string }>>();
  const pending = [entryPath];
  while (pending.length) {
    const name = pending.pop()!;
    if (graph.has(name)) continue;
    const file = files.get(name);
    if (!file) return;
    const edges: Array<{ module: string; candidate?: string; resolved?: string }> = [];
    graph.set(name, edges);
    if (!/\.[jt]sx?$/i.test(name)) continue;
    const dependencies = scriptDependencies(file);
    if (!dependencies) return;
    for (const module of dependencies.modules) {
      let candidate: string;
      if (module.startsWith('./') || module.startsWith('../'))
        candidate = path.posix.normalize(path.posix.join(path.posix.dirname(name), module));
      else if (module.startsWith('@/'))
        candidate =
          (snapshot.some((file) => file.path.startsWith('src/')) ? 'src/' : '') + module.slice(2);
      else {
        if (!/^(?:@[\w-]+\/)?[\w-]+(?:\/[\w./-]+)*$/.test(module)) return;
        edges.push({ module });
        continue;
      }
      try {
        if (assertArtifactPath(candidate) !== candidate) return;
      } catch {
        return;
      }
      const matches = dependencyCandidates(candidate).filter((name) => files.has(name));
      if (matches.length > 1) return;
      const resolved = matches[0];
      edges.push({ module, candidate, resolved });
      if (resolved) pending.push(resolved);
    }
  }
  return graph;
}

/** 依赖图及缺失路径必须不变；通向缺失导入者的源码保持原样。
 * 无关脚本/样式可继续写正文；等待只说明已知缺口未齐，不声称其他文件已通过编译。
 * 依赖声明变化、未知解析、二进制与删除仍触发编译。
 */
export function unchangedMissingPreviewFile(
  diagnostic: PreviewDiagnostic,
  previous: PreviewSnapshotFile[],
  snapshot: PreviewSnapshotFile[],
  entryPath = diagnostic.file,
) {
  if (!missingPreviewFile(diagnostic, previous)) return;
  const waitingForFile = missingPreviewFile(diagnostic, snapshot);
  if (!waitingForFile) return;
  if (!entryPath) return;
  const before = dependencyGraph(previous, entryPath);
  const after = dependencyGraph(snapshot, entryPath);
  if (!before || !after || JSON.stringify([...before]) !== JSON.stringify([...after])) return;
  const missing = before.get(diagnostic.file!);
  if (!missing?.some((edge) => edge.candidate === waitingForFile && !edge.resolved)) return;
  const protectedFiles = new Set([diagnostic.file!]);
  // Reverse reachability handles barrels and cycles as well as direct page imports.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, edges] of before) {
      if (
        !protectedFiles.has(name) &&
        edges.some((edge) => edge.resolved && protectedFiles.has(edge.resolved))
      ) {
        protectedFiles.add(name);
        changed = true;
      }
    }
  }
  const current = new Map(snapshot.map((file) => [file.path, file]));
  for (const file of previous) {
    const next = current.get(file.path);
    if (!next || next.kind !== file.kind) return;
    if (next.size === file.size && next.sha256 === file.sha256) continue;
    if (file.kind !== 'source' || protectedFiles.has(file.path)) return;
    const priorDependencies = changeDependencies(file);
    const nextDependencies = changeDependencies(next);
    if (
      !priorDependencies ||
      !nextDependencies ||
      priorDependencies.signature !== nextDependencies.signature
    )
      return;
  }
  const prior = new Set(previous.map((file) => file.path));
  const names = new Set<string>();
  for (const file of snapshot) {
    const name = file.path.toLowerCase();
    if (
      names.has(name) ||
      (!prior.has(file.path) && (file.kind !== 'source' || !changeDependencies(file)))
    )
      return;
    names.add(name);
  }
  return waitingForFile;
}
