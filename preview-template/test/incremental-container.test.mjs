import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  cp,
  realpath,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

const template = fileURLToPath(new URL('..', import.meta.url));

/** 本地真实 Vite 使用独立执行根，验证固定脚本与常驻增量协议。 */
test('trusted cold build and serial incremental worker', { timeout: 90000 }, async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'preview-container-')));
  const roots = {
    '/tmp/work': `${temporary}/work`,
    '/input': `${temporary}/input`,
    '/output': `${temporary}/output`,
    '/control': `${temporary}/control`,
    '/opt/preview/node_modules': await realpath(`${template}/node_modules`),
    '/opt/preview/template': `${temporary}/template`,
  };
  const previousRoot = process.env.PIXELPRINT_PREVIEW_ROOT;
  process.env.PIXELPRINT_PREVIEW_ROOT = temporary;
  let controller;
  let worker;
  try {
    for (const directory of ['input', 'output', 'control', 'template'])
      await mkdir(`${temporary}/${directory}`);
    await cp(`${template}/src/main.tsx`, `${temporary}/template/main.tsx`);
    await cp(`${template}/index.html`, `${temporary}/template/index.html`);
    const { buildPreview, syncPreviewInput, validPreviewPath, validatePreviewOptions } =
      await import('../container/build.mjs');
    const { runWarmWorker, validateWarmRequest } = await import('../container/warm.mjs');
    const options = { target: 'h5', entry: 'page.tsx', unit: 'px', rawBase: 750 };
    const request = (extra = {}) => ({
      id: randomUUID(),
      target: 'h5',
      entryPath: 'page.tsx',
      unit: { outputUnit: 'px', outputBase: 750 },
      ...extra,
    });
    /** 输出所有分块，确保缓存没有保留上一轮源码/样式/图片内容。 */
    async function output(directory = roots['/output']) {
      let content = '';
      for (const item of await readdir(directory, { withFileTypes: true }))
        content += item.isDirectory()
          ? await output(path.join(directory, item.name))
          : await readFile(path.join(directory, item.name), 'utf8');
      return content;
    }
    /** 有界等待控制文件条件，轮询间隔与生产协议一致。 */
    async function waitFor(name, predicate) {
      for (let index = 0; index < 1200; index++) {
        try {
          const result = JSON.parse(await readFile(`${temporary}/control/${name}.json`, 'utf8'));
          if (predicate(result)) return result;
        } catch {}
        await setTimeout(25);
      }
      throw new Error(`Timed out waiting for ${name}`);
    }
    /** 使用宿主原子 staging 协议发送单个请求。 */
    async function send(value) {
      await writeFile(`${temporary}/control/request.json`, JSON.stringify(value));
      return waitFor('result', (result) => result.id === value.id);
    }

    await t.test('strict paths, units, request fields and safe import', async () => {
      assert.equal(await stat(roots['/tmp/work']).catch(() => null), null);
      for (const entry of [
        '../page.tsx',
        '/page.tsx',
        'node_modules/a.tsx',
        '.env',
        'config/a.tsx',
        'vite.config.ts',
        'a\\b.tsx',
      ])
        assert.equal(validPreviewPath(entry), false);
      for (const change of [
        { target: 'web' },
        { entry: 'a.svg' },
        { rawBase: Infinity },
        { rawBase: 0 },
      ])
        assert.throws(() => validatePreviewOptions({ ...options, ...change }));
      for (const value of [
        request({ id: 'invalid' }),
        request({ extra: true }),
        request({ unit: { outputUnit: 'px', outputBase: '750' } }),
      ])
        assert.throws(() => validateWarmRequest(value));
    });
    await writeFile(
      `${temporary}/input/page.tsx`,
      'import "./style.scss"; export default function Page(){return <div>COLD_SENTINEL</div>}',
    );
    await writeFile(
      `${temporary}/input/style.scss`,
      '@use "./colors"; .page{width:750px;color:colors.$color}',
    );
    await writeFile(`${temporary}/input/_colors.scss`, '$color: red;');
    await writeFile(`${temporary}/input/removed.ts`, 'export const removed = true;');
    await mkdir(`${temporary}/input/static`);
    await writeFile(`${temporary}/input/static/old.svg`, '<svg>OLD_ASSET</svg>');
    await t.test(
      'cold production output, unchanged mtime, changed and removed assets',
      async () => {
        await buildPreview(options);
        assert.match(await output(), /COLD_SENTINEL/);
        assert.match(await output(), /100vw/);
        const before = (await stat(`${temporary}/work/page.tsx`)).mtimeMs;
        await syncPreviewInput('page.tsx');
        assert.equal((await stat(`${temporary}/work/page.tsx`)).mtimeMs, before);
        await rm(`${temporary}/input/removed.ts`);
        await rm(`${temporary}/input/static/old.svg`);
        await writeFile(`${temporary}/input/static/new.svg`, '<svg>NEW_ASSET</svg>');
        await syncPreviewInput('page.tsx');
        assert.equal(await stat(`${temporary}/work/public/static/old.svg`).catch(() => null), null);
        assert.match(
          await readFile(`${temporary}/work/public/static/new.svg`, 'utf8'),
          /NEW_ASSET/,
        );
      },
    );
    await t.test(
      'real watch cache, serial results, recovery and configuration cache keys',
      async () => {
        const calls = [];
        controller = new AbortController();
        worker = runWarmWorker({
          signal: controller.signal,
          compile: async (input) => {
            calls.push(input);
            const cache = await buildPreview(input);
            assert.ok(cache.modules.length > 0);
            return cache;
          },
        });
        assert.deepEqual(await waitFor('ready', () => true), { protocol: 1 });
        assert.equal((await send(request())).incremental, false);
        await writeFile(
          `${temporary}/input/page.tsx`,
          'import "./style.scss"; export default function Page(){return <div>WARM_SENTINEL</div>}',
        );
        await writeFile(`${temporary}/input/_colors.scss`, '$color: blue;');
        const second = request();
        assert.equal((await send(second)).incremental, true);
        assert.ok(calls[1].cache.modules.length > 0);
        assert.match(await output(), /WARM_SENTINEL/);
        assert.doesNotMatch(await output(), /COLD_SENTINEL/);
        assert.match(await output(), /blue/);
        await setTimeout(100);
        assert.equal(calls.length, 2);
        assert.equal(
          (await send(request({ unit: { outputUnit: 'vw', outputBase: 375 } }))).incremental,
          false,
        );
        assert.equal(calls.at(-1).cache, undefined);
        await writeFile(`${temporary}/input/page.tsx`, 'export default <PRIVATE_SOURCE_BROKEN');
        const failed = await send(request());
        assert.equal(failed.ok, false);
        assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_SOURCE|stack|stderr/);
        await writeFile(
          `${temporary}/input/page.tsx`,
          'export default function Page(){return <div>RECOVERED</div>}',
        );
        const recovered = await send(request());
        assert.equal(recovered.ok, true);
        assert.equal(recovered.incremental, false);
        const invalid = await send(request({ target: 'bad' }));
        assert.equal(invalid.ok, false);
        assert.equal((await send(request())).incremental, false);
        assert.equal((await send(request({ target: 'rn' }))).incremental, false);
        await cp(`${temporary}/input/page.tsx`, `${temporary}/input/other.tsx`);
        assert.equal(
          (await send(request({ target: 'rn', entryPath: 'other.tsx' }))).incremental,
          false,
        );
        await writeFile(
          `${temporary}/input/other.tsx`,
          'const image = require("./static/new.svg"); export default function Page(){return <img src={image.uri}/>}',
        );
        const rnRequest = { target: 'rn', entryPath: 'other.tsx' };
        assert.equal((await send(request(rnRequest))).incremental, true);
        assert.match(await output(), /NEW_ASSET/);
        await writeFile(`${temporary}/input/static/new.svg`, '<svg>CHANGED_ASSET</svg>');
        assert.equal((await send(request(rnRequest))).incremental, true);
        assert.match(await output(), /CHANGED_ASSET/);
        assert.doesNotMatch(await output(), /NEW_ASSET/);
        controller.abort();
        await worker;
        worker = undefined;
      },
    );
    await t.test('CLI keeps positional cold entrypoint and sanitized failure output', async () => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const buildFile = fileURLToPath(new URL('../container/build.mjs', import.meta.url));
      const script = `
                import { pathToFileURL } from 'node:url';
        process.argv = ['node', ${JSON.stringify(buildFile)}, 'h5', process.argv[1], 'px', '750'];
        await import(pathToFileURL(${JSON.stringify(buildFile)}).href);
      `;
      const success = await run(process.execPath, [
        '--input-type=module',
        '--eval',
        script,
        'page.tsx',
      ]);
      assert.equal(success.stdout, '');
      assert.equal(success.stderr, '');
      assert.match(await output(), /RECOVERED/);
      await assert.rejects(
        run(process.execPath, ['--input-type=module', '--eval', script, '../PRIVATE_SOURCE.tsx']),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /^PIXELPRINT_PREVIEW_DIAGNOSTIC:/);
          assert.doesNotMatch(error.stderr, /PRIVATE_SOURCE|stack|at file:/);
          return true;
        },
      );
    });
    await t.test('reject config, symlink and special/oversized input before copying', async () => {
      await writeFile(`${temporary}/input/vite.config.js`, 'throw new Error("UNTRUSTED")');
      await assert.rejects(syncPreviewInput('page.tsx'), /PREVIEW_INVALID_INPUT/);
      await rm(`${temporary}/input/vite.config.js`);
      await symlink('/etc/passwd', `${temporary}/input/unsafe.ts`);
      await assert.rejects(syncPreviewInput('page.tsx'), /PREVIEW_INVALID_INPUT/);
      await rm(`${temporary}/input/unsafe.ts`);
      const { execFileSync } = await import('node:child_process');
      execFileSync('mkfifo', [`${temporary}/input/pipe.ts`]);
      await assert.rejects(syncPreviewInput('page.tsx'), /PREVIEW_INVALID_INPUT/);
      await rm(`${temporary}/input/pipe.ts`);
      const { open } = await import('node:fs/promises');
      const file = await open(`${temporary}/input/huge.ts`, 'w');
      await file.truncate(64 * 1024 * 1024 + 1);
      await file.close();
      await assert.rejects(syncPreviewInput('page.tsx'), /PREVIEW_INVALID_INPUT/);
    });
  } finally {
    controller?.abort();
    if (worker) await worker;
    if (previousRoot === undefined) delete process.env.PIXELPRINT_PREVIEW_ROOT;
    else process.env.PIXELPRINT_PREVIEW_ROOT = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
