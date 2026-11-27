import { previewEngine } from '../preview/engine';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { previewTemplateRoot } from '../preview/paths';
import type { EditRecord } from './store';

/** 构建参数与缓存身份共用同一单位规则，保持 H5 与 RN 的既有行为。 */
export function editBuildUnit(record: Pick<EditRecord, 'target' | 'configSnapshot'>) {
  const config = record.configSnapshot.config as
    | { unit?: { outputUnit?: string; outputBase?: number } }
    | undefined;
  return {
    outputUnit:
      record.target === 'h5' || config?.unit?.outputUnit === 'vw'
        ? ('vw' as const)
        : ('px' as const),
    outputBase: Number(config?.unit?.outputBase ?? 750),
  };
}

/** 模板在进程生命周期内固定；重启后重新核对脚本、配置及依赖锁，升级自动换键。 */
export function createEditBuildRevision(root = previewTemplateRoot) {
  let pending: Promise<string> | undefined;
  async function read() {
    const hash = createHash('sha256').update(
      JSON.stringify(['pixelprint-edit-build-v1', previewEngine, process.versions.node]),
    );
    let count = 0;
    let total = 0;
    async function visit(relative = '') {
      const entries = await readdir(path.join(root, relative), { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await visit(name);
        else {
          if (!entry.isFile() || ++count > 256) throw new Error('EDIT_BUILD_REVISION_INVALID');
          const bytes = await readFile(path.join(root, name));
          total += bytes.length;
          if (total > 8 * 1024 * 1024) throw new Error('EDIT_BUILD_REVISION_INVALID');
          hash.update(JSON.stringify([name, bytes.length]));
          hash.update(bytes);
        }
      }
    }
    await visit();
    if (!count) throw new Error('EDIT_BUILD_REVISION_INVALID');
    return hash.digest('hex');
  }
  return () => (pending ??= read());
}

/** 只共享不可变产物，副本/修订/job 不参与命中；身份与来源仍绑定当前授权范围。 */
export function editBuildKey(
  record: Pick<EditRecord, 'target' | 'entryPath' | 'configSnapshot' | 'files' | 'snapshot'>,
  scope: readonly string[],
  revision: string,
  limits: { textFileBytes: number; filesPerSession: number; uploadBytes: number },
) {
  const source = new Map(record.files.map((file) => [file.path, file.content]));
  const inputs = record.snapshot
    .map((file) => {
      if (file.kind !== 'source') return [file.path, file.kind, file.size, file.sha256];
      const content = source.get(file.path);
      if (typeof content !== 'string') throw new Error('EDIT_INPUT_CORRUPT');
      return [
        file.path,
        file.kind,
        Buffer.byteLength(content),
        createHash('sha256').update(content).digest('hex'),
      ];
    })
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pixelprint-edit-content-v1',
        scope,
        revision,
        record.target,
        record.entryPath,
        editBuildUnit(record),
        [limits.textFileBytes, limits.filesPerSession, limits.uploadBytes],
        inputs,
      ]),
    )
    .digest('hex');
}
