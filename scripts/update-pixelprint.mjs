import { sanitizeResources } from './sanitize-resources.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'pixelprint');
const source = 'https://github.com/double-coding-lab/PixelPrint.git';
const repair = process.argv.slice(2).includes('--repair');
if (process.argv.slice(2).some((arg) => arg !== '--repair'))
  throw new Error('只支持 --repair 参数');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pixelprint-sync-'));
const checkout = path.join(temporary, 'source');
const stage = await fs.mkdtemp(path.join(root, '.pixelprint-stage-'));
const backup = stage + '-previous';
let moved = false;
try {
  await git('git', ['clone', '--quiet', '--no-checkout', source, checkout], { timeout: 180000 });
  if (repair) {
    const previous = JSON.parse(await fs.readFile(path.join(destination, 'VERSION.json'), 'utf8'));
    if (previous.source !== source || !/^[a-f0-9]{40}$/.test(previous.sourceRevision))
      throw new Error('当前版本记录无效');
    await git('git', ['-C', checkout, 'checkout', '--quiet', '--detach', previous.sourceRevision]);
  } else await git('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'HEAD']);
  const { stdout } = await git('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  const sourceRevision = stdout.trim();
  const pkg = JSON.parse(await fs.readFile(path.join(checkout, 'package.json'), 'utf8'));
  /** 模板按完整目录同步，包含 Skill 引用的共享切图脚本；拒绝链接与特殊文件。 */
  async function verify(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error('模板包含非普通资源');
      if (entry.isDirectory()) await verify(path.join(directory, entry.name));
    }
  }
  const templates = path.join(checkout, 'templates');
  await verify(templates);
  await fs.cp(templates, path.join(stage, 'templates'), { recursive: true, errorOnExist: true });
  for (const required of [
    'pp-d2c/SKILL.md',
    'pp-d2c-rn/SKILL.md',
    'pp-d2c-reskin/reskin-slice.mjs',
    'pp-d2c-reskin/SLICE-CONTRACT.md',
  ])
    await fs.access(path.join(stage, 'templates/skills', required));
  await fs.writeFile(
    path.join(stage, 'VERSION.json'),
    JSON.stringify(
      { source, version: pkg.version, sourceRevision, updatedAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  await sanitizeResources(stage);
  await fs.rename(destination, backup);
  moved = true;
  try {
    await fs.rename(stage, destination);
  } catch (error) {
    await fs.rename(backup, destination);
    moved = false;
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true });
  moved = false;
  console.log(
    `PixelPrint 资源已${repair ? '按原修订补齐' : '更新'}：${pkg.version} (${sourceRevision})。旧工作区需要显式升级资源版本。`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
  if (!moved) await fs.rm(stage, { recursive: true, force: true });
}
