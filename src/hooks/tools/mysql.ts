import { Sequelize } from 'sequelize';
import mysql2 from 'mysql2';
import { projectConfig } from '@/config/project';
import { initModels } from '@/models/index';

/** 使用本地连接配置认证 MySQL 并注册模型；建表由独立初始化命令负责。 */
export async function connectMysql() {
  const config = projectConfig.database;
  const mysql = new Sequelize(config.name, config.username, config.password, {
    host: config.host,
    port: config.port,
    dialect: 'mysql',
    dialectModule: mysql2,
    timezone: '+08:00',
    logging: false,
  });
  try {
    await mysql.authenticate();
    initModels(mysql);
    return mysql;
  } catch (error) {
    await mysql.close().catch(() => undefined);
    throw error;
  }
}
