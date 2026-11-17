import path from 'node:path';
import type { PreviewDiagnostic } from './diagnostics';
import { createHash } from 'node:crypto';
import type { Sequelize, Transaction } from 'sequelize';
import type { D2cFile } from '../../../models/D2cFile';
import type { D2cWorkspace } from '../../../models/D2cWorkspace';
import { ownedSession, SessionError } from '../session/access';
import { createConfigSnapshot, parseWorkspaceConfigs } from '../utils/config';
import { assertArtifactPath } from '../utils/paths';

export type PreviewSnapshotFile = {
  path: string;
  kind: 'source' | 'asset' | 'attachment';
  content: string | null;
  objectLocator: Record<string, unknown> | null;
  size: number;
  sha256: string;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** 与隔离构建器保持相同模板边界，报告与内部配置不参与输入摘要。 */
function participates(file: D2cFile) {
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
) {
  validateSessionEntry(entryPath);
  const { workspace: owned, session } = await ownedSession(
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
  const rows = await (mysql.models.D2cFile as typeof D2cFile).findAll({
    where: { sessionId },
    transaction,
    order: [['pathHash', 'ASC']],
    ...(write ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const snapshot: PreviewSnapshotFile[] = [];
  let total = 0;
  for (const file of rows.filter(participates)) {
    try {
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
        (typeof file.content !== 'string' ||
          Buffer.byteLength(file.content) !== file.size ||
          sha(file.content) !== file.sha256)
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
      content: file.kind === 'source' ? file.content : null,
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
  const candidates = [
    candidate,
    ...[
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.json',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx',
    ].map((extension) => candidate + extension),
  ];
  if (snapshot.some((item) => candidates.includes(item.path))) return;
  return candidate;
}
