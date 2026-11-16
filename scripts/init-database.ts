import { connectMysql } from '../src/hooks/tools/mysql';

/** 显式创建缺失表，不清空数据、不自动更改已有表结构。 */
const database = await connectMysql();
try {
  await database.sync({ force: false, alter: false });
  console.log('数据库表已初始化；已有表及数据保持原样。');
} finally {
  await database.close();
}
