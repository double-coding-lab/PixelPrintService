import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeRelativePath } from './paths';
import type { PixelPrintTarget } from './targets';

/** 检查配置中的输出目录，不允许将生成结果写入模板或凭据目录。 */
const outputDirectory = z.string().refine((value) => {
  try {
    const parts = normalizeRelativePath(value).split('/');
    return parts.every((part) => !part.startsWith('.') && part !== 'node_modules');
  } catch {
    return false;
  }
});

const baseConfig = z
  .object({
    version: z.string().min(1),
    project: z
      .object({ name: z.string().min(1), framework: z.string(), styleFormat: z.string() })
      .passthrough(),
    unit: z
      .object({
        figmaBase: z.number().positive().finite(),
        outputBase: z.number().positive().finite(),
        outputUnit: z.enum(['px', 'vw']),
        scale: z.number().positive().finite(),
      })
      .passthrough(),
    images: z.object({ assetsDir: outputDirectory, imageBaseUrl: z.string() }).passthrough(),
    output: z.object({ dir: outputDirectory }).passthrough(),
  })
  .passthrough();

const h5Config = baseConfig.extend({
  project: baseConfig.shape.project.extend({
    framework: z.literal('react'),
    styleFormat: z.enum(['css', 'scss']),
  }),
});

const rnConfig = baseConfig.extend({
  project: baseConfig.shape.project.extend({
    framework: z.literal('rn'),
    styleFormat: z.literal('stylesheet'),
  }),
  unit: baseConfig.shape.unit.extend({ outputUnit: z.literal('px') }),
});

const workspaceSchema = z.object({ h5: h5Config, rn: rnConfig });
export type WorkspaceConfigs = z.infer<typeof workspaceSchema>;

/** 工作区生成配置不保存平台/用户凭据；也拒绝原型污染字段。 */
function checkConfigFields(value: unknown, prefix = 'configs', depth = 0) {
  if (depth > 20) throw new Error('工作区配置层级过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  ) {
    throw new Error('工作区配置必须是 JSON 数据');
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:proto|constructor|prototype|token|figmatoken|apikey|modelapikey|appsecret|password|authorization|cookie)$/i.test(
        key.replace(/[-_]/g, ''),
      )
    ) {
      throw new Error(`工作区配置不允许凭据或保留字段：${prefix}.${key}`);
    }
    checkConfigFields(item, `${prefix}.${key}`, depth + 1);
  }
}

/** 验证数据库中工作区的 H5/RN 配置；保留 Skill 的业务扩展字段。 */
export function parseWorkspaceConfigs(value: unknown): WorkspaceConfigs {
  checkConfigFields(value);
  const parsed = workspaceSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'configs')),
    ];
    throw new Error(`工作区生成配置无效：${fields.join('、')}`);
  }
  return parsed.data;
}

/** 固定一轮执行的生成配置，与后续工作区编辑分离。 */
export function createConfigSnapshot(
  configs: WorkspaceConfigs,
  target: PixelPrintTarget,
  configRevision: number,
  resourceRevisionId: string,
) {
  if (
    !['h5', 'rn'].includes(target) ||
    !Number.isSafeInteger(configRevision) ||
    configRevision < 1 ||
    !resourceRevisionId.trim()
  ) {
    throw new Error('配置修订无效');
  }
  const validated = parseWorkspaceConfigs(configs);
  const config = JSON.parse(
    JSON.stringify(validated[target]),
  ) as WorkspaceConfigs[PixelPrintTarget];
  const content = JSON.stringify(config);
  return {
    target,
    configRevision,
    resourceRevisionId,
    config,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}
