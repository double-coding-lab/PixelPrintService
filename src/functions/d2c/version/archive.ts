import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertArtifactPath } from '../utils/paths';

export type ArchiveFile = {
  path: string;
  kind: 'source' | 'asset' | 'attachment';
  content: string | null;
  objectLocator: Record<string, unknown> | null;
  mimeType: string | null;
  size: number;
  sha256: string;
};

/** fflate 0.8.3's Node ESM worker bootstrap fails; its public CommonJS entry works. */
const { AsyncZipDeflate, Zip } = createRequire(import.meta.url)(
  'fflate',
) as typeof import('fflate');

const RAW_BYTES = 64 * 1024 * 1024;
const ZIP_BYTES = 30_000_000;

/** Compress verified files asynchronously in path order, stopping at the output byte limit. */
function compressArchive(
  entries: { path: string; bytes: Buffer }[],
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let index = 0;
    let stopped = false;
    const archive = new Zip((error, chunk, final) => {
      if (stopped) return;
      if (error) return fail('ARCHIVE_ZIP_FAILED');
      size += chunk.byteLength;
      if (size > maxBytes) return fail('ARCHIVE_ZIP_LIMIT');
      chunks.push(Buffer.from(chunk));
      if (final) {
        stopped = true;
        resolve(Buffer.concat(chunks, size));
      }
    });

    /** Stop workers and expose only a fixed error code. */
    function fail(code: string): void {
      if (stopped) return;
      stopped = true;
      archive.terminate();
      reject(new Error(code));
    }

    /** Start one worker at a time while preserving even numeric filename ordering. */
    function next(): void {
      if (stopped) return;
      try {
        const entry = entries[index++];
        if (!entry) {
          archive.end();
          return;
        }
        const file = new AsyncZipDeflate(entry.path, { level: 6 });
        /** fflate encodes local calendar fields: use a fixed local date across time zones. */
        file.mtime = new Date(1980, 0, 1, 0, 0, 0);
        archive.add(file);
        const ondata = file.ondata;
        file.ondata = (error, chunk, final) => {
          try {
            ondata(error, chunk, final);
            if (final && !error) next();
          } catch {
            fail('ARCHIVE_ZIP_FAILED');
          }
        };
        /** Workers transfer ownership; pooled Node Buffer backing stores cannot be transferred. */
        file.push(Uint8Array.from(entry.bytes), true);
      } catch {
        fail('ARCHIVE_ZIP_FAILED');
      }
    }

    next();
  });
}

/** Build a reproducible ZIP exclusively from immutable version files and verified object bytes. */
export async function buildVersionArchive(
  files: ArchiveFile[],
  download: (locator: Record<string, unknown>) => Promise<Buffer>,
  limits: { textFileBytes: number; filesPerSession: number; uploadBytes: number },
): Promise<Buffer> {
  if (
    ![limits.textFileBytes, limits.filesPerSession, limits.uploadBytes].every(
      (limit) => Number.isSafeInteger(limit) && limit >= 0,
    )
  ) {
    throw new Error('ARCHIVE_INVALID_LIMITS');
  }
  const maxBytes = Math.min(limits.uploadBytes, ZIP_BYTES);
  if (files.length > limits.filesPerSession || files.length > 65_535) {
    throw new Error('ARCHIVE_FILE_LIMIT');
  }
  let total = 0;
  let headers = 22;
  const paths = new Set<string>();
  /** Copy all metadata before the first await; no live session state is consulted. */
  const snapshot = files.map((file) => {
    let path: string;
    try {
      path = assertArtifactPath(file.path);
    } catch {
      throw new Error('ARCHIVE_INVALID_PATH');
    }
    if (path !== file.path || Buffer.byteLength(path, 'utf8') > 65_535) {
      throw new Error('ARCHIVE_INVALID_PATH');
    }
    if (paths.has(path)) throw new Error('ARCHIVE_PATH_CONFLICT');
    paths.add(path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error('ARCHIVE_INVALID_FILE');
    }
    if (file.kind === 'source') {
      if (typeof file.content !== 'string' || file.objectLocator !== null) {
        throw new Error('ARCHIVE_INVALID_FILE');
      }
      if (Buffer.byteLength(file.content, 'utf8') > limits.textFileBytes) {
        throw new Error('ARCHIVE_TEXT_LIMIT');
      }
    } else if (
      (file.kind !== 'asset' && file.kind !== 'attachment') ||
      file.content !== null ||
      !file.objectLocator ||
      typeof file.objectLocator !== 'object' ||
      Array.isArray(file.objectLocator) ||
      !Object.keys(file.objectLocator).length
    ) {
      throw new Error('ARCHIVE_INVALID_FILE');
    }
    total += file.size;
    if (total > RAW_BYTES) throw new Error('ARCHIVE_RAW_LIMIT');
    /** Local/central headers and the streaming data descriptor, excluding compressed data. */
    headers += 92 + 2 * Buffer.byteLength(path, 'utf8');
    if (headers > maxBytes) throw new Error('ARCHIVE_ZIP_LIMIT');
    try {
      return { ...file, path, objectLocator: structuredClone(file.objectLocator) };
    } catch {
      throw new Error('ARCHIVE_INVALID_FILE');
    }
  });
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) throw new Error('ARCHIVE_PATH_CONFLICT');
      parts.pop();
    }
  }
  if (headers > maxBytes) throw new Error('ARCHIVE_ZIP_LIMIT');
  snapshot.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: { path: string; bytes: Buffer }[] = [];
  for (const file of snapshot) {
    let bytes: Buffer;
    if (file.kind === 'source') {
      bytes = Buffer.from(file.content!, 'utf8');
    } else {
      try {
        const downloaded = await download(file.objectLocator!);
        if (!Buffer.isBuffer(downloaded)) throw new Error();
        bytes = downloaded;
      } catch {
        throw new Error('ARCHIVE_DOWNLOAD_FAILED');
      }
    }
    if (
      bytes.length !== file.size ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()
    ) {
      throw new Error('ARCHIVE_INTEGRITY_FAILED');
    }
    entries.push({ path: file.path, bytes: Buffer.from(bytes) });
  }
  return compressArchive(entries, maxBytes);
}
