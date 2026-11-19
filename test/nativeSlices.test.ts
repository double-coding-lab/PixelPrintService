import './helpers/projectFixture';
import { diagnoseRunFailure } from '../src/functions/d2c/run/errors';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareSlices } from '../src/functions/d2c/run/slices';
import { ToolIssue, toolIssue } from '../src/functions/d2c/run/toolFeedback';

/** 离线字节和节点替身；不冒充真实Figma/对象存储联调。 */
async function fixture(t: import('node:test').TestContext) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'native-slices-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let revision = 'v1';
  let failing = true;
  let image: Buffer | undefined;
  const calls: string[] = [];
  const saved: string[] = [];
  const signal = new AbortController();
  const root = {
    id: '1:2',
    name: 'Page',
    children: [
      { id: '2:1', name: 'img-first' },
      { id: '2:2', name: 'img-second' },
    ],
  };
  const input = {
    workspace,
    figmaUrl: 'https://www.figma.com/design/key/Page?node-id=1-2',
    slug: 'page',
    assetsDir: 'static/',
    scope: 'fixed',
    signal: signal.signal,
    assertLease: async () => {},
    async request(address: string, kind: 'json' | 'image') {
      const url = new URL(address);
      if (url.pathname.endsWith('/nodes'))
        return Buffer.from(
          JSON.stringify({ lastModified: revision, nodes: { '1:2': { document: root } } }),
        );
      if (kind === 'json') {
        const node = url.searchParams.get('ids')!;
        calls.push(node);
        if (node === '2:2' && failing)
          throw toolIssue('NETWORK_RETRY', 'NETWORK_UNAVAILABLE', {
            stage: 'tool',
            tool: 'prepare_slices',
          });
        return Buffer.from(
          JSON.stringify({ images: { [node]: `https://assets.example/${node}` } }),
        );
      }
      if (image) return image;
      const png = Buffer.alloc(25);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.writeUInt32BE(20, 16);
      png.writeUInt32BE(20, 20);
      png[24] = url.pathname.endsWith('2:1') ? 1 : 2;
      return png;
    },
    async saveText(relative: string, content: string) {
      const filename = path.join(workspace, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content);
    },
    async saveBinary(relative: string, content: Buffer) {
      saved.push(relative);
      const filename = path.join(workspace, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content);
    },
  };
  return {
    input,
    calls,
    saved,
    signal,
    healthy: () => {
      failing = false;
    },
    useImage: (content: Buffer) => {
      image = content;
    },
    revision: () => {
      revision = 'v2';
    },
  };
}

test(
  '压缩后的上传字节、工作区、断点摘要保持一致，恢复不重复下载',
  {
    skip: !existsSync('image-compression/.venv/bin/python3') && '先执行 npm run prepare:images',
  },
  async (t) => {
    const f = await fixture(t);
    f.healthy();
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAABE0lEQVR4AQEIAff+AQECA2QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdPoAeldSLfQAAAAASUVORK5CYII=',
      'base64',
    );
    f.useImage(image);
    const result = await prepareSlices(f.input);
    assert.ok(result.manifest.compression.afterBytes < result.manifest.compression.beforeBytes);
    const checkpoint = JSON.parse(
      await fs.readFile(
        path.join(f.input.workspace, '.d2c-cache/key/slice-partial-page.json'),
        'utf8',
      ),
    );
    for (const item of checkpoint.entries) {
      const bytes = await fs.readFile(path.join(f.input.workspace, item.entry.filepath));
      assert.ok(bytes.length < image.length);
      assert.equal(item.size, bytes.length);
      assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.ok(f.saved.includes(item.entry.filepath));
    }
    f.calls.length = 0;
    await prepareSlices(f.input);
    assert.deepEqual(f.calls, []);
  },
);

test('部分失败先保存成功图片及断点，重建调用只导出失败项，完整清单仍需全成功', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareSlices(f.input));
  assert.deepEqual(f.calls, ['2:1', '2:2']);
  const partial = JSON.parse(
    await fs.readFile(
      path.join(f.input.workspace, '.d2c-cache/key/slice-manifest-page.json'),
      'utf8',
    ),
  );
  assert.equal(partial.themes[0].miss, 1);
  assert.equal(f.saved.length, 1);
  f.healthy();
  f.calls.length = 0;
  const result = await prepareSlices(f.input);
  assert.deepEqual(f.calls, ['2:2']);
  assert.equal(result.manifest.themes[0].miss, 0);
  assert.equal(result.manifest.themes[0].entries.length, 2);
  assert.equal(f.saved.length, 2);
});

test('设计版本或配置变化重新导出，损坏的单张图片只补当前项', async (t) => {
  const f = await fixture(t);
  f.healthy();
  await prepareSlices(f.input);
  f.calls.length = 0;
  await fs.writeFile(path.join(f.input.workspace, 'static/theme-page/first.png'), 'broken');
  await prepareSlices(f.input);
  assert.deepEqual(f.calls, ['2:1']);
  f.calls.length = 0;
  f.revision();
  await prepareSlices(f.input);
  assert.deepEqual(f.calls, ['2:1', '2:2']);
  f.calls.length = 0;
  await prepareSlices({ ...f.input, scope: 'changed' });
  assert.deepEqual(f.calls, ['2:1', '2:2']);
});

test('存储失败立即停止，不导出下一张；取消不会被当作可重试切图错误吞掉', async (t) => {
  const f = await fixture(t);
  f.healthy();
  const failure = new Error('db failed');
  await assert.rejects(
    prepareSlices({
      ...f.input,
      saveBinary: async () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.calls, ['2:1']);
  f.calls.length = 0;
  f.signal.abort(new Error('stop'));
  await assert.rejects(prepareSlices(f.input), /stop/);
  assert.equal(f.calls.length, 0);
});

test('并发会话的断点和图片相互隔离，不使用全局cwd或环境变量', async (t) => {
  const a = await fixture(t),
    b = await fixture(t);
  a.healthy();
  b.healthy();
  const cwd = process.cwd(),
    token = process.env.FIGMA_TOKEN;
  await Promise.all([prepareSlices(a.input), prepareSlices({ ...b.input, slug: 'second' })]);
  assert.equal(process.cwd(), cwd);
  assert.equal(process.env.FIGMA_TOKEN, token);
  assert.ok(a.saved.every((file) => file.startsWith('static/theme-page/')));
  assert.ok(b.saved.every((file) => file.startsWith('static/theme-second/')));
});

test('复用成功项时断点保存失败也立即停止，不把存储ENOENT误当图片缺失', async (t) => {
  const f = await fixture(t);
  f.healthy();
  await prepareSlices(f.input);
  f.calls.length = 0;
  const error = Object.assign(new Error('storage missing'), { code: 'ENOENT' });
  await assert.rejects(
    prepareSlices({
      ...f.input,
      saveText: async () => {
        throw error;
      },
    }),
    (value) => value === error,
  );
  assert.deepEqual(f.calls, []);
});

test('显式基线先于last-page，基线节点命名与base/names变化隔离断点', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.input.workspace, '.d2c-cache'), { recursive: true });
  await fs.writeFile(path.join(f.input.workspace, '.d2c-cache/last-page.json'), '{invalid');
  const baseUrl = 'https://www.figma.com/design/baseKey/Base?node-id=7-2';
  const request = async (address: string, kind: 'json' | 'image') => {
    const url = new URL(address);
    if (url.pathname.endsWith('/nodes') && url.pathname.includes('base'))
      return Buffer.from(
        JSON.stringify({
          version: 'base-v1',
          nodes: {
            '7:2': {
              document: {
                id: '7:2',
                name: 'Base',
                children: [
                  { id: '7:3', name: 'img-first' },
                  { id: '7:4', name: 'img-second' },
                ],
              },
            },
          },
        }),
      );
    return f.input.request(address, kind);
  };
  const options = { ...f.input, baseUrl, names: { '7:3': 'hero' }, request };
  await assert.rejects(prepareSlices(options));
  assert.deepEqual(f.saved, ['static/theme-page/hero.png']);
  f.healthy();
  f.calls.length = 0;
  const completed = await prepareSlices(options);
  assert.deepEqual(f.calls, ['2:2']);
  assert.equal(completed.manifest.themes[0].entries[0].filename, 'hero.png');
  f.calls.length = 0;
  await prepareSlices({ ...options, names: { '7:3': 'poster' } });
  assert.deepEqual(f.calls, ['2:1', '2:2'], 'names改变不能复用原断点');
  f.calls.length = 0;
  await prepareSlices({
    ...options,
    names: { '7:3': 'poster' },
    baseUrl: baseUrl.replace('baseKey', 'baseOther'),
  });
  assert.deepEqual(f.calls, ['2:1', '2:2'], '即使基线节点树相同，文件变了也不能复用');
  const partial = JSON.parse(
    await fs.readFile(
      path.join(f.input.workspace, '.d2c-cache/key/slice-partial-page.json'),
      'utf8',
    ),
  );
  assert.match(partial.design.baseUrl, /baseOther/);
  assert.equal(partial.design.names['7:3'], 'poster');
});

test('中文多主题与同批重名保持英文消歧、独立路径和原始图层名，重复调用复用各自断点', async (t) => {
  const f = await fixture(t);
  f.healthy();
  const request = async (address: string, kind: 'json' | 'image') => {
    const url = new URL(address);
    if (url.pathname.endsWith('/nodes'))
      return Buffer.from(
        JSON.stringify({
          version: 'v1',
          nodes: {
            '1:2': {
              document: {
                id: '1:2',
                name: '活动主题',
                children: [
                  { id: '2:1', name: 'img-背景' },
                  { id: '2:2', name: 'img-背景' },
                ],
              },
            },
          },
        }),
      );
    return f.input.request(address, kind);
  };
  for (const slug of ['warm', 'cool']) {
    const options = {
      ...f.input,
      slug,
      figmaUrl: `https://www.figma.com/design/${slug}Key/Theme?node-id=1-2`,
      request,
      names: { 'img-背景': 'hero' },
    };
    const result = await prepareSlices(options);
    const entries = result.manifest.themes[0].entries;
    assert.deepEqual(
      entries.map((e) => e.filename),
      ['hero.png', 'hero__2.png'],
    );
    assert.deepEqual(
      entries.map((e) => e.name),
      ['img-背景', 'img-背景'],
    );
    assert.deepEqual(
      entries.map((e) => e.filepath),
      [`static/theme-${slug}/hero.png`, `static/theme-${slug}/hero__2.png`],
    );
    for (const entry of entries)
      assert.ok((await fs.readFile(path.join(f.input.workspace, entry.filepath))).length > 0);
    f.calls.length = 0;
    assert.equal((await prepareSlices(options)).reused, true);
    assert.deepEqual(f.calls, [], '同主题重建调用逐项复核字节后复用');
  }
  assert.equal(f.saved.length, 4, '相同中文命名不会跨主题去重或覆盖');
  assert.equal(new Set(f.saved).size, 4);
});

test('未知中文在导出前要求语义英文映射，补齐后保存英文名而不改变原图层名', async (t) => {
  const f = await fixture(t);
  f.healthy();
  const request = f.input.request;
  const options = {
    ...f.input,
    request: async (address: string, kind: 'json' | 'image') => {
      if (new URL(address).pathname.endsWith('/nodes'))
        return Buffer.from(
          JSON.stringify({
            nodes: {
              '1:2': {
                document: { id: '1:2', name: 'Page', children: [{ id: '2:1', name: 'img-鹦鹉' }] },
              },
            },
          }),
        );
      return request(address, kind);
    },
  };
  await assert.rejects(prepareSlices(options), (error: unknown) => {
    assert.ok(error instanceof ToolIssue);
    assert.equal(error.feedback.action, 'adjust');
    assert.deepEqual(Reflect.get(error.feedback, 'needsNames'), [
      { nodeId: '2:1', name: 'img-鹦鹉', parentName: 'Page' },
    ]);
    return true;
  });
  assert.equal(f.calls.length, 0, '命名未完成前不请求任何图片导出');
  assert.equal(f.saved.length, 0);
  const result = await prepareSlices({ ...options, names: { '2:1': 'parrot' } });
  assert.equal(result.manifest.themes[0].entries[0].name, 'img-鹦鹉');
  assert.equal(result.manifest.themes[0].entries[0].filename, 'parrot.png');
  assert.deepEqual(f.saved, ['static/theme-page/parrot.png']);
});

/** 相同公开分类下仍能从后台区分请求结果和校验失败，正文不进入诊断。 */
test('切图诊断区分节点、导出地址、JSON与图片校验失败', async (t) => {
  for (const scenario of ['node', 'json', 'export', 'image'] as const) {
    const f = await fixture(t);
    f.healthy();
    const original = f.input.request;
    const content = Buffer.from(
      scenario === 'json' ? 'private-token invalid json' : '{"nodes":{}}',
    );
    if (scenario === 'image') f.useImage(Buffer.from('private invalid PNG'));
    f.input.request = async (address, kind) => {
      if (scenario === 'node' || scenario === 'json') return content;
      if (scenario === 'export' && new URL(address).pathname.startsWith('/v1/images/'))
        return Buffer.from('{"images":{}}');
      return original(address, kind);
    };
    await assert.rejects(prepareSlices(f.input), (error) => {
      assert.ok(error instanceof ToolIssue);
      const report = diagnoseRunFailure(error.failure);
      assert.equal(report.failure.code, 'FIGMA_REQUEST_FAILED');
      assert.equal(error.feedback.code, 'RESOURCE_UNAVAILABLE');
      assert.equal(
        report.diagnostics.slice?.reason,
        {
          node: 'NODE_MISSING',
          json: 'INVALID_JSON',
          export: 'EXPORT_URL_MISSING',
          image: 'INVALID_IMAGE',
        }[scenario],
      );
      assert.equal(
        report.diagnostics.slice?.nodeId,
        scenario === 'node' || scenario === 'json' ? '1:2' : '2:1',
      );
      assert.ok((report.diagnostics.slice?.bytes ?? 0) > 0);
      assert.doesNotMatch(JSON.stringify(report), /private|token|api\.figma|https:/);
      assert.equal('slice' in report.failure, false);
      return true;
    });
  }
});
