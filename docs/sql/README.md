# 数据库 SQL 入口

所有可执行建表、升级和结构检查 SQL 集中在本目录。运行应用只连接数据库和注册模型；`npm run db:init` 创建缺失表，**不会 ALTER 已存在的表**。

## 新建空库

推荐先创建使用 utf8mb4 的 MySQL 数据库，填写 `project.config.json`，再执行：

```bash
npm run db:init
```

也可在选定的**空数据库**执行 [schema.sql](schema.sql)。它按当前注册的 18 个模型离线生成，包含表、主键及业务索引；不能用于修补旧表。两种初始化方式二选一，完成后不再执行下面的历史增量脚本。初始化 SQL 中索引语句没有重复执行保护。

结构事实源为 `src/models/` 和 `src/models/index.ts`。更新模型时同步本目录；MySQL 的库字符集、权限、备份和连接配置由部署者管理。

## 已有数据库升级

先执行 [check-schema.sql](check-schema.sql)，它只读 information_schema，不扫描聊天正文或检查点大字段。按当前库的实际缺失项选择升级，不能将全部 SQL 拼接后无差别执行。DDL 可能隐式提交，脚本不是一个可整体回滚的事务。

| 升级能力 | SQL | 使用条件 |
| --- | --- | --- |
| 会话广场、个人作品与冻结文件 | [session-plaza-migration.sql](session-plaza-migration.sql) | 三张表不存在时创建；已存在的表与索引先检查再跳过，不重复建索引 |
| 文件正文外置（第一阶段） | [content-storage-migration.sql](content-storage-migration.sql) | `d2c_file`、`d2c_version_file`、`d2c_saved_work_file` 各自缺少 `contentRef` 时执行对应语句 |
| 检查点/中间写外置（第二阶段） | [checkpoint-storage-migration.sql](checkpoint-storage-migration.sql) | 补 `checkpointRef`、`metadataRef`、`writeRef`；按缺失列选择语句 |
| 个人模型凭据 | [personal-model-credentials-migration.sql](personal-model-credentials-migration.sql) | 凭据 kind 枚举需支持 model；会话表缺少 modelCredentialId 时补列 |

**广场脚本创建的作品文件表已含 `contentRef`。** 之后执行第一阶段脚本时跳过该表的 ADD COLUMN；其余两张表仍按检查结果补齐。第二阶段 checkpoint 的同一 ALTER 包含两列；只缺其中一列时拆出缺失列执行，不重复添加已有列。`CREATE TABLE IF NOT EXISTS` 只跳过建表，不补旧表字段，也不让后续 ADD INDEX 自动幂等。

这些增量脚本覆盖对应功能变更，不是任意旧版本到当前版本的通用迁移器；更早版本或自行修改过的数据库须对照当前模型/完整 schema 确认字段和索引差异。字段名 `ownerEid` 是作品表既有存储契约，在社区版保存本地账号标识，无需为文档统一改列名。

建议顺序：备份 → 暂停写入和后台任务 → 核对结构 → 执行缺失项 → 再查结构 → 配置并重启 → 验证历史会话、恢复、预览、作品保存与下载。本文整理不代表已经执行目标数据库 SQL。

## 外置存储的启用顺序

文件正文和检查点分别使用 `runtime.d2c.contentStorage` / `checkpointStorage`，配置位于 `project.config.json`。

| mode | 新写入行为 |
| --- | --- |
| inline | 正文保留在数据库 |
| shadow | 按阈值保存对象引用，同时保留数据库正文 |
| external | 达到阈值后外置正文，数据库保留引用；小正文仍可内联 |

已有库先补引用列，再设对应 `schemaReady: true`，填写持久保存的加密密钥并重启。新实例 setup 默认 external、schemaReady=true，由初始化创建引用列。旧配置不会被 setup 覆盖；缺少引用的历史数据继续按原内联格式读取，切换 external 不等于自动搬迁旧记录。

完整配置见[配置说明](../deployment/configuration.md)。历史数据迁移使用 `content:migrate` / `checkpoint:migrate` 专用命令，和建列步骤分开；迁移前按脚本帮助、备份及检查结果操作，保留所有历史密钥，不执行直接清空 LONGTEXT/BLOB 的 SQL。
