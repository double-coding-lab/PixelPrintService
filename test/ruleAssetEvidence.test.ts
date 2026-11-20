import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const targets = ['pp-d2c', 'pp-d2c-rn'] as const;
type Target = (typeof targets)[number];
type Report = {
  ok: boolean;
  violations: { rule: string; nodeId: string; actual: string }[];
  warnings: { rule: string; reason: string }[];
};

/** 合成设计缓存和独立临时产物；真实固定脚本仅离线读取这些文件。 */
async function fixture(t: test.TestContext, target: Target) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-assets-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, 'workspace');
  const page = path.join(workspace, 'page');
  const block = path.join(page, 'blocks/card');
  const write = async (relative: string, content: string) => {
    const file = path.join(workspace, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const isRN = target === 'pp-d2c-rn';
  const blockSource = (references: string) =>
    isRN
      ? `import styles from './styles';
         export default function Card() { return <View data-node-id="910:1" style={styles.card}>${references}</View>; }`
      : `export default function Card() { return <div data-node-id="910:1" className="card">${references}</div>; }`;
  const image = isRN
    ? '<Image data-node-id="910:2" source={{uri:"https://example.com/icon.png"}} />'
    : '<img data-node-id="910:2" src="https://example.com/icon.png" />';
  const shape = isRN
    ? '<Image source={{uri:"https://example.com/shape.png"}} />'
    : '<img src="https://example.com/shape.png" />';
  const rootSource = `import Card from './blocks/card';
    export default function Page() { return ${isRN ? '<View><ScrollView><View><Card /></View></ScrollView></View>' : '<Card />'}; }`;
  const node = {
    id: '900:1',
    name: 'page',
    type: 'FRAME',
    children: [
      {
        id: '910:1',
        name: 'sub-card',
        type: 'FRAME',
        children: [
          { id: '910:2', name: 'picture', type: 'RECTANGLE', fills: [{ type: 'IMAGE' }] },
          {
            id: '910:3',
            name: 'shape',
            type: 'GROUP',
            children: [1, 2, 3].map((n) => ({ id: `911:${n}`, type: 'VECTOR' })),
          },
        ],
      },
    ],
  };
  await write('pp-d2c.config.json', JSON.stringify({ unit: { scale: 1 } }));
  await write('.d2c-cache/synthetic/nodes/root.json', JSON.stringify({ node }));
  await write(
    '.d2c-cache/synthetic/slice-manifest-page.json',
    JSON.stringify({
      themes: [
        {
          slug: 'synthetic',
          confirmed: true,
          entries: [{ filename: 'icon.png' }, { filename: 'shape.png' }],
        },
      ],
    }),
  );
  await write('page/index.tsx', rootSource);
  await write('page/rule-hits.json', '{}');
  await write('page/assets.txt', 'Page QA: no local image declarations.');
  await write('page/blocks/card/index.tsx', blockSource(image + shape));
  await write('page/blocks/card/rule-hits.json', '{}');
  await write('page/blocks/card/assets.txt', '- icon.png nodeId=910:2\n- shape.png nodeId=910:3');
  if (isRN)
    await write(
      'page/blocks/card/styles.ts',
      "import { StyleSheet } from 'react-native'; export default StyleSheet.create({card:{}});",
    );
  const script = path.resolve(`pixelprint/templates/skills/${target}/bin/check-rules.mjs`);
  const check = async (mode: 'block' | 'merge', directory = mode === 'block' ? block : page) => {
    const args = [script, `--${mode}`, directory, '--cache-key', 'synthetic'];
    if (mode === 'block') args.push('--root', '910:1');
    let stdout: string;
    let code = 0;
    try {
      ({ stdout } = await execute(process.execPath, args, { cwd: workspace }));
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1, failure.stderr);
      stdout = failure.stdout;
      code = failure.code;
    }
    const report = JSON.parse(stdout) as Report;
    assert.equal(code, report.ok ? 0 : 1);
    assert.ok(!report.warnings.some((warning) => /rule crashed/.test(warning.reason)), stdout);
    return report;
  };
  return { temporary, workspace, page, block, write, check, blockSource, rootSource, image, shape };
}

/** 只关注图片规则时仍执行整套脚本；成功场景同时要求完整报告通过。 */
function imageFailures(report: Report) {
  return report.violations.filter((hit) => hit.rule === 'R02' || hit.rule === 'R03');
}

for (const target of targets) {
  test(`${target}: block/merge 聚合当前区块清单，R03 保留原切图判定`, async (t) => {
    const f = await fixture(t, target);
    for (const mode of ['block', 'merge'] as const) {
      const report = await f.check(mode);
      assert.equal(report.ok, true, JSON.stringify(report));
    }
    // R03 原语义：清单中的切图记录可以独立提供证据，不要求额外 DOM。
    await f.write('page/blocks/card/index.tsx', f.blockSource(f.image));
    for (const mode of ['block', 'merge'] as const)
      assert.deepEqual(imageFailures(await f.check(mode)), []);
  });

  test(`${target}: 仅登记不能替代 R02 引用，完全缺图仍报告 R02/R03`, async (t) => {
    const f = await fixture(t, target);
    await f.write('page/blocks/card/index.tsx', f.blockSource(''));
    for (const mode of ['block', 'merge'] as const) {
      const hits = imageFailures(await f.check(mode));
      assert.deepEqual(
        hits.map((hit) => hit.rule),
        ['R02'],
      );
      assert.match(hits[0].actual, /已记录但产物未引用/);
    }
    await f.write('page/blocks/card/assets.txt', 'No image evidence.');
    for (const mode of ['block', 'merge'] as const)
      assert.deepEqual(
        imageFailures(await f.check(mode)).map((hit) => hit.rule),
        ['R02', 'R03'],
      );
  });

  test(`${target}: 未引用旧块的清单和源码均不能提供证据，动态依赖也不扩大范围`, async (t) => {
    const f = await fixture(t, target);
    await f.write('page/blocks/card/index.tsx', f.blockSource(''));
    await f.write('page/blocks/card/assets.txt', 'No image evidence.');
    await f.write('page/blocks/old/rule-hits.json', '{}');
    await f.write(
      'page/blocks/old/assets.txt',
      '- icon.png nodeId=910:2\n- shape.png nodeId=910:3',
    );
    await f.write('page/blocks/old/index.tsx', 'export const unused = "910:2 910:3";');
    for (const dynamic of ['', "const target = './blocks/old'; import(target);"]) {
      await f.write('page/index.tsx', f.rootSource + dynamic);
      for (const mode of ['block', 'merge'] as const)
        assert.deepEqual(
          imageFailures(await f.check(mode)).map((hit) => hit.rule),
          ['R02', 'R03'],
        );
    }
  });

  test(`${target}: 清单 nodeId 按完整原始 ID 匹配，不接受相近或复合 ID`, async (t) => {
    const f = await fixture(t, target);
    await f.write('page/blocks/card/index.tsx', f.blockSource(''));
    await f.write(
      'page/blocks/card/assets.txt',
      '1910:2 910:20 I910:2;999:1 1910:3 910:30 I910:3;999:1',
    );
    for (const mode of ['block', 'merge'] as const)
      assert.deepEqual(
        imageFailures(await f.check(mode)).map((hit) => hit.rule),
        ['R02', 'R03'],
      );
  });

  test(`${target}: 原始与归一 ID 的语义前后缀源码引用保持兼容`, async (t) => {
    const f = await fixture(t, target);
    await f.write('page/blocks/card/assets.txt', 'No image evidence.');
    for (const ids of [
      ['910:2', '910:3'],
      ['910-2', '910-3'],
    ]) {
      const refs = ids.map((id) =>
        target === 'pp-d2c-rn'
          ? `<Image source={{uri:"https://example.com/hero-${id}-tail.png"}} />`
          : `<img className="bg-${id}-tail" src="https://example.com/hero-${id}-tail.png" />`,
      );
      await f.write('page/blocks/card/index.tsx', f.blockSource(refs.join('')));
      for (const mode of ['block', 'merge'] as const)
        assert.deepEqual(imageFailures(await f.check(mode)), []);
    }
  });

  test(`${target}: 根目录符号别名不会丢失合法源码和区块清单`, async (t) => {
    const f = await fixture(t, target);
    const alias = path.join(f.temporary, 'alias');
    await fs.symlink(f.workspace, alias, 'dir');
    for (const mode of ['block', 'merge'] as const) {
      const dir = path.join(alias, mode === 'block' ? 'page/blocks/card' : 'page');
      const report = await f.check(mode, dir);
      assert.equal(report.ok, true, JSON.stringify(report));
    }
  });

  for (const destination of ['outside', 'old-block'] as const)
    test(`${target}: ${destination} 的清单 symlink 不提供证据`, async (t) => {
      const f = await fixture(t, target);
      const evidence =
        destination === 'outside'
          ? path.join(f.temporary, 'external-assets.txt')
          : path.join(f.page, 'blocks/old/assets.txt');
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.writeFile(evidence, '910:3');
      await fs.rm(path.join(f.block, 'assets.txt'));
      await fs.symlink(evidence, path.join(f.block, 'assets.txt'));
      for (const mode of ['block', 'merge'] as const)
        assert.ok(imageFailures(await f.check(mode)).some((hit) => hit.rule === 'R03'));
    });

  test(`${target}: 子源码 symlink 不能注入引用证据`, async (t) => {
    const f = await fixture(t, target);
    await f.write('page/blocks/card/assets.txt', 'No image evidence.');
    await f.write('page/blocks/card/index.tsx', f.blockSource('') + "\nimport './proof';");
    await f.write('page/blocks/card/unused.tsx', 'export const unused = "910:2 910:3";');
    await fs.symlink(path.join(f.block, 'unused.tsx'), path.join(f.block, 'proof.tsx'));
    for (const mode of ['block', 'merge'] as const)
      assert.deepEqual(
        imageFailures(await f.check(mode)).map((hit) => hit.rule),
        ['R02', 'R03'],
      );
  });
}
