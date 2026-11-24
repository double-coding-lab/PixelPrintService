-- 新建部署：凭据及会话表公开 DDL，与当前 Sequelize 模型一致。
-- 仅供缺失表初始化；已有部署请使用 personal-model-credentials-migration.sql。
-- 其余业务表继续使用 npm run db:init；本文件不连接数据库。

CREATE TABLE IF NOT EXISTS `d2c_credential` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `credentialId` VARCHAR(64),
  `ownerUserId` VARCHAR(64) COMMENT '服务端 账号认证 用户 ID',
  `kind` ENUM('figma', 'model') NOT NULL DEFAULT 'figma',
  `ciphertext` TEXT COMMENT 'AES-256-GCM 密文，Base64 编码',
  `iv` VARCHAR(32) COMMENT '独立随机 12 字节 IV，Base64 编码',
  `authTag` VARCHAR(32) COMMENT '16 字节 GCM 认证标签，Base64 编码',
  `keyId` VARCHAR(128) COMMENT '外部密钥版本标识',
  `revision` INTEGER UNSIGNED,
  `status` ENUM('active', 'revoked') NOT NULL DEFAULT 'active',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `d2c_credential` ADD UNIQUE INDEX `uk_d2c_credential_credentialId` (`credentialId`);
ALTER TABLE `d2c_credential` ADD INDEX `idx_d2c_credential_owner_kind` (`ownerUserId`,
  `kind`);
ALTER TABLE `d2c_credential` ADD UNIQUE INDEX `uk_d2c_credential_owner_kind_revision` (`ownerUserId`,
  `kind`,
  `revision`);

CREATE TABLE IF NOT EXISTS `d2c_session` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增内部主键',
  `sessionId` VARCHAR(64) COMMENT '会话业务 ID',
  `workspaceId` VARCHAR(64) COMMENT '工作区业务 ID',
  `createdUserId` VARCHAR(64) COMMENT '会话创建者用户 ID，历史记录允许 NULL',
  `creatorName` VARCHAR(100) COMMENT '会话创建者显示姓名，历史记录允许 NULL',
  `name` VARCHAR(200) COMMENT '显示名称',
  `target` ENUM('h5', 'rn') COMMENT '生成目标 H5 或 RN',
  `figmaUrl` TEXT COMMENT '设计稿链接',
  `credentialId` VARCHAR(64) COMMENT '关联凭据业务 ID',
  `modelCredentialId` VARCHAR(64) DEFAULT NULL COMMENT '本人固定模型 Token 修订，NULL 沿用平台模型',
  `fileRevision` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '稳定文件修订号',
  `timelineSeq` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '时间线最后序号',
  `activeRunId` VARCHAR(64) COMMENT '当前未结束轮次 ID',
  `contextSummary` LONGTEXT COMMENT '私有会话上下文摘要',
  `summaryThroughSeq` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '摘要覆盖的时间线序号',
  `validationState` JSON COMMENT '当前产物校验状态',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库最后更新时间',
  `deletedAt` DATETIME(3) DEFAULT NULL COMMENT '软删除时间，NULL 表示正常',
  PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `d2c_session` ADD UNIQUE INDEX `uk_d2c_session_sessionId` (`sessionId`);
ALTER TABLE `d2c_session` ADD INDEX `idx_d2c_session_workspace_createdAt` (`workspaceId`,
  `createdAt`);
ALTER TABLE `d2c_session` ADD INDEX `idx_d2c_session_activeRunId` (`activeRunId`);

