import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/** 离线测试使用独立公开配置，不读取部署方密钥，也不连接外部服务。 */
const directory = mkdtempSync(path.join(tmpdir(), 'pixelprint-offline-config-'));
const configFile = path.join(directory, 'project.config.json');
const config = JSON.parse(
  readFileSync(new URL('../../project.config.example.json', import.meta.url), 'utf8'),
);
config.auth.sessionSecret = 'offline-test-secret-'.repeat(3);
config.auth.users = [{ id: 'offline-test', name: 'Offline test', passwordHash: 'scrypt$fixture' }];
writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const previous = process.env.PIXELPRINT_CONFIG;
process.env.PIXELPRINT_CONFIG = configFile;
after(() => {
  if (previous === undefined) delete process.env.PIXELPRINT_CONFIG;
  else process.env.PIXELPRINT_CONFIG = previous;
  rmSync(directory, { recursive: true, force: true });
});
