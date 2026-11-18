import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactFigmaCacheForStorage,
  compactFigmaNodeForModel,
  inspectFigmaNode,
  inspectFigmaSubtree,
} from '../src/functions/d2c/run/figmaNode';
import { estimateTokens } from '../src/functions/d2c/run/agent/tokens';

/** Build a representative fixed-script cache with layout, text, paint and instance fields. */
function fixture() {
  return {
    _depth: null,
    node: {
      id: '92:823',
      type: 'FRAME',
      name: '详情页',
      layoutMode: 'VERTICAL',
      itemSpacing: 16,
      absoluteBoundingBox: { x: 10, y: 20, width: 375, height: 812 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 1 } }],
      pluginData: { custom: ['保留', null, false, 0] },
      children: [
        {
          id: '92:824',
          type: 'FRAME',
          layoutAlign: 'STRETCH',
          children: [
            {
              id: '92:826',
              type: 'TEXT',
              characters: '标题',
              style: { fontFamily: 'PingFang SC', fontWeight: 600, fontSize: 20 },
              characterStyleOverrides: [0, 1],
              styleOverrideTable: { '1': { fontSize: 24 } },
              children: [{ id: 'I92:827;12:34', type: 'VECTOR', visible: false }],
            },
          ],
        },
        { id: '92:825', type: 'RECTANGLE', cornerRadius: 8, children: [] },
      ],
    },
  };
}

test('默认深度按层级和原顺序返回，完整保留字体/布局/颜色/自定义字段', () => {
  const cache = fixture();
  const view = inspectFigmaNode(cache, '92:823')!;
  assert.deepEqual(view, {
    rootNodeId: '92:823',
    nodeId: '92:823',
    depth: 1,
    truncated: true,
    nodes: [
      {
        attributes: Object.fromEntries(
          Object.entries(cache.node).filter(([key]) => key !== 'children'),
        ),
        childIds: ['92:824', '92:825'],
      },
      { attributes: { id: '92:824', type: 'FRAME', layoutAlign: 'STRETCH' }, childIds: ['92:826'] },
      { attributes: { id: '92:825', type: 'RECTANGLE', cornerRadius: 8 }, childIds: [] },
    ],
  });
  const text = inspectFigmaNode(cache, '92:826', 0)!;
  const { children, ...attributes } = cache.node.children[0].children![0];
  assert.deepEqual(text.nodes, [{ attributes, childIds: ['I92:827;12:34'] }]);
  assert.equal(text.truncated, true);
});

test('0/1/2 深度边界保留实际 childIds，仅有省略后代时 truncated', () => {
  const cache = fixture();
  for (const [depth, ids] of [
    [0, ['92:823']],
    [1, ['92:823', '92:824', '92:825']],
    [2, ['92:823', '92:824', '92:825', '92:826']],
  ] as const) {
    const view = inspectFigmaNode(cache, '92:823', depth)!;
    assert.deepEqual(
      view.nodes.map((node) => node.attributes.id),
      ids,
    );
    assert.equal(view.truncated, true);
    assert.ok(view.nodes.every((node) => !Object.hasOwn(node.attributes, 'children')));
  }
  const subtree = inspectFigmaNode(cache, '92:824', 2)!;
  assert.deepEqual(
    subtree.nodes.map((node) => node.attributes.id),
    ['92:824', '92:826', 'I92:827;12:34'],
  );
  assert.equal(subtree.rootNodeId, '92:823');
  assert.equal(subtree.truncated, false);
  assert.equal(inspectFigmaNode(cache, '92:825', 0)!.truncated, false);
  assert.equal(inspectFigmaNode(cache, '99:999'), undefined);
  assert.deepEqual(
    inspectFigmaNode({ node: cache.node }, '92:823'),
    inspectFigmaNode(cache, '92:823'),
  );
});

test('返回的 compound childId 可直接查询，支持各段可选 I 前缀和 200 字符边界', () => {
  const cache = fixture();
  const childId = inspectFigmaNode(cache, '92:826', 0)!.nodes[0].childIds[0];
  assert.equal(childId, 'I92:827;12:34');
  assert.deepEqual(inspectFigmaNode(cache, childId), {
    rootNodeId: '92:823',
    nodeId: childId,
    depth: 1,
    truncated: false,
    nodes: [{ attributes: { id: childId, type: 'VECTOR', visible: false }, childIds: [] }],
  });
  for (const nodeId of [
    'I1:2',
    '1:2;3:4',
    '1:2;I3:4',
    'I1:2;I3:4;5:6',
    `I${'1'.repeat(193)}:2;3:4`,
  ]) {
    assert.ok(nodeId.length <= 200);
    assert.equal(inspectFigmaNode({ node: { id: nodeId } }, nodeId)!.nodeId, nodeId);
  }
  const longestId = `I${'1'.repeat(193)}:2;3:4`;
  assert.equal(longestId.length, 200);
  for (const nodeId of [
    `${longestId}0`,
    'I1:2;',
    ';I1:2',
    'I1:2;;3:4',
    'II1:2',
    'I1:2;i3:4',
    'I1:2;3',
    'I1:2;3:4 ',
  ]) {
    assert.throws(() => inspectFigmaNode(cache, nodeId), {
      message: 'Invalid Figma node parameters',
    });
  }
  assert.equal(inspectFigmaNode(cache, 'I99:999;12:34'), undefined);
});

test('输出和输入双向隔离，保留特殊 own 字段，冻结输入也可读取', () => {
  const cache = fixture();
  const before = JSON.stringify(cache);
  const view = inspectFigmaNode(cache, '92:823')!;
  assert.equal(JSON.stringify(cache), before);
  (view.nodes[0].attributes.absoluteBoundingBox as { x: number }).x = 999;
  view.nodes[0].childIds.push('0:0');
  assert.equal(JSON.stringify(cache), before);
  cache.node.fills[0].color.r = 0;
  assert.equal((view.nodes[0].attributes.fills as { color: { r: number } }[])[0].color.r, 1);
  const special = JSON.parse(
    '{"node":{"id":"1:2","__proto__":{"custom":true},"constructor":"own"}}',
  );
  Object.freeze(special.node.__proto__);
  Object.freeze(special.node);
  Object.freeze(special);
  const attributes = inspectFigmaNode(special, '1:2')!.nodes[0].attributes;
  assert.equal(Object.hasOwn(attributes, '__proto__'), true);
  assert.deepEqual(attributes.__proto__, { custom: true });
  assert.equal(attributes.constructor, 'own');
});

test('无效参数仅返回固定错误，不包含输入原文', () => {
  for (const id of ['', 'secret', '1-2', '1:2:3', ' 1:2', '1:2\n', 12, null]) {
    assert.throws(() => inspectFigmaNode(fixture(), id as string), {
      message: 'Invalid Figma node parameters',
    });
  }
  for (const depth of [-1, 3, 0.5, NaN, Infinity, '1', null]) {
    assert.throws(() => inspectFigmaNode(fixture(), '92:823', depth as number), {
      message: 'Invalid Figma node parameters',
    });
  }
});

test('拒绝部分缓存及任意位置的结构无效、非 JSON 数据，错误不泄露原文', () => {
  const cyclic: Record<string, unknown> = { id: '1:2' };
  cyclic.children = [cyclic];
  const invalid = [
    null,
    [],
    {},
    { node: null },
    { node: [] },
    ...[0, 1, 2, 'null', false, undefined].map((_depth) => ({ _depth, node: { id: '1:2' } })),
    ...[null, {}, 'secret', [null], [{ id: 3 }], [{ id: '' }], [{ id: '1:2' }]].map((children) => ({
      node: { id: '1:2', children },
    })),
    ...[undefined, NaN, Infinity, BigInt(1), () => 'secret', new Date(), Symbol('secret')].map(
      (custom) => ({ node: { id: '1:2', custom } }),
    ),
    { node: cyclic },
    { node: { id: '1:2', custom: new Array(2) } },
    { node: { id: '1:2', children: [{ id: '1:3', children: 'secret' }] } },
  ];
  for (const cache of invalid) {
    for (const id of ['1:2', '99:999']) {
      assert.throws(() => inspectFigmaNode(cache, id), { message: 'Invalid Figma cache' });
    }
  }
  let accessed = false;
  const accessor = {
    node: {
      id: '1:2',
      get secret() {
        accessed = true;
        throw new Error('private payload');
      },
    },
  };
  assert.throws(() => inspectFigmaNode(accessor, '1:2'), { message: 'Invalid Figma cache' });
  assert.equal(accessed, false);
});

test('完整区块子树分页跨越depth边界，逐页覆盖所有真实节点且不重复', () => {
  const cache = fixture();
  const before = JSON.stringify(cache);
  const pages = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: NonNullable<ReturnType<typeof inspectFigmaSubtree>> = inspectFigmaSubtree(
      cache,
      '92:823',
      offset,
      2,
    )!;
    assert.equal(page.totalNodes, 5);
    assert.equal(page.truncated, false);
    assert.equal(page.subtree, true);
    assert.equal(page.depth, null);
    pages.push(...page.nodes);
    offset = page.nextOffset;
  }
  assert.deepEqual(
    pages.map((node) => node.attributes.id),
    ['92:823', '92:824', '92:825', '92:826', 'I92:827;12:34'],
  );
  assert.equal(pages[3].attributes.characters, '标题');
  assert.equal(JSON.stringify(cache), before);
  assert.equal(inspectFigmaSubtree(cache, '99:999'), undefined);
  assert.equal(inspectFigmaSubtree(cache, '92:824')!.totalNodes, 3);
  assert.deepEqual(inspectFigmaSubtree(cache, '92:823', 50)!.nodes, []);
  assert.equal(inspectFigmaSubtree(cache, '92:823', 50)!.nextOffset, null);
});

test('子树分页拒绝部分缓存、非法编号和无界分页参数', () => {
  for (const [offset, limit] of [
    [-1, 40],
    [0.5, 40],
    [0, 0],
    [0, 101],
    [0, Infinity],
  ])
    assert.throws(() => inspectFigmaSubtree(fixture(), '92:823', offset, limit));
  assert.throws(() => inspectFigmaSubtree(fixture(), '../secret'));
  assert.throws(() => inspectFigmaSubtree({ ...fixture(), _depth: 2 }, '92:823'));
});

test('模型视图删除编辑器来源字段及空元数据，保留渲染、有效交互和未知属性', () => {
  const node = {
    ...fixture().node,
    exportSettings: [],
    locked: true,
    overrides: [{ id: '92:824', overriddenFields: ['style'] }],
    interactions: [],
    transitionNodeID: null,
    transitionDuration: 0,
    boundVariables: {},
    unknown: { interactions: [], boundVariables: {}, locked: true, exportSettings: ['custom'] },
    unknownNull: null,
    unknownEmpty: [],
    children: [
      {
        id: '92:824',
        type: 'TEXT',
        characters: '真实文字',
        style: { fontSize: 20 },
        exportSettings: [{ format: 'PNG', constraint: { type: 'SCALE', value: 2 } }],
        interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url: '/' }] }],
        boundVariables: { width: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } },
        explicitVariableModes: {},
        componentPropertyReferences: null,
      },
    ],
  };
  const original = JSON.stringify(node);
  const expected = JSON.parse(original);
  for (const key of [
    'locked',
    'exportSettings',
    'overrides',
    'interactions',
    'transitionNodeID',
    'boundVariables',
  ])
    delete expected[key];
  delete expected.children[0].exportSettings;
  delete expected.children[0].explicitVariableModes;
  delete expected.children[0].componentPropertyReferences;
  const view = compactFigmaNodeForModel(node);
  assert.deepEqual(view, expected);
  assert.equal(JSON.stringify(node), original);
  assert.deepEqual(compactFigmaNodeForModel(view), view);
});

test('模型仅省略指定空渲染字段，非空值、空文字、零值及未知字段完整保留', () => {
  const node = {
    id: '1:2',
    type: 'TEXT',
    characters: '',
    opacity: 0,
    visible: false,
    effects: [],
    strokes: [],
    fills: [],
    characterStyleOverrides: [],
    styleOverrideTable: {},
    unknownEmpty: [],
    style: { effects: [], styleOverrideTable: {} },
    children: [
      {
        id: '1:3',
        effects: [{ type: 'DROP_SHADOW', radius: 8 }],
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        characterStyleOverrides: [0, 1],
        styleOverrideTable: { '1': { fontSize: 20 } },
      },
      { id: '1:4', effects: null, strokes: null, styleOverrideTable: null },
    ],
  };
  const before = JSON.stringify(node);
  const expected = JSON.parse(before);
  for (const key of ['effects', 'strokes', 'characterStyleOverrides', 'styleOverrideTable'])
    delete expected[key];
  const view = compactFigmaNodeForModel(node);
  assert.deepEqual(view, expected);
  assert.deepEqual(compactFigmaNodeForModel(view), view);
  assert.equal(JSON.stringify(node), before);
});

test('背景只在与fills逐项完整一致时省略，缺失/不同背景及图层顺序保留', () => {
  const paints = [
    { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 },
    { type: 'IMAGE', imageRef: '真实引用', scaleMode: 'FILL' },
  ];
  const root = { id: '1:2', fills: paints, background: structuredClone(paints), children: [] };
  assert.deepEqual(compactFigmaNodeForModel(root), {
    id: '1:2',
    fills: paints,
    children: [],
  });
  assert.ok(Object.hasOwn(root, 'background'));
  for (const attributes of [
    { background: paints },
    { fills: null, background: paints },
    { fills: paints, background: [...paints].reverse() },
    { fills: paints, background: [{ ...paints[0], opacity: 1 }, paints[1]] },
    { fills: paints, background: [] },
    { fills: paints, background: null },
  ]) {
    const node = { id: '1:3', ...attributes };
    assert.deepEqual(compactFigmaNodeForModel(node), node);
  }
  assert.deepEqual(compactFigmaNodeForModel({ id: '1:4', fills: [], background: [] }), {
    id: '1:4',
    fills: [],
  });
});

test('紧凑缓存只移除排版，完整保留原属性、字符串内空白及部分缓存深度标记', () => {
  const cache = {
    ...fixture(),
    _depth: 2,
    node: {
      ...fixture().node,
      characters: '  保留 空格\n换行 😀  ',
      locked: true,
      exportSettings: [{ format: 'PNG' }],
      overrides: [{ id: '92:824', overriddenFields: ['characters'] }],
    },
  };
  const original = JSON.stringify(cache, null, 2);
  const compact = compactFigmaCacheForStorage(original);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(original));
  assert.deepEqual(JSON.parse(compact), cache);
  assert.equal(compactFigmaCacheForStorage(compact), compact);
  assert.throws(() => inspectFigmaNode(JSON.parse(compact), '92:823'));
  for (const invalid of ['{ invalid', 'null', '[]', '{"node":null}', '{"other":[]}'])
    assert.equal(compactFigmaCacheForStorage(invalid), invalid);
});

test('没有空元数据的节点语义完整保留，输入输出隔离且拒绝访问器', () => {
  const node = fixture().node;
  const before = JSON.stringify(node);
  const view = compactFigmaNodeForModel(node);
  assert.deepEqual(view, node);
  (view.absoluteBoundingBox as { x: number }).x = 999;
  assert.equal(JSON.stringify(node), before);
  let accessed = false;
  assert.throws(() =>
    compactFigmaNodeForModel({
      id: '1:2',
      get interactions() {
        accessed = true;
        return [];
      },
    }),
  );
  assert.equal(accessed, false);
});

test('真实离线分词确认模型JSON减少Token，全部节点和有效数据保留', (t) => {
  const node = {
    id: '1:2',
    type: 'FRAME',
    children: Array.from({ length: 100 }, (_, index) => ({
      id: `2:${index}`,
      type: 'TEXT',
      characters: `第${index}项标题`,
      style: { fontFamily: 'Arial', fontSize: 16 },
      exportSettings: [],
      interactions: [],
      transitionNodeID: null,
      boundVariables: {},
      explicitVariableModes: {},
      componentPropertyReferences: {},
    })),
  };
  const view = compactFigmaNodeForModel(node);
  const before = estimateTokens(JSON.stringify({ ok: true, data: { node } }));
  const after = estimateTokens(JSON.stringify({ ok: true, data: { node: view } }));
  assert.ok(after < before);
  assert.equal((view.children as unknown[]).length, node.children.length);
  t.diagnostic(`合成100节点工具结果：${before} → ${after} Token（平台估算，非线上账单）`);
});
