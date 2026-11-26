import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const release = 'a'.repeat(40);
const script = path.resolve('scripts/deploy-server.sh');
const runtimeFiles = [
  'Dockerfile',
  'package.json',
  'preview-template/package.json',
  'preview-browser/package.json',
  'package-lock.json',
  'preview-template/package-lock.json',
  'preview-browser/package-lock.json',
  'image-compression/requirements.txt',
  'scripts/prepare-image-compression.mjs',
  'scripts/pip-environment.mjs',
  'scripts/prepare-preview.mjs',
  'preview-browser/build.sh',
];

/** Exercise the actual deploy script with isolated command boundaries; no SSH or live Docker. */
async function fixture(
  t: any,
  options: { stale?: boolean; healthFailure?: boolean; badArchive?: boolean } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'pixelprint-deploy smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const source = path.join(root, 'source');
  const build = path.join(root, 'build');
  for (const dir of [app, bin, source, path.join(app, '.runtime'), path.join(build, 'dist/public')])
    await mkdir(dir, { recursive: true });
  for (const file of runtimeFiles) {
    await mkdir(path.dirname(path.join(app, file)), { recursive: true });
    await writeFile(path.join(app, file), '{}');
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), '{}');
  }
  await copyFile('scripts/runtime-signature.sh', path.join(app, 'scripts/runtime-signature.sh'));
  await copyFile('scripts/runtime-signature.sh', path.join(source, 'scripts/runtime-signature.sh'));
  await writeFile(path.join(source, 'fixture.txt'), 'source');
  await writeFile(path.join(build, 'dist/index.js'), 'console.log("fixture")');
  await writeFile(path.join(build, 'dist/public/index.html'), '<html></html>');
  await writeFile(
    path.join(build, 'dist/release.json'),
    JSON.stringify({ commit: options.badArchive ? 'b'.repeat(40) : release }),
  );
  const archive = path.join(root, 'build.tgz');
  execFileSync('tar', ['-czf', archive, '-C', build, 'dist'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const log = path.join(root, 'events');
  await writeFile(log, '');
  async function executable(name: string, body: string) {
    await writeFile(path.join(bin, name), '#!/bin/sh\nset -eu\n' + body + '\n', { mode: 0o755 });
  }
  await executable(
    'git',
    `case "$1" in
    fetch|merge) exit 0 ;;
    rev-parse) printf '%s\\n' "$TEST_MAIN_SHA" ;;
    archive) exec tar -cf - -C "$TEST_SOURCE" . ;;
    *) exit 91 ;;
  esac`,
  );
  await executable(
    'docker',
    `printf '%s\\n' "$*" >> "$TEST_LOG"
  case "$1" in
    inspect) echo sha256:111111 ;;
    image) case "$2" in inspect) echo sha256:222222 ;; esac ;;
    compose) case "$*" in *'ps -q app'*) echo fixture-container ;; esac ;;
  esac`,
  );
  await executable('curl', '[ "${TEST_HEALTH_FAIL:-0}" = 0 ]');
  await executable('sleep', 'exit 0');
  // macOS has no flock; this substitute only models the lock boundary, not lock correctness.
  await executable('flock', 'exit 0');
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    PIXELPRINT_DEPLOY_DIR: app,
    TEST_SOURCE: source,
    TEST_LOG: log,
    TEST_MAIN_SHA: options.stale ? 'b'.repeat(40) : release,
    TEST_HEALTH_FAIL: options.healthFailure ? '1' : '0',
  };
  const signature = execFileSync('bash', ['scripts/runtime-signature.sh'], {
    cwd: app,
    encoding: 'utf8',
    env,
  });
  await writeFile(path.join(app, '.runtime/runtime-signature'), signature);
  await writeFile(path.join(app, '.runtime/runtime-image'), 'sha256:111111');
  const run = () =>
    spawnSync('bash', [script, release], {
      input: execFileSync('cat', [archive]),
      encoding: 'utf8',
      env,
      timeout: 15000,
    });
  return { app, log, run };
}

test('deployment refuses invalid commit input before reading an archive', () => {
  const result = spawnSync('bash', [script, 'main;echo unexpected'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});
test('stale queued release does not build or restart the app', async (t) => {
  const f = await fixture(t, { stale: true });
  assert.equal(f.run().status, 0);
  assert.equal(await readFile(f.log, 'utf8'), '');
});
test('archive with another commit never reaches image build', async (t) => {
  const f = await fixture(t, { badArchive: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(f.log, 'utf8'), '');
});
test('healthy release records the exact commit after template checks and activation', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const events = await readFile(f.log, 'utf8');
  assert.match(events, /run --rm --entrypoint npm .* run check:templates/);
  assert.match(events, /up -d --no-build app/);
  assert.equal(
    (await readFile(path.join(f.app, '.runtime/deployed-commit'), 'utf8')).trim(),
    release,
  );
});
test('failed health check restores the previous image without recording success', async (t) => {
  const f = await fixture(t, { healthFailure: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(
    await readFile(path.join(f.app, '.runtime/compose.release.yaml'), 'utf8'),
    /image: pixelprint-app:rollback-/,
  );
  assert.match(result.stderr, /restoring previous app image/);
});
