import './helpers/projectFixture';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGenerationTools } from '../src/functions/d2c/run/tools';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

const execute = promisify(execFile);
const block = 'page/blocks/card';
const rootNodeId = '2:1';
const imagePath = 'static/theme-page/icon.png';
const imageUrl = 'https://images.example.test/opaque.png';
const manifestPath = '.d2c-cache/design/slice-manifest-page.json';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Report = {
  ok: boolean;
  violations: Array<{ rule: string; nodeId: string; actual?: string }>;
  warnings: Array<{ rule: string; reason: string }>;
  platformAssetView?: { references: number };
};

/** 真实固定脚本只读合成设计缓存；可信切图清单从稳定文件恢复，不请求 Figma/Token/网络。 */
async function fixture(t: TestContext, target: 'h5' | 'rn') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'block-scope-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const resources = path.join(directory, 'resources');
  const skill = target === 'h5' ? 'pp-d2c' : 'pp-d2c-rn';
  const bin = path.join(resources, 'templates/skills', skill, 'bin');
  await fs.cp(path.resolve('pixelprint/templates/skills', skill, 'bin'), bin, { recursive: true });
  const script = path.join(bin, 'check-rules.mjs');
  const callsFile = path.join(directory, 'calls.ndjson');
  const original = await fs.readFile(script, 'utf8');
  // Observe both real script processes, including the temporary CDN view, without replacing checks.
  await fs.writeFile(
    script,
    `import { appendFileSync as scopeTrace } from 'node:fs';\n` +
      `scopeTrace(${JSON.stringify(callsFile)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+'\\n');\n` +
      original.replace(/^#![^\n]*\n/, ''),
  );
  const write = async (relative: string, content: string | Buffer) => {
    const filename = path.join(workspace, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  };
  const design = {
    id: '1:2',
    type: 'FRAME',
    name: 'page',
    children: [
      {
        id: rootNodeId,
        type: 'FRAME',
        name: 'sub-card',
        children: [
          { id: '2:2', type: 'TEXT', name: 'owned text', characters: 'card' },
          { id: '2:3', type: 'RECTANGLE', name: 'img-icon', fills: [{ type: 'IMAGE' }] },
        ],
      },
      {
        id: '3:1',
        type: 'FRAME',
        name: 'sub-sibling',
        children: [
          { id: '3:2', type: 'TEXT', name: 'missing sibling text', characters: 'sibling' },
          { id: '3:3', type: 'RECTANGLE', name: 'img-sibling', fills: [{ type: 'IMAGE' }] },
          { id: '3:4', type: 'VECTOR', name: 'different sibling structure' },
        ],
      },
    ],
  };
  const image = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  image.writeUInt32BE(1, 16);
  image.writeUInt32BE(1, 20);
  const manifest = JSON.stringify({
    themes: [
      {
        slug: 'page',
        hit: 1,
        miss: 0,
        confirmed: true,
        entries: [{ nodeId: '2:3', filename: 'icon.png', filepath: imagePath }],
      },
    ],
  });
  const source =
    target === 'h5'
      ? `export default function Card(){return <div data-node-id="2:1"><span data-node-id="2:2">card</span><img data-node-id="2:3" src="${imageUrl}"/><div data-node-id="3:1"/></div>;}`
      : `import { View, Text, Image } from 'react-native'; export default function Card(){return <View data-node-id="2:1"><Text data-node-id="2:2">card</Text><Image data-node-id="2:3" source={{uri:'${imageUrl}'}}/><View data-node-id="3:1"/></View>;}`;
  await write('pp-d2c.config.json', JSON.stringify({ unit: { scale: 1 } }));
  await write('.d2c-cache/design/nodes/1_2.json', JSON.stringify({ _depth: null, node: design }));
  await write(manifestPath, manifest);
  await write(imagePath, image);
  await write(`${block}/index.tsx`, source);
  await write(`${block}/rule-hits.json`, '{}');
  await write(`${block}/assets.txt`, '- icon.png nodeId=2:3');
  await write('page/rule-hits.json', '{}');
  await write('page/assets.txt', 'Page root has no images.');
  await write(
    'page/index.tsx',
    target === 'h5'
      ? `import Card from './blocks/card'; export default () => <Card/>;`
      : `import {View,ScrollView} from 'react-native'; import Card from './blocks/card'; export default () => <View><ScrollView><Card/></ScrollView></View>;`,
  );
  const calls = async (): Promise<Array<{ args: string[]; cwd: string }>> => {
    try {
      return (await fs.readFile(callsFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const check = async (mode: 'block' | 'merge', scoped = false): Promise<Report> => {
    const args = [
      script,
      `--${mode}`,
      path.join(workspace, mode === 'block' ? block : 'page'),
      '--cache-key',
      'design',
    ];
    if (scoped) args.push('--root', rootNodeId);
    let output: string;
    try {
      output = (await execute(process.execPath, args, { cwd: workspace })).stdout;
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1, failure.stderr);
      output = failure.stdout;
    }
    return JSON.parse(output);
  };
  const runtime = () =>
    createGenerationTools({
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
      figmaUrl: 'https://www.figma.com/design/design/Page?node-id=1-2',
      target,
      proxyUrl: 'http://unused.test:8080',
      allowedHosts: [],
      textFileBytes: 65536,
      uploadBytes: 65536,
      signal: new AbortController().signal,
      savedFiles: [
        { path: imagePath, kind: 'asset', size: image.length, sha256: sha(image) },
        { path: manifestPath, kind: 'internal', sha256: sha(manifest) },
      ],
      reusableLegacyManifests: [manifestPath],
      assetUrls: () => ({ [imagePath]: imageUrl }),
      token: async () => assert.fail('rule checks must not request credentials'),
      redact: (value) => value,
      save: async () => {},
      saveBinary: async () => {},
      remove: async () => {},
      assertLease: async () => {},
    });
  return { workspace, source, write, calls, check, runtime };
}

/** 运行工具失败信封保留的仍是真实检查报告。 */
function report(output: string): Report {
  const parsed = JSON.parse(output);
  const value = parsed.report ? JSON.parse(parsed.report) : parsed;
  assert.ok(Array.isArray(value.violations));
  assert.ok(
    !value.warnings?.some((warning: { reason: string }) => /rule crashed/.test(warning.reason)),
    output,
  );
  return value;
}

for (const target of ['h5', 'rn'] as const) {
  test(`${target}: real script trusted root prevents leaked sibling DOM from widening the inferred LCA`, async (t) => {
    const f = await fixture(t, target);
    const inferred = await f.check('block');
    assert.ok(inferred.violations.some((hit) => hit.nodeId === '3:2' && hit.rule === 'R21'));
    const scoped = await f.check('block', true);
    assert.ok(
      scoped.warnings.some(
        (warning) => warning.rule === 'scope' && warning.reason.includes('2:1(--root)'),
      ),
    );
    assert.ok(!scoped.violations.some((hit) => ['3:2', '3:3'].includes(hit.nodeId)));
    assert.ok(
      scoped.violations.some((hit) => hit.nodeId === '3:1' && hit.rule === 'R21'),
      'out-of-scope DOM itself must remain invalid',
    );
    await f.write(`${block}/index.tsx`, f.source.replace('data-node-id="2:2"', ''));
    assert.ok(
      (await f.check('block', true)).violations.some(
        (hit) => hit.nodeId === '2:2' && hit.rule === 'R21',
      ),
    );
    const merged = await f.check('merge');
    assert.ok(merged.violations.some((hit) => hit.nodeId === '3:2' && hit.rule === 'R21'));
    assert.ok(merged.violations.some((hit) => hit.nodeId === '3:3' && hit.rule === 'R02'));
  });

  test(`${target}: real generation tools bind both original/CDN script calls and never scope a page merge`, async (t) => {
    const f = await fixture(t, target);
    const runtime = await f.runtime();
    const scoped = report(await runtime.tools.rules(block, 'block', { rootNodeId }));
    const calls = await f.calls();
    assert.equal(calls.length, 2, 'must run the original and published-image view');
    assert.notEqual(calls[0].cwd, calls[1].cwd);
    for (const call of calls) {
      assert.equal(call.args.filter((arg) => arg === '--root').length, 1);
      assert.equal(call.args[call.args.indexOf('--root') + 1], rootNodeId);
    }
    assert.equal(scoped.platformAssetView?.references, 1);
    assert.ok(!scoped.violations.some((hit) => ['3:2', '3:3'].includes(hit.nodeId)));
    assert.ok(scoped.violations.some((hit) => hit.nodeId === '3:1'));
    assert.equal(await fs.readFile(path.join(f.workspace, block, 'index.tsx'), 'utf8'), f.source);
    await assert.rejects(
      runtime.tools.rules('page', 'merge', { rootNodeId }),
      (error) => error instanceof ToolIssue && error.feedback.code === 'INVALID_ARGUMENT',
    );
    assert.equal((await f.calls()).length, 2, 'invalid merge must not invoke any script');
    const merged = report(await runtime.tools.rules('page', 'merge'));
    const mergeCalls = (await f.calls()).slice(2);
    assert.equal(mergeCalls.length, 2);
    for (const call of mergeCalls) assert.ok(!call.args.includes('--root'));
    assert.ok(merged.violations.some((hit) => hit.nodeId === '3:2' && hit.rule === 'R21'));
    assert.ok(merged.violations.some((hit) => hit.nodeId === '3:3' && hit.rule === 'R02'));
  });
}
