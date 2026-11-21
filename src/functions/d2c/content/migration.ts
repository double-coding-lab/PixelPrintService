import { createHash } from 'node:crypto';
import { Op, type Model, type ModelStatic, type Sequelize } from 'sequelize';
import {
  contentModel,
  prepareTextContent,
  resolveTextContent,
  textContentPolicy,
  type PreparedText,
} from './runtime';
import { TextContentError } from './store';

export type ContentMigrationTable = 'files' | 'versions' | 'works' | 'previews';
const tables = {
  files: 'D2cFile',
  versions: 'D2cVersionFile',
  works: 'D2cSavedWorkFile',
  previews: 'D2cPreview',
} as const;
export type ContentMigrationOptions = {
  table: ContentMigrationTable;
  afterId?: string;
  untilId?: string;
  batchSize?: number;
  dryRun?: boolean;
  action?: 'externalize' | 'restore';
  signal?: AbortSignal;
};
export type ContentMigrationResult = {
  table: ContentMigrationTable;
  action: 'externalize' | 'restore';
  dryRun: boolean;
  nextAfterId: string;
  untilId: string;
  scanned: number;
  eligible: number;
  written: number;
  skipped: number;
  conflicts: number;
  hasMore: boolean;
  error?: { id: string; code: string };
};
type Row = Record<string, unknown> & {
  content?: string | null;
  contentRef?: unknown;
  size?: number | null;
  sha256?: string | null;
  objectLocator?: unknown;
};

/** BIGINT游标保持字符串，拒绝浮点、负数和任意SQL标识。 */
function cursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new TextContentError('INVALID_REFERENCE');
  return value;
}
function plain(row: Model): Row {
  return typeof row.get === 'function'
    ? (row.get({ plain: true }) as Row)
    : (row as unknown as Row);
}
function verifyText(row: Row, text: string): void {
  if (
    Buffer.from(text).toString('utf8') !== text ||
    row.size !== Buffer.byteLength(text) ||
    row.sha256 !== createHash('sha256').update(text).digest('hex')
  )
    throw new TextContentError('INTEGRITY_FAILED');
}
function same(old: Row, current: Row): boolean {
  return (
    old.content === current.content &&
    old.size === current.size &&
    old.sha256 === current.sha256 &&
    old.kind === current.kind &&
    old.revision === current.revision &&
    JSON.stringify(old.contentRef ?? null) === JSON.stringify(current.contentRef ?? null) &&
    JSON.stringify(old.objectLocator ?? null) === JSON.stringify(current.objectLocator ?? null)
  );
}
function scope(table: ContentMigrationTable, row: Row): string {
  const id =
    table === 'files' || table === 'previews'
      ? row.sessionId
      : table === 'versions'
        ? row.versionId
        : row.workId;
  if (typeof id !== 'string' || !id || id.length > 160)
    throw new TextContentError('INVALID_REFERENCE');
  return (table === 'versions' ? 'version:' : table === 'works' ? 'work:' : 'session:') + id;
}

/**
 * 一次有界迁移批次。先只分页ID，再逐行加载正文；上传/回读位于事务外。
 * 锁内重验原值后只改变存储描述，不改变内容摘要、业务修订或事件；不清理对象。
 */
export async function migrateContentBatch(
  mysql: Sequelize,
  options: ContentMigrationOptions,
): Promise<ContentMigrationResult> {
  if (!Object.hasOwn(tables, options.table)) throw new TextContentError('INVALID_REFERENCE');
  const after = cursor(options.afterId ?? '0');
  const batch = options.batchSize ?? 25;
  const dryRun = options.dryRun !== false;
  const action = options.action ?? 'externalize';
  if (
    !Number.isSafeInteger(batch) ||
    batch < 1 ||
    batch > 100 ||
    !['externalize', 'restore'].includes(action)
  )
    throw new TextContentError('INVALID_REFERENCE');
  const policy = textContentPolicy(mysql);
  if (!dryRun && (!policy.schemaReady || (action === 'externalize' && policy.mode === 'inline')))
    throw new TextContentError('INVALID_CONFIG');
  const original = mysql.models[tables[options.table]] as ModelStatic<Model>;
  if (!original) throw new TextContentError('INVALID_CONFIG');
  const model = options.table === 'previews' ? original : contentModel(mysql, original);
  const last =
    options.untilId === undefined
      ? await model.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
      : null;
  const upper = options.untilId ?? String(last ? plain(last).id : '0');
  cursor(upper);
  const result: ContentMigrationResult = {
    table: options.table,
    action,
    dryRun,
    nextAfterId: after,
    untilId: upper,
    scanned: 0,
    eligible: 0,
    written: 0,
    skipped: 0,
    conflicts: 0,
    hasMore: false,
  };
  if (BigInt(after) >= BigInt(upper)) return result;
  const heads = await model.findAll({
    attributes: ['id'],
    where: { id: { [Op.gt]: after, [Op.lte]: upper } },
    order: [['id', 'ASC']],
    limit: batch + 1,
  });
  result.hasMore = heads.length > batch;
  for (const head of heads.slice(0, batch)) {
    if (options.signal?.aborted) throw new DOMException('正文迁移已取消', 'AbortError');
    const id = cursor(String(plain(head).id));
    try {
      const loaded = await model.findOne({ where: { id } });
      if (!loaded) {
        result.skipped++;
        result.nextAfterId = id;
        continue;
      }
      const old = plain(loaded);
      result.scanned++;
      let patch: Record<string, unknown> | null = null;
      if (options.table === 'previews') {
        // 版本预览从版本文件构建，没有会话snapshot；正在构建的行留给后续补扫。
        if (['queued', 'building'].includes(String(old.status))) {
          if (!dryRun) {
            result.error = { id, code: 'PREVIEW_ACTIVE' };
            result.hasMore = true;
            break; // 等构建结束后从同一行继续，不能把待回填输入宣称已恢复完成。
          }
          result.skipped++;
          result.nextAfterId = id;
          continue;
        }
        const manifest = old.buildManifest;
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
          result.skipped++;
          result.nextAfterId = id;
          continue;
        }
        const snapshot = (manifest as Record<string, unknown>).snapshot;
        if (!Array.isArray(snapshot)) {
          result.skipped++;
          result.nextAfterId = id;
          continue;
        }
        const next: unknown[] = [];
        let changed = false;
        for (const entry of snapshot) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new TextContentError('INVALID_REFERENCE');
          const file = entry as Row;
          const prepared =
            file.kind === 'source' ? await prepare(file, scope('previews', old)) : null;
          if (prepared) {
            changed = true;
            next.push({ ...file, ...prepared });
          } else next.push(file);
        }
        if (changed) patch = { buildManifest: { ...manifest, snapshot: next } };
      } else if (['source', 'internal'].includes(String(old.kind)) && old.objectLocator == null) {
        const prepared = await prepare(old, scope(options.table, old));
        if (prepared) patch = prepared;
      }
      if (!patch) result.skipped++;
      else {
        result.eligible++;
        if (!dryRun) {
          let conflict = false;
          const written = await mysql.transaction(async (transaction) => {
            const current = await model.findOne({
              where: { id },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            if (!current) {
              result.conflicts++;
              conflict = true;
              return false;
            }
            if (options.signal?.aborted) throw new DOMException('正文迁移已取消', 'AbortError');
            const value = plain(current);
            const unchanged =
              options.table === 'previews'
                ? JSON.stringify(value.buildManifest) === JSON.stringify(old.buildManifest) &&
                  value.status === old.status
                : same(old, value);
            if (!unchanged) {
              result.conflicts++;
              conflict = true;
              return false;
            }
            if (options.signal?.aborted) throw new DOMException('正文迁移已取消', 'AbortError');
            await current.update(patch!, { transaction });
            if (options.signal?.aborted) throw new DOMException('正文迁移已取消', 'AbortError');
            return true;
          });
          if (written) result.written++;
          if (conflict) {
            result.error = { id, code: 'REVISION_CONFLICT' };
            result.hasMore = true;
            break;
          }
        }
      }
      result.nextAfterId = id;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('正文迁移已取消', 'AbortError');
      result.error = {
        id,
        code: error instanceof TextContentError ? error.code : 'MIGRATION_FAILED',
      };
      result.hasMore = true;
      break; // 失败行不推进游标，下一次可在同一点恢复。
    }
  }
  return result;

  /** dry-run不下载/上传。apply可复用已核验引用，切换仅外置前仍验证对象。 */
  async function prepare(row: Row, binding: string): Promise<PreparedText | null> {
    if (action === 'restore') {
      if (typeof row.content === 'string' || row.contentRef == null) return null;
      if (dryRun) return { content: null };
      const text = await resolveTextContent(mysql, row, undefined, options.signal);
      if (typeof text !== 'string') throw new TextContentError('INVALID_REFERENCE');
      verifyText(row, text);
      return { content: text }; // 保留引用，回滚旧程序前库内正文已可读。
    }
    if (typeof row.content !== 'string') {
      if (row.contentRef == null) throw new TextContentError('INVALID_REFERENCE');
      return null;
    }
    verifyText(row, row.content);
    if (row.size! < policy.thresholdBytes || row.size! > policy.maxBytes) return null;
    if (row.contentRef && typeof row.contentRef === 'object') {
      const ref = row.contentRef as Record<string, unknown>;
      if (ref.sha256 === row.sha256 && ref.size === row.size) {
        if (policy.mode !== 'external') return null;
        if (dryRun) return { content: null };
        const verified = await resolveTextContent(
          mysql,
          { ...row, content: null },
          undefined,
          options.signal,
        );
        if (verified !== row.content) throw new TextContentError('INTEGRITY_FAILED');
        return { content: null, contentRef: row.contentRef as PreparedText['contentRef'] };
      }
    }
    if (dryRun) return { content: null };
    return prepareTextContent(mysql, binding, row.content, options.signal);
  }
}
