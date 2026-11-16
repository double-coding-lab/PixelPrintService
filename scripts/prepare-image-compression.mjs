import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipEnvironment } from './pip-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'image-compression');

/** 只在安装或镜像构建阶段准备固定 Pillow；请求处理期间不下载依赖。 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error || result.status !== 0)
    throw new Error('图片压缩环境准备失败，请检查 Python 3.9+、venv/pip 与Python 包源。');
}

try {
  const available = spawnSync('python3', ['-c', 'import venv, ensurepip'], { cwd: root });
  if (available.error || available.status !== 0) {
    if (process.platform !== 'linux')
      throw new Error('请先安装 Python 3.9+（包含 venv/pip），再执行 npm run prepare:images。');
    const manager = ['dnf', 'microdnf', 'yum', 'apt-get'].find(
      (name) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0,
    );
    if (!manager) throw new Error('请在应用基础镜像安装 Python 3.9+ 和 venv/pip。');
    const packages =
      manager === 'apt-get'
        ? ['python3', 'python3-venv', 'python3-pip']
        : ['python3', 'python3-pip'];
    if (manager === 'apt-get') run(manager, ['update']);
    run(manager, ['install', '-y', ...packages]);
  }
  run('python3', ['-m', 'venv', path.join(directory, '.venv')]);
  const python = path.join(directory, '.venv', 'bin', 'python3');
  run(
    python,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-r',
      path.join(directory, 'requirements.txt'),
    ],
    pipEnvironment(),
  );
  run(python, [
    '-I',
    '-c',
    'from PIL import Image; print("[image-compression] Pillow", Image.__version__)',
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
