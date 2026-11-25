import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readTemplateResources,
  validateResourceBundle,
} from '../src/functions/d2c/workspace/resources';

/** 使用独立模板与平台资源目录，不依赖部署目录或连接外部服务。 */
test('RN新资源使用pages，旧冻结包与自定义根目录保持原配置', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rn-output-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'pixelprint');
  const skills = path.join(directory, 'skills');
  await fs.cp(path.resolve('pixelprint'), root, { recursive: true });
  await fs.mkdir(skills);
  const filename = path.join(root, 'templates/pp-d2c.rn.config.json');
  const config = JSON.parse(await fs.readFile(filename, 'utf8'));
  config.output.dir = 'src/pages/';
  await fs.writeFile(filename, JSON.stringify(config));
  const fresh = await readTemplateResources(root, skills);
  assert.equal(fresh.defaultConfigs.rn.output.dir, 'pages/');
  const entry = fresh.files.find((file) => file.path === 'templates/pp-d2c.rn.config.json')!;
  assert.equal(JSON.parse(Buffer.from(entry.content, 'base64').toString()).output.dir, 'pages/');
  const oldFiles = structuredClone(fresh.files);
  oldFiles.find((file) => file.path === entry.path)!.content = Buffer.from(
    JSON.stringify(config),
  ).toString('base64');
  const frozen = validateResourceBundle({ format: 1, files: oldFiles });
  assert.equal(validateResourceBundle(frozen).defaultConfigs.rn.output.dir, 'src/pages/');
  assert.notEqual(frozen.hash, fresh.hash);
  config.output.dir = 'custom/screens/';
  await fs.writeFile(filename, JSON.stringify(config));
  assert.equal(
    (await readTemplateResources(root, skills)).defaultConfigs.rn.output.dir,
    'custom/screens/',
  );
});
