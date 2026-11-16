export type Data = Record<string, any>;
export type Fact = {
  node: Data;
  parent?: Fact;
  children: Fact[];
  hidden: boolean;
  bakedBy: string | null;
  duplicate: boolean;
};

/** Copy data properties only; never execute getters, toJSON, or user functions. */
export function copyData(value: unknown): any {
  const active = new Set<object>();
  const holder: Data = {};
  const jobs = [{ value, parent: holder, key: 'value', exit: false, depth: 0 }];
  let count = 0;
  while (jobs.length) {
    const job = jobs.pop()!;
    if (++count > 500_000 || job.depth > 128) throw new Error('RULE_SCAN_LIMIT_EXCEEDED');
    const v = job.value;
    if (job.exit) {
      active.delete(v as object);
      continue;
    }
    if (
      v === null ||
      ['string', 'boolean'].includes(typeof v) ||
      (typeof v === 'number' && Number.isFinite(v))
    ) {
      Object.defineProperty(job.parent, job.key, { value: v, enumerable: true });
      continue;
    }
    if (
      !v ||
      typeof v !== 'object' ||
      active.has(v) ||
      (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
    )
      throw new Error('RULE_SCAN_INVALID_DATA');
    active.add(v);
    jobs.push({ ...job, exit: true });
    const out: Data = Array.isArray(v) ? [] : {};
    Object.defineProperty(job.parent, job.key, { value: out, enumerable: true });
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v) && keys.length !== v.length + 1) throw new Error('RULE_SCAN_INVALID_DATA');
    for (const key of keys) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (
        typeof key !== 'string' ||
        !d.enumerable ||
        !('value' in d) ||
        (Array.isArray(v) && !/^(0|[1-9]\d*)$/.test(key))
      )
        throw new Error('RULE_SCAN_INVALID_DATA');
      jobs.push({ value: d.value, parent: out, key, exit: false, depth: job.depth + 1 });
    }
  }
  return holder.value;
}

/** Recognize protocol prefixes, including bare baked/ignored names. */
export function prefix(node: Data, name: string): boolean {
  return (
    typeof node.name === 'string' &&
    (node.name.trim().startsWith(name + '-') ||
      (['bg', 'img', 'x'].includes(name) && node.name.trim() === name))
  );
}

/** Match loadCache's depth-three container signature without comparing text content. */
export function signature(node: Data, depth = 3): string {
  return (
    node.type +
    (depth > 0 && node.children?.length
      ? '(' + node.children.map((n: Data) => signature(n, depth - 1)).join(',') + ')'
      : '')
  );
}

/** Normalize complete cache envelopes and preserve ancestor exclusions before selecting scope. */
export function designFacts(
  cache: unknown,
  rootNodeId: string,
): { all: Fact[]; scoped: Fact[]; root: Fact } {
  try {
    const data = copyData(cache);
    const roots: Data[] = [];
    const envelopes = [data];
    while (envelopes.length) {
      const item = envelopes.pop();
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        (Object.hasOwn(item, '_depth') && item._depth !== null) ||
        item.truncated === true
      )
        throw new Error();
      if (typeof item.id === 'string') roots.push(item);
      else if (item.node) envelopes.push(item.node);
      else if (item.document) envelopes.push(item.document);
      else if (item.nodes && typeof item.nodes === 'object' && !Array.isArray(item.nodes))
        envelopes.push(...Object.values(item.nodes));
      else throw new Error();
    }
    if (!roots.length) throw new Error();
    const all: Fact[] = [];
    const ids = new Set<string>();
    const queue: { node: Data; parent?: Fact; duplicate: boolean }[] = roots.map((node) => ({
      node,
      duplicate: false,
    }));
    for (let i = 0; i < queue.length; i++) {
      const { node, parent, duplicate } = queue[i];
      if (
        !node ||
        typeof node !== 'object' ||
        Array.isArray(node) ||
        typeof node.id !== 'string' ||
        !node.id ||
        ids.has(node.id) ||
        typeof node.type !== 'string' ||
        !node.type ||
        (Object.hasOwn(node, '_depth') && node._depth !== null) ||
        node.truncated === true ||
        (Object.hasOwn(node, 'children') && !Array.isArray(node.children))
      )
        throw new Error();
      ids.add(node.id);
      if (ids.size > 20_000) throw new Error('RULE_SCAN_LIMIT_EXCEEDED');
      const fact: Fact = {
        node,
        parent,
        children: [],
        hidden: !!parent?.hidden || node.visible === false,
        duplicate: !!parent?.duplicate || duplicate,
        bakedBy:
          parent?.bakedBy ??
          (parent && ['bg', 'img', 'x'].some((p) => prefix(parent.node, p))
            ? parent.node.id
            : null),
      };
      parent?.children.push(fact);
      all.push(fact);
      const seen = new Set<string>();
      for (const [index, child] of (node.children ?? []).entries()) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error();
        const sig = signature(child);
        const dup = prefix(node, 'list') ? index > 0 : !!child.children?.length && seen.has(sig);
        if (child.children?.length) seen.add(sig);
        queue.push({ node: child, parent: fact, duplicate: dup });
      }
    }
    const root = all.find((f) => f.node.id === rootNodeId);
    if (!root) throw new Error('RULE_SCAN_ROOT_NOT_FOUND');
    const scoped = [root];
    for (let i = 0; i < scoped.length; i++) scoped.push(...scoped[i].children);
    for (const f of all) {
      if (f.hidden || f.bakedBy || f.duplicate || ['bg', 'img', 'x'].some((p) => prefix(f.node, p)))
        continue;
      if (['GROUP', 'BOOLEAN_OPERATION'].includes(f.node.type) && !f.children.length)
        throw new Error('RULE_SCAN_CACHE_INCOMPLETE');
    }
    return { all, scoped, root };
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'RULE_SCAN_ROOT_NOT_FOUND',
        'RULE_SCAN_CACHE_INCOMPLETE',
        'RULE_SCAN_LIMIT_EXCEEDED',
      ].includes(error.message)
    )
      throw error;
    throw new Error('RULE_SCAN_INVALID_CACHE');
  }
}

/** Traverse descendants without following wrappers or flattening out-of-scope siblings. */
export function subtree(fact: Fact): Fact[] {
  const result = [fact];
  for (let i = 0; i < result.length; i++) result.push(...result[i].children);
  return result;
}

/** Return visible paint layers in Figma order (last = topmost). */
export function paints(node: Data): Data[] {
  return Array.isArray(node.fills)
    ? node.fills.filter((f: any) => f && typeof f === 'object' && f.visible !== false)
    : [];
}

/** Whether a fact remains independently actionable under inherited exclusions. */
export function actionable(fact: Fact): boolean {
  return !fact.hidden && !fact.bakedBy && !fact.duplicate && !prefix(fact.node, 'x');
}
