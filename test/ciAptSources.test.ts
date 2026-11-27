import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('CI apt preparation only disables Microsoft list/source files, retains Ubuntu and signed checks, and is idempotent', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pixelprint-ci-apt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ubuntu =
    'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
  await writeFile(path.join(dir, 'ubuntu.sources'), ubuntu);
  await writeFile(
    path.join(dir, 'microsoft-prod.list'),
    'deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n',
  );
  await writeFile(
    path.join(dir, 'optional.sources'),
    'Types: deb\nURIs: https://packages.microsoft.com/ubuntu/24.04/prod\n',
  );
  await writeFile(
    path.join(dir, 'lookalike.list'),
    'deb https://packages.microsoft.com.example.invalid/prod noble main\n',
  );
  await writeFile(
    path.join(dir, 'comments.list'),
    '# See https://packages.microsoft.com/documentation\n',
  );
  await symlink(path.join(dir, 'microsoft-prod.list'), path.join(dir, 'linked.list'));
  for (let i = 0; i < 2; i++) execFileSync('python3', ['scripts/prepare-ci-apt.py', dir]);
  assert.equal(await readFile(path.join(dir, 'ubuntu.sources'), 'utf8'), ubuntu);
  const files = await readdir(dir);
  for (const name of [
    'microsoft-prod.list.disabled',
    'optional.sources.disabled',
    'ubuntu.sources',
    'lookalike.list',
    'linked.list',
    'comments.list',
  ])
    assert.ok(files.includes(name));
  assert.ok(!files.includes('microsoft-prod.list'));
});
