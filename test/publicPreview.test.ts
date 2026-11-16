import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { previewEngine } from '../src/functions/d2c/preview/engine';
import { collectPreviewOutput, runPreviewBuild } from '../src/functions/d2c/preview/runner';
import { previewProcessEnv } from '../src/functions/d2c/preview/localProcess';
import { createWarmPreviewRunner } from '../src/functions/d2c/preview/warmRunner';

const temporary = await mkdtemp(path.join(tmpdir(), 'public-preview-test-'));
const configFile = path.join(temporary, 'project.config.json');
const sample = JSON.parse(await readFile('project.config.example.json', 'utf8'));
sample.auth.sessionSecret = 'preview-offline-test-secret-32-bytes';
sample.auth.users = [{ id: 'preview-test', name: 'Preview test', passwordHash: 'scrypt$test' }];
sample.server.publicUrl = 'http://localhost:8080';
sample.storage.publicUrl = 'http://localhost:8080/files/';
await writeFile(configFile, JSON.stringify(sample));
const previousConfig = process.env.PIXELPRINT_CONFIG;
process.env.PIXELPRINT_CONFIG = configFile;
const { projectConfig } = await import('../src/config/project');
const { previewAssetBase } = await import('../src/functions/d2c/preview/assetPolicy');
const { runPreviewCapture } = await import('../src/functions/d2c/preview/capture');
after(async () => {
  if (previousConfig === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = previousConfig;
  await rm(temporary, { recursive: true, force: true });
});

/** 固定输入不读取外部服务，不要求数据库、Redis、执行平台或容器 daemon。 */
function input(source = 'export default function Page(){return <div>offline-first</div>}') {
  return {
    target: 'h5' as 'h5' | 'rn',
    entryPath: 'page.tsx',
    unit: { outputUnit: 'px' as const, outputBase: 750 },
    signal: new AbortController().signal,
    files: [{ path: 'page.tsx', content: Buffer.from(source) }],
  };
}

/** 递归读取受控源码目录，用于防止重新引入私有执行平台和下载源。 */
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.browsers', 'dist', 'test'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

test('preview ships one local engine and no enterprise execution or private download sources', async () => {
  assert.equal(previewEngine, 'local');
  const files = [
    ...(await sourceFiles('src/functions/d2c/preview')),
    ...(await sourceFiles('preview-template')),
    ...(await sourceFiles('preview-browser')),
    'scripts/prepare-preview.mjs',
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /previewSandbox|getPreviewSandboxConfig|configurePreviewSandbox|sandboxClient|sandboxRunner|dockerRunner|dockerCapture|dockerWarmRunner|enterprise.*dockerimage/i,
      file,
    );
  }
  assert.equal(existsSync('src/functions/d2c/preview/sandboxClient.ts'), false);
  assert.equal(existsSync('src/functions/d2c/preview/dockerRunner.ts'), false);
});

test('prepare installs public locked dependencies without engine config or Docker', async () => {
  const bin = path.join(temporary, 'bin');
  const log = path.join(temporary, 'commands.log');
  await mkdir(bin);
  for (const name of ['npm', 'sh']) {
    await writeFile(
      path.join(bin, name),
      '#!/bin/sh\nprintf "%s|%s|%s\\n" "$PWD" "$npm_config_registry" "$*" >> "$PREVIEW_TEST_LOG"\n',
      { mode: 0o755 },
    );
  }
  const result = spawnSync(process.execPath, ['scripts/prepare-preview.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin, PREVIEW_TEST_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(log, 'utf8')).trim().split('\n');
  assert.equal(commands.length, 3);
  assert.match(commands[0], /preview-template\|https:\/\/registry\.npmjs\.org\/\|ci /);
  assert.match(commands[1], /preview-browser\|https:\/\/registry\.npmjs\.org\/\|ci /);
  assert.match(commands[2], /preview-browser\/build\.sh$/);
  await writeFile(log, '');
  const browser = spawnSync(process.execPath, ['scripts/prepare-preview.mjs', '--browser-only'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin, PREVIEW_TEST_LOG: log },
  });
  assert.equal(browser.status, 0, browser.stderr);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
  const invalid = spawnSync(process.execPath, ['scripts/prepare-preview.mjs', '--unknown'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin, PREVIEW_TEST_LOG: log },
  });
  assert.equal(invalid.status, 1);
});

test('source/output validation and cancellation protect the local build boundary', async () => {
  await assert.rejects(runPreviewBuild({ ...input(), entryPath: '../escape.tsx' }), {
    reason: 'PREVIEW_INVALID_INPUT',
  });
  await assert.rejects(runPreviewBuild({ ...input(), signal: AbortSignal.abort() }), {
    reason: 'PREVIEW_BUILD_CANCELLED',
  });
  await assert.rejects(
    runPreviewBuild({
      ...input(),
      files: [...input().files, { path: 'vite.config.ts', content: Buffer.from('throw Error()') }],
    }),
    { reason: 'PREVIEW_INVALID_INPUT' },
  );
  const output = path.join(temporary, 'linked-output');
  await mkdir(output);
  await writeFile(path.join(output, 'index.html'), '<html></html>');
  await symlink(configFile, path.join(output, 'secret.json'));
  await assert.rejects(collectPreviewOutput(output), { reason: 'PREVIEW_BUILD_FAILED' });
  const prior = process.env.PREVIEW_TEST_SECRET;
  process.env.PREVIEW_TEST_SECRET = 'must-not-reach-worker';
  try {
    assert.equal(previewProcessEnv().PREVIEW_TEST_SECRET, undefined);
    assert.equal(previewProcessEnv().NODE_OPTIONS, undefined);
    assert.equal(previewProcessEnv().HTTPS_PROXY, undefined);
  } finally {
    if (prior === undefined) delete process.env.PREVIEW_TEST_SECRET;
    else process.env.PREVIEW_TEST_SECRET = prior;
  }
});

test(
  'H5 cold builds and warm edits replace stale output using real local Vite',
  { timeout: 90000 },
  async (t) => {
    if (!existsSync('preview-template/node_modules/vite'))
      return t.skip('run npm run prepare:preview first');
    const cold = await runPreviewBuild(input());
    assert.ok(cold.some((file) => file.path === 'index.html'));
    assert.ok(cold.some((file) => file.content.includes('offline-first')));
    const manager = createWarmPreviewRunner({ maxContexts: 1 });
    try {
      const first = await manager.run('offline-edit', input());
      assert.equal(manager.lastIncremental, false);
      const second = await manager.run(
        'offline-edit',
        input('export default function Page(){return <div>offline-updated</div>}'),
      );
      assert.equal(manager.lastIncremental, true);
      assert.ok(second.some((file) => file.content.includes('offline-updated')));
      assert.ok(second.every((file) => !file.content.includes('offline-first')));
      assert.notDeepEqual(
        second.map((file) => file.path),
        first.map((file) => file.path),
      );
      await manager.release('offline-edit');
      await manager.run('offline-edit', input());
      assert.equal(manager.lastIncremental, false);
    } finally {
      await manager.close();
    }
  },
);

test(
  'RN Web cold build retains StyleSheet and image compatibility',
  { timeout: 90000 },
  async (t) => {
    if (!existsSync('preview-template/node_modules/vite'))
      return t.skip('run npm run prepare:preview first');
    const page = input(
      "import {View, Text, StyleSheet} from 'react-native'; const styles=StyleSheet.create({box:{padding:12}}); export default function Page(){return <View style={styles.box}><Text>offline-native</Text></View>}",
    );
    page.target = 'rn';
    const output = await runPreviewBuild(page);
    assert.ok(output.some((file) => file.path === 'index.html'));
    assert.ok(output.some((file) => file.content.includes('offline-native')));
  },
);

test('asset policy follows public local/S3 storage and rejects credential injection', () => {
  const previous = projectConfig.storage.publicUrl;
  try {
    projectConfig.storage.publicUrl = 'https://assets.example.test/bucket';
    assert.equal(previewAssetBase(), 'https://assets.example.test/bucket/');
    projectConfig.storage.publicUrl = '';
    assert.equal(previewAssetBase(), 'http://localhost:8080/files/');
    for (const url of [
      'https://user:password@assets.example.test/',
      'file:///etc/',
      'https://assets.example.test/?token=secret',
    ]) {
      projectConfig.storage.publicUrl = url;
      assert.throws(previewAssetBase, /PREVIEW_ASSET_CONFIG_INVALID/);
    }
  } finally {
    projectConfig.storage.publicUrl = previous;
  }
});

test(
  'real Chromium screenshots keep opaque CSP and block unlisted external network',
  { timeout: 90000 },
  async (t) => {
    if (!existsSync('preview-browser/.browsers'))
      return t.skip('run npm run prepare:preview first');
    const html = Buffer.from(
      '<!doctype html><html><body><script src="./page.js"></script><img src="https://blocked.example.test/no.png"></body></html>',
    );
    const script = Buffer.from(
      "document.body.dataset.origin=location.origin; fetch('https://blocked.example.test/secret').catch(()=>{}); if(window.origin !== 'null') throw Error('not opaque'); const proof=new Image(); proof.src='https://blocked.example.test/opaque-ok.png'; document.body.append(proof);",
    );
    const requests: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests.push(String(url));
      throw new Error('offline test must not fetch');
    }) as typeof fetch;
    try {
      const result = await runPreviewCapture({
        target: 'h5',
        signal: new AbortController().signal,
        width: 375,
        files: [
          { path: 'index.html', content: html, mimeType: 'text/html; charset=utf-8' },
          { path: 'page.js', content: script, mimeType: 'text/javascript; charset=utf-8' },
        ],
      });
      assert.equal(result.image.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.equal(result.width, 375);
      assert.equal(
        result.errors.some((error) => error.code === 'PAGE_RUNTIME_ERROR'),
        false,
      );
      assert.ok(result.missingAssets.includes('https://blocked.example.test/no.png'));
      assert.ok(result.missingAssets.includes('https://blocked.example.test/opaque-ok.png'));
      assert.deepEqual(requests, []);
    } finally {
      globalThis.fetch = previous;
    }
  },
);

test('asset gateway retains HTML sandbox, nonce inspector and authenticated asset lookup', async () => {
  const { default: Fastify } = await import('fastify');
  const { installPreview } = await import('../src/functions/d2c/preview/runtime');
  const calls: unknown[][] = [];
  const service = {
    async asset(...args: unknown[]) {
      calls.push(args);
      return {
        content: Buffer.from('<!doctype html><html><body>preview</body></html>'),
        mimeType: 'text/html; charset=utf-8',
      };
    },
  };
  const app = Fastify();
  installPreview(app, {
    worker: false,
    service: service as unknown as import('../src/functions/d2c/preview/service').PreviewService,
  });
  try {
    const html = await app.inject('/H5_Preview/preview-test/ticket-test/index.html');
    assert.equal(html.statusCode, 200);
    const csp = String(html.headers['content-security-policy']);
    assert.match(csp, /^sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /img-src .*http:\/\/localhost:8080\/files\//);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.ok(html.body.includes(`nonce="${nonce}"`));
    assert.match(html.body, /pixelprint:inspect/);
    assert.deepEqual(calls[0], ['h5', 'preview-test', 'ticket-test', 'index.html']);
    const script = await app.inject(
      '/H5_Preview/preview-test/ticket-test/__pixelprint_tools/eruda-3.4.3.js',
    );
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /text\/javascript/);
    assert.deepEqual(calls[1], ['h5', 'preview-test', 'ticket-test', 'index.html']);
    assert.equal(
      (await app.inject('/RN_Preview/preview-test/ticket-test/.private')).statusCode,
      404,
    );
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});

test(
  'screenshot prefetch is restricted to the configured storage prefix and omits credentials',
  { timeout: 90000 },
  async (t) => {
    if (!existsSync('preview-browser/.browsers'))
      return t.skip('run npm run prepare:preview first');
    const previous = globalThis.fetch;
    const requests: string[] = [];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLe8AAAAASUVORK5CYII=',
      'base64',
    );
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      requests.push(String(url));
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      assert.deepEqual(options?.headers, { Accept: 'image/*' });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    try {
      const result = await runPreviewCapture({
        target: 'h5',
        signal: new AbortController().signal,
        files: [
          {
            path: 'index.html',
            mimeType: 'text/html; charset=utf-8',
            content: Buffer.from(
              '<html><body><img src="http://localhost:8080/files/ok.png"><img src="http://localhost:8080/admin/blocked.png"><img src="http://localhost:8080/files-evil/no.png"><img src="http://localhost:8080/files/../admin/no.png"><img src="http://localhost:8080/files/%2e%2e%2fadmin/no.png"><img src="http://localhost:8080@blocked.example.test/files/no.png"></body></html>',
            ),
          },
        ],
      });
      assert.deepEqual(requests, ['http://localhost:8080/files/ok.png']);
      assert.ok(!result.missingAssets.includes('http://localhost:8080/files/ok.png'));
      assert.ok(result.missingAssets.includes('http://localhost:8080/admin/blocked.png'));
      assert.equal(result.mimeType, 'image/png');
    } finally {
      globalThis.fetch = previous;
    }
  },
);
