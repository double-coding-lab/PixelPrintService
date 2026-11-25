import { safeRuntimeCoverUrl } from '../utils/runtimeCover';
import { findOrderedRows } from '../utils/orderedRead';
import { createHash, randomUUID } from 'node:crypto';
import { UniqueConstraintError, type Sequelize, type Transaction } from 'sequelize';
import type { D2cSavedWork } from '../../../models/D2cSavedWork';
import type { D2cSavedWorkFile } from '../../../models/D2cSavedWorkFile';
import type { PreviewSnapshotFile } from '../preview/session';
import { validateSessionEntry } from '../preview/session';
import { requireIdentifier, requireRevision, SessionError } from '../session/access';
import { assertArtifactPath } from '../utils/paths';
import { buildVersionArchive } from '../version/archive';
import {
  contentModel,
  copyTextStorage,
  prepareTextContent,
  resolveTextContent,
} from '../content/runtime';
import type { TextContentReference } from '../content/store';

/** Private frozen input; only the editor's transaction-free hydration may expose its text. */
type FrozenSnapshotFile = PreviewSnapshotFile & { contentRef?: TextContentReference | null };

export type SavedWorkLimits = {
  textFileBytes: number;
  filesPerSession: number;
  uploadBytes: number;
};
/** Trusted output of edit.exportSnapshot; HTTP bodies must never supply this snapshot directly. */
export type SavedWorkDraft = {
  editId: string;
  revision: number;
  sourceId: string;
  target: 'h5' | 'rn';
  baseFileRevision: number;
  snapshot: PreviewSnapshotFile[];
  configSnapshot: Record<string, unknown>;
  entries: string[];
  entryPath: string | null;
};
export type SaveSavedWorkInput = {
  name?: string;
  workId?: string;
  expectedRevision?: number;
  draft: SavedWorkDraft;
};
export type SavedWorkOptions = {
  readVariantCovers?: (urls: string[]) => Promise<Map<string, string>>;
  readCovers?: (userId: string, sourceIds: string[]) => Promise<Map<string, string>>;
  binary: () => { downloadFile(locator: Record<string, unknown>): Promise<Buffer> };
  readLimits: () => SavedWorkLimits;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** Fixed errors must not contain storage locators, SQL or original configuration. */
function invalid(): never {
  throw new SessionError(422, 'INVALID_SAVED_WORK', '作品快照无效');
}
/** Explicit public projection, shared by list/get/save; no source configuration or locators. */
function metadata(row: D2cSavedWork) {
  return {
    workId: row.workId,
    name: row.name,
    target: row.target,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export type SavedWorkMetadata = ReturnType<typeof metadata>;
/** Runtime whitelist only: neither model settings nor upstream resource credentials survive. */
function previewConfig(value: Record<string, unknown>) {
  const config = value?.config as
    | { unit?: { outputUnit?: unknown; outputBase?: unknown } }
    | undefined;
  const base = config?.unit?.outputBase ?? 750;
  const unit = config?.unit?.outputUnit ?? 'px';
  if (
    typeof base !== 'number' ||
    !Number.isFinite(base) ||
    base <= 0 ||
    !['px', 'vw', 'rpx'].includes(String(unit))
  )
    invalid();
  return { config: { unit: { outputUnit: unit as 'px' | 'vw' | 'rpx', outputBase: base } } };
}
/** Check the server-exported snapshot and project only permanent file fields. */
function snapshotFiles(
  input: PreviewSnapshotFile[],
  limits: SavedWorkLimits,
  privateStorage = false,
): FrozenSnapshotFile[] {
  if (!Array.isArray(input) || input.length > limits.filesPerSession) invalid();
  const paths = new Set<string>();
  let bytes = 0;
  const result = input.map((file) => {
    if (!file || typeof file.path !== 'string') invalid();
    /** Even a structurally valid reference supplied by a client is not trusted storage state. */
    if (!privateStorage && 'contentRef' in file) invalid();
    const ref = privateStorage ? (file as FrozenSnapshotFile).contentRef : undefined;
    try {
      if (assertArtifactPath(file.path) !== file.path) invalid();
    } catch {
      invalid();
    }
    if (
      paths.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      invalid();
    paths.add(file.path);
    bytes += file.size;
    if (bytes > 64 * 1024 * 1024) invalid();
    let locator: Record<string, unknown> | null = null;
    if (file.kind === 'source') {
      if (
        (typeof file.content === 'string'
          ? Buffer.byteLength(file.content) !== file.size || sha(file.content) !== file.sha256
          : file.content !== null || !ref) ||
        (ref != null && (ref.size !== file.size || ref.sha256 !== file.sha256)) ||
        file.size > limits.textFileBytes ||
        file.objectLocator !== null
      )
        invalid();
    } else {
      if (
        !['asset', 'attachment'].includes(file.kind) ||
        ref != null ||
        file.content !== null ||
        !file.objectLocator ||
        typeof file.objectLocator !== 'object' ||
        Array.isArray(file.objectLocator)
      )
        invalid();
      const original = file.objectLocator;
      /** Storage providers validate immutable namespace and bytes on download. Persist no secrets. */
      const keys = ['provider', 'fileName', 'url', 'sha256', 'size', 'mimeType'];
      if (
        !['local', 's3'].includes(String(original.provider)) ||
        original.sha256 !== file.sha256 ||
        original.size !== file.size
      )
        invalid();
      locator = {};
      for (const key of keys) {
        if (key === 'size' ? typeof original[key] !== 'number' : typeof original[key] !== 'string')
          invalid();
        locator[key] = original[key];
      }
      try {
        const url = new URL(String(locator.url));
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          invalid();
      } catch {
        invalid();
      }
    }
    return {
      path: file.path,
      kind: file.kind,
      content: file.content,
      ...(ref ? { contentRef: structuredClone(ref) } : {}),
      objectLocator: locator,
      size: file.size,
      sha256: file.sha256,
    };
  });
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) invalid();
      parts.pop();
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
/** Personal works have their own tables; no gallery, session or publication lookup is used. */
export function createSavedWorkService(mysql: Sequelize, options: SavedWorkOptions) {
  const works = mysql.models.D2cSavedWork as typeof D2cSavedWork;
  const files = mysql.models.D2cSavedWorkFile as typeof D2cSavedWorkFile;
  if (!works || !files) throw new SessionError(503, 'MODELS_UNAVAILABLE', '个人作品模型尚未注册');
  /** Invalid/missing runtime limits fail closed. */
  function limits(): SavedWorkLimits {
    let value: SavedWorkLimits;
    try {
      value = options.readLimits();
    } catch {
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额暂不可用');
    }
    if (
      !value ||
      ![value.textFileBytes, value.filesPerSession, value.uploadBytes].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new SessionError(503, 'LIMITS_UNAVAILABLE', '文件限额暂不可用');
    return value;
  }
  /** Ownership is included in SQL, including transactional reads and overwrite checks. */
  async function owned(eid: string, workId: string, transaction?: Transaction) {
    requireIdentifier(eid);
    requireIdentifier(workId);
    const row = await works.findOne({
      where: { ownerEid: eid, workId },
      transaction,
      ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
    });
    if (!row || row.ownerEid !== eid || row.workId !== workId)
      throw new SessionError(404, 'SAVED_WORK_NOT_FOUND', '个人作品不存在');
    return row;
  }
  /** Read a single permanent revision, never current upstream rows. */
  async function frozen(row: D2cSavedWork, settings: SavedWorkLimits, transaction?: Transaction) {
    const rows = await findOrderedRows(contentModel(mysql, files), 'pathHash', {
      where: { ownerEid: row.ownerEid, workId: row.workId, workRevision: row.revision },
      transaction,
      order: [['pathHash', 'ASC']],
    });
    try {
      return snapshotFiles(
        rows.map((file) => {
          if (!file.path || sha(file.path) !== file.pathHash) invalid();
          return {
            path: file.path,
            kind: file.kind,
            ...copyTextStorage(mysql, file),
            objectLocator: file.objectLocator,
            size: file.size,
            sha256: file.sha256,
          };
        }),
        settings,
        true,
      );
    } catch {
      throw new SessionError(503, 'SAVED_WORK_CORRUPT', '个人作品文件校验失败');
    }
  }
  /** Resolve trusted frozen references, then construct a fresh snapshot with no private fields. */
  async function resolveSnapshot(snapshot: FrozenSnapshotFile[]): Promise<PreviewSnapshotFile[]> {
    try {
      const result: PreviewSnapshotFile[] = [];
      for (const file of snapshot) {
        const content = file.kind === 'source' ? await resolveTextContent(mysql, file) : null;
        if (
          file.kind === 'source' &&
          (typeof content !== 'string' ||
            Buffer.byteLength(content) !== file.size ||
            sha(content) !== file.sha256)
        )
          throw new Error();
        result.push({
          path: file.path,
          kind: file.kind,
          content,
          objectLocator: structuredClone(file.objectLocator),
          size: file.size,
          sha256: file.sha256,
        });
      }
      return result;
    } catch {
      throw new SessionError(503, 'SAVED_WORK_CORRUPT', '个人作品文件校验失败');
    }
  }
  /** Hold owner/revision locks only while copying immutable rows, never during object reads. */
  async function readFrozen(eid: string, workId: string) {
    return mysql.transaction(async (transaction) => {
      const row = await owned(eid, workId, transaction);
      return { info: metadata(row), snapshot: await frozen(row, limits(), transaction) };
    });
  }
  /** Reauthorize after slow storage I/O and reject results from an obsolete work revision. */
  async function recheck(eid: string, workId: string, revision: number) {
    const row = await works.findOne({
      where: { ownerEid: eid, workId },
      attributes: ['ownerEid', 'workId', 'revision'],
    });
    if (!row || row.ownerEid !== eid || row.workId !== workId)
      throw new SessionError(404, 'SAVED_WORK_NOT_FOUND', '个人作品不存在');
    if (row.revision !== revision)
      throw new SessionError(409, 'SAVED_WORK_CONFLICT', '个人作品已更新，请重新读取');
  }
  /** Public file metadata excludes binary locators and upstream configuration. */
  function fileMetadata(file: PreviewSnapshotFile) {
    return {
      fileId: sha(file.path),
      path: file.path,
      kind: file.kind,
      size: file.size,
      sha256: file.sha256,
    };
  }
  /** Validate and detach all values before entering async database/storage operations. */
  function prepare(draft: SavedWorkDraft, settings: SavedWorkLimits) {
    if (!draft) invalid();
    requireIdentifier(draft.editId);
    requireIdentifier(draft.sourceId);
    requireRevision(draft.revision);
    requireRevision(draft.baseFileRevision);
    if (!['h5', 'rn'].includes(draft.target)) invalid();
    const snapshot = snapshotFiles(draft.snapshot, settings);
    const entries = snapshot
      .filter((file) => file.kind === 'source' && /\.(tsx|jsx)$/i.test(file.path))
      .map((file) => file.path);
    if (
      !entries.length ||
      !Array.isArray(draft.entries) ||
      new Set(draft.entries).size !== draft.entries.length ||
      draft.entries.length !== entries.length ||
      draft.entries.some((entry) => !entries.includes(entry))
    )
      invalid();
    if (draft.entryPath !== null && !entries.includes(draft.entryPath)) invalid();
    return { ...draft, snapshot, entries, configSnapshot: previewConfig(draft.configSnapshot) };
  }
  /** Package exclusively frozen content; caller already authorized the exported draft. */
  async function pack(snapshot: FrozenSnapshotFile[], settings: SavedWorkLimits, fileName: string) {
    const data = await buildVersionArchive(
      snapshot.map((file) => ({
        ...file,
        mimeType:
          typeof file.objectLocator?.mimeType === 'string' ? file.objectLocator.mimeType : null,
      })),
      (locator) => options.binary().downloadFile(locator),
      settings,
      (file) => resolveTextContent(mysql, file),
    );
    return { data, fileName, mimeType: 'application/zip' as const };
  }
  const service = {
    /** 核对列表修订后短事务删除所有冻结修订，不回收共享图片、正文对象或缓存。 */
    async remove(eid: string, workId: string, expectedRevision: number) {
      requireIdentifier(eid);
      requireIdentifier(workId);
      requireRevision(expectedRevision, false);
      return mysql.transaction(async (transaction) => {
        const row = await works.findOne({
          where: { ownerEid: eid, workId },
          attributes: ['ownerEid', 'workId', 'revision'],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!row || row.ownerEid !== eid || row.workId !== workId)
          throw new SessionError(404, 'SAVED_WORK_NOT_FOUND', '个人作品不存在');
        if (row.revision !== expectedRevision)
          throw new SessionError(409, 'SAVED_WORK_CONFLICT', '个人作品已更新，请刷新后重试');
        await files.destroy({ where: { ownerEid: eid, workId }, transaction });
        const count = await works.destroy({
          where: { ownerEid: eid, workId, revision: expectedRevision },
          transaction,
        });
        if (count !== 1)
          throw new SessionError(409, 'SAVED_WORK_CONFLICT', '个人作品已更新，请刷新后重试');
        return { workId, deleted: true as const };
      });
    },

    /** Lightweight authorization for preview assets, without loading or locking snapshot files. */
    async authorize(eid: string, workId: string): Promise<void> {
      requireIdentifier(eid);
      requireIdentifier(workId);
      const row = await works.findOne({
        where: { ownerEid: eid, workId },
        attributes: ['workId', 'ownerEid'],
      });
      if (!row || row.ownerEid !== eid || row.workId !== workId)
        throw new SessionError(404, 'SAVED_WORK_NOT_FOUND', '个人作品不存在');
    },
    /** List only the authenticated owner's personal works. */
    async list(eid: string, page = 1, pageSize = 12) {
      requireIdentifier(eid);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 50
      )
        throw new SessionError(422, 'INVALID_PAGE', '分页参数无效');
      const where = { ownerEid: eid };
      const rows = await findOrderedRows(works, 'workId', {
        where,
        attributes: [
          'workId',
          'name',
          'target',
          'revision',
          'createdAt',
          'updatedAt',
          'sourceId',
          'configSnapshot',
        ],
        order: [
          ['updatedAt', 'DESC'],
          ['workId', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const missing = rows.filter(
        (row) => !safeRuntimeCoverUrl(row.configSnapshot?.runtimeCoverUrl),
      );
      const inherited =
        options.readCovers && missing.length
          ? await options.readCovers(
              eid,
              missing.map((row) => row.sourceId),
            )
          : new Map<string, string>();
      const covers = rows.map(
        (row) =>
          safeRuntimeCoverUrl(row.configSnapshot?.runtimeCoverUrl) ??
          safeRuntimeCoverUrl(inherited.get(row.sourceId)),
      );
      let preferred = new Map<string, string>();
      try {
        preferred =
          (await options.readVariantCovers?.(covers.filter((url): url is string => !!url))) ??
          preferred;
      } catch {
        /* 派生图不可用时继续使用已冻结原图。 */
      }
      return {
        items: rows.map((row, index) => ({
          ...metadata(row),
          coverUrl: safeRuntimeCoverUrl(preferred.get(covers[index] ?? '')) ?? covers[index],
          ...(safeRuntimeCoverUrl(preferred.get(covers[index] ?? ''))
            ? { coverOriginalUrl: covers[index] }
            : {}),
        })),
        total: await works.count({ where }),
        page,
        pageSize,
      };
    },
    /** Public detail DTO; private preview configuration is only available via source(). */
    async get(eid: string, workId: string) {
      const { info, snapshot } = await readFrozen(eid, workId);
      const resolved = await resolveSnapshot(snapshot);
      await recheck(eid, workId, info.revision);
      return { ...info, files: resolved.map(fileMetadata) };
    },
    /** Read only public file metadata. */
    async files(eid: string, workId: string) {
      return (await service.get(eid, workId)).files;
    },
    /** Read one owned source file, without exposing storage locators. */
    async getFile(eid: string, workId: string, fileId: string) {
      if (typeof fileId !== 'string' || !/^[a-f0-9]{64}$/.test(fileId)) invalid();
      const { info, snapshot } = await readFrozen(eid, workId);
      const resolved = await resolveSnapshot(snapshot);
      await recheck(eid, workId, info.revision);
      const file = resolved.find((item) => sha(item.path) === fileId && item.kind === 'source');
      if (!file) throw new SessionError(404, 'SAVED_WORK_FILE_NOT_FOUND', '源码文件不存在');
      return { ...fileMetadata(file), content: file.content! };
    },
    /** Internal frozen metadata/refs only; the editor hydrates after releasing this transaction. */
    async source(
      eid: string,
      workId: string,
      entryPath: string | undefined,
      transaction: Transaction,
      settings: SavedWorkLimits,
    ) {
      validateSessionEntry(entryPath);
      if (
        !settings ||
        ![settings.textFileBytes, settings.filesPerSession].every(
          (n) => Number.isSafeInteger(n) && n > 0,
        )
      )
        invalid();
      const row = await owned(eid, workId, transaction);
      const snapshot = await frozen(row, settings, transaction);
      const entries = snapshot
        .filter((file) => file.kind === 'source' && /\.(tsx|jsx)$/i.test(file.path))
        .map((file) => file.path);
      const selected = entryPath ?? row.entryPath;
      if (selected !== null && !entries.includes(selected))
        throw new SessionError(422, 'INVALID_ENTRY', '作品入口不存在');
      return {
        fileRevision: row.revision,
        target: row.target,
        snapshot,
        configSnapshot: previewConfig(row.configSnapshot ?? {}),
        entries,
        entryPath: selected,
      };
    },
    /** Atomic owner-only create or CAS overwrite; file rows are append-only by revision. */
    async save(eid: string, input: SaveSavedWorkInput): Promise<SavedWorkMetadata> {
      requireIdentifier(eid);
      if (
        !input ||
        (input.name !== undefined &&
          (typeof input.name !== 'string' ||
            !input.name.trim() ||
            input.name.trim().length > 200 ||
            /[\x00-\x1f\x7f]/.test(input.name)))
      )
        invalid();
      const requestedName = input.name?.trim();
      const defaultName = `编辑作品 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const workId = input.workId;
      const expectedRevision = input.expectedRevision;
      if (workId !== undefined) {
        requireIdentifier(workId);
        requireRevision(expectedRevision!, false);
      }
      const draft = prepare(input.draft, limits());
      const saveKey = sha(JSON.stringify([draft.editId, draft.revision]));
      const initialWhere = { ownerEid: eid, editId: draft.editId, editRevision: draft.revision };
      /** Check authorization/replay before preparing external objects, and repeat CAS under lock. */
      function assertOverwrite(row: D2cSavedWork) {
        if (
          row.revision !== expectedRevision ||
          draft.baseFileRevision !== expectedRevision ||
          draft.sourceId !== workId ||
          row.target !== draft.target
        )
          throw new SessionError(409, 'SAVED_WORK_CONFLICT', '个人作品已更新，请重新进入编辑');
      }
      if (workId !== undefined) {
        const row = await owned(eid, workId);
        if (row.lastSaveKey === saveKey) return metadata(row);
        assertOverwrite(row);
      } else {
        const prior = await works.findOne({ where: initialWhere });
        if (prior) return metadata(prior);
      }
      const source = await works.findOne({
        where: { ownerEid: eid, workId: workId ?? draft.sourceId },
      });
      let runtimeCoverUrl = safeRuntimeCoverUrl(source?.configSnapshot?.runtimeCoverUrl);
      if (!runtimeCoverUrl && options.readCovers) {
        const urls = await options.readCovers(eid, [source?.sourceId ?? draft.sourceId]);
        runtimeCoverUrl = safeRuntimeCoverUrl(urls.get(source?.sourceId ?? draft.sourceId));
      }
      const configSnapshot = {
        ...draft.configSnapshot,
        ...(runtimeCoverUrl ? { runtimeCoverUrl } : {}),
      };
      const destinationId = workId ?? randomUUID();
      const prepared: FrozenSnapshotFile[] = [];
      /** Upload/readback must finish before opening the short database transaction. */
      for (const file of draft.snapshot) {
        prepared.push({
          ...file,
          ...(file.kind === 'source'
            ? await prepareTextContent(mysql, 'work:' + destinationId, file.content!)
            : {}),
        });
      }
      try {
        return await mysql.transaction(async (transaction) => {
          let row: D2cSavedWork;
          let revision = 1;
          if (workId !== undefined) {
            row = await owned(eid, workId, transaction);
            if (row.lastSaveKey === saveKey) return metadata(row);
            assertOverwrite(row);
            requireRevision(row.revision, false);
            revision = row.revision + 1;
            const [count] = await works.update(
              {
                name: requestedName ?? row.name,
                revision,
                lastSaveKey: saveKey,
                baseFileRevision: draft.baseFileRevision,
                sourceId: draft.sourceId,
                entryPath: draft.entryPath,
                entries: draft.entries,
                configSnapshot,
              },
              { where: { ownerEid: eid, workId, revision: expectedRevision }, transaction },
            );
            if (count !== 1)
              throw new SessionError(409, 'SAVED_WORK_CONFLICT', '个人作品已更新，请重新进入编辑');
            /** Instance update would filter by auto-PK only; reread through the ownership filter. */
            row = await owned(eid, workId, transaction);
          } else {
            const prior = await works.findOne({ where: initialWhere, transaction });
            if (prior) return metadata(prior);
            row = await works.create(
              {
                workId: destinationId,
                ownerEid: eid,
                name: requestedName ?? defaultName,
                target: draft.target,
                revision,
                editId: draft.editId,
                editRevision: draft.revision,
                lastSaveKey: saveKey,
                sourceId: draft.sourceId,
                baseFileRevision: draft.baseFileRevision,
                entryPath: draft.entryPath,
                entries: draft.entries,
                configSnapshot,
              },
              { transaction },
            );
          }
          await files.bulkCreate(
            prepared.map((file) => ({
              ...file,
              ownerEid: eid,
              workId: row.workId,
              workRevision: revision,
              pathHash: sha(file.path),
            })),
            { transaction },
          );
          return metadata(row);
        });
      } catch (error) {
        /** A concurrent initial save may win the unique owner/edit/revision key. */
        if (workId === undefined && error instanceof UniqueConstraintError) {
          const prior = await works.findOne({ where: initialWhere });
          if (prior) return metadata(prior);
        }
        throw error;
      }
    },
    /** Download a consistent owned revision; source unpublish/delete is irrelevant. */
    async archive(eid: string, workId: string) {
      const settings = limits();
      const snapshot = await mysql.transaction(async (transaction) =>
        frozen(await owned(eid, workId, transaction), settings, transaction),
      );
      return pack(snapshot, settings, `pixelprint-${workId}.zip`);
    },
    /** Only accept an already-authorized edit.exportSnapshot result. */
    async archiveDraft(draft: SavedWorkDraft) {
      const settings = limits();
      const frozen = prepare(draft, settings);
      return pack(frozen.snapshot, settings, `pixelprint-draft-${frozen.editId}.zip`);
    },
  };
  return service;
}
export type SavedWorkService = ReturnType<typeof createSavedWorkService>;
export type SavedWorkSource = Awaited<ReturnType<SavedWorkService['source']>>;
