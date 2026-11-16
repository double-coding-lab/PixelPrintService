import { createHash } from 'node:crypto';
import { RULE_SOURCE_SHA256 } from './compatibility';
import { adapter, gradient, hex } from './adapters';
import {
  actionable,
  copyData,
  designFacts,
  paints,
  prefix,
  signature,
  subtree,
  type Data,
  type Fact,
} from './facts';

/** Shared scanner/protocol revision for tool context and reproducible fingerprints. */
export const nativeRuleScanRevision = 'native-rules-v1';

export type NativeRuleScanResult = {
  report: {
    block: string;
    cache_key: string;
    generated_at: string;
    generated_by: string;
    hits: Array<{
      rule: string;
      nodeId: string;
      trigger: string;
      expected: string;
      context: Record<string, unknown>;
    }>;
    [key: string]: unknown;
  };
  pending: Array<{ rule: string; nodeIds: string[]; reason: string }>;
  deterministicRules: string[];
  unsupportedRules: string[];
  fingerprint: string;
};

/** Serialize object keys canonically while preserving semantically significant array order. */
function stable(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
      .join(',') +
    '}'
  );
}

/** Hash data only, with no file, shell, network or dynamic execution capability. */
function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Retain paint facts only; never repeat SVG paths or arbitrary plugin payloads in reports. */
function compactPaints(value: unknown): Data[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => p && typeof p === 'object')
    .map((p) =>
      Object.fromEntries(
        [
          'type',
          'visible',
          'opacity',
          'blendMode',
          'color',
          'imageRef',
          'scaleMode',
          'gradientStops',
          'gradientHandlePositions',
          'gradientTransform',
          'imageTransform',
        ]
          .filter((key) => Object.hasOwn(p, key))
          .map((key) => [key, p[key]]),
      ),
    );
}

/** Scan verified design triggers, never claim generated code passed or violated a rule. */
export function scanDesignRules(input: {
  cache: unknown;
  rootNodeId: string;
  target: string;
  config: Record<string, unknown>;
  ruleSources: Record<string, string>;
  block: string;
  cacheKey: string;
  generatedAt: string;
}): NativeRuleScanResult {
  if (input.target !== 'h5' && input.target !== 'rn')
    throw new Error('RULE_SCAN_UNSUPPORTED_TARGET');
  if (
    ![input.rootNodeId, input.block, input.cacheKey, input.generatedAt].every(
      (v) => typeof v === 'string' && v.length > 0,
    )
  )
    throw new Error('RULE_SCAN_INVALID_INPUT');
  const target = input.target;
  const config = copyData(input.config) as Data;
  const sources = copyData(input.ruleSources) as Record<string, string>;
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== 'object' ||
    !sources ||
    Array.isArray(sources) ||
    typeof sources !== 'object' ||
    Object.values(sources).some((s) => typeof s !== 'string')
  )
    throw new Error('RULE_SCAN_INVALID_INPUT');
  const { scoped, root } = designFacts(input.cache, input.rootNodeId);
  const policy = adapter(target);
  const unit = config.unit ?? {};
  const scale = unit.scale ?? (target === 'h5' ? 2 : null);
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)
    throw new Error('RULE_SCAN_INVALID_CONFIG');
  const pending: NativeRuleScanResult['pending'] = [];
  const hits: NativeRuleScanResult['report']['hits'] = [];
  const constraints: Data[] = [];
  const deferredChecks: Data[] = [];
  const unsupported = new Set<string>();
  const supported = new Map<string, string>();
  const frozen = RULE_SOURCE_SHA256[target];
  const readmeOK =
    typeof sources['README.md'] === 'string' && sha(sources['README.md']) === frozen['README.md'];
  /** A review task always names actual scoped nodes, so reconciliation cannot accept unrelated hits. */
  function defer(rule: string, nodeIds: string[], reason: string) {
    pending.push({ rule, nodeIds: [...new Set(nodeIds)].sort(), reason });
  }
  for (const name of [...new Set([...Object.keys(frozen), ...Object.keys(sources)])].sort()) {
    if (name === 'README.md' && readmeOK) continue;
    const rule = name.match(/^(RN\d+|R\d+)(?:-|\.)/)?.[1] ?? name;
    if (
      readmeOK &&
      frozen[name] &&
      typeof sources[name] === 'string' &&
      sha(sources[name]) === frozen[name] &&
      !supported.has(rule)
    ) {
      supported.set(rule, name);
    } else {
      unsupported.add(rule);
      defer(
        rule,
        [input.rootNodeId],
        !readmeOK
          ? 'Rule protocol README changed or missing; model must review.'
          : 'New, changed or missing rule source; model must review.',
      );
    }
  }
  // Duplicate IDs, additions and protocol changes cannot silently reuse an old implementation.
  for (const rule of unsupported) supported.delete(rule);
  const active = scoped.filter(actionable);
  /** Include all original node facts and explicit derived parameters for UI consumers. */
  function context(f: Fact): Data {
    const attributes = Object.fromEntries(
      [
        'id',
        'name',
        'type',
        'layoutMode',
        'layoutPositioning',
        'primaryAxisAlignItems',
        'counterAxisAlignItems',
        'layoutGrow',
        'layoutSizingHorizontal',
        'layoutSizingVertical',
        'itemSpacing',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'cornerRadius',
        'opacity',
        'isMask',
        'booleanOperation',
      ]
        .filter((key) => Object.hasOwn(f.node, key))
        .map((key) => [key, f.node[key]]),
    );
    const fills = paints(f.node);
    const last = fills.at(-1);
    return {
      ...attributes,
      parent_nodeId: f.parent?.node.id ?? null,
      child_nodeIds: f.children.map((c) => c.node.id),
      fills: compactPaints(f.node.fills),
      fills_last_type: last?.type ?? null,
      fills_last_stops: last?.gradientStops ?? [],
      fills_last_handles: last?.gradientHandlePositions ?? [],
      fills_layers: compactPaints(fills),
      color_hex: last ? hex(last.color) : '#000000',
      first_stop_hex: hex(last?.gradientStops?.[0]?.color),
      scale,
      constraints: f.node.constraints ?? {},
      bbox: f.node.absoluteBoundingBox ?? null,
      parent_bbox: f.parent?.node.absoluteBoundingBox ?? null,
      layout_expected: policy.layout(f.node),
    };
  }
  /** A hit is a design-trigger instruction, not evidence of a generated-code violation. */
  function hit(rule: string, f: Fact, trigger: string, extra: Data = {}) {
    const name = supported.get(rule);
    if (!name) return;
    hits.push({
      rule,
      nodeId: f.node.id,
      trigger,
      expected: policy.expected(rule),
      context: { ...context(f), ...extra, rule_source: name },
    });
  }
  /** Keep post-generation checks separate: implementation choices are unknown at scan time. */
  function constraint(rule: string, nodeIds: string[], reason: string, expected?: string) {
    const name = supported.get(rule);
    if (!name) return;
    const entry = {
      rule,
      nodeIds: [...new Set(nodeIds)].sort(),
      reason,
      rule_source: name,
      expected: expected ?? policy.expected(rule),
    };
    constraints.push(entry);
    deferredChecks.push({ ...entry, requires: 'generated_artifacts', status: 'deferred' });
  }
  const fixed = active.filter((f) => prefix(f.node, 'fixed'));
  const imageRulesKnown = supported.has('R02') && supported.has('R03');
  const implicit = new Set(active.filter((f) => policy.implicitImage(f)).map((f) => f.node.id));
  for (const f of active) {
    const n = f.node;
    const fills = paints(n);
    const last = fills.at(-1);
    const descendants = subtree(f).filter((c) => !c.hidden);
    const bg = prefix(n, 'bg');
    const bgc = prefix(n, 'bgc');
    const image = prefix(n, 'img');
    const fixedNode = prefix(n, 'fixed');
    const auto = ['HORIZONTAL', 'VERTICAL'].includes(n.layoutMode);
    const parentInScope = f !== root && f.parent;
    const baselineChild = parentInScope && prefix(f.parent!.node, 'bl');
    if (fixedNode)
      hit('R01', f, 'fixed- prefix', {
        placement:
          target === 'rn'
            ? 'root View direct child; absolute; zIndex >= 100'
            : 'position: fixed; viewport constraints',
      });
    if (fills.some((p) => p.type === 'IMAGE')) hit('R02', f, 'visible IMAGE fill');
    if (implicit.has(n.id)) hit('R03', f, 'unprefixed pure geometry subtree');
    if (n.type === 'TEXT' && last && (gradient(last) || last.type === 'IMAGE'))
      hit('R04', f, 'TEXT last visible fill is gradient/IMAGE');
    if (n.primaryAxisAlignItems === 'SPACE_BETWEEN')
      hit('R05', f, 'primaryAxisAlignItems === SPACE_BETWEEN');
    if (
      n.type === 'TEXT' &&
      Array.isArray(n.fills) &&
      n.fills.length &&
      (!last || last.type === 'SOLID')
    ) {
      if (last && hex(last.color) === null && supported.has('R06'))
        defer('R06', [n.id], 'SOLID color channels missing; cannot derive color.');
      else
        hit(
          'R06',
          f,
          last ? 'TEXT last visible fill is SOLID' : 'TEXT fills all invisible; default black',
        );
    }
    if (
      fills.length >= 2 &&
      !fills.every((p) => p.type === 'SOLID') &&
      !(n.type === 'TEXT' && (gradient(last) || last?.type === 'IMAGE'))
    )
      hit('R07', f, 'multiple visible non-SOLID-only fills', {
        css_background_layers: compactPaints([...fills].reverse()),
      });
    if (bg) hit('R08', f, 'bg prefix or bare bg');
    if (prefix(n, 'btn')) {
      for (const b of descendants
        .slice(1)
        .filter((c) => actionable(c) && prefix(c.node, 'bgc') && policy.buttonGradient(c.node))) {
        hit('R09', f, `btn subtree contains gradient bgc ${b.node.id}`, {
          btn_nodeId: n.id,
          bgc_nodeId: b.node.id,
          bgc_fills: compactPaints(b.node.fills),
          bgc_last_fill: compactPaints(paints(b.node)).at(-1),
          bgc_first_stop_hex: hex(paints(b.node).at(-1)?.gradientStops?.[0]?.color),
        });
      }
      if (n.absoluteBoundingBox?.width > 0 && n.absoluteBoundingBox?.height > 0)
        constraint(
          'R22',
          [n.id],
          'After generation inspect actual button visuals; warning only, never infer invisible output from cache.',
        );
    }
    const geometryCandidates = descendants.filter(
      (c) => actionable(c) && !prefix(c.node, 'bg') && !prefix(c.node, 'img'),
    );
    const complex =
      geometryCandidates.some(
        (c) =>
          c.node.type === 'BOOLEAN_OPERATION' ||
          (c.node.isMask === true &&
            (c.children.length > 0 || (c.parent?.children.length ?? 0) > 1)) ||
          (c.node.type === 'VECTOR' && (c.node.vectorPaths?.length || c.node.fillGeometry?.length)),
      ) || geometryCandidates.filter((c) => c.node.type === 'VECTOR').length >= 2;
    if (
      supported.has('R11') &&
      complex &&
      !bg &&
      !image &&
      !(supported.has('R02') && fills.some((p) => p.type === 'IMAGE')) &&
      !(supported.has('R03') && implicit.has(n.id))
    )
      defer(
        'R11',
        [n.id],
        imageRulesKnown
          ? 'Composite geometry requires semantic judgment of CSS/RN expressibility and safe slicing.'
          : 'Image rule dependencies changed; model must decide geometry ownership.',
      );
    if (fixed.length >= 2 && fixedNode)
      hit('R14', f, 'multiple fixed- nodes', { fixed_nodeIds: fixed.map((c) => c.node.id) });
    if (prefix(n, 'list') && f.children.length >= 2)
      hit('R15', f, 'explicit list- declaration', {
        representative_nodeId: f.children[0].node.id,
        item_nodeIds: f.children.map((c) => c.node.id),
      });
    else if (!prefix(n, 'list') && !bg && !image && !implicit.has(n.id) && supported.has('R15')) {
      const groups = new Map<string, Fact[]>();
      for (const c of f.children.filter((c) => !c.hidden && !c.bakedBy)) {
        const namePrefix =
          typeof c.node.name === 'string' ? c.node.name.replace(/[-_ ](?:\d.*|[a-z])$/i, '') : '';
        if (!namePrefix) continue;
        const key = namePrefix + ':' + signature(c.node);
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      for (const group of groups.values())
        if (group.length >= 3)
          defer(
            'R15',
            group.map((c) => c.node.id),
            'Unlabelled structurally similar siblings require semantic list judgment.',
          );
    }
    if (
      ['GROUP', 'FRAME', 'INSTANCE', 'COMPONENT'].includes(n.type) &&
      !bg &&
      !image &&
      descendants.slice(1).some((c) => c.node.type === 'TEXT')
    )
      hit('R16', f, 'non-image container contains TEXT; do not flatten');
    if (auto) {
      hit('R18', f, 'AutoLayout direction', { direction: policy.layout(n) });
      hit('R19', f, 'AutoLayout padding (including zero)', {
        padding_expected: Object.fromEntries(
          ['Top', 'Right', 'Bottom', 'Left'].map((edge) => [
            edge.toLowerCase(),
            (n['padding' + edge] ?? 0) * scale,
          ]),
        ),
        tolerance: 2,
      });
    }
    if (
      n.layoutPositioning === 'ABSOLUTE' &&
      !fixedNode &&
      !baselineChild &&
      parentInScope &&
      !bgc
    ) {
      const b = n.absoluteBoundingBox;
      const p = f.parent!.node.absoluteBoundingBox;
      if (b && p && ['x', 'y'].every((k) => typeof b[k] === 'number' && typeof p[k] === 'number'))
        hit('R20', f, 'ABSOLUTE child with parent bbox', {
          top: (b.y - p.y) * scale,
          left: (b.x - p.x) * scale,
          tolerance: 4,
        });
      else if (supported.has('R20'))
        defer('R20', [n.id], 'Missing parent/child bbox prevents deterministic offsets.');
    }
    if (
      (target === 'rn' || !bg) &&
      !bgc &&
      (n.type === 'TEXT' ||
        auto ||
        n.layoutPositioning === 'ABSOLUTE' ||
        ['img', 'btn', 'input'].some((p) => prefix(n, p)))
    )
      hit('R21', f, 'independently rendered node must carry data-node-id');
    if (n.absoluteBoundingBox && !bgc)
      constraint(
        'R23',
        [n.id],
        target === 'rn'
          ? 'Compare explicit generated width/height to bbox × scale, tolerance 4; RN is always border-box including padding; forbid 1×1 hidden anchors.'
          : 'Compare explicit generated width/height to bbox × scale, tolerance 4; skip H5 padding without border-box; forbid 1×1 hidden anchors.',
      );
    if (prefix(n, 'bl'))
      hit('R24', f, 'bl- baseline declaration', {
        exempt_position_nodeIds: f.children.map((c) => c.node.id),
      });
    if (target === 'rn') {
      if (bg)
        hit(
          'RN03',
          f,
          'background Image dimensions must be numeric, not percentage or absoluteFillObject',
        );
      if (
        parentInScope &&
        ['HORIZONTAL', 'VERTICAL'].includes(f.parent!.node.layoutMode) &&
        n.layoutPositioning !== 'ABSOLUTE' &&
        !fixedNode &&
        !bg &&
        !bgc &&
        !baselineChild
      )
        hit('RN02', f, 'AutoLayout flow child; position/margins require no coordinate inference', {
          flex_one_allowed:
            n.layoutGrow === 1 ||
            n.layoutSizingHorizontal === 'FILL' ||
            n.layoutSizingVertical === 'FILL',
        });
    }
  }
  const banned = scoped.filter((f) => f.bakedBy && !f.hidden && !f.duplicate).map((f) => f.node.id);
  if (banned.length)
    constraint('R17', banned, 'Baked/ignored descendants must not render independently.');
  constraint(
    'R10',
    active.map((f) => f.node.id),
    'After generation trace actual solid colors to fills; exclude R06/R07/R09-owned colors and system defaults. Unknown implementation is not a violation.',
  );
  if (config.merge?.mode === 'flat')
    constraint(
      'R12',
      [root.node.id],
      'After generation inspect cross-block naming collisions; isolated CSS Modules are exempt.',
    );
  if (scale !== 1 || (target === 'rn' && unit.responsive?.enabled === true))
    constraint(
      'R13',
      [root.node.id],
      'After generation compare dimension values × scale and RN responsive wrapping; do not wrap zIndex/flex/opacity/fontWeight.',
    );
  constraint(
    'R21',
    [root.node.id],
    'After generation reject literal data-node-id absent from full cache; virtual wrappers need no invented Figma id.',
  );
  if (target === 'rn') {
    const blockScope = /(?:^|\/)blocks\/[^/]+(?:\/|$)/.test(input.block.replaceAll('\\', '/'));
    const skeletonExpectation = blockScope
      ? '区块禁止套页面骨架（ScrollView + scrollContent）；scrollx-/scrolly- 的普通滚动容器允许。'
      : '页面使用 View > ScrollView > View(scrollContent)；内容用 minHeight，根和内容禁止 overflow:hidden。';
    constraint(
      'RN01',
      [root.node.id],
      blockScope
        ? 'Block scope: forbid duplicate page skeleton; ordinary named scroll containers remain allowed.'
        : 'Page scope: require root scrolling skeleton, minHeight and no clipping.',
      skeletonExpectation,
    );
    constraint(
      'RN04',
      [root.node.id],
      'Keep styles in independent styles files; forbid StyleSheet.create/static inline objects in JSX.',
    );
  }
  /** Canonical ordering does not depend on source map property insertion order. */
  const compare = (a: unknown, b: unknown) =>
    stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0;
  hits.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule, 'en') || a.nodeId.localeCompare(b.nodeId, 'en') || compare(a, b),
  );
  pending.sort((a, b) => a.rule.localeCompare(b.rule, 'en') || compare(a, b));
  constraints.sort(compare);
  deferredChecks.sort(compare);
  const deterministicRules = [...supported.keys()].sort();
  const unsupportedRules = [...unsupported].sort();
  const report: NativeRuleScanResult['report'] = {
    block: input.block,
    cache_key: input.cacheKey,
    generated_at: input.generatedAt,
    generated_by: 'native-rule-scan',
    hits,
    constraints,
    deferredChecks,
    context: {
      target,
      rootNodeId: input.rootNodeId,
      config: { unit: config.unit ?? {}, merge: config.merge ?? {}, adapter: config.adapter ?? {} },
      scope_nodeIds: scoped.map((f) => f.node.id).sort(),
      scan_kind: 'design_triggers',
      artifact_validation: 'deferred',
      exclusions: scoped
        .filter((f) => !actionable(f))
        .map((f) => ({
          nodeId: f.node.id,
          hidden: f.hidden,
          bakedBy: f.bakedBy,
          templateDup: f.duplicate,
          ignored: prefix(f.node, 'x'),
        }))
        .sort(compare),
    },
  };
  const fingerprint = sha(
    stable({
      revision: nativeRuleScanRevision,
      target,
      rootNodeId: input.rootNodeId,
      block: input.block,
      cacheKey: input.cacheKey,
      config,
      ruleSources: sources,
      design: root.node,
      facts: scoped.map((f) => ({
        ...context(f),
        hidden: f.hidden,
        bakedBy: f.bakedBy,
        duplicate: f.duplicate,
      })),
      hits,
      pending,
      constraints,
      deferredChecks,
      deterministicRules,
      unsupportedRules,
    }),
  );
  return { report, pending, deterministicRules, unsupportedRules, fingerprint };
}
