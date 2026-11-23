import { createHash } from 'node:crypto';
import { assetUrl } from './assetUrls';
import { assertArtifactPath } from './paths';

/** SQL restricts the page's frozen files to supported raster image suffixes. */
export const workCoverPattern = '^.+[.]([pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$';
export const workCoverAttributes = ['path', 'pathHash', 'kind', 'size', 'sha256', 'objectLocator'];
type CoverFile = {
  path: string | null;
  pathHash: string | null;
  kind: string | null;
  size: number | null;
  sha256: string | null;
  objectLocator: Record<string, unknown> | null;
};

/** Compare decimal node IDs without losing precision or relying on database row order. */
function compareNodePart(a: string, b: string) {
  const left = a.replace(/^0+/, '') || '0';
  const right = b.replace(/^0+/, '') || '0';
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

/** Prefer a frozen design root, otherwise the largest valid raster asset in the same snapshot. */
export function workCoverUrl(files: CoverFile[]): string | null {
  const candidates = files.flatMap((file) => {
    const suffix = /\.(png|jpe?g|webp)$/i.exec(file.path ?? '')?.[1].toLowerCase();
    if (!suffix) return [];
    const mimeType =
      suffix === 'png' ? 'image/png' : suffix === 'webp' ? 'image/webp' : 'image/jpeg';
    const design = /^design-reference\/root-([0-9]+)_([0-9]+)\.png$/.exec(file.path ?? '');
    try {
      const locator = file.objectLocator;
      if (
        assertArtifactPath(file.path!) !== file.path ||
        file.path!.split('/').some((part) => /^(?:internal|__preview)$/i.test(part)) ||
        createHash('sha256').update(file.path!).digest('hex') !== file.pathHash ||
        !['asset', 'attachment'].includes(file.kind ?? '') ||
        !Number.isSafeInteger(file.size) ||
        file.size! <= 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
        !locator ||
        typeof locator !== 'object' ||
        Array.isArray(locator) ||
        locator.size !== file.size ||
        locator.sha256 !== file.sha256 ||
        (locator.mimeType != null && locator.mimeType !== mimeType)
      )
        return [];
      const url = assetUrl(locator);
      return url ? [{ node: design?.slice(1), path: file.path!, size: file.size!, url }] : [];
    } catch {
      return [];
    }
  });
  candidates.sort((a, b) => {
    const order =
      a.node && b.node
        ? compareNodePart(a.node[0], b.node[0]) || compareNodePart(a.node[1], b.node[1])
        : a.node
          ? -1
          : b.node
            ? 1
            : b.size - a.size;
    return order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return candidates[0]?.url ?? null;
}
