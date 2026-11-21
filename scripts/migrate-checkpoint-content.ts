import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { z } from 'zod';
import {
  migrateCheckpointBatch,
  type CheckpointMigrationTable,
} from '../src/functions/d2c/content/checkpointMigration';
import { checkpointContentPolicy } from '../src/functions/d2c/content/checkpointRuntime';

const tableSchema = z.enum(['checkpoints', 'writes']);
const idSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const stateSchema = z
  .object({
    version: z.literal(1),
    table: tableSchema,
    action: z.enum(['externalize', 'restore']),
    dryRun: z.boolean(),
    nextAfterId: idSchema,
    untilId: idSchema,
  })
  .strict();

/** CLI只公开固定分类，不能把平台连接、配置或本地文件的原始错误带出。 */
class CheckpointCliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const help = `Usage: npm run checkpoint:migrate -- --dry-run --table checkpoints
       npm run checkpoint:migrate -- --apply --table checkpoints [--resume]
       npm run checkpoint:migrate -- --apply --restore --table checkpoints

--table checkpoints|writes   Required fixed table group.
--dry-run                             Read/validate only; no object download/upload or database writes.
--apply                               Explicitly execute storage changes after schemaReady/config setup.
--restore                             Refill inline binary payloads from verified references; never delete objects.
--confirm-external                    Required when applying external mode after old writers have exited.
--after-id N                          Start after this BIGINT ID (default 0); cannot combine with --resume.
--batch-size N                        1..100 (default 25); bodies processed sequentially.
--max-batches N                       1..10000 (default 1); bounded execution, repeat with --resume.
--state-file PATH                     Atomic local metadata checkpoint (default .runtime/checkpoint-content-migration/...).
--resume                              Reuse matching action/table/dry-run state; never clears or recreates tables.
--help                                Show help without loading platform config or connecting database.

Uploads occur before short row transactions. Changed rows stop at the last committed cursor. Active or missing parent sessions stop migration.
Run a fresh pass for concurrent changes after stopping old writers. Back up metadata, objects and body keys.
This command never executes DDL, clears historical payloads automatically or deletes objects.
`;

/** 固定参数解析先于加载真实配置，错误值不进入日志或SQL标识。 */
export function parseCheckpointMigrationArgs(args: string[]) {
  try {
    return parseArgs(args);
  } catch {
    throw new CheckpointCliError('INVALID_ARGUMENTS');
  }
}

/** 解析只操作参数，不初始化平台或读取运行配置。 */
function parseArgs(args: string[]) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return null;
  const flags = new Set(['--dry-run', '--apply', '--restore', '--resume', '--confirm-external']);
  const values = new Set([
    '--table',
    '--after-id',
    '--batch-size',
    '--max-batches',
    '--state-file',
  ]);
  const input: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (Object.hasOwn(input, name)) throw new Error('INVALID_ARGUMENTS');
    if (flags.has(name)) input[name] = true;
    else if (values.has(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      input[name] = value;
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (!!input['--apply'] === !!input['--dry-run'] || (input['--resume'] && input['--after-id']))
    throw new Error('INVALID_ARGUMENTS');
  const table = tableSchema.parse(input['--table']);
  const afterId = idSchema.parse(input['--after-id'] ?? '0');
  const integer = (key: string, fallback: number, maximum: number) => {
    const raw = input[key];
    if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)))
      throw new Error('INVALID_ARGUMENTS');
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) throw new Error('INVALID_ARGUMENTS');
    return value;
  };
  const action = input['--restore'] ? ('restore' as const) : ('externalize' as const);
  const dryRun = input['--dry-run'] === true;
  const stateFile = path.resolve(
    String(
      input['--state-file'] ??
        path.join(
          '.runtime',
          'checkpoint-content-migration',
          table + '-' + action + '-' + (dryRun ? 'dry-run' : 'apply') + '.json',
        ),
    ),
  );
  return {
    table,
    afterId,
    action,
    dryRun,
    stateFile,
    resume: input['--resume'] === true,
    confirmExternal: input['--confirm-external'] === true,
    batchSize: integer('--batch-size', 25, 100),
    maxBatches: integer('--max-batches', 1, 10000),
  };
}

/** checkpoint仅含控制元数据；临时文件及最终文件权限为0600，不保存正文、定位或密钥。 */
async function saveState(filename: string, value: z.infer<typeof stateSchema>) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** 可注入离线服务验证完整命令；默认只在显式操作后才加载平台数据库依赖。 */
export async function runCheckpointMigrationCli(
  args: string[],
  open: () => Promise<{ mysql: Sequelize; close: () => Promise<void> }> = async () =>
    (await import('../src/functions/d2c/content/operator')).openContentMigration(),
  print: (value: string) => void = console.log,
): Promise<number> {
  try {
    return await runCli(args, open, print);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new DOMException('检查点迁移已取消', 'AbortError');
    if (error instanceof CheckpointCliError) throw error;
    throw new CheckpointCliError('CHECKPOINT_MIGRATION_FAILED');
  }
}

/** 有界执行批次；恢复失败不覆盖已保存的安全游标。 */
async function runCli(
  args: string[],
  open: () => Promise<{ mysql: Sequelize; close: () => Promise<void> }>,
  print: (value: string) => void,
): Promise<number> {
  const options = parseCheckpointMigrationArgs(args);
  if (!options) {
    print(help);
    return 0;
  }
  let afterId = options.afterId;
  let untilId: string | undefined;
  if (options.resume) {
    let state: z.infer<typeof stateSchema>;
    try {
      if ((await stat(options.stateFile)).size > 4096) throw new Error();
      state = stateSchema.parse(JSON.parse(await readFile(options.stateFile, 'utf8')));
      if (BigInt(state.nextAfterId) > BigInt(state.untilId)) throw new Error();
    } catch {
      throw new CheckpointCliError('INVALID_STATE');
    }
    if (
      state.table !== options.table ||
      state.action !== options.action ||
      state.dryRun !== options.dryRun
    )
      throw new CheckpointCliError('STATE_MISMATCH');
    afterId = state.nextAfterId;
    untilId = state.untilId;
  }
  const connection = await open();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const policy = checkpointContentPolicy(connection.mysql);
    if (
      !options.dryRun &&
      options.action === 'externalize' &&
      policy.mode === 'external' &&
      !options.confirmExternal
    )
      throw new CheckpointCliError('EXTERNAL_CONFIRMATION_REQUIRED');
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const result = await migrateCheckpointBatch(connection.mysql, {
        table: options.table as CheckpointMigrationTable,
        action: options.action,
        afterId,
        untilId,
        batchSize: options.batchSize,
        dryRun: options.dryRun,
        signal: controller.signal,
      });
      await saveState(options.stateFile, {
        version: 1,
        table: result.table,
        action: result.action,
        dryRun: result.dryRun,
        nextAfterId: result.nextAfterId,
        untilId: result.untilId,
      });
      print(JSON.stringify(result));
      if (result.error) return 1;
      if (!result.hasMore) return 0;
      afterId = result.nextAfterId;
      untilId = result.untilId;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 平台配置SDK可能持有订阅；连接关闭后结束命令，绝不启动HTTP/后台Worker。
  void runCheckpointMigrationCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => {
      console.error(
        'CHECKPOINT_CONTENT_MIGRATION_FAILED：请核对参数、schemaReady、正文密钥和数据库权限；未输出原始错误。',
      );
      process.exit(1);
    });
}
