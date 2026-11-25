import { createHash } from 'node:crypto';
import type { StorageFileObject } from '@/hooks/tools/storage';

export type VariantJob = {
  source: StorageFileObject;
  fileName: string;
  attempts: number;
  required?: boolean;
};
export type VariantClaim = { id: string; token: string; job: VariantJob };
export type VariantResult = { sourceSha: string; locator: StorageFileObject };
export interface ImageVariantStore {
  enqueue(id: string, job: VariantJob): Promise<void>;
  claim(token: string): Promise<VariantClaim | null>;
  complete(claim: VariantClaim, result: VariantResult): Promise<void>;
  retry(claim: VariantClaim): Promise<void>;
  discard(claim: VariantClaim): Promise<void>;
  remember(id: string, source: StorageFileObject): Promise<void>;
  sources(ids: string[]): Promise<Array<StorageFileObject | null>>;
  get(ids: string[]): Promise<Array<VariantResult | null>>;
  invalidate(id: string): Promise<void>;
}

/** 策略版本参与键，调整缩图策略时不复用旧产物。URL 使用真实回执而非拼接规则。 */
export const variantId = (url: string) =>
  createHash('sha256').update(`webp-320-q80-v1\n${url}`).digest('hex');
const prefix = 'pixelprint:{image-webp-v1}:';
const queue = prefix + 'queue';
const clock =
  "local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)\n";
const enqueueScript =
  clock +
  `
local cached=redis.call('GET',KEYS[2])
if cached then
  local ok,record=pcall(cjson.decode,cached)
  if ok and type(record)=='table' and record.sourceSha==ARGV[3] then return 0 end
  redis.call('DEL',KEYS[2])
end
local existing=redis.call('GET',KEYS[3])
if existing then
  if ARGV[4]=='1' then
    local ok,job=pcall(cjson.decode,existing)
    if ok and type(job)=='table' then
      job.required=true; redis.call('SET',KEYS[3],cjson.encode(job),'EX',604800)
      if redis.call('EXISTS',KEYS[4])==0 then redis.call('ZADD',KEYS[1],now-60000,ARGV[1]) end
    end
  end
  return 0
end
redis.call('SET',KEYS[3],ARGV[2],'EX',604800)
redis.call('ZADD',KEYS[1],now-(ARGV[4]=='1' and 60000 or 0),ARGV[1]); return 1`;
const claimScript =
  clock +
  `
for _,id in ipairs(redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,8)) do
  local job=redis.call('GET',ARGV[1]..'job:'..id)
  if not job then redis.call('ZREM',KEYS[1],id)
  elseif redis.call('SET',ARGV[1]..'lock:'..id,ARGV[2],'NX','PX',120000) then
    redis.call('ZADD',KEYS[1],now+120000,id)
    return {id,job}
  end
end
return nil`;
const completeScript = `
if redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
redis.call('SET',KEYS[4],ARGV[3],'EX',2592000)
redis.call('DEL',KEYS[2],KEYS[3]); redis.call('ZREM',KEYS[1],ARGV[1]); return 1`;
const retryScript =
  clock +
  `
if redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
redis.call('DEL',KEYS[2])
if tonumber(ARGV[4])>=3 then
  redis.call('DEL',KEYS[3]); redis.call('ZREM',KEYS[1],ARGV[1])
else
  local pending=redis.call('GET',KEYS[3])
  local ok,current=pcall(cjson.decode,pending or '')
  local nextJob=cjson.decode(ARGV[3])
  if ok and type(current)=='table' and current.required then nextJob.required=true end
  redis.call('SET',KEYS[3],cjson.encode(nextJob),'EX',604800)
  redis.call('ZADD',KEYS[1],now+30000*tonumber(ARGV[4]),ARGV[1])
end
return 1`;
const discardScript =
  clock +
  `
if redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
local value=redis.call('GET',KEYS[3])
local ok,job=pcall(cjson.decode,value or '')
redis.call('DEL',KEYS[2])
if ok and type(job)=='table' and job.required then
  redis.call('ZADD',KEYS[1],now-60000,ARGV[1]); return 0
end
redis.call('DEL',KEYS[3]);redis.call('ZREM',KEYS[1],ARGV[1]);return 1`;

/** 所有键在相同 Redis 槽内，生产桥接沿用项目的主节点原子命令能力。 */
export function createRedisImageVariantStore(
  command: (key: string, args: string[]) => Promise<unknown>,
): ImageVariantStore {
  const key = (kind: string, id: string) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('IMAGE_VARIANT_KEY');
    return `${prefix}${kind}:${id}`;
  };
  return {
    async enqueue(id, job) {
      await command(queue, [
        'EVAL',
        enqueueScript,
        '4',
        queue,
        key('ready', id),
        key('job', id),
        key('lock', id),
        id,
        JSON.stringify(job),
        job.source.sha256,
        job.required ? '1' : '0',
      ]);
    },
    async claim(token) {
      const result = await command(queue, ['EVAL', claimScript, '1', queue, prefix, token]);
      if (!Array.isArray(result) || result.length !== 2) return null;
      const id = String(result[0]);
      key('job', id);
      return { id, token, job: JSON.parse(String(result[1])) as VariantJob };
    },
    async complete(claim, result) {
      await command(queue, [
        'EVAL',
        completeScript,
        '4',
        queue,
        key('lock', claim.id),
        key('job', claim.id),
        key('ready', claim.id),
        claim.id,
        claim.token,
        JSON.stringify(result),
      ]);
    },
    async retry(claim) {
      const job = { ...claim.job, attempts: claim.job.attempts + 1 };
      await command(queue, [
        'EVAL',
        retryScript,
        '3',
        queue,
        key('lock', claim.id),
        key('job', claim.id),
        claim.id,
        claim.token,
        JSON.stringify(job),
        String(job.attempts),
      ]);
    },
    async get(ids) {
      if (!ids.length) return [];
      const rows = await command(queue, ['MGET', ...ids.map((id) => key('ready', id))]);
      return ids.map((_, i) => {
        try {
          return Array.isArray(rows) && rows[i] != null
            ? (JSON.parse(String(rows[i])) as VariantResult)
            : null;
        } catch {
          return null;
        }
      });
    },
    async remember(id, source) {
      await command(queue, ['SET', key('source', id), JSON.stringify(source), 'EX', '2592000']);
    },
    async sources(ids) {
      if (!ids.length) return [];
      const rows = await command(queue, ['MGET', ...ids.map((id) => key('source', id))]);
      return ids.map((_, i) => {
        try {
          return Array.isArray(rows) && rows[i] != null
            ? (JSON.parse(String(rows[i])) as StorageFileObject)
            : null;
        } catch {
          return null;
        }
      });
    },
    async discard(claim) {
      await command(queue, [
        'EVAL',
        discardScript,
        '3',
        queue,
        key('lock', claim.id),
        key('job', claim.id),
        claim.id,
        claim.token,
      ]);
    },
    async invalidate(id) {
      await command(queue, ['DEL', key('ready', id)]);
    },
  };
}
