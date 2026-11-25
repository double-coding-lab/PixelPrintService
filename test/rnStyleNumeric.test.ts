import assert from 'node:assert/strict';
import test from 'node:test';

const libraryPath = '../pixelprint/templates/skills/pp-d2c-rn/bin/lib/styleMatch.mjs';
const ruleRoot = '../pixelprint/templates/skills/pp-d2c-rn/bin/rules/';
const parser = import(libraryPath);
const sizeRule = import(`${ruleRoot}R23-size-fidelity.mjs`);
const paddingRule = import(`${ruleRoot}R19-padding.mjs`);
const positionRule = import(`${ruleRoot}R20-absolute-position.mjs`);

/** Feed real RN rule modules synthetic styles and geometry, without executing the styles. */
function context(body: string, extra = '', scale = 1, helperName = 'rpx') {
  return {
    cache: {
      nodes: {
        '1:1': {
          id: '1:1',
          name: 'card',
          type: 'FRAME',
          absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 80 },
        },
      },
    },
    product: {
      style: [
        {
          rel: 'styles.ts',
          content: `const styles = StyleSheet.create({card: {${body}}, ${extra}});`,
        },
      ],
    },
    config: { unit: { scale, responsive: { helperName } } },
    classMap: { '1:1': ['card'] },
  };
}

test('R23 is invariant under ordering of dimensions and nested shadowOffset', async () => {
  const { check } = await sizeRule;
  const { collectRuleBodies, getNumeric } = await parser;
  const entries = ['width:100', 'height:80', 'shadowOffset:{width:0,height:2}'];
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const input = context(order.map((index) => entries[index]).join(','));
    const [{ body }] = collectRuleBodies(input.product.style[0].content, 'card');
    assert.deepEqual(getNumeric(body, 'width'), { value: 100, viaRpx: false });
    assert.deepEqual(getNumeric(body, 'height'), { value: 80, viaRpx: false });
    assert.deepEqual(check(input), []);
  }
});

test('nested objects, arrays, calls, functions, comments and strings cannot supply dimensions', async () => {
  const { getNumeric } = await parser;
  const fragments = [
    'shadowOffset:{width:0,height:2}',
    'transform:[{width:0}, [{height:2}]]',
    'metadata: choose({width:0,height:2}, [0, 2])',
    'callback: () => ({width:0,height:2})',
    'callback: function () { const x = {width:0,height:2}; return x; }',
    'callback() { return {width:0,height:2}; }',
    '// width:0, height:2\n',
    '/* width:0, height:2 */',
    'label: "text, width:0, height:2"',
    "label: 'text, width:0, height:2'",
    'label: `text, ${choose({width:0,height:2})}`',
  ];
  for (const fragment of fragments) {
    for (const prop of ['width', 'height']) {
      assert.equal(getNumeric(fragment, prop), null, fragment);
      const value = prop === 'width' ? 100 : 80;
      for (const body of [`${prop}:${value},${fragment}`, `${fragment},${prop}:${value}`]) {
        assert.deepEqual(getNumeric(body, prop), { value, viaRpx: false }, body);
      }
    }
  }
});

test('quoted direct keys, comments and multiline rpx values are read literally', async () => {
  const { getNumeric } = await parser;
  assert.deepEqual(getNumeric(`'width' /* key */ : /* value */ rpx(\n100 /* arg */\n)`, 'width'), {
    value: 100,
    viaRpx: true,
  });
  assert.deepEqual(getNumeric('"height":80 // trailing comment', 'height'), {
    value: 80,
    viaRpx: false,
  });
  assert.equal(getNumeric('minWidth:10, borderWidth:2, metadata:{width:3}', 'width'), null);
  assert.deepEqual(getNumeric('width:1/* token boundary */00', 'width'), { unparseable: true });
});

test('complete dynamic expressions stay unknown instead of exposing numeric prefixes or nested keys', async () => {
  const { getNumeric } = await parser;
  for (const value of [
    'size',
    "'100%'",
    '`100`',
    'Platform.select({ios:100, default:80})',
    'ready ? 100 : 80',
    '100\n + adjustment',
    'rpx(100) + 2',
    'rpx(size)',
    '{width:0,height:2}',
    '[{width:0,height:2}]',
    '() => ({width:0,height:2})',
    'function () { return {width:0,height:2}; }',
  ]) {
    assert.deepEqual(getNumeric(`width:${value},height:80`, 'width'), { unparseable: true }, value);
    assert.deepEqual(getNumeric(`width:${value},height:80`, 'height'), {
      value: 80,
      viaRpx: false,
    });
  }
});

test('last direct declaration wins, including quoted keys, shorthand and dynamic overrides', async () => {
  const { getNumeric } = await parser;
  assert.deepEqual(getNumeric('width:5,"width":100,shadowOffset:{width:0}', 'width'), {
    value: 100,
    viaRpx: false,
  });
  for (const tail of ['width:size', "'width':rpx(size)", 'width', 'width() { return 100; }']) {
    assert.deepEqual(getNumeric(`width:100,${tail}`, 'width'), { unparseable: true }, tail);
  }
  assert.deepEqual(getNumeric('width:size,width:rpx(100)', 'width'), { value: 100, viaRpx: true });
});

test('unknown spreads and computed keys invalidate earlier numeric evidence until explicitly overridden', async () => {
  const { getNumeric } = await parser;
  for (const unknown of ['...dynamicStyle', '[dimension]:100']) {
    assert.deepEqual(getNumeric(`width:100,${unknown}`, 'width'), { unparseable: true });
    assert.deepEqual(getNumeric(`${unknown},width:100`, 'width'), { value: 100, viaRpx: false });
  }
});

test('across style bodies the last declaration wins and later dynamic values remain conservative', async () => {
  const { getNumericAcross } = await parser;
  assert.deepEqual(getNumericAcross(['width:10', 'width:100', 'shadowOffset:{width:0}'], 'width'), {
    value: 100,
    viaRpx: false,
  });
  assert.deepEqual(getNumericAcross(['width:10', 'width:size', 'height:80'], 'width'), {
    unparseable: true,
  });
  assert.deepEqual(getNumericAcross(['width:size', 'width:rpx(100)'], 'width'), {
    value: 100,
    viaRpx: true,
  });
  assert.equal(getNumericAcross(['height:80', 'shadowOffset:{width:0}'], 'width'), null);
});

test('rpx unwraps in Figma comparison units and supports a configured literal helper name', async () => {
  const { getNumeric } = await parser;
  const { check } = await sizeRule;
  assert.deepEqual(getNumeric('top:rpx(-12.5)', 'top'), { value: -12.5, viaRpx: true });
  assert.deepEqual(getNumeric('left:-3.5', 'left'), { value: -3.5, viaRpx: false });
  assert.deepEqual(getNumeric('width:units.rpx(100)', 'width', 'units.rpx'), {
    value: 100,
    viaRpx: true,
  });
  assert.deepEqual(getNumeric('width:unitsXrpx(100)', 'width', 'units.rpx'), { unparseable: true });
  assert.deepEqual(check(context('width:rpx(100),height:rpx(80)')), []);
  assert.deepEqual(check(context('width:dp(200),height:dp(160)', '', 2, 'dp')), []);
});

test('R23 still rejects wrong dimensions and hidden 1x1 anchors even with plausible nested dimensions', async () => {
  const { check } = await sizeRule;
  for (const body of [
    'width:10,height:8,shadowOffset:{width:100,height:80}',
    'shadowOffset:{width:100,height:80},width:10,height:8',
    'width:100,height:80,width:10,height:8',
    '\'width\':10,"height":8',
  ]) {
    const hits = check(context(body));
    assert.equal(hits.length, 1, body);
    assert.equal(hits[0].rule, 'R23');
    assert.match(hits[0].actual, /width=10 应 100/);
    assert.match(hits[0].actual, /height=8 应 80/);
  }
  const [anchor] = check(
    context("width:1,height:1,overflow:'hidden',shadowOffset:{width:100,height:80}"),
  );
  assert.match(anchor.actual, /锚点欺诈/);
});

test('R23 skips final dynamic dimensions and uses the last style key override', async () => {
  const { check } = await sizeRule;
  assert.deepEqual(check(context('width:10,width:size,height:8,height:other')), []);
  const input = context('width:10,height:8', 'override:{width:size,height:other}');
  input.classMap['1:1'].push('override');
  assert.deepEqual(check(input), []);
});

test('R19 padding reads direct properties while retaining real padding violations', async () => {
  const { check } = await paddingRule;
  const input = context('padding:12,metadata:{padding:99}');
  Object.assign(input.cache.nodes['1:1'], {
    layoutMode: 'VERTICAL',
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 12,
  });
  assert.deepEqual(check(input), []);
  input.product.style[0].content = 'StyleSheet.create({card:{padding:99,metadata:{padding:12}}})';
  assert.equal(check(input).length, 1);
});

test('R20 position reads direct coordinates while retaining real offset violations', async () => {
  const { check } = await positionRule;
  const input = context("position:'absolute',top:rpx(20),left:10,metadata:{top:0,left:0}");
  Object.assign(input.cache.nodes, {
    '0:1': {
      name: 'parent',
      type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 160 },
    },
  });
  Object.assign(input.cache.nodes['1:1'], { _parentId: '0:1', layoutPositioning: 'ABSOLUTE' });
  assert.deepEqual(check(input), []);
  input.product.style[0].content =
    "StyleSheet.create({card:{position:'absolute',top:0,left:0,metadata:{top:20,left:10}}})";
  assert.equal(check(input).length, 1);
});
