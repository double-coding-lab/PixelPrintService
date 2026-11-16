import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  server: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    publicUrl: z.url(),
  }),
  database: z.object({
    host: z.string(),
    port: z.number().int().positive(),
    name: z.string(),
    username: z.string(),
    password: z.string(),
  }),
  redis: z.object({ url: z.string().url() }),
  auth: z.object({
    sessionSecret: z.string().min(32),
    sessionTtlSeconds: z.number().int().positive(),
    users: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          passwordHash: z.string().startsWith('scrypt$'),
          apiToken: z.string().min(32).optional(),
        }),
      )
      .min(1),
  }),
  logging: z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
  }),
  storage: z.object({
    driver: z.enum(['local', 's3']),
    directory: z.string(),
    publicUrl: z.string().url(),
    bucket: z.string(),
    region: z.string(),
    endpoint: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    forcePathStyle: z.boolean(),
  }),
  network: z.object({ proxyUrl: z.string() }),
  runtime: z.object({
    modelConfigs: z.array(z.record(z.string(), z.unknown())),
    d2c: z.record(z.string(), z.unknown()),
  }),
});

/** 仅在进程启动读取项目内配置；错误只报告字段路径，不泄露配置值。 */
export function loadProjectConfig(
  filename = process.env.PIXELPRINT_CONFIG || 'project.config.json',
) {
  const full = path.resolve(filename);
  if (!existsSync(full)) throw new Error('缺少 project.config.json，请先运行 npm run setup。');
  const raw = JSON.parse(readFileSync(full, 'utf8'));
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      '项目配置无效：' +
        [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', '),
    );
  const ids = parsed.data.auth.users.map((user) => user.id);
  if (new Set(ids).size !== ids.length) throw new Error('auth.users.id 不能重复');
  return parsed.data;
}

export const projectConfig = loadProjectConfig();
