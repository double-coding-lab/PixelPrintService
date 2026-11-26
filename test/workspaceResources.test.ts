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

/** 复现社区发布目录，缺少可选扩展不影响创建，核心资源及显式路径仍严格检查。 */
test('community template loads without optional extensions and rejects broken required resources', async (t) => {
  const previous = process.cwd();
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'community-template-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'pixelprint');
  await fs.cp(path.resolve('pixelprint'), root, { recursive: true });
  process.chdir(directory);
  try {
    const core = await readTemplateResources(root);
    assert.ok(core.files.some((file) => file.path === 'templates/skills/pp-d2c/SKILL.md'));
    assert.ok(!core.files.some((file) => file.path.startsWith('platform-skills/')));
    await assert.rejects(readTemplateResources(root, path.join(directory, 'missing')), {
      code: 'ENOENT',
    });
    await fs.mkdir('skills');
    await fs.writeFile('skills/demo.md', 'platform extension');
    const extended = await readTemplateResources(root);
    assert.ok(extended.files.some((file) => file.path === 'platform-skills/demo.md'));
    assert.notEqual(core.hash, extended.hash);
    assert.equal(validateResourceBundle(core).hash, core.hash);
    await fs.rm('skills', { recursive: true });
    await fs.symlink(root, 'skills', 'dir');
    await assert.rejects(readTemplateResources(root), /符号链接/);
    await fs.unlink('skills');
    await fs.unlink(path.join(root, 'templates/skills/pp-d2c/bin/figma.mjs'));
    await assert.rejects(readTemplateResources(root), /缺少模板资源/);
  } finally {
    process.chdir(previous);
  }
});

/** cwd中的同名扩展不属于发布包，不能被意外冻结进用户工作区。 */
test('default platform extensions follow the template deployment instead of process cwd', async (t) => {
  const previous = process.cwd();
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'template-location-')),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'deployment/pixelprint');
  await fs.cp(path.resolve('pixelprint'), root, { recursive: true });
  await fs.mkdir(path.join(directory, 'foreign/skills'), { recursive: true });
  await fs.writeFile(path.join(directory, 'foreign/skills/unrelated.md'), 'unrelated cwd resource');
  process.chdir(path.join(directory, 'foreign'));
  try {
    const bundle = await readTemplateResources(root);
    assert.ok(!bundle.files.some((file) => file.path.startsWith('platform-skills/')));
  } finally {
    process.chdir(previous);
  }
});
