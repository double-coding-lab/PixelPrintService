import { createHash, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import { Op, type Sequelize } from 'sequelize';
import ts from 'typescript';
import type { D2cFile } from '@/models/D2cFile';
import type { D2cRun } from '@/models/D2cRun';
import { ownedSession, requireRevision, SessionError } from '../session/access';
import { appendFileEvent } from '../session/service';
import { assertArtifactPath, isExecutionDocument, normalizeRelativePath } from '../utils/paths';

export type BlockDirectoryRename = { from: string; to: string; nodeId?: string };
export type RenameBlockDirectoriesInput = {
  baseFileRevision: number;
  renames: BlockDirectoryRename[];
  limits: { textFileBytes: number; filesPerSession: number };
};
type MappingEntry = BlockDirectoryRename & { originalName: string };
type Mapping = {
  version: 1;
  baseFileRevision: number;
  fileRevision: number;
  renames: MappingEntry[];
};
const mappingPath = '.d2c-cache/block-paths.json';

/** 使用实际 UTF-8 字节计算路径或文本摘要。 */
function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 所有路径比较均使用目录边界，避免把相似目录前缀当成子目录。 */
function within(value: string, directory: string) {
  return value === directory || value.startsWith(directory + '/');
}

/** 校验平行、互不重叠的 blocks 直接子目录映射；禁止链式迁移及互换。 */
function validateRenames(renames: BlockDirectoryRename[]) {
  if (!Array.isArray(renames) || !renames.length)
    throw new SessionError(422, 'INVALID_RENAMES', '区块映射不能为空');
  const endpoints: string[] = [];
  for (const rename of renames) {
    try {
      if (!rename || typeof rename.from !== 'string' || typeof rename.to !== 'string')
        throw new Error();
      for (const value of [rename.from, rename.to]) {
        if (
          assertArtifactPath(value) !== value ||
          Buffer.byteLength(value) > 1024 ||
          !/^(?:[^/]+\/)*blocks\/[^/]+$/.test(value)
        )
          throw new Error();
      }
      if (
        path.dirname(rename.from) !== path.dirname(rename.to) ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path.basename(rename.to)) ||
        path.basename(rename.to).startsWith('sub-') ||
        (rename.nodeId !== undefined &&
          (typeof rename.nodeId !== 'string' ||
            !/^[^\u0000-\u001f\u007f]{1,200}$/.test(rename.nodeId)))
      )
        throw new Error();
    } catch {
      throw new SessionError(422, 'INVALID_RENAMES', '仅允许同父目录的区块迁移到 ASCII kebab-case');
    }
    for (const value of [rename.from, rename.to]) {
      if (endpoints.some((other) => within(value, other) || within(other, value)))
        throw new SessionError(422, 'OVERLAPPING_RENAMES', '区块目录不能重叠、重复或链式互换');
      endpoints.push(value);
    }
  }
}

/** 单次映射而非串行替换；输入已经禁止映射链和重叠。 */
function mappedPath(value: string, renames: BlockDirectoryRename[]) {
  const rename = renames.find((item) => within(value, item.from));
  return rename ? rename.to + value.slice(rename.from.length) : value;
}

/** 只解析明确的本地路径；相对导入同时基于旧、新引用文件位置重算。 */
function reference(value: string, before: string, after: string, renames: BlockDirectoryRename[]) {
  const match = /^([^?#]+)([?#].*)?$/.exec(value);
  if (!match || value.includes('\\') || /^(?:[a-z]+:|\/\/)/i.test(value)) return value;
  const [, body, suffix = ''] = match;
  const relative = body.startsWith('./') || body.startsWith('../');
  const alias = body.startsWith('@/') ? '@/' : '';
  const root = relative
    ? path.normalize(path.join(path.dirname(before), body))
    : body.slice(alias.length);
  if (root.startsWith('../') || root.startsWith('/')) return value;
  const next = mappedPath(root, renames);
  if (next === root && (!relative || before === after)) return value;
  if (!relative) return alias + next + suffix;
  const result = path.relative(path.dirname(after), next);
  return (result.startsWith('.') ? result : './' + result) + suffix;
}

/** 从后向前拼接文本编辑，保留未修改区间的换行、缩进、注释及引号。 */
function applyEdits(content: string, edits: Array<{ start: number; end: number; text: string }>) {
  for (const edit of edits.sort((a, b) => b.start - a.start))
    content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
  return content;
}

/** 只改模块说明符，不触碰任意字符串、JSX 标签、className 或注释。 */
function sourceReferences(
  content: string,
  before: string,
  after: string,
  renames: BlockDirectoryRename[],
) {
  const source = ts.createSourceFile(before, content, ts.ScriptTarget.Latest, true);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ((ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) ||
        (ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'URL' &&
          node.arguments?.[1]?.getText(source) === 'import.meta.url')) &&
      node.arguments?.[0] &&
      !ts.isStringLiteralLike(node.arguments[0])
    )
      throw new SessionError(409, 'UNSUPPORTED_REFERENCE', '动态模块或 URL 路径无法安全迁移');
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const module =
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
        (ts.isExternalModuleReference(parent) && parent.expression === node) ||
        (ts.isLiteralTypeNode(parent) &&
          ts.isImportTypeNode(parent.parent) &&
          parent.parent.argument === parent) ||
        (ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.arguments.length === 1 ||
            parent.expression.kind === ts.SyntaxKind.ImportKeyword) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')));
      const url =
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'URL' &&
        parent.arguments?.[0] === node;
      if (
        url &&
        reference(node.text, before, after, renames) !== node.text &&
        parent.arguments?.[1]?.getText(source) !== 'import.meta.url'
      )
        throw new SessionError(
          409,
          'UNSUPPORTED_REFERENCE',
          '本地 new URL 引用必须以 import.meta.url 为基准',
        );
      if (module || (url && parent.arguments?.[1]?.getText(source) === 'import.meta.url')) {
        const next = reference(node.text, before, after, renames);
        if (next !== node.text) {
          const quote = content[node.getStart(source)];
          const escaped = next
            .replace(/\\/g, '\\\\')
            .replaceAll(quote, '\\' + quote)
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n')
            .replace(/\$\{/g, '\\${');
          edits.push({ start: node.getStart(source) + 1, end: node.end - 1, text: escaped });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return applyEdits(content, edits);
}

/** 定点改写 CSS/Sass 静态模块与 url()，动态模块路径明确拒绝，注释原样保留。 */
function styleReferences(
  content: string,
  before: string,
  after: string,
  renames: BlockDirectoryRename[],
) {
  const masked = content.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (token) =>
      token.startsWith('/*') || token.startsWith('//') ? token.replace(/[^\r\n]/g, ' ') : token,
  );
  const edits = new Map<number, { start: number; end: number; text: string }>();
  const handled = new Set<number>();
  const moduleUrls = new Set<number>();
  /** 跳过普通字符串中的示例文字，只有样式语法位置才可出现模块/url 引用。 */
  const starts = new Set<number>();
  for (const token of masked.matchAll(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@(?:import|use|forward)\b|url\(|(?:\$[\w-]+|--[\w-]+)\s*:/gi,
  ))
    if (token[0][0] !== '"' && token[0][0] !== "'") starts.add(token.index);
  const containsOldDirectory = (value: string) =>
    renames.some((rename) => value.includes(path.basename(rename.from)));
  const add = (value: string, start: number, module = true) => {
    if (/[\\$]|#\{/.test(value)) {
      if (module || containsOldDirectory(value))
        throw new SessionError(409, 'UNSUPPORTED_REFERENCE', '样式引用必须是静态路径');
      return;
    }
    const next = reference(value, before, after, renames);
    if (next !== value) edits.set(start, { start, end: start + value.length, text: next });
  };
  for (const directive of masked.matchAll(/@(?:import|use|forward)\b([^;\r\n]*)(?:;|$)/g)) {
    if (!starts.has(directive.index)) continue;
    handled.add(directive.index);
    for (const offset of starts)
      if (
        masked.slice(offset, offset + 4).toLowerCase() === 'url(' &&
        offset >= directive.index &&
        offset < directive.index + directive[0].length
      )
        moduleUrls.add(offset);
    const body = directive[1].trimStart();
    if (!/^(?:["']|url\()/i.test(body))
      throw new SessionError(409, 'UNSUPPORTED_REFERENCE', '样式模块路径无法静态解析');
    if (/^url\(/i.test(body) && !/^url\(\s*(?:(["'])[^"']*\1|[^\s()'";]+)\s*\)/i.test(body))
      throw new SessionError(409, 'UNSUPPORTED_REFERENCE', '样式模块 url 无法静态解析');
    const quoted = /(["'])([^"']*)\1/g;
    for (const literal of directive[0].matchAll(quoted)) {
      /** @use ... with (...) 的配置字符串不属于模块说明符。 */
      if (/\bwith\s*\(/i.test(directive[0].slice(0, literal.index))) break;
      add(literal[2], directive.index + literal.index + 1);
    }
  }
  for (const offset of starts)
    if (masked[offset] === '@' && !handled.has(offset))
      throw new SessionError(
        409,
        'UNSUPPORTED_REFERENCE',
        '多行样式模块声明需先规范为静态单行路径',
      );
  const handledUrls = new Set<number>();
  for (const url of masked.matchAll(/url\(\s*(?:(["'])([^"']*)\1|([^\s()'";]*))\s*\)/gi)) {
    if (!starts.has(url.index)) continue;
    handledUrls.add(url.index);
    const value = url[2] ?? url[3];
    add(
      value,
      url.index + url[0].indexOf(value, url[0].indexOf('(') + 1),
      moduleUrls.has(url.index),
    );
  }
  for (const offset of starts)
    if (
      masked.slice(offset, offset + 4).toLowerCase() === 'url(' &&
      !handledUrls.has(offset) &&
      containsOldDirectory(masked.slice(offset).split(/[;\r\n]/, 1)[0])
    )
      throw new SessionError(
        409,
        'UNSUPPORTED_REFERENCE',
        '动态图片 URL 包含待迁移目录，无法安全解析',
      );
  /** 变量声明中的完整静态路径也可被 url($variable) 间接引用，按原始区间修正。 */
  for (const variable of masked.matchAll(
    /(?:\$[\w-]+|--[\w-]+)\s*:\s*(?:(["'])([^"'\r\n]*)\1|([^;\s{}]+))/g,
  )) {
    if (!starts.has(variable.index)) continue;
    const value = variable[2] ?? variable[3];
    if (/^url\(/i.test(value)) continue;
    const offset = variable[0].indexOf(':') + 1;
    add(value, variable.index + variable[0].indexOf(value, offset), false);
  }
  return applyEdits(content, [...edits.values()]);
}

/** 报告正文只处理完整路径 token，不匹配中文标签或嵌在 URL 内的目录名称。 */
function reportReferences(
  content: string,
  before: string,
  after: string,
  renames: BlockDirectoryRename[],
) {
  return content.replace(/[^\s"'`<>(){}\[\],;:=|\\]+/gu, (token) => {
    if (!token.includes('/') || token.startsWith('//')) return token;
    return reference(token, before, after, renames);
  });
}

/** JSON 只编辑字符串值的原始区间；name/label 等展示字段及 Figma 子树保持原样。 */
function jsonReferences(
  content: string,
  before: string,
  after: string,
  renames: BlockDirectoryRename[],
) {
  try {
    JSON.parse(content);
  } catch {
    throw new SessionError(409, 'INVALID_REPORT', 'JSON 报告内容无效');
  }
  const source = ts.parseJsonText(before, content);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const protectedKeys = /^(?:name|originalName|label|title|text|className|figma|layers?)$/i;
  const visit = (node: ts.Node, parent?: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      protectedKeys.test(ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(source))
    )
      return;
    if (
      ts.isStringLiteral(node) &&
      !(parent && ts.isPropertyAssignment(parent) && parent.name === node)
    ) {
      /**
       * JSON AST 默认没有 parent；显式传父节点，避免把属性名当成路径值改写。
       * 原始转义按 UTF-16 位置映射，只重写实际变化的路径 token。
       */
      const start = node.getStart(source);
      const raw = content.slice(start, node.end);
      const offsets: number[] = [];
      for (let i = 1; i < raw.length - 1; i++) {
        offsets.push(i);
        if (raw[i] === '\\') i += raw[i + 1] === 'u' ? 5 : 1;
      }
      offsets.push(raw.length - 1);
      for (const token of node.text.matchAll(/[^\s"'`<>(){}\[\],;:=|\\]+/gu)) {
        const next = reportReferences(token[0], before, after, renames);
        if (next !== token[0])
          edits.push({
            start: start + offsets[token.index],
            end: start + offsets[token.index + token[0].length],
            text: JSON.stringify(next).slice(1, -1),
          });
      }
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(source);
  return applyEdits(content, edits);
}

/** 仅开放产物源码、Markdown/JSON 报告与规则缓存；设计缓存和配置不参与替换。 */
function textKind(file: D2cFile): 'source' | 'json' | 'markdown' | 'style' | undefined {
  const value = file.path!;
  if (value === mappingPath || file.content === null || file.objectLocator !== null) return;
  if (/^(?:.*\/)?(?:pp-d2c(?:\.rn)?\.config\.json|[^/]*config\.[^/]+)$/i.test(value)) return;
  let artifact = false;
  try {
    artifact = assertArtifactPath(value) === value;
  } catch {
    /* 内部文档单独白名单。 */
  }
  const report =
    isExecutionDocument(value) ||
    /(?:^|\/)(?:COMPLETION\.md|rule-hits\.json|check-report\.json)$/.test(value);
  if (!artifact && !report) return;
  if (artifact && file.kind === 'source' && /\.[cm]?[jt]sx?$/.test(value)) return 'source';
  if (artifact && file.kind === 'source' && /\.(?:css|scss|sass|less)$/.test(value)) return 'style';
  if (/\.json$/.test(value)) return 'json';
  if (/\.md$/.test(value)) return 'markdown';
}

/** 核对正文元数据及限额，拒绝在损坏文本上推导迁移结果。 */
function textData(content: string, maximum: number) {
  if (
    content.includes('\0') ||
    Buffer.from(content).toString('utf8') !== content ||
    Buffer.byteLength(content) > maximum
  )
    throw new SessionError(422, 'INVALID_CONTENT', '文本格式无效或超过字节限额');
  return { content, size: Buffer.byteLength(content), sha256: hash(content) };
}

/**
 * 原子迁移本人空闲会话的 blocks 直接子目录，并定点修复当前文件引用。
 * 按工作区→会话→当前文件写锁，baseFileRevision 冲突或未结束 Run 拒绝写入；
 * 唯一例外是 mapping 证明刚提交成功的同一请求重试，此时不增加任何修订或事件。
 * 只更新 D2cFile 当前态与平台 mapping，不访问图片对象、冻结版本、聊天或会话配置。
 * @param mysql 已注册 D2C 模型的 Sequelize；userId 必须来自可信身份上下文。
 * @param input 同父目录映射、基础文件修订及显式文本/文件数量限额。
 * @param notify 整个事务提交后发布最终 seq，通知失败不改变已提交结果。
 * @returns 提交后的 fileRevision、路径/正文变更数量及是否为幂等重试。
 */
export async function renameBlockDirectories(
  mysql: Sequelize,
  userId: string,
  sessionId: string,
  input: RenameBlockDirectoriesInput,
  notify?: (sessionId: string, seq: number) => void | Promise<void>,
) {
  requireRevision(input.baseFileRevision);
  validateRenames(input.renames);
  const { limits, renames } = input;
  if (
    !limits ||
    ![limits.textFileBytes, limits.filesPerSession].every((v) => Number.isSafeInteger(v) && v > 0)
  )
    throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额尚未配置');
  for (const name of ['D2cFile', 'D2cRun', 'D2cSession', 'D2cWorkspace', 'D2cTimeline'])
    if (!mysql.models[name]) throw new SessionError(503, 'MODELS_UNAVAILABLE', '迁移模型尚未注册');
  const files = mysql.models.D2cFile as typeof D2cFile;
  const runs = mysql.models.D2cRun as typeof D2cRun;
  return mysql.transaction(async (transaction) => {
    const { session } = await ownedSession(mysql, userId, sessionId, transaction);
    if (
      (session.activeRunId != null && session.activeRunId !== '') ||
      (await runs.findOne({
        where: { sessionId, status: { [Op.notIn]: ['succeeded', 'failed', 'cancelled'] } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      }))
    )
      throw new SessionError(409, 'SESSION_BUSY', '请先完成或明确结束当前轮次');
    requireRevision(session.fileRevision);
    const rows = await files.findAll({
      where: { sessionId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const file of rows) {
      try {
        if (
          !file.path ||
          normalizeRelativePath(file.path) !== file.path ||
          Buffer.byteLength(file.path) > 1024 ||
          file.pathHash !== hash(file.path)
        )
          throw new Error();
      } catch {
        throw new SessionError(503, 'FILE_CORRUPT', '文件路径元数据无效');
      }
    }
    const mappingFile = rows.find((file) => file.path === mappingPath);
    let prior: Mapping | undefined;
    if (mappingFile) {
      try {
        if (
          mappingFile.kind !== 'internal' ||
          typeof mappingFile.content !== 'string' ||
          mappingFile.objectLocator !== null ||
          mappingFile.sha256 !== hash(mappingFile.content) ||
          mappingFile.size !== Buffer.byteLength(mappingFile.content)
        )
          throw new Error();
        prior = JSON.parse(mappingFile.content) as Mapping;
        if (prior?.version !== 1 || !Array.isArray(prior.renames)) throw new Error();
        requireRevision(prior.baseFileRevision);
        requireRevision(prior.fileRevision);
        validateRenames(prior.renames);
        if (!prior.renames.every((entry) => typeof entry.originalName === 'string'))
          throw new Error();
      } catch {
        throw new SessionError(409, 'INVALID_MAPPING', '已有区块映射无效，不能覆盖');
      }
    }
    const sourceExists = (rename: BlockDirectoryRename) =>
      rows.some((file) => within(file.path!, rename.from));
    const recorded = (rename: BlockDirectoryRename) =>
      prior?.renames.some(
        (entry) =>
          entry.from === rename.from && entry.to === rename.to && entry.nodeId === rename.nodeId,
      );
    const complete = renames.every(
      (rename) =>
        recorded(rename) &&
        !sourceExists(rename) &&
        rows.some((file) => file.path!.startsWith(rename.to + '/')),
    );
    const sameRevision = session.fileRevision === input.baseFileRevision;
    if (
      !sameRevision &&
      !(
        complete &&
        prior?.baseFileRevision === input.baseFileRevision &&
        prior.fileRevision === session.fileRevision
      )
    )
      throw new SessionError(409, 'FILES_CONFLICT', '会话文件已更新，请重新读取');
    if (complete)
      return {
        sessionId,
        fileRevision: session.fileRevision,
        renamedFiles: 0,
        updatedFiles: 0,
        unchanged: true,
      };
    const merged = [...(prior?.renames ?? [])];
    for (const rename of renames) {
      if (!sourceExists(rename))
        throw new SessionError(409, 'SOURCE_NOT_FOUND', '原区块目录不存在');
      if (
        rows.some(
          (file) =>
            within(file.path!, rename.to) ||
            within(rename.to, file.path!) ||
            file.path === rename.from,
        )
      )
        throw new SessionError(409, 'PATH_EXISTS', '目标目录已存在或被文件占用');
      merged.push({ ...rename, originalName: path.basename(rename.from) });
    }
    validateRenames(merged);
    if (rows.length + (mappingFile ? 0 : 1) > limits.filesPerSession)
      throw new SessionError(422, 'FILE_LIMIT', '会话文件数量超过限额');
    if (session.fileRevision >= 4294967294)
      throw new SessionError(409, 'REVISION_EXHAUSTED', '文件修订已达到上限');
    const fileRevision = session.fileRevision + 1;
    const plans = rows
      .filter((file) => file !== mappingFile)
      .map((file) => {
        const before = file.path!,
          after = mappedPath(before, renames);
        if (Buffer.byteLength(after) > 1024)
          throw new SessionError(422, 'INVALID_PATH', '迁移路径过长');
        const kind = textKind(file);
        let content = file.content;
        if (kind) {
          if (
            typeof content !== 'string' ||
            file.size !== Buffer.byteLength(content) ||
            file.sha256 !== hash(content)
          )
            throw new SessionError(503, 'FILE_CORRUPT', '文件正文摘要不一致');
          content =
            kind === 'source'
              ? sourceReferences(content, before, after, renames)
              : kind === 'style'
                ? styleReferences(content, before, after, renames)
                : kind === 'json'
                  ? jsonReferences(content, before, after, renames)
                  : reportReferences(content, before, after, renames);
        }
        const changed = content !== file.content;
        return {
          file,
          before,
          after,
          changed,
          data: changed ? textData(content!, limits.textFileBytes) : {},
        };
      });
    const finalPaths = new Map<string, string>();
    for (const plan of plans) {
      const digest = hash(plan.after);
      if (finalPaths.has(digest)) throw new SessionError(409, 'PATH_HASH_CONFLICT', '迁移路径冲突');
      finalPaths.set(digest, plan.after);
    }
    const mapping = textData(
      JSON.stringify(
        {
          version: 1,
          baseFileRevision: input.baseFileRevision,
          fileRevision,
          renames: merged,
        } satisfies Mapping,
        null,
        2,
      ) + '\n',
      limits.textFileBytes,
    );
    let seq = session.timelineSeq,
      renamedFiles = 0,
      updatedFiles = 0;
    const event = async (
      file: D2cFile,
      action: 'created' | 'updated' | 'deleted',
      value: string,
      revision: number,
    ) => {
      seq = await appendFileEvent(mysql, session, transaction, {
        action,
        path: value,
        fileId: file.fileId!,
        revision,
        fileRevision,
      });
    };
    for (const plan of plans) {
      if (plan.before === plan.after && !plan.changed) continue;
      requireRevision(plan.file.revision, false);
      if (plan.file.revision >= 4294967294)
        throw new SessionError(409, 'REVISION_EXHAUSTED', '文件修订已达到上限');
      const revision = plan.file.revision + 1;
      if (plan.before !== plan.after)
        await event(plan.file, 'deleted', plan.before, plan.file.revision);
      await plan.file.update(
        { path: plan.after, pathHash: hash(plan.after), revision, ...plan.data },
        { transaction },
      );
      if (plan.before !== plan.after) {
        renamedFiles++;
        await event(plan.file, 'created', plan.after, revision);
      }
      if (plan.changed) {
        updatedFiles++;
        await event(plan.file, 'updated', plan.after, revision);
      }
    }
    if (mappingFile) {
      requireRevision(mappingFile.revision, false);
      if (mappingFile.revision >= 4294967294)
        throw new SessionError(409, 'REVISION_EXHAUSTED', '映射修订已达到上限');
      await mappingFile.update({ ...mapping, revision: mappingFile.revision + 1 }, { transaction });
      await event(mappingFile, 'updated', mappingPath, mappingFile.revision);
    } else {
      const created = await files.create(
        {
          fileId: randomUUID(),
          sessionId,
          path: mappingPath,
          pathHash: hash(mappingPath),
          kind: 'internal',
          ...mapping,
          objectLocator: null,
          mimeType: 'application/json',
          revision: 1,
        },
        { transaction },
      );
      await event(created, 'created', mappingPath, 1);
    }
    await session.update(
      { fileRevision, validationState: { status: 'stale', fileRevision } },
      { transaction },
    );
    if (notify)
      transaction.afterCommit(async () => {
        try {
          await notify(sessionId, seq);
        } catch {
          /* 已提交的数据库事件始终是事实源。 */
        }
      });
    return { sessionId, fileRevision, renamedFiles, updatedFiles, unchanged: false };
  });
}
