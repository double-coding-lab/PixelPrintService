import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';

const args = process.argv.slice(2);
/** 只接受明确的本地初始化选项，配置已存在时默认保持原文件。 */
function argument(name, fallback) {
  const index = args.indexOf('--' + name);
  return index < 0 ? fallback : args[index + 1];
}
const filename = argument('config', process.env.PIXELPRINT_CONFIG || 'project.config.json');
if (existsSync(filename)) {
  console.log('配置已存在，保持原样：' + filename);
  process.exit(0);
}
const config = JSON.parse(readFileSync('project.config.example.json', 'utf8'));
const username = argument('user', 'admin');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(username))
  throw new Error('账号只允许字母、数字、下划线、短横线');
const password = argument('password', randomBytes(18).toString('base64url'));
if (!password || password.length < 12) throw new Error('登录密码至少12位');
const salt = randomBytes(16).toString('hex');
config.auth.sessionSecret = randomBytes(32).toString('hex');
config.auth.users = [
  {
    id: username,
    name: username,
    passwordHash: 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('hex'),
  },
];
config.runtime.d2c.secrets.keys.primary = randomBytes(32).toString('hex');
if (args.includes('--docker')) {
  config.database.host = 'mysql';
  config.redis.url = 'redis://redis:6379';
}
if (process.env.MODEL_BASE_URL)
  config.runtime.modelConfigs[0].MODEL_BASE_URL = process.env.MODEL_BASE_URL;
if (process.env.MODEL_NAME) config.runtime.modelConfigs[0].MODEL_NAME = process.env.MODEL_NAME;
if (process.env.MODEL_API_KEY)
  config.runtime.modelConfigs[0].MODEL_API_KEY = process.env.MODEL_API_KEY;
writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('配置已生成：' + filename);
console.log('首次登录账号：' + username + '\n一次性显示的密码：' + password);
console.log('请编辑 runtime.modelConfigs 配置模型；密钥保存在本地配置，请持久保存并勿提交。');
