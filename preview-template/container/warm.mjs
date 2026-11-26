import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { buildPreview, validatePreviewOptions } from './build.mjs';
import { formatCompilerDiagnostic } from './diagnostics.mjs';

const control = path.resolve(
  process.env.PIXELPRINT_PREVIEW_ROOT ?? '.runtime/preview-build',
  'control',
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 仅接收固定协议字段；任何路径、配置或运行参数都不能来自额外字段。 */
export function validateWarmRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'entryPath,id,target,unit' ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id) ||
    !value.unit ||
    typeof value.unit !== 'object' ||
    Array.isArray(value.unit) ||
    Object.keys(value.unit).sort().join(',') !== 'outputBase,outputUnit'
  )
    throw new Error('PREVIEW_INVALID_INPUT');
  validatePreviewOptions({
    target: value.target,
    entry: value.entryPath,
    unit: value.unit.outputUnit,
    rawBase: value.unit.outputBase,
  });
  return value;
}

/** 固定控制目录内原子发布；不输出原始异常或源码。 */
async function publish(name, value) {
  const temporary = `${control}/${name}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, `${control}/${name}.json`);
}

/** 串行常驻协议；一轮关闭 watcher 并发布结果后才接收下一份完整输入。 */
export async function runWarmWorker({ signal, compile = buildPreview } = {}) {
  let latestId;
  let cache;
  let cacheKey;
  await publish('ready', { protocol: 1 });
  while (!signal?.aborted) {
    let request;
    try {
      const info = await lstat(`${control}/request.json`);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
        throw new Error('PREVIEW_INVALID_INPUT');
      request = JSON.parse(await readFile(`${control}/request.json`, 'utf8'));
      /** No trustworthy correlation ID exists for malformed JSON/IDs: await a valid request. */
      if (typeof request?.id !== 'string' || !UUID.test(request.id))
        throw new Error('PREVIEW_INVALID_INPUT');
      if (request.id !== latestId) {
        latestId = request.id;
        let result;
        try {
          validateWarmRequest(request);
          const key = JSON.stringify([
            request.target,
            request.entryPath,
            request.unit.outputUnit,
            request.unit.outputBase,
          ]);
          if (key !== cacheKey) cache = undefined;
          const incremental = Boolean(cache);
          cache = await compile({
            target: request.target,
            entry: request.entryPath,
            unit: request.unit.outputUnit,
            rawBase: request.unit.outputBase,
            incremental: true,
            cache,
          });
          cacheKey = key;
          result = { id: request.id, ok: true, incremental };
        } catch (error) {
          cache = undefined;
          cacheKey = undefined;
          result = { id: request.id, ok: false, diagnostic: formatCompilerDiagnostic(error) };
        }
        await publish('result', result);
      }
    } catch {
      /** 未接收新任务时的读取/解析异常不影响上次成功缓存；任务失败由内层 catch 清理。 */
    }
    try {
      await setTimeout(25, undefined, { signal });
    } catch {
      if (!signal?.aborted) throw new Error('PREVIEW_WORKER_FAILED');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  runWarmWorker().catch(() => {
    process.exitCode = 1;
  });
}
