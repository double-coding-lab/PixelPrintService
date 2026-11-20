import './helpers/projectFixture';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { materializeExportImage } from '../src/functions/d2c/run/exportImage';
import { createGenerationTools } from '../src/functions/d2c/run/tools';
import { RunExecutionError } from '../src/functions/d2c/run/errors';
import { ToolIssue } from '../src/functions/d2c/run/toolFeedback';

const source = 'static/theme-page/product.png';
const target = 'static/theme-page/layer-b.png';
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfoAAAAASUVORK5CYII=',
  'base64',
);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** 私有工作区配真实缓存图片；所有用例独立且不调用Figma或其他外部服务。 */
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelprint-export-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(workspace, path.dirname(source)), { recursive: true });
  await fs.writeFile(path.join(workspace, source), image);
  const controller = new AbortController();
  const input = {
    workspace,
    target,
    returnedPath: path.join(workspace, source) as unknown,
    reused: true,
    maxBytes: 65536,
    sourceHash: (relative: string) => (relative === source ? hash(image) : undefined),
    signal: controller.signal,
    assertLease: async () => {},
  };
  return { directory, workspace, input, controller };
}

/** 缺失和不可用导出应交给现有有限纠错流程，不能误报JSON解析失败。 */
function missing(error: unknown) {
  assert.ok(error instanceof ToolIssue);
  assert.equal(error.feedback.code, 'FIGMA_EXPORT_FILE_MISSING');
  assert.equal(error.feedback.action, 'adjust');
  assert.equal(error.feedback.retryable, false);
  assert.equal(error.failure.context.command, 'export-image');
  assert.doesNotMatch(JSON.stringify(error.feedback), /\/tmp\/|\/var\/|JSON/);
  return true;
}

test('同节点缓存使用旧名时创建目标别名，保留原图；绝对与相对路径均可幂等复用', async (t) => {
  const f = await fixture(t);
  for (const returnedPath of [
    f.input.returnedPath,
    source,
    path.join(await fs.realpath(f.workspace), source),
  ])
    await materializeExportImage({ ...f.input, returnedPath });
  assert.deepEqual(await fs.readFile(path.join(f.workspace, target)), image);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, source)), image);
});

test('其他节点、摘要变化和未声明复用的不同路径均不能复制为目标', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { sourceHash: () => undefined },
    { sourceHash: () => '0'.repeat(64) },
    { reused: false },
  ])
    await assert.rejects(materializeExportImage({ ...f.input, ...extra }), missing);
  await assert.rejects(fs.stat(path.join(f.workspace, target)), { code: 'ENOENT' });
});

test('外部、穿越、内部资源、格式不符及符号链接路径保持拒绝，不覆盖已有目标', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside.png');
  await fs.writeFile(outside, image);
  const link = 'static/theme-page/link.png';
  await fs.symlink(path.join(f.workspace, source), path.join(f.workspace, link));
  for (const returnedPath of [
    outside,
    '../outside.png',
    '.d2c-cache/image.png',
    link,
    'static/image.svg',
    'https://example.test/image.png',
  ])
    await assert.rejects(
      materializeExportImage({ ...f.input, returnedPath, sourceHash: () => hash(image) }),
      missing,
    );
  await fs.writeFile(path.join(f.workspace, target), 'newer-content');
  await assert.rejects(materializeExportImage(f.input), missing);
  assert.equal(await fs.readFile(path.join(f.workspace, target), 'utf8'), 'newer-content');
});

test('缺少路径、缺文件、空图和超限返回具体导出反馈；正常新导出不需要旧缓存登记', async (t) => {
  const f = await fixture(t);
  for (const returnedPath of [undefined, 'static/missing.png'])
    await assert.rejects(materializeExportImage({ ...f.input, returnedPath }), missing);
  await fs.writeFile(path.join(f.workspace, target), '');
  await assert.rejects(materializeExportImage({ ...f.input, returnedPath: target }), missing);
  await fs.writeFile(path.join(f.workspace, target), image);
  await assert.rejects(
    materializeExportImage({ ...f.input, returnedPath: target, maxBytes: 1 }),
    missing,
  );
  await materializeExportImage({
    ...f.input,
    returnedPath: target,
    reused: false,
    sourceHash: () => undefined,
  });
});

test('停止或失租不创建图片别名，实际磁盘读取失败仍是存储故障', async (t) => {
  const f = await fixture(t);
  const lost = new RunExecutionError('LEASE_LOST', { stage: 'worker' });
  let guards = 0;
  await assert.rejects(
    materializeExportImage({
      ...f.input,
      assertLease: async () => {
        if (++guards === 2) throw lost;
      },
    }),
    (error) => error === lost,
  );
  await assert.rejects(fs.stat(path.join(f.workspace, target)), { code: 'ENOENT' });
  f.controller.abort(lost);
  await assert.rejects(materializeExportImage(f.input), (error) => error === lost);
  const io = Object.assign(new Error('private disk failure'), { code: 'EIO' });
  t.mock.method(fs, 'readFile', async () => {
    throw io;
  });
  await assert.rejects(
    materializeExportImage({ ...f.input, signal: new AbortController().signal }),
    (error) =>
      error instanceof RunExecutionError && error.code === 'STORAGE_FAILED' && error.cause === io,
  );
});

for (const kind of ['h5', 'rn'] as const) {
  test(`旧冻结脚本 ${kind} 缓存返回旧名，平台完整导图链仍持久化目标、地址和节点来源`, async (t) => {
    const f = await fixture(t);
    const resources = path.join(f.directory, 'resources');
    const skill = `templates/skills/${kind === 'h5' ? 'pp-d2c' : 'pp-d2c-rn'}/bin`;
    await fs.mkdir(path.join(resources, skill), { recursive: true });
    await fs.copyFile(
      path.resolve('pixelprint', skill, 'figma.mjs'),
      path.join(resources, skill, 'figma.mjs'),
    );
    await fs.writeFile(
      path.join(resources, skill, 'check-rules.mjs'),
      'throw new Error("not used");',
    );
    await fs.writeFile(
      path.join(f.workspace, 'pp-d2c.config.json'),
      JSON.stringify({ images: { assetsDir: 'static/' } }),
    );
    const cachePath = '.d2c-cache/fixedKey/images.json';
    const exportsPath = '.d2c-cache/fixedKey/image-exports.json';
    const cache = JSON.stringify({
      '2:1': { path: path.join(f.workspace, source), format: 'png' },
    });
    const exports = JSON.stringify({ images: [{ nodeId: '2:1', path: source }] });
    await fs.mkdir(path.join(f.workspace, '.d2c-cache/fixedKey'), { recursive: true });
    await fs.writeFile(path.join(f.workspace, cachePath), cache);
    await fs.writeFile(path.join(f.workspace, exportsPath), exports);
    const urls: Record<string, string> = {};
    const uploaded: string[] = [];
    const saved = new Map<string, string>();
    const runtime = await createGenerationTools({
      restored: {
        directory: f.directory,
        resources,
        workspace: f.workspace,
        skill: '',
        skillFile: '',
        configHash: '',
        bundleHash: '',
        dispose: async () => {},
      },
      target: kind,
      figmaUrl: 'https://www.figma.com/design/fixedKey/Test?node-id=1-2',
      proxyUrl: 'http://unused.invalid:8080',
      allowedHosts: [],
      textFileBytes: 65536,
      uploadBytes: 65536,
      savedFiles: [
        { path: source, kind: 'asset', sha256: hash(image), size: image.length },
        ...[
          [cachePath, cache],
          [exportsPath, exports],
        ].map(([path, content]) => ({
          path,
          kind: 'internal',
          sha256: hash(content),
          size: Buffer.byteLength(content),
        })),
      ],
      signal: f.controller.signal,
      assertLease: async () => {},
      token: async () => 'offline-not-a-real-token',
      redact: (value) => value,
      save: async (file, content) => {
        saved.set(file, content);
      },
      saveBinary: async (file, content) => {
        uploaded.push(file);
        urls[file] = `https://assets.example.test/${file}`;
        return content;
      },
      assetUrls: () => urls,
      remove: async () => assert.fail('must retain original image'),
    });
    const result = JSON.parse(
      await runtime.tools.figma('export-image', {
        nodeId: '2:1',
        filename: target,
        format: 'png',
        scale: 2,
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.path, target);
    assert.equal(result.data.reused, true);
    assert.equal(result.data.uploaded, true);
    assert.equal(result.data.url, urls[target]);
    assert.ok(uploaded.includes(target));
    assert.ok(!uploaded.includes(source));
    assert.ok(
      JSON.parse(saved.get(exportsPath)!).images.some(
        (entry: { nodeId: string; path: string }) =>
          entry.nodeId === '2:1' && entry.path === target,
      ),
    );
    assert.equal(
      JSON.parse(saved.get('.d2c-cache/fixedKey/asset-urls.json')!).images[target],
      urls[target],
    );
    assert.deepEqual(await fs.readFile(path.join(f.workspace, source)), image);
  });
}
