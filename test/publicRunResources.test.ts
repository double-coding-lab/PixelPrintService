import './helpers/projectFixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTemplateResources } from '../src/functions/d2c/workspace/resources';
import { createConfigSnapshot } from '../src/functions/d2c/utils/config';
import { restoreExecutionWorkspace } from '../src/functions/d2c/run/workspace';
import { createGenerationTools } from '../src/functions/d2c/run/tools';

/** 实际公开资源经冻结/恢复后在仓库之外执行，不安装依赖、不使用真实凭据。 */
for (const target of ['h5', 'rn'] as const) {
  test(target + '公开资源可隔离恢复并运行真实规则脚本，缺失报告仍拒绝通过', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'public-worker-'));
    let dispose = async () => {};
    t.after(async () => {
      try {
        await dispose();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
    const bundle = await readTemplateResources(path.resolve('pixelprint'));
    const content = JSON.stringify({
      _depth: null,
      node: {
        id: '1:2',
        name: 'page',
        type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        children: [],
      },
    });
    const cache = {
      path: '.d2c-cache/offlineKey/nodes/1_2.json',
      kind: 'internal' as const,
      content,
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      objectLocator: null,
    };
    const restored = await restoreExecutionWorkspace({
      workRoot: path.join(directory, '执行 # percent%20literal'),
      resourceRevisionId: 'offline-resource',
      bundleHash: bundle.hash,
      bundleObject: { fixture: true },
      configSnapshot: createConfigSnapshot(bundle.defaultConfigs, target, 1, 'offline-resource'),
      files: [cache],
      limits: { textFileBytes: 2 ** 20, uploadBytes: 2 ** 20, filesPerSession: 100 },
      store: { load: async () => bundle },
      assertLease: async () => {},
    });
    dispose = restored.dispose;
    assert.equal(restored.bundleHash, bundle.hash);
    assert.equal(restored.skill, await fs.readFile(restored.skillFile, 'utf8'));
    await assert.rejects(fs.stat(path.join(restored.directory, 'node_modules')), {
      code: 'ENOENT',
    });
    const saved = new Map<string, string>();
    const runtime = await createGenerationTools({
      restored,
      target,
      figmaUrl: 'https://www.figma.com/design/offlineKey/Test?node-id=1-2',
      proxyUrl: '',
      allowedHosts: [],
      textFileBytes: 2 ** 20,
      uploadBytes: 2 ** 20,
      savedFiles: [cache],
      signal: new AbortController().signal,
      assertLease: async () => {},
      token: async () => assert.fail('unexpected credential access'),
      redact: (value) => value,
      save: async (name, value) => {
        saved.set(name, value);
      },
      saveBinary: async () => assert.fail('unexpected binary upload'),
      remove: async () => assert.fail('unexpected deletion'),
    });
    const source =
      target === 'h5'
        ? 'export default function Page(){ return <div data-node-id="1:2">offline</div>; }'
        : 'import { View, Text } from "react-native"; export default function Page(){ return <View data-node-id="1:2"><Text>offline</Text></View>; }';
    await runtime.tools.write('pages/home/index.tsx', source);
    assert.equal(saved.get('pages/home/index.tsx'), source);
    assert.deepEqual((await runtime.delivery(true)).problems, []);
    const result = JSON.parse(await runtime.tools.rules('pages/home', 'merge'));
    assert.equal(result.code, 'RULES_FAILED');
    assert.ok(
      JSON.parse(result.report).violations.some(
        (item: { rule: string }) => item.rule === 'GATE-rule-hits',
      ),
    );
    assert.equal((await runtime.validation()).status, 'failed');
    assert.equal(JSON.parse(saved.get('.d2c-cache/offlineKey/check-report.json')!).ok, false);
    assert.equal(await fs.readFile(path.join(restored.workspace, cache.path), 'utf8'), content);
  });
}
