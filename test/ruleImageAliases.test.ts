import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRuleImageMap,
  RuleImageMappingError,
  ruleImageMappingReport,
  type RuleImage,
} from '../src/functions/d2c/run/rulesWorkspace';
import { createGenerationTools } from '../src/functions/d2c/run/tools';

const url = 'https://images.example.test/opaque.png';
const a = 'static/page/a.png';
const b = 'static/page/b.png';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfoAAAAASUVORK5CYII=',
  'base64',
);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const image = (file: string, bytes = png): RuleImage => ({
  url,
  path: file,
  sha256: sha(bytes),
  size: bytes.length,
});

test('同URL相同当前字节的多路径别名可共用映射，代表路径与清单顺序无关', () => {
  for (const entries of [
    [image(a), image(b)],
    [image(b), image(a)],
    [image(a), image(a)],
  ]) {
    assert.deepEqual([...createRuleImageMap(entries)], [[url, a]]);
  }
});

test('不同URL不合并，参数及片段仍按完整地址精确匹配', () => {
  const entries = [
    image(a),
    { ...image(b), url: url + '?v=2' },
    { ...image(b), url: url + '#fragment' },
  ];
  assert.equal(createRuleImageMap(entries).size, 3);
});

test('不同摘要或字节数拒绝合并，反馈保留冲突路径而不公开URL及摘要', () => {
  for (const changed of [{ sha256: 'a'.repeat(64) }, { size: png.length + 1 }]) {
    assert.throws(
      () => createRuleImageMap([image(a), { ...image(b), ...changed }]),
      (error) => {
        assert.ok(error instanceof RuleImageMappingError);
        const report = ruleImageMappingReport(error);
        assert.equal(report.ok, false);
        assert.equal(report.violations[0].code, 'IMAGE_URL_CONTENT_CONFLICT');
        assert.deepEqual(report.violations[0].paths, [a, b]);
        assert.ok(!JSON.stringify(report).includes(url));
        assert.ok(!JSON.stringify(report).includes(sha(png)));
        return true;
      },
    );
  }
});

test('没有当前文件身份、大小非法或路径越界时不能用同URL冒充等价图片', () => {
  for (const changed of [{ sha256: '' }, { size: 0 }, { size: NaN }, { path: '../outside.png' }])
    assert.throws(
      () => createRuleImageMap([image(a), { ...image(b), ...changed }]),
      RuleImageMappingError,
    );
});

/** 使用实际H5/RN检查脚本和真实文件摘要，不访问Figma、图片服务或数据库。 */
async function fixture(t: test.TestContext, target: 'h5' | 'rn', conflict = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rule-image-alias-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const resources = path.join(directory, 'resources');
  const skill = `templates/skills/${target === 'h5' ? 'pp-d2c' : 'pp-d2c-rn'}`;
  await fs.mkdir(path.join(resources, skill), { recursive: true });
  await fs.cp(path.resolve('pixelprint', skill, 'bin'), path.join(resources, skill, 'bin'), {
    recursive: true,
  });
  const manifestPath = '.d2c-cache/file/slice-manifest-page.json';
  const files: Record<string, string | Buffer> = {
    'pp-d2c.config.json': JSON.stringify({
      unit: { scale: 1 },
      slice: { confirmBeforeContinue: false },
    }),
    '.d2c-cache/file/nodes/1_2.json': JSON.stringify({
      _depth: null,
      node: { id: '1:2', name: 'page', type: 'FRAME', children: [] },
    }),
    [manifestPath]: JSON.stringify({
      themes: [
        {
          slug: 'page',
          hit: 2,
          miss: 0,
          confirmed: true,
          entries: [a, b].map((filepath, index) => ({
            filepath,
            filename: path.posix.basename(filepath),
            nodeId: `2:${index + 1}`,
          })),
        },
      ],
    }),
    'pages/page/rule-hits.json': JSON.stringify({
      block: 'pages/page',
      cache_key: 'file',
      generated_at: '2026-11-26T00:00:00Z',
      generated_by: 'offline-fixture',
      hits: [],
    }),
    'pages/page/index.tsx':
      target === 'rn'
        ? `const Page = () => <View><ScrollView><View data-node-id="1:2" style={styles.page}><Image source={{uri:'${url}'}} /></View></ScrollView></View>;`
        : `const Page = () => <div data-node-id="1:2" className="page"><img src="${url}" /></div>;`,
    'pages/page/styles.ts': 'const styles = StyleSheet.create({page:{}});',
    [a]: png,
    [b]: conflict ? Buffer.concat([png, Buffer.from('different')]) : png,
  };
  for (const [name, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.writeFile(path.join(workspace, name), value);
  }
  const saved = new Map<string, string>();
  const controller = new AbortController();
  const input: Parameters<typeof createGenerationTools>[0] = {
    restored: {
      directory,
      workspace,
      resources,
      skill: '',
      skillFile: '',
      configHash: 'config',
      bundleHash: 'bundle',
      dispose: async () => {},
    },
    target,
    figmaUrl: 'https://www.figma.com/design/file/Test?node-id=1-2',
    proxyUrl: 'http://unused.invalid:8080',
    allowedHosts: [],
    textFileBytes: 1048576,
    uploadBytes: 1048576,
    signal: controller.signal,
    assetUrls: () => ({ [a]: url, [b]: url }),
    savedFiles: Object.entries(files).map(([name, value]) => ({
      path: name,
      sha256: sha(value),
      kind: Buffer.isBuffer(value) ? 'asset' : 'text',
      size: Buffer.byteLength(value),
    })),
    reusableLegacyManifests: [manifestPath],
    token: async () => assert.fail('unexpected credential access'),
    redact: (value) => value,
    save: async (name, content) => {
      saved.set(name, content);
    },
    saveBinary: async () => assert.fail('unexpected binary upload'),
    remove: async () => assert.fail('unexpected delete'),
    assertLease: async () => {},
  };
  const runtime = await createGenerationTools(input);
  return { ...runtime, input, saved, files, workspace, directory, controller };
}

for (const target of ['h5', 'rn'] as const) {
  test(`${target}真实规则链接受相同图片别名，原源码与证据保持不变`, async (t) => {
    const f = await fixture(t, target);
    const value = JSON.parse(await f.tools.rules('pages/page', 'merge'));
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(value.platformAssetView.references, 1);
    for (const name of ['pages/page/index.tsx', 'pages/page/rule-hits.json', a, b]) {
      const actual = await fs.readFile(path.join(f.workspace, name));
      assert.deepEqual(actual, Buffer.from(f.files[name]));
    }
    assert.deepEqual(
      (await fs.readdir(f.directory)).filter((name) => name.startsWith('rules-')),
      [],
    );
  });

  test(`${target}真实内容冲突返回具体失败报告并保存失败状态，不抛笼统终止`, async (t) => {
    const f = await fixture(t, target, true);
    const value = JSON.parse(await f.tools.rules('pages/page', 'merge'));
    assert.equal(value.code, 'RULES_FAILED');
    const report = JSON.parse(value.report);
    assert.equal(report.violations[0].code, 'IMAGE_URL_CONTENT_CONFLICT');
    assert.deepEqual(report.violations[0].paths, [a, b]);
    assert.equal(JSON.parse(f.saved.get('.d2c-cache/file/check-report.json')!).ok, false);
    assert.equal((await f.validation()).status, 'failed');
  });

  test(`${target}允许别名后，缺少真实规则报告仍失败且不能借映射放行`, async (t) => {
    const f = await fixture(t, target);
    await fs.rm(path.join(f.workspace, 'pages/page/rule-hits.json'));
    const value = JSON.parse(await f.tools.rules('pages/page', 'merge'));
    assert.equal(value.code, 'RULES_FAILED');
    assert.ok(
      JSON.parse(value.report).violations.some(
        (item: { rule: string }) => item.rule === 'GATE-rule-hits',
      ),
    );
    assert.equal((await f.validation()).status, 'failed');
  });

  test(`${target}后续真实映射冲突覆盖之前的通过结果，不能遗留passed`, async (t) => {
    const f = await fixture(t, target, true);
    f.input.assetUrls = () => ({ [a]: url, [b]: 'https://images.example.test/distinct.png' });
    assert.equal(JSON.parse(await f.tools.rules('pages/page', 'merge')).ok, true);
    assert.equal((await f.validation()).status, 'passed');
    f.input.assetUrls = () => ({ [a]: url, [b]: url });
    assert.equal(JSON.parse(await f.tools.rules('pages/page', 'merge')).code, 'RULES_FAILED');
    assert.equal((await f.validation()).status, 'failed');
  });
}

test('保存冲突报告失败和检查期间取消仍按原始异常中止', async (t) => {
  const f = await fixture(t, 'h5', true);
  const failure = new Error('synthetic storage failure');
  f.input.save = async (name, content) => {
    if (name.endsWith('/check-report.json')) throw failure;
    f.saved.set(name, content);
  };
  await assert.rejects(f.tools.rules('pages/page', 'merge'), (error: unknown) => {
    let current = error;
    for (let i = 0; current instanceof Error && i < 10; i++, current = current.cause)
      if (current === failure) return true;
    return false;
  });
  f.controller.abort();
  await assert.rejects(f.tools.rules('pages/page', 'merge'));
});
