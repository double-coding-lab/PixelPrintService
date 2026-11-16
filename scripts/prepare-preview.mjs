import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmRegistry = 'https://registry.npmjs.org/';
const installEnv = { ...process.env, npm_config_registry: npmRegistry };

/** 构建阶段安装固定公开依赖，运行时只执行已安装的本地编译器与浏览器。 */
function run(command, args, cwd = root) {
  console.log(`[preview] ${path.relative(root, cwd) || '.'}: ${command} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: installEnv });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`预览环境准备失败：${command} (${code})`)),
    );
  });
}

try {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--browser-only')) {
    throw new Error('只支持 --browser-only 参数');
  }
  const directories = args.includes('--browser-only')
    ? ['preview-browser']
    : ['preview-template', 'preview-browser'];
  for (const directory of directories) {
    await run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--include=dev', '--no-audit', '--no-fund', `--registry=${npmRegistry}`],
      path.join(root, directory),
    );
  }
  await run('sh', ['preview-browser/build.sh']);
  console.log('[preview] 本地编译和截图环境已准备');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
