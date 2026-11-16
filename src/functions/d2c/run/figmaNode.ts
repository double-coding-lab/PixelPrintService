type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export interface FigmaNodeInspection {
  rootNodeId: string;
  nodeId: string;
  depth: number;
  truncated: boolean;
  nodes: { attributes: JsonObject; childIds: string[] }[];
}

/** Clone JSON-only data without invoking accessors, coercions or toJSON hooks. */
function cloneJson(value: unknown): JsonValue {
  const holder: JsonObject = {};
  const active = new Set<object>();
  const pending: {
    value: unknown;
    parent: JsonObject | JsonValue[];
    key: string;
    exit?: object;
  }[] = [{ value, parent: holder, key: 'value' }];
  while (pending.length) {
    const job = pending.pop()!;
    if (job.exit) {
      active.delete(job.exit);
      continue;
    }
    const current = job.value;
    let copy: JsonValue;
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      copy = current;
    } else {
      if (
        typeof current !== 'object' ||
        active.has(current) ||
        (!Array.isArray(current) &&
          Object.getPrototypeOf(current) !== Object.prototype &&
          Object.getPrototypeOf(current) !== null)
      ) {
        throw new Error('Invalid Figma cache');
      }
      const array = Array.isArray(current);
      const keys = Reflect.ownKeys(current);
      if (array && keys.length !== current.length + 1) {
        throw new Error('Invalid Figma cache');
      }
      copy = array ? [] : {};
      active.add(current);
      pending.push({ ...job, exit: current });
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (
          typeof key !== 'string' ||
          !descriptor.enumerable ||
          !('value' in descriptor) ||
          (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length))
        ) {
          throw new Error('Invalid Figma cache');
        }
        pending.push({ value: descriptor.value, parent: copy, key });
      }
    }
    Object.defineProperty(job.parent, job.key, {
      value: copy,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return holder.value;
}

/** Return an object only for JSON records, excluding arrays and null. */
function isRecord(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Inspect a complete fixed-script Figma cache without changing or sharing its data.
 * Returns the selected node and up to depth (0..2) descendant levels in breadth-first order.
 * Accepts simple or compound instance IDs of at most 200 characters.
 * Boundary child IDs remain complete; truncated indicates omitted descendants.
 * Missing nodes return undefined. Invalid parameters or cache data throw fixed safe errors.
 */
export function inspectFigmaNode(
  cache: unknown,
  nodeId: string,
  depth = 1,
): FigmaNodeInspection | undefined {
  if (
    typeof nodeId !== 'string' ||
    nodeId.length > 200 ||
    !/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(nodeId) ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > 2
  ) {
    throw new Error('Invalid Figma node parameters');
  }
  return inspectTree(cache, nodeId, depth);
}

/** 从完整根缓存分页读取指定区块的全部后代；节点属性和顺序与定点查询一致。 */
export function inspectFigmaSubtree(cache: unknown, nodeId: string, offset = 0, limit = 40) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Invalid Figma node parameters');
  /** 复用原入口的节点编号校验；树遍历在下方仅执行一次。 */
  if (
    typeof nodeId !== 'string' ||
    nodeId.length > 200 ||
    !/^I?\d+:\d+(?:;I?\d+:\d+)*$/.test(nodeId)
  )
    throw new Error('Invalid Figma node parameters');
  const view = inspectTree(cache, nodeId, Infinity);
  if (!view) return;
  const totalNodes = view.nodes.length;
  return {
    ...view,
    depth: null,
    subtree: true,
    totalNodes,
    offset,
    nodes: view.nodes.slice(offset, offset + limit),
    nextOffset: offset + limit < totalNodes ? offset + limit : null,
  };
}

/** 校验完整缓存并按广度优先返回节点，深度和分页不改变原缓存内容。 */
function inspectTree(
  cache: unknown,
  nodeId: string,
  depth: number,
): FigmaNodeInspection | undefined {
  try {
    const data = cloneJson(cache);
    if (
      !isRecord(data) ||
      (Object.hasOwn(data, '_depth') && data._depth !== null) ||
      !isRecord(data.node)
    ) {
      throw new Error('Invalid Figma cache');
    }
    const root = data.node;
    const pending = [root];
    const ids = new Set<string>();
    let target: JsonObject | undefined;
    while (pending.length) {
      const node = pending.pop()!;
      if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) {
        throw new Error('Invalid Figma cache');
      }
      ids.add(node.id);
      if (node.id === nodeId) target = node;
      if (Object.hasOwn(node, 'children')) {
        if (!Array.isArray(node.children) || !node.children.every(isRecord)) {
          throw new Error('Invalid Figma cache');
        }
        for (const child of node.children) pending.push(child);
      }
    }
    if (!target) return undefined;
    const result: FigmaNodeInspection = {
      rootNodeId: root.id as string,
      nodeId,
      depth,
      truncated: false,
      nodes: [],
    };
    const queue = [{ node: target, level: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const { node, level } = queue[index];
      const { children: rawChildren, ...attributes } = node;
      const children = (rawChildren ?? []) as JsonObject[];
      result.nodes.push({ attributes, childIds: children.map((child) => child.id as string) });
      if (level === depth) {
        if (children.length) result.truncated = true;
      } else {
        for (const child of children) queue.push({ node: child, level: level + 1 });
      }
    }
    return result;
  } catch {
    throw new Error('Invalid Figma cache');
  }
}
