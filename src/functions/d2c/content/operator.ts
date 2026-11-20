import type { FastifyInstance } from 'fastify';
import { connectMysql } from '@/hooks/tools/mysql';
import { RuntimeConfig } from '@/hooks/tools/config';
import { installContentStorage } from './install';

/** 迁移进程仅取得配置与数据库，不启动HTTP、Redis、Worker或DDL；本次策略固定为快照。 */
export async function openContentMigration() {
  const qconfig = new RuntimeConfig();
  await qconfig.load();
  const snapshot = structuredClone(qconfig.get());
  const mysql = await connectMysql();
  try {
    installContentStorage({
      mysql,
      runtimeConfig: { get: () => snapshot },
    } as unknown as FastifyInstance);
    return { mysql, close: () => mysql.close() };
  } catch (error) {
    await mysql.close();
    throw error;
  }
}
