import fs from 'node:fs/promises';
import path from 'node:path';
import { previewLayoutCheckSchema, type PreviewLayoutCheck } from './interaction';

type Node = {
  id?: string;
  type?: string;
  name?: string;
  visible?: boolean;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  children?: Node[];
  document?: Node;
  node?: Node;
  nodes?: Record<string, Node>;
};

/** Reuse one cached root; bounded traversal never requests Figma or invents missing geometry. */
export function layoutChecksFromCache(value: Node, rootId: string): PreviewLayoutCheck[] {
  let root: Node | undefined;
  const pending = [value];
  for (let count = 0; pending.length && count < 2000; count++) {
    const node = pending.pop()!;
    if (node.id === rootId) {
      root = node;
      break;
    }
    pending.push(
      ...(node.children ?? []),
      ...(node.document ? [node.document] : []),
      ...(node.node ? [node.node] : []),
      ...Object.values(node.nodes ?? {}),
    );
  }
  const box = root?.absoluteBoundingBox;
  if (!root || !box || !(box.width > 0) || !Number.isFinite(box.width)) return [];
  const ratio = 375 / box.width;
  const checks: PreviewLayoutCheck[] = [];
  const queue: Array<{ node: Node; parent?: Node }> = [{ node: root }];
  for (let count = 0; queue.length && count < 2000 && checks.length < 32; count++) {
    const { node, parent } = queue.shift()!;
    if (node.visible === false || /^(?:bg|img|x)(?:-|$)/.test(node.name ?? '')) continue;
    const b = node.absoluteBoundingBox;
    if (b && node.id && /^[\d:;]+$/.test(node.id)) {
      const check: PreviewLayoutCheck = { selector: `[data-node-id="${node.id}"]`, tolerance: 3 };
      // FILL/HUG and text dimensions remain layout-driven; measure only explicit FIXED axes.
      if (node.type !== 'TEXT') {
        if (node.layoutSizingHorizontal === 'FIXED' && b.width > 0) check.width = b.width * ratio;
        if (node.layoutSizingVertical === 'FIXED' && b.height > 0) check.height = b.height * ratio;
      } else if (parent?.id && /^[\d:;]+$/.test(parent.id) && parent.absoluteBoundingBox) {
        const p = parent.absoluteBoundingBox;
        const horizontal =
          node.textAlignHorizontal === 'CENTER' ||
          (parent.layoutMode === 'HORIZONTAL'
            ? parent.primaryAxisAlignItems
            : parent.counterAxisAlignItems) === 'CENTER';
        const vertical =
          node.textAlignVertical === 'CENTER' ||
          (parent.layoutMode === 'VERTICAL'
            ? parent.primaryAxisAlignItems
            : parent.counterAxisAlignItems) === 'CENTER';
        check.centerX =
          node.layoutSizingHorizontal !== 'FILL' &&
          horizontal &&
          Math.abs(b.x + b.width / 2 - p.x - p.width / 2) * ratio <= 1;
        check.centerY =
          node.layoutSizingVertical !== 'FILL' &&
          vertical &&
          Math.abs(b.y + b.height / 2 - p.y - p.height / 2) * ratio <= 1;
        if (check.centerX || check.centerY) check.container = `[data-node-id="${parent.id}"]`;
      }
      const valid = previewLayoutCheckSchema.safeParse(check);
      if (valid.success) checks.push(valid.data);
    }
    for (const child of node.children ?? []) queue.push({ node: child, parent: node });
  }
  return checks;
}

/** Read only an existing canonical cache path; cache gaps fall back to explicit assertions. */
export async function cachedLayoutChecks(workspace: string, figmaUrl: string | null) {
  if (!figmaUrl) return [];
  try {
    const url = new URL(figmaUrl);
    const key = url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)\//)?.[1];
    const id = url.searchParams.get('node-id')?.replace(/-/g, ':');
    if (!key || !id || !/^\d+:\d+$/.test(id)) return [];
    const filename = path.join(
      workspace,
      '.d2c-cache',
      key,
      'nodes',
      `${id.replace(':', '_')}.json`,
    );
    if ((await fs.stat(filename)).size > 16 * 1024 * 1024) return [];
    return layoutChecksFromCache(JSON.parse(await fs.readFile(filename, 'utf8')), id);
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
}
