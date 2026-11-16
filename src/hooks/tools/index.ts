import type { FastifyInstance } from 'fastify';
import type { Sequelize } from 'sequelize';
import { closeRedis, connectRedis, type RedisClient } from './redis';
import { connectMysql } from './mysql';
import { RuntimeConfig } from './config';
import logging from './logging';

declare module 'fastify' {
  interface FastifyInstance {
    logging: typeof logging;
    redis: RedisClient;
    mysql: Sequelize;
    runtimeConfig: RuntimeConfig;
  }
}

/** 初始化本地配置、Redis 和 MySQL，并为启动失败及关闭注册资源清理。 */
export async function registerTools(app: FastifyInstance) {
  app.decorate('logging', logging);
  const runtimeConfig = new RuntimeConfig();
  await runtimeConfig.load();
  const redis = await connectRedis();
  let mysql: Sequelize;
  try {
    mysql = await connectMysql();
  } catch (error) {
    await closeRedis(redis).catch(() => undefined);
    throw error;
  }
  app.addHook('onClose', async () => {
    const results = await Promise.allSettled([closeRedis(redis), mysql.close()]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Failed to close application connections');
    }
  });
  app.decorate('redis', redis);
  app.decorate('mysql', mysql);
  app.decorate('runtimeConfig', runtimeConfig);
}
