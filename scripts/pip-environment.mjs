import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 兼容基础镜像将旧版用户 pip.conf 写为配置路径的情况，保留部署者设置的包源。 */
export function pipEnvironment(env = process.env, home = os.homedir()) {
  if (env.PIP_CONFIG_FILE) return { ...env };
  const legacy = path.join(home, '.pip', 'pip.conf');
  if (!fs.existsSync(legacy)) return { ...env };
  const target = fs.readFileSync(legacy, 'utf8').trim();
  if (!path.isAbsolute(target) || /[\r\n]/.test(target)) return { ...env };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile())
    throw new Error('基础镜像 pip.conf 指向的配置文件不存在，请检查Python 包源配置。');
  return { ...env, PIP_CONFIG_FILE: target };
}
