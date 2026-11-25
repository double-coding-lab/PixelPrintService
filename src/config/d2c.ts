import path from 'node:path';
import { contentStorageSchema } from '../functions/d2c/content/runtime';
import { checkpointStorageSchema } from '../functions/d2c/content/checkpointRuntime';
import { z } from 'zod';

/** 校验服务器使用的 HTTP 地址，禁止将账号密码写入 URL。 */
const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });

const secretReference = z
  .string()
  .trim()
  .min(1)
  .max(16384)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

/** 密钥材料按原值保存；空白、控制字符与继承属性不能作为密钥。 */
export const secretKeysSchema = z
  .object({
    activeKeyId: z.string().trim().min(1),
    keys: z.record(
      z.string().trim().min(1),
      z
        .string()
        .min(1)
        .max(16384)
        .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)),
    ),
  })
  .refine(
    (value) =>
      Object.hasOwn(value.keys, value.activeKeyId) && Boolean(value.keys[value.activeKeyId]),
    { path: ['keys'] },
  );

/** 域名名单只接收主机名或明确的通配后缀，不接受 URL、端口与路径。 */
const hostname = z
  .string()
  .trim()
  .refine((value) => {
    const name = value.startsWith('*.') ? value.slice(2) : value;
    return (
      name.length <= 253 &&
      name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    );
  });

/** 通用文件服务由项目存储配置启用。 */
export const storageSchema = z.object({ enabled: z.boolean().default(true) });

/** 模型连接参数与输入上下文预算按模型配置，数组第一项作为当前默认模型。 */
export const modelConfigsSchema = z
  .array(
    z.object({
      MODEL_BASE_URL: httpUrl,
      MODEL_NAME: z.string().trim().min(1),
      MODEL_API_KEY: secretReference,
      contextBudgetTokens: z.number().int().min(1024),
      requestTimeoutMs: z.number().int().min(1000).max(600000).default(180000),
      reasoningPolicy: z.enum(['adaptive', 'provider-default']).optional(),
    }),
  )
  .min(1);

/** 执行目录默认位于 cwd 下；相对路径统一解析为绝对路径，并拒绝空白与文件系统根。 */
const workRootSchema = z
  .string()
  .trim()
  .min(1)
  .default('.runtime/runs')
  .transform((value) => path.resolve(process.cwd(), value))
  .refine((value) => path.parse(value).root !== value);

/** 平台运行参数由 项目配置 提供；存储和预览接入可以独立准备。 */
const runtimeSchema = z.object({
  modelConfigs: modelConfigsSchema,
  d2c: z.object({
    imageVariants: z.object({ enabled: z.boolean().default(true) }).optional(),
    execution: z
      .object({
        workRoot: workRootSchema,
        concurrency: z.number().int().min(1).max(32),
        pollIntervalMs: z.number().int().min(100),
        heartbeatMs: z.number().int().min(1000),
        leaseMs: z.number().int().min(3000),
        runTimeoutMs: z.number().int().min(1000),
        maxTurns: z.number().int().min(1).max(1000),
      })
      .refine((value) => value.leaseMs > value.heartbeatMs * 2, { path: ['leaseMs'] }),
    network: z.object({
      allowedExternalHosts: z.array(hostname).min(1),
    }),
    storage: storageSchema.optional(),
    secrets: secretKeysSchema.optional(),
    contentStorage: contentStorageSchema.optional(),
    checkpointStorage: checkpointStorageSchema.optional(),
    limits: z.object({
      textFileBytes: z.number().int().min(1),
      filesPerSession: z.number().int().min(1),
      uploadBytes: z.number().int().min(1),
    }),
  }),
});

export type D2cRuntimeConfig = z.infer<typeof runtimeSchema>;
export type D2cCapability = 'imageStorage' | 'fileStorage' | 'secrets';

/** 已验证的平台参数只读保存，业务调用不能修改最后有效配置。 */
function freezeConfig(value: unknown) {
  if (value === null || typeof value !== 'object') return;
  for (const item of Object.values(value)) freezeConfig(item);
  Object.freeze(value);
}

/** 从原始 项目配置 内容取得有效参数；错误只包含字段名，不带配置值。 */
export function parseD2cRuntimeConfig(value: unknown): D2cRuntimeConfig {
  const parsed = runtimeSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => {
          const keys = issue.path.indexOf('keys');
          return (keys >= 0 ? issue.path.slice(0, keys + 1) : issue.path).join('.') || 'root';
        }),
      ),
    ];
    throw new Error(`项目 runtime 配置无效：${fields.join('、')}`);
  }
  return parsed.data;
}

/** 保留最后有效配置，无效配置只上报字段错误，不覆盖运行参数。 */
export function createD2cConfigReader(read: () => unknown, reportInvalid?: (error: Error) => void) {
  let current: D2cRuntimeConfig | undefined;
  let lastInvalidMessage: string | undefined;
  return function getRuntimeConfig(): D2cRuntimeConfig {
    const source = read();
    try {
      const next = parseD2cRuntimeConfig(source);
      freezeConfig(next);
      current = next;
      lastInvalidMessage = undefined;
      return next;
    } catch (error) {
      if (!current) throw error;
      if ((error as Error).message !== lastInvalidMessage) {
        lastInvalidMessage = (error as Error).message;
        reportInvalid?.(error as Error);
      }
      return current;
    }
  };
}

/** 依赖尚未配置时明确失败，不返回测试地址或伪造的上传/预览结果。 */
export function requireD2cCapability(config: D2cRuntimeConfig, capability: D2cCapability) {
  const ready = {
    imageStorage: config.d2c.storage,
    fileStorage: config.d2c.storage,
    secrets: config.d2c.secrets,
  }[capability];
  if (!ready) throw new Error(`D2C 接入尚未就绪：${capability}`);
}
