import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, copyFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import test from 'node:test';

/** 初始化仅使用临时目录，验证密钥生成、Docker 地址和已有文件保护。 */
test('setup generates usable private configuration and never overwrites it', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pixelprint-setup-'));
  try {
    await copyFile(
      new URL('../project.config.example.json', import.meta.url),
      path.join(cwd, 'project.config.example.json'),
    );
    const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
    const env = { ...process.env };
    for (const name of ['PIXELPRINT_CONFIG', 'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY'])
      delete env[name];
    const output = execFileSync(process.execPath, [script, '--docker', '--user', 'alice'], {
      cwd,
      env,
      encoding: 'utf8',
    });
    const filename = path.join(cwd, 'project.config.json');
    const initial = await readFile(filename, 'utf8');
    const config = JSON.parse(initial);
    const { parseD2cRuntimeConfig } = await import('../src/config/d2c');
    assert.equal(parseD2cRuntimeConfig(config.runtime).modelConfigs.length, 1);
    assert.equal(config.runtime.d2c.limits.textFileBytes, 100 * 1024 * 1024);
    assert.equal(config.runtime.d2c.limits.uploadBytes, 30000000);
    assert.equal(config.database.host, 'mysql');
    assert.equal(config.redis.url, 'redis://redis:6379');
    assert.equal(config.auth.users[0].id, 'alice');
    assert.equal(config.auth.sessionSecret.length, 64);
    assert.equal(config.runtime.d2c.secrets.keys.primary.length, 64);
    assert.notEqual(config.auth.sessionSecret, config.runtime.d2c.secrets.keys.primary);
    const password = output.match(/一次性显示的密码：(\S+)/)?.[1];
    assert.ok(password);
    const [, salt, hash] = config.auth.users[0].passwordHash.split('$');
    assert.ok(timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hash, 'hex')));
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    execFileSync(process.execPath, [script, '--user', 'other'], { cwd, env, stdio: 'pipe' });
    assert.equal(await readFile(filename, 'utf8'), initial);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
