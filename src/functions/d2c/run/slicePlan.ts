import { englishSliceName, MAX_SLICE_FILENAME_LENGTH, validateSliceNames } from './sliceNames';

/** Geometry returned by Figma for nominal or rendered bounds. */
type SliceBounds = { x: number; y: number; width: number; height: number };

/** Minimal recursive Figma subtree consumed by the slice planner. */
export type FigmaSliceNode = {
  id: string;
  name: string;
  children?: FigmaSliceNode[];
  fills?: ({ type: string; visible?: boolean; imageRef?: string | null } | null)[];
  absoluteBoundingBox?: SliceBounds | null;
  absoluteRenderBounds?: SliceBounds | null;
};

/** A planned export; filename is an ASCII stem of at most 160 characters, without .png. */
export type SliceItem = {
  nodeId: string;
  name: string;
  parentName: string | null;
  filename: string;
  renderBounds?: SliceBounds | null;
  boundingBox?: SliceBounds | null;
  listAncestor?: string | null;
  imageRefKey?: string | null;
};

type CollectedSlice = SliceItem & { pathStack: string[] };

/** Match only bare img/bg tags and their hyphenated descendants. */
function isSliceName(name: string): boolean {
  return name === 'img' || name === 'bg' || name.startsWith('img-') || name.startsWith('bg-');
}

/** Sort visible image references without deduplicating or mutating input fills. */
function imageRefKeyOf(node: FigmaSliceNode): string | null {
  const refs = (node.fills || [])
    .filter((fill) => fill && fill.type === 'IMAGE' && fill.visible !== false && fill.imageRef)
    .map((fill) => fill!.imageRef!);
  return refs.length ? refs.sort().join(',') : null;
}

/** Collect slices in pre-order, including descendants of other slices. */
function collectSliceNodes(
  node: FigmaSliceNode,
  out: CollectedSlice[] = [],
  pathStack: string[] = [],
  parentName: string | null = null,
  listAncestor: string | null = null,
): CollectedSlice[] {
  const name = node.name;
  if (isSliceName(name)) {
    out.push({
      nodeId: node.id,
      name,
      parentName,
      filename: '',
      pathStack: [...pathStack, name],
      renderBounds: node.absoluteRenderBounds ? { ...node.absoluteRenderBounds } : null,
      boundingBox: node.absoluteBoundingBox ? { ...node.absoluteBoundingBox } : null,
      listAncestor,
      imageRefKey: imageRefKeyOf(node),
    });
  }
  for (const child of node.children || []) {
    collectSliceNodes(
      child,
      out,
      [...pathStack, name],
      name,
      name.startsWith('list-') ? node.id : listAncestor,
    );
  }
  return out;
}

/** Prefer an own node-ID override to an own original-layer-name override. */
function filenameOverride(slice: CollectedSlice, names: Record<string, string>): string | null {
  if (Object.hasOwn(names, slice.nodeId)) return names[slice.nodeId];
  if (Object.hasOwn(names, slice.name)) return names[slice.name];
  return null;
}

/** Select the original label whose semantics name the slice, stripping structural prefixes. */
function filenameSubject(slice: CollectedSlice): string {
  if (slice.name === 'img' || slice.name === 'bg') {
    return slice.parentName
      ? slice.parentName.replace(/^(img|bg|sub|block|scrollx|scrolly|fixed|end|btn|input|x)-/, '')
      : 'root';
  }
  return slice.name.replace(/^(img|bg)-/, '');
}

/** Resolve an explicit or dictionary name without disguising unknown words as positional names. */
function semanticFilename(slice: CollectedSlice, names: Record<string, string>): string | null {
  const override = filenameOverride(slice, names);
  if (override) return override;
  if (slice.name === 'img' || slice.name === 'bg') {
    const parentOverride =
      slice.parentName && Object.hasOwn(names, slice.parentName) ? names[slice.parentName] : null;
    const translated = parentOverride || englishSliceName(filenameSubject(slice));
    return translated ? `${translated}__${slice.name}` : null;
  }
  return englishSliceName(filenameSubject(slice));
}

/** Bare tags borrow parent semantics; unknown names use their one-based slice position. */
function baseFilename(
  slice: CollectedSlice,
  position: number,
  names: Record<string, string>,
): string {
  const fallback = `image-${position}`;
  return (
    semanticFilename(slice, names) ||
    (slice.name === 'img' || slice.name === 'bg' ? `${fallback}__${slice.name}` : fallback)
  );
}

/**
 * List Chinese naming subjects needing explicit English names before downloading any slices.
 * Bare img/bg subjects come from their parent; named tags use their own original label.
 * Baseline mode returns baseline IDs/labels in baseline traversal order, including repeats.
 * Validate all overrides as the planner does; a legal override is trusted as explicit intent,
 * not independently verified as an accurate translation. Non-Han fallbacks are not listed.
 * This pure preflight leaves planSlices' return shape unchanged and makes no model requests.
 */
export function requiredSliceNames(
  root: FigmaSliceNode,
  baseline?: FigmaSliceNode,
  names: Record<string, string> = {},
): Pick<SliceItem, 'nodeId' | 'name' | 'parentName'>[] {
  validateSliceNames(names);
  return collectSliceNodes(baseline || root)
    .filter(
      (slice) => /\p{Script=Han}/u.test(filenameSubject(slice)) && !semanticFilename(slice, names),
    )
    .map(({ nodeId, name, parentName }) => ({ nodeId, name, parentName }));
}

/** Find the nearest meaningful ancestor, skipping generic group/frame labels. */
function parentPrefixSlug(slice: CollectedSlice, names: Record<string, string>): string | null {
  for (let i = slice.pathStack.length - 2; i >= 0; i--) {
    const name = slice.pathStack[i];
    const raw = name.toLowerCase().trim();
    if (!raw || ['编组', 'group', 'frame'].includes(raw)) continue;
    const slug = Object.hasOwn(names, name) ? names[name] : englishSliceName(name);
    if (slug) return slug;
  }
  return null;
}

/** Bound the entire ASCII stem, reserving room for numeric suffixes and existing filenames. */
function uniqueFilename(stem: string, used: Set<string>, reserved: Set<string>): string {
  let candidate = stem.slice(0, MAX_SLICE_FILENAME_LENGTH);
  let suffix = 2;
  while (used.has(candidate.toLowerCase()) || reserved.has(candidate.toLowerCase())) {
    const ending = `__${suffix++}`;
    candidate = `${stem.slice(0, MAX_SLICE_FILENAME_LENGTH - ending.length)}${ending}`;
  }
  return candidate;
}

/** Keep every slice, resolving translated collisions with parent semantics and ordered suffixes. */
function resolveFilenameCollisions(
  slices: CollectedSlice[],
  names: Record<string, string>,
): SliceItem[] {
  const groups = new Map<string, CollectedSlice[]>();
  for (const [index, slice] of slices.entries()) {
    const base = baseFilename(slice, index + 1, names);
    const group = groups.get(base) || [];
    group.push(slice);
    groups.set(base, group);
  }
  for (const [base, group] of groups) {
    const used = new Set<string>();
    for (const slice of group) {
      const prefix = group.length > 1 ? parentPrefixSlug(slice, names) : null;
      const candidate = uniqueFilename(prefix ? `${prefix}__${base}` : base, used, new Set());
      used.add(candidate.toLowerCase());
      slice.filename = candidate;
    }
  }
  const reserved = new Set(slices.map((slice) => slice.filename.toLowerCase()));
  const used = new Set<string>();
  return slices.map(({ pathStack: _pathStack, ...slice }) => {
    if (used.has(slice.filename.toLowerCase())) {
      slice.filename = uniqueFilename(slice.filename, used, reserved);
    }
    used.add(slice.filename.toLowerCase());
    return slice;
  });
}

/** Match original labels; the theme's outer frame may have a different name. */
function matchKey(name: string, parentName: string | null, rootChild: boolean): string {
  return JSON.stringify([
    rootChild ? 'theme-root' : 'parent',
    rootChild ? null : parentName || 'root',
    name,
  ]);
}

/**
 * Plan ASCII filename stems without changing slice selection or deduplication metadata.
 * Overrides accept node IDs or original layer names and must be safe stems of at most 160 chars.
 * Generated stems, including parent prefixes and collision suffixes, are also capped at 160.
 * A baseline owns all filenames and override lookup; target node IDs never rename its slots.
 * Alignment keeps baseline name/parentName but copies geometry, image refs and list IDs from target.
 * Match original labels/parents first, then absent/renamed single-parent groups by original label.
 * Indistinguishable repeated labels consume traversal order; ambiguous renamed parents miss.
 */
export function planSlices(
  root: FigmaSliceNode,
  baseline?: FigmaSliceNode,
  names: Record<string, string> = {},
): { items: SliceItem[]; missing: string[] } {
  validateSliceNames(names);
  const collected = collectSliceNodes(baseline || root);
  const slices = resolveFilenameCollisions(collected, names);
  if (!baseline) return { items: slices, missing: [] };

  const targetSlices = new Map(collectSliceNodes(root).map((slice) => [slice.nodeId, slice]));
  const groups = new Map<string, FigmaSliceNode[]>();
  const nodesByName = new Map<string, FigmaSliceNode[]>();
  const parents = new Map<FigmaSliceNode, string | null>();
  /** Index all named theme nodes in pre-order, as aligned-to-base does. */
  function walk(node: FigmaSliceNode, parentName: string | null, depth: number): void {
    if (node.name) {
      const key = matchKey(node.name, parentName, depth === 1);
      const group = groups.get(key) || [];
      group.push(node);
      groups.set(key, group);
      const named = nodesByName.get(node.name) || [];
      named.push(node);
      nodesByName.set(node.name, named);
      parents.set(node, parentName);
    }
    for (const child of node.children || []) walk(child, node.name, depth + 1);
  }
  walk(root, null, 0);

  const cursors = new Map<string, number>();
  const matched = new Map<SliceItem, FigmaSliceNode>();
  const used = new Set<FigmaSliceNode>();
  const unmatched = new Map<string, SliceItem[]>();
  /** Reserve all exact original-label matches before considering renamed-parent fallbacks. */
  for (const [index, slice] of slices.entries()) {
    const key = matchKey(slice.name, slice.parentName, collected[index].pathStack.length === 2);
    const cursor = cursors.get(key) || 0;
    cursors.set(key, cursor + 1);
    const node = groups.get(key)?.[cursor];
    if (node) {
      matched.set(slice, node);
      used.add(node);
    } else {
      const group = unmatched.get(slice.name) || [];
      group.push(slice);
      unmatched.set(slice.name, group);
    }
  }
  for (const [name, group] of unmatched) {
    const candidates = (nodesByName.get(name) || []).filter((node) => !used.has(node));
    const sourceParents = new Set(group.map((slice) => slice.parentName));
    const targetParents = new Set(candidates.map((node) => parents.get(node)));
    const sourceParent = group[0].parentName;
    if (
      sourceParent &&
      !nodesByName.has(sourceParent) &&
      sourceParents.size === 1 &&
      targetParents.size === 1
    ) {
      for (let index = 0; index < Math.min(group.length, candidates.length); index++) {
        matched.set(group[index], candidates[index]);
      }
    }
  }

  const items: SliceItem[] = [];
  const missing: string[] = [];
  for (const slice of slices) {
    const target = matched.get(slice);
    if (!target) {
      missing.push(slice.name);
    } else {
      const metadata = targetSlices.get(target.id)!;
      items.push({
        nodeId: target.id,
        name: slice.name,
        parentName: slice.parentName,
        filename: slice.filename,
        renderBounds: metadata.renderBounds,
        boundingBox: metadata.boundingBox,
        listAncestor: metadata.listAncestor,
        imageRefKey: metadata.imageRefKey,
      });
    }
  }
  return { items, missing };
}
