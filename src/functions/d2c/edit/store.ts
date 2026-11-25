import { createHash } from 'node:crypto';
import type { RedisClient } from '@/hooks/tools/redis';
import type { PreviewSnapshotFile } from '../preview/session';

export const EDIT_TTL_MS = 2 * 60 * 60 * 1000;
export type EditPreview = {
  status: 'idle' | 'building' | 'ready' | 'failed';
  key?: string;
  job?: string;
  startedAt?: number;
  error?: string;
};
export type EditRecord = {
  editId: string;
  /** Source id, never the detached owner-scoped storage key. */
  sessionId: string;
  ownerUserId: string;
  revision: number;
  baseFileRevision: number;
  files: Array<{ path: string; content: string }>;
  entries: string[];
  entryPath: string | null;
  target: 'h5' | 'rn';
  expiresAt: string;
  snapshot: PreviewSnapshotFile[];
  configSnapshot: Record<string, unknown>;
  preview: EditPreview;
  applying?: string;
};
export type EditTicket = {
  editId: string;
  /** Source id, never the detached owner-scoped storage key. */
  sessionId: string;
  target: 'h5' | 'rn';
  key: string;
  expiresAt: string;
};

/** Redis 是唯一副本事实源；CAS 比较完整状态，包含 active editId、修订和构建 owner。 */
export interface EditStore {
  /** Storage keys may be scoped to owner + source; locate/index use this same opaque key. */
  load(sessionId: string): Promise<EditRecord | null>;
  locate(editId: string): Promise<string | null>;
  index(editId: string, sessionId: string, expiresAt: string): Promise<void>;
  cas(sessionId: string, previous: EditRecord | null, next: EditRecord | null): Promise<boolean>;
  ticket(hash: string, value: EditTicket): Promise<void>;
  readTicket(hash: string): Promise<EditTicket | null>;
}

type NativeClient = {
  sendCommand(args: string[]): Promise<unknown>;
};

/** 单 key Lua：比较与写入/删除不可分割；Redis 时钟限定固定绝对期限，保存不续两小时。 */
const CAS = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]); return 1 end
local t = redis.call('TIME')
local remaining = tonumber(ARGV[3]) - (tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000))
if remaining <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', remaining)
return 1`;

/**
 * 主 agent 接线：createRedisEditStore(app.redis)，不创建连接、不关闭 app.redis。
 * 使用标准 Redis sendCommand 执行原子 Lua，不依赖客户端私有字段。
 * 不支持原生命令时明确失败，不降级成 GET/SET 或本地 Map。
 */
export function createRedisCommand(redis: RedisClient, reason = 'REDIS_ATOMIC_UNAVAILABLE') {
  return async (_key: string, args: string[]) => {
    const client = redis;
    if (!client || typeof client.sendCommand !== 'function') throw new Error(reason);
    return client.sendCommand(args);
  };
}

/** 编辑副本继续沿用原有 Redis 键与 CAS 语义，命令桥可供其他后台任务复用。 */
export function createRedisEditStore(redis: RedisClient, prefix = 'pixelprint:edit:v1'): EditStore {
  const command = createRedisCommand(redis, 'EDIT_REDIS_ATOMIC_UNAVAILABLE');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const key = (kind: string, id: string) => `${prefix}:${kind}:${digest(id)}`;

  /** 服务端构造的 JSON 保持键序，读后不原地修改 previous 才能用于 CAS。 */
  async function read<T>(name: string): Promise<T | null> {
    const value = await command(name, ['GET', name]);
    return value == null ? null : (JSON.parse(String(value)) as T);
  }
  /** 辅助定位与短票据同样交由 Redis 到期，不保存源码到索引。 */
  async function put(name: string, value: unknown, expiresAt: string) {
    await command(name, [
      'SET',
      name,
      JSON.stringify(value),
      'PXAT',
      String(Date.parse(expiresAt)),
    ]);
  }
  return {
    load: (sessionId) => read<EditRecord>(key('session', sessionId)),
    locate: (editId) => read<string>(key('index', editId)),
    index: (editId, sessionId, expiresAt) => put(key('index', editId), sessionId, expiresAt),
    async cas(sessionId, previous, next) {
      const name = key('session', sessionId);
      const result = await command(name, [
        'EVAL',
        CAS,
        '1',
        name,
        previous ? JSON.stringify(previous) : '',
        next ? JSON.stringify(next) : '',
        next ? String(Date.parse(next.expiresAt)) : '0',
      ]);
      return Number(result) === 1;
    },
    ticket: (hash, value) => put(key('ticket', hash), value, value.expiresAt),
    readTicket: (hash) => read<EditTicket>(key('ticket', hash)),
  };
}
