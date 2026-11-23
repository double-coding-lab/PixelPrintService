import assert from 'node:assert/strict';
import test from 'node:test';

const modulePath = '../pixelprint/templates/skills/pp-d2c/bin/lib/cssMatch.mjs';

test('规则读取不把短类名与连字符后缀类名混淆，保留真实伪类与组合选择器', async () => {
  const { collectRuleBodies, findProperty } = await import(modulePath);
  const css = '.card-title {height:999px} .card {height:40px} .card:hover {color:red}';
  const bodies = collectRuleBodies(css, 'card');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].body, 'height:40px');
  assert.equal(findProperty([{ content: css, rel: 'index.scss' }], ['card'], /999px/).hit, false);
  assert.equal(collectRuleBodies('.parent > .card {width:20px}', 'card').length, 1);
});

test('SCSS后缀精确匹配，不能借用另一个后缀的声明', async () => {
  const { collectRuleBodies } = await import(modulePath);
  const css = '.page { &__title-extra {height:999px} &__title {height:40px} }';
  const bodies = collectRuleBodies(css, 'page__title');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].body, 'height:40px');
});
