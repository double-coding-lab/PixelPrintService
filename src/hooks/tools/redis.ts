import { createClient } from 'redis';
import { projectConfig } from '@/config/project';
import logging from './logging';

export type RedisClient = ReturnType<typeof createClient>;

/** 创建标准 Redis 客户端，连接失败时销毁客户端，避免后台重连泄漏。 */
export async function connectRedis(): Promise<RedisClient> {
  const client = createClient({
    url: projectConfig.redis.url,
    socket: { connectTimeout: 10000, reconnectStrategy: false },
  });
  client.on('error', () => logging.error({ message: 'Redis connection error' }));
  try {
    await client.connect();
    return client;
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  }
}

/** 优雅关闭 Redis；断线或关闭失败时销毁底层连接。 */
export async function closeRedis(client: RedisClient) {
  if (!client.isOpen) return;
  try {
    await client.close();
  } finally {
    if (client.isOpen) client.destroy();
  }
}
