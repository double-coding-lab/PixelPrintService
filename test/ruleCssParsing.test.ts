import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const modulePath = '../pixelprint/templates/skills/pp-d2c/bin/lib/cssMatch.mjs';
const rulePath = '../pixelprint/templates/skills/pp-d2c/bin/rules/R05-space-between.mjs';
const parser = import(modulePath);

/** 保留选择器行号，同时不把后代/兄弟声明归给父类。 */
test('SCSS 按完整父级展开多层 &，相同 suffix 不串作用域', async () => {
  const { collectRuleBodies } = await parser;
  const css = `.first { &-card { &__title {height:40px} } }
.second { &-card { &__title {height:999px} } }
.first-card__title-extra {height:888px}
.first-card__title .child {height:777px}
.first-card__title + .sibling {height:666px}`;
  assert.deepEqual(collectRuleBodies(css, 'first-card__title'), [{ body: 'height:40px', line: 1 }]);
  assert.deepEqual(collectRuleBodies(css, 'second-card__title'), [
    { body: 'height:999px', line: 2 },
  ]);
  assert.deepEqual(collectRuleBodies(css, 'first-card'), [{ body: '', line: 1 }]);
  assert.deepEqual(collectRuleBodies(css, 'unrelated-card__title'), []);
});

test('父级在嵌套前后的声明完整收集，子级属性不泄漏', async () => {
  const { collectRuleBodies, findProperty, firstRuleBody } = await parser;
  const css = `.card {
  display:flex;
  .child { position:fixed; }
  &-title { height:999px; }
  justify-content:space-between;
  padding: 12px;
}`;
  const style = [{ content: css, rel: 'page.scss' }];
  assert.deepEqual(collectRuleBodies(css, 'card'), [
    { body: 'display:flex;justify-content:space-between;padding: 12px;', line: 1 },
  ]);
  assert.equal(findProperty(style, ['card'], /position\s*:/).hit, false);
  assert.equal(findProperty(style, ['card'], /justify-content:space-between/g).hit, true);
  assert.equal(findProperty(style, ['card'], /justify-content:space-between/g).hit, true);
  assert.equal(firstRuleBody(style, ['missing', 'card'])?.line, 1);
  assert.equal(firstRuleBody(style, ['missing']), null);
});

test('字符串、注释、函数括号、属性值中的大括号与分号不改变规则结构', async () => {
  const { collectRuleBodies } = await parser;
  const css = `/* .ghost {height:999px} */
.card {
 content: "hello } ; { /* not comment */";
 background: url("data:image/svg+xml;utf8,<svg>{}</svg>");
 width: calc(100% - var(--size, 20px));
 // .ghost {height:888px}
 &[data-label="{;}"], &:is(:hover, :focus) { color:red; }
 /* } { ; */
 height:40px;
}
.after {height:50px}`;
  const rules = collectRuleBodies(css, 'card');
  assert.equal(rules.length, 2);
  assert.match(rules[0].body, /hello } ; \{ \/\* not comment \*\//);
  assert.match(rules[0].body, /height:40px/);
  assert.doesNotMatch(rules[0].body, /color:red|888px|999px/);
  assert.deepEqual(rules[1], { body: 'color:red;', line: 7 });
  assert.deepEqual(collectRuleBodies(css, 'ghost'), []);
  assert.deepEqual(collectRuleBodies(css, 'after'), [{ body: 'height:50px', line: 11 }]);
});

test('条件分组规则继承作用域，顶层分组与列表正确展开', async () => {
  const { collectRuleBodies } = await parser;
  const css = `@media (width > 300px) {
 .a, .b {
  color:black;
  @supports (display:grid) { display:grid; &-title {width:20px} }
  color:blue;
 }
}
.a { @container card (width > 300px) { height:30px; .child {height:900px} } }
@layer components { .a:hover {padding:10px} }`;
  assert.deepEqual(collectRuleBodies(css, 'a'), [
    { body: 'color:black;color:blue;', line: 2 },
    { body: 'display:grid;', line: 2 },
    { body: '', line: 8 },
    { body: 'height:30px;', line: 8 },
    { body: 'padding:10px', line: 9 },
  ]);
  assert.equal(collectRuleBodies(css, 'a-title')[0].body, 'width:20px');
  assert.equal(collectRuleBodies(css, 'b-title')[0].body, 'width:20px');
  assert.equal(collectRuleBodies(css, 'title').length, 0);
});

test('伪类、组合关系、属性与伪元素保持主体声明归属', async () => {
  const { collectRuleBodies } = await parser;
  const css = `.card:hover {color:red}
.card.active {height:10px}
.parent > .card {width:20px}
.card .child {position:fixed}
.card ~ .other {height:999px}
:not(.card) {height:888px}
[data-name=".card"] {height:777px}
.card::before {height:666px}
.card:after {height:555px}
.card { .theme & {padding:10px} &:not(.hidden) {opacity:1} }`;
  assert.deepEqual(
    collectRuleBodies(css, 'card').map((r: { body: string }) => r.body),
    ['color:red', 'height:10px', 'width:20px', '', 'padding:10px', 'opacity:1'],
  );
  assert.equal(collectRuleBodies(css, 'parent').length, 0);
  assert.equal(collectRuleBodies(css, 'hidden').length, 0);
});

test('动态 Sass 指令不猜测声明，静态规则仍可读取', async () => {
  const { collectRuleBodies, deriveScssSuffixes } = await parser;
  const css = `.card {
 @mixin fake { .card {height:999px} }
 @if true { height:888px; .card {height:777px} }
 &-#{$variant} {height:666px}
 --data: { nested: {height:555px} };
 height:40px;
}`;
  assert.deepEqual(collectRuleBodies(css, 'card'), [{ body: 'height:40px;', line: 1 }]);
  assert.deepEqual(deriveScssSuffixes('page__cd-num'), ['__cd-num', '-num']);
});

/** 直接运行真实 R05，覆盖原来的正则实现会误报/漏报的例子。 */
test('R05 复用嵌套解析，不能借用后代、后缀或其他父级声明', async () => {
  const { check } = await import(rulePath);
  const checkStyle = (css: string, cls = 'card') =>
    check({
      cache: { nodes: { '1:1': { primaryAxisAlignItems: 'SPACE_BETWEEN', type: 'FRAME' } } },
      product: { style: [{ content: css, rel: 'index.scss' }] },
      classMap: { '1:1': [cls] },
      config: {},
    });
  assert.equal(
    checkStyle('.page { &-card { .child {color:red} justify-content:space-between } }', 'page-card')
      .length,
    0,
  );
  for (const css of [
    '.card-title {justify-content:space-between}',
    '.card { .child {justify-content:space-between} }',
    '.other { &-card {justify-content:space-between} }',
    '.card::before {justify-content:space-between}',
  ])
    assert.equal(checkStyle(css).length, 1, css);
  const [failure] = checkStyle('\n.page { &-card { color:red; } }', 'page-card');
  assert.equal(failure.line, 2);
  assert.equal(failure.file, 'index.scss');
  assert.equal(failure.snippet, 'color:red;');
});

test('固定资源复制到无 node_modules 目录后仍可由原生 Node 独立执行', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'css-resource-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'lib'));
  await fs.mkdir(path.join(dir, 'rules'));
  const root = path.resolve('pixelprint/templates/skills/pp-d2c/bin');
  for (const file of ['lib/cssMatch.mjs', 'rules/R05-space-between.mjs'])
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { collectRuleBodies } from './lib/cssMatch.mjs';
    import { check } from './rules/R05-space-between.mjs';
    console.log(JSON.stringify(collectRuleBodies('.page { &-card {height:40px} }', 'page-card')));
    if (typeof check !== 'function') process.exit(1);
  `,
    ],
    { cwd: dir, env: { PATH: process.env.PATH } },
  );
  assert.deepEqual(JSON.parse(stdout), [{ body: 'height:40px', line: 1 }]);
});

test('正向函数伪类解析分支主体，不混入分支祖先或否定参数', async () => {
  const { collectRuleBodies } = await parser;
  const css = `:is(.card, .card-title) {width:20px}
:where(.parent .card, :is(.another)) {height:30px}
:has(.card) {padding:999px}
:not(:is(.card)) {padding:888px}`;
  assert.deepEqual(collectRuleBodies(css, 'card'), [
    { body: 'width:20px', line: 1 },
    { body: 'height:30px', line: 2 },
  ]);
  assert.deepEqual(collectRuleBodies(css, 'parent'), []);
  assert.equal(collectRuleBodies(css, 'another').length, 1);
});

test('换行和制表符后代关系不能把子类声明归入父类，空规则保留定位', async () => {
  const { collectRuleBodies } = await parser;
  for (const gap of ['\n', '\t', '\r\n', '\f']) {
    const css = `.card${gap}.child {height:999px}`;
    assert.deepEqual(collectRuleBodies(css, 'card'), []);
    assert.equal(collectRuleBodies(css, 'child')[0].body, 'height:999px');
  }
  assert.deepEqual(collectRuleBodies('\n.empty {}', 'empty'), [{ body: '', line: 2 }]);
});
