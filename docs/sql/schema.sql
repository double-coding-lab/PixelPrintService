-- PixelPrint 当前完整表结构，从注册模型离线生成。
-- 适用于空数据库；已有实例按 README.md 选择增量迁移。
-- 生成过程未连接数据库。

CREATE TABLE IF NOT EXISTS `d2c_saved_work_file` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增主键',
  `workId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属个人作品',
  `ownerEid` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '服务端身份；文件查询必须匹配',
  `workRevision` INTEGER UNSIGNED NOT NULL DEFAULT 1 COMMENT '不可变作品快照修订',
  `path` TEXT COMMENT '固定相对文件路径',
  `pathHash` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '相对路径 SHA-256',
  `kind` ENUM('source', 'asset', 'attachment') NOT NULL DEFAULT 'source' COMMENT '可预览或下载产物',
  `content` LONGTEXT COMMENT '冻结源码正文',
  `contentRef` JSON COMMENT '私有不可变文本正文引用，按schemaReady启用',
  `objectLocator` JSON COMMENT '不可变存储定位；不含凭据',
  `size` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '文件字节数',
  `sha256` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '内容 SHA-256',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_saved_work_file` ADD UNIQUE INDEX `uk_d2c_saved_file_owner_revision_path` (`ownerEid`, `workId`, `workRevision`, `pathHash`);

CREATE TABLE IF NOT EXISTS `d2c_saved_work` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增主键',
  `workId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '个人作品业务标识',
  `ownerEid` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '服务端身份；所有查询必须匹配',
  `name` VARCHAR(200) NOT NULL DEFAULT '' COMMENT '个人作品名称',
  `target` ENUM('h5', 'rn') NOT NULL DEFAULT 'h5' COMMENT '固定预览目标',
  `revision` INTEGER UNSIGNED NOT NULL DEFAULT 1 COMMENT '作品乐观锁修订',
  `editId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '首次保存的副本标识；后续不改',
  `editRevision` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '首次保存的副本修订；后续不改',
  `lastSaveKey` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '最近一次 editId/revision 摘要；重试重放',
  `sourceId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '来源标识，仅溯源，无外键或生命周期依赖',
  `baseFileRevision` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '最近保存时的副本基线修订',
  `entryPath` TEXT COMMENT '固定预览入口',
  `entries` JSON COMMENT '冻结入口清单',
  `configSnapshot` JSON COMMENT '仅预览运行时白名单，不保存模型或凭据',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_saved_work` ADD UNIQUE INDEX `uk_d2c_saved_work_id` (`workId`);

ALTER TABLE `d2c_saved_work` ADD UNIQUE INDEX `uk_d2c_saved_work_owner_edit` (`ownerEid`, `editId`, `editRevision`);

ALTER TABLE `d2c_saved_work` ADD INDEX `idx_d2c_saved_work_owner_updated` (`ownerEid`, `datachange_lasttime`);

CREATE TABLE IF NOT EXISTS `d2c_session_share` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '内部自增主键',
  `sessionId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '唯一会话业务标识',
  `shareId` VARCHAR(36) NOT NULL DEFAULT '' COMMENT '当前发布 UUID；重新发布轮换，撤销期间不可访问',
  `enabled` TINYINT(1) NOT NULL DEFAULT false COMMENT '是否对全部已登录用户公开',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发布状态首次创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发布状态最后更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 会话广场发布状态';

ALTER TABLE `d2c_session_share` ADD UNIQUE INDEX `uk_d2c_session_share_sessionId` (`sessionId`);

ALTER TABLE `d2c_session_share` ADD UNIQUE INDEX `uk_d2c_session_share_shareId` (`shareId`);

ALTER TABLE `d2c_session_share` ADD INDEX `idx_d2c_session_share_enabled_createdAt` (`enabled`, `createdAt`);

CREATE TABLE IF NOT EXISTS `d2c_team` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增内部主键',
  `teamId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '团队业务 ID',
  `name` VARCHAR(200) NOT NULL DEFAULT '' COMMENT '团队名称',
  `createdUserId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '创建者用户 ID，去首尾空白并转小写',
  `creatorName` VARCHAR(100) COMMENT '创建者显示姓名',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库最后更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 协作团队';

ALTER TABLE `d2c_team` ADD UNIQUE INDEX `uk_d2c_team_teamId` (`teamId`);

ALTER TABLE `d2c_team` ADD INDEX `idx_d2c_team_creator_createdAt` (`createdUserId`, `createdAt`);

CREATE TABLE IF NOT EXISTS `d2c_team_member` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增内部主键',
  `teamId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属团队业务 ID',
  `userId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '成员用户 ID，去首尾空白并转小写',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库最后更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 团队成员，创建者同时是不可移除成员';

ALTER TABLE `d2c_team_member` ADD UNIQUE INDEX `uk_d2c_team_member_team_userId` (`teamId`, `userId`);

ALTER TABLE `d2c_team_member` ADD INDEX `idx_d2c_team_member_userId_team` (`userId`, `teamId`);

CREATE TABLE IF NOT EXISTS `d2c_workspace` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增内部主键',
  `workspaceId` VARCHAR(64) COMMENT '工作区业务 ID',
  `teamId` VARCHAR(64) COMMENT '共享团队业务 ID，NULL 为个人工作区',
  `name` VARCHAR(200) COMMENT '显示名称',
  `createdUserId` VARCHAR(64) COMMENT '服务端 账号认证 用户 ID',
  `creatorName` VARCHAR(100) COMMENT '创建者显示姓名',
  `status` ENUM('preparing', 'ready', 'updating', 'failed') NOT NULL DEFAULT 'preparing' COMMENT '业务状态',
  `activeResourceRevisionId` VARCHAR(64) COMMENT '当前固定资源修订 ID',
  `configRevision` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '配置修订号',
  `configJson` JSON COMMENT 'H5/RN 配置集，不含密钥',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库最后更新时间',
  `deletedAt` DATETIME(3) DEFAULT NULL COMMENT '软删除时间，NULL 表示正常',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 工作区';

ALTER TABLE `d2c_workspace` ADD UNIQUE INDEX `uk_d2c_workspace_workspaceId` (`workspaceId`);

ALTER TABLE `d2c_workspace` ADD INDEX `idx_d2c_workspace_creator_createdAt` (`createdUserId`, `createdAt`);

ALTER TABLE `d2c_workspace` ADD INDEX `idx_d2c_workspace_team_createdAt` (`teamId`, `createdAt`);

CREATE TABLE IF NOT EXISTS `d2c_workspace_revision` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `resourceRevisionId` VARCHAR(64),
  `workspaceId` VARCHAR(64),
  `revision` INTEGER UNSIGNED,
  `sourceVersion` VARCHAR(64),
  `sourceCommit` VARCHAR(64),
  `bundleHash` VARCHAR(64),
  `bundleObject` JSON COMMENT '上传完成后记录不可变资源包定位，不含上传凭据',
  `defaultConfigs` JSON,
  `status` ENUM('preparing', 'ready', 'failed') NOT NULL DEFAULT 'preparing',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_workspace_revision` ADD UNIQUE INDEX `uk_d2c_workspace_revision_resourceId` (`resourceRevisionId`);

ALTER TABLE `d2c_workspace_revision` ADD UNIQUE INDEX `uk_d2c_workspace_revision_workspace_revision` (`workspaceId`, `revision`);

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
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 会话';

ALTER TABLE `d2c_session` ADD UNIQUE INDEX `uk_d2c_session_sessionId` (`sessionId`);

ALTER TABLE `d2c_session` ADD INDEX `idx_d2c_session_workspace_createdAt` (`workspaceId`, `createdAt`);

ALTER TABLE `d2c_session` ADD INDEX `idx_d2c_session_activeRunId` (`activeRunId`);

CREATE TABLE IF NOT EXISTS `d2c_run` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增内部主键',
  `runId` VARCHAR(64) COMMENT '轮次业务 ID',
  `sessionId` VARCHAR(64) COMMENT '会话业务 ID',
  `requestedUserId` VARCHAR(64) COMMENT '本轮实际请求用户 ID，历史记录允许 NULL',
  `clientRequestId` VARCHAR(64) COMMENT '客户端幂等请求 ID',
  `status` ENUM('queued', 'running', 'waiting_input', 'stopping', 'paused', 'interrupted', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued' COMMENT '业务状态',
  `stage` VARCHAR(64) COMMENT '当前执行阶段',
  `resourceRevisionId` VARCHAR(64) COMMENT '本轮固定资源修订 ID',
  `configRevision` INTEGER UNSIGNED COMMENT '配置修订号',
  `configSnapshot` JSON COMMENT '固定配置快照，不含密钥',
  `modelSnapshot` JSON COMMENT '模型与运行参数快照，不含 API Key',
  `credentialId` VARCHAR(64) COMMENT '关联凭据业务 ID',
  `baseFileRevision` INTEGER UNSIGNED COMMENT '本轮基础文件修订号',
  `resumeFromRunId` VARCHAR(64) COMMENT '继续执行来源轮次 ID',
  `leaseOwner` VARCHAR(128) COMMENT '持有租约的执行实例',
  `leaseExpiresAt` DATETIME(3) COMMENT '执行租约到期时间',
  `heartbeatAt` DATETIME(3) COMMENT '最近执行心跳时间',
  `stopRequested` TINYINT(1) NOT NULL DEFAULT false COMMENT '是否已请求停止',
  `cancelRequested` TINYINT(1) NOT NULL DEFAULT false COMMENT '是否已请求取消',
  `checkpoint` JSON COMMENT '私有、无密钥的稳定 SDK 检查点',
  `pendingInteraction` JSON COMMENT '等待中的交互请求',
  `error` JSON COMMENT '安全错误诊断',
  `modelUsage` JSON COMMENT '本轮模型用量',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库最后更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT 'D2C 执行轮次';

ALTER TABLE `d2c_run` ADD UNIQUE INDEX `uk_d2c_run_runId` (`runId`);

ALTER TABLE `d2c_run` ADD UNIQUE INDEX `uk_d2c_run_session_request` (`sessionId`, `clientRequestId`);

ALTER TABLE `d2c_run` ADD INDEX `idx_d2c_run_status_createdAt` (`status`, `createdAt`);

ALTER TABLE `d2c_run` ADD INDEX `idx_d2c_run_leaseExpiresAt` (`leaseExpiresAt`);

ALTER TABLE `d2c_run` ADD INDEX `idx_d2c_run_session_createdAt` (`sessionId`, `createdAt`);

CREATE TABLE IF NOT EXISTS `d2c_timeline` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `entryId` VARCHAR(64),
  `sessionId` VARCHAR(64),
  `runId` VARCHAR(64),
  `seq` INTEGER UNSIGNED,
  `kind` VARCHAR(64) COMMENT 'message/tool_call/tool_result/stage/text_delta 等事件类型',
  `messageId` VARCHAR(64),
  `toolCallId` VARCHAR(200) COMMENT 'SDK 调用 ID，非平台业务 UUID',
  `sdkItem` JSON COMMENT '私有 SDK 回放记录，不含凭据',
  `displayPayload` JSON COMMENT '已脱敏的 UI 展示记录',
  `completed` TINYINT(1) NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_timeline` ADD UNIQUE INDEX `uk_d2c_timeline_entryId` (`entryId`);

ALTER TABLE `d2c_timeline` ADD UNIQUE INDEX `uk_d2c_timeline_session_seq` (`sessionId`, `seq`);

ALTER TABLE `d2c_timeline` ADD INDEX `idx_d2c_timeline_run_seq` (`runId`, `seq`);

ALTER TABLE `d2c_timeline` ADD INDEX `idx_d2c_timeline_session_message` (`sessionId`, `messageId`);

CREATE TABLE IF NOT EXISTS `d2c_file` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `fileId` VARCHAR(64),
  `sessionId` VARCHAR(64),
  `path` TEXT,
  `pathHash` VARCHAR(64),
  `kind` ENUM('source', 'asset', 'attachment', 'internal'),
  `content` LONGTEXT,
  `contentRef` JSON COMMENT '私有不可变文本正文引用，按schemaReady启用',
  `objectLocator` JSON COMMENT '不可变二进制定位，不含上传凭据',
  `mimeType` VARCHAR(200),
  `size` INTEGER UNSIGNED COMMENT '文件字节数',
  `sha256` VARCHAR(64),
  `revision` INTEGER UNSIGNED NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_file` ADD UNIQUE INDEX `uk_d2c_file_fileId` (`fileId`);

ALTER TABLE `d2c_file` ADD UNIQUE INDEX `uk_d2c_file_session_pathHash` (`sessionId`, `pathHash`);

CREATE TABLE IF NOT EXISTS `d2c_version` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `versionId` VARCHAR(64),
  `sessionId` VARCHAR(64),
  `workspaceId` VARCHAR(64),
  `clientRequestId` VARCHAR(64),
  `name` VARCHAR(200),
  `target` ENUM('h5', 'rn'),
  `createdUserId` VARCHAR(64) COMMENT '服务端 账号认证 用户 ID',
  `creatorName` VARCHAR(100),
  `sourceFileRevision` INTEGER UNSIGNED,
  `resourceRevisionId` VARCHAR(64),
  `configRevision` INTEGER UNSIGNED,
  `configSnapshot` JSON COMMENT '私有固定配置快照，不含密钥',
  `validationSummary` JSON COMMENT 'passed/failed/stale/not_checked 及校验证据',
  `manifestHash` VARCHAR(64),
  `status` ENUM('saving', 'ready', 'failed') NOT NULL DEFAULT 'saving',
  `archiveObject` JSON COMMENT '上传完成后记录不可变 ZIP 定位',
  `error` JSON,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_version` ADD UNIQUE INDEX `uk_d2c_version_versionId` (`versionId`);

ALTER TABLE `d2c_version` ADD UNIQUE INDEX `uk_d2c_version_session_request` (`sessionId`, `clientRequestId`);

ALTER TABLE `d2c_version` ADD INDEX `idx_d2c_version_creator_createdAt` (`createdUserId`, `createdAt`);

ALTER TABLE `d2c_version` ADD INDEX `idx_d2c_version_status_createdAt` (`status`, `createdAt`);

ALTER TABLE `d2c_version` ADD INDEX `idx_d2c_version_session_createdAt` (`sessionId`, `createdAt`);

ALTER TABLE `d2c_version` ADD INDEX `idx_d2c_version_status_target_createdAt` (`status`, `target`, `createdAt`);

CREATE TABLE IF NOT EXISTS `d2c_version_file` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `versionId` VARCHAR(64),
  `path` TEXT,
  `pathHash` VARCHAR(64),
  `kind` ENUM('source', 'asset', 'attachment', 'internal'),
  `content` LONGTEXT,
  `contentRef` JSON COMMENT '私有不可变文本正文引用，按schemaReady启用',
  `objectLocator` JSON COMMENT '不可变二进制定位，不含上传凭据',
  `mimeType` VARCHAR(200),
  `size` INTEGER UNSIGNED COMMENT '文件字节数',
  `sha256` VARCHAR(64),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_version_file` ADD UNIQUE INDEX `uk_d2c_version_file_version_pathHash` (`versionId`, `pathHash`);

CREATE TABLE IF NOT EXISTS `d2c_preview` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment ,
  `previewId` VARCHAR(64),
  `sessionId` VARCHAR(64) COMMENT '与 versionId 互斥，由业务层检查',
  `versionId` VARCHAR(64) COMMENT '与 sessionId 互斥，由业务层检查',
  `fileRevision` INTEGER UNSIGNED,
  `manifestHash` VARCHAR(64),
  `configSnapshot` JSON COMMENT '私有固定配置快照，不含密钥',
  `resourceRevisionId` VARCHAR(64),
  `runtimeRevision` VARCHAR(64),
  `status` ENUM('queued', 'building', 'ready', 'failed') NOT NULL DEFAULT 'queued',
  `leaseOwner` VARCHAR(128),
  `leaseExpiresAt` DATETIME(3),
  `buildManifest` JSON,
  `error` JSON,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `datachange_lasttime` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_preview` ADD UNIQUE INDEX `uk_d2c_preview_previewId` (`previewId`);

ALTER TABLE `d2c_preview` ADD INDEX `idx_d2c_preview_manifest_runtime` (`manifestHash`, `runtimeRevision`);

ALTER TABLE `d2c_preview` ADD INDEX `idx_d2c_preview_status_createdAt` (`status`, `createdAt`);

ALTER TABLE `d2c_preview` ADD INDEX `idx_d2c_preview_leaseExpiresAt` (`leaseExpiresAt`);

ALTER TABLE `d2c_preview` ADD INDEX `idx_d2c_preview_session_createdAt` (`sessionId`, `createdAt`);

ALTER TABLE `d2c_preview` ADD INDEX `idx_d2c_preview_version_createdAt` (`versionId`, `createdAt`);

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
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_credential` ADD UNIQUE INDEX `uk_d2c_credential_credentialId` (`credentialId`);

ALTER TABLE `d2c_credential` ADD INDEX `idx_d2c_credential_owner_kind` (`ownerUserId`, `kind`);

ALTER TABLE `d2c_credential` ADD UNIQUE INDEX `uk_d2c_credential_owner_kind_revision` (`ownerUserId`, `kind`, `revision`);

CREATE TABLE IF NOT EXISTS `d2c_agent_checkpoint` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '内部自增 ID，应用按字符串处理',
  `sessionId` VARCHAR(36) NOT NULL DEFAULT '' COMMENT '所属会话 UUID',
  `threadId` VARCHAR(40) NOT NULL DEFAULT '' COMMENT '固定 d2c:会话UUID，按原文核对',
  `namespaceHash` VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'namespace UTF-8 SHA-256 索引',
  `checkpointNs` LONGTEXT COMMENT '完整 namespace，hash 命中后核对原文',
  `checkpointId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '检查点 ID，ASCII 字节顺序',
  `parentCheckpointId` VARCHAR(64) COMMENT '同 namespace 的父检查点 ID',
  `checkpointType` VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'serde typed 检查点编码',
  `checkpointPayload` LONGBLOB COMMENT '完整 typed 检查点，含全部 channel_values 与版本',
  `metadataType` VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'serde typed 元数据编码',
  `metadataPayload` LONGBLOB COMMENT 'typed 元数据',
  `checkpointRef` JSON COMMENT '私有不可变typed载荷引用',
  `metadataRef` JSON COMMENT '私有不可变typed载荷引用',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库变更时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE `d2c_agent_checkpoint` ADD UNIQUE INDEX `uk_d2c_agent_checkpoint_key` (`sessionId`, `namespaceHash`, `checkpointId`);

CREATE TABLE IF NOT EXISTS `d2c_agent_write` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '内部自增 ID，应用按字符串处理',
  `sessionId` VARCHAR(36) NOT NULL DEFAULT '' COMMENT '所属会话 UUID',
  `threadId` VARCHAR(40) NOT NULL DEFAULT '' COMMENT '固定 d2c:会话UUID，按原文核对',
  `namespaceHash` VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'namespace UTF-8 SHA-256 索引',
  `checkpointNs` LONGTEXT COMMENT '完整 namespace，hash 命中后核对原文',
  `checkpointId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '检查点 ID，ASCII 字节顺序',
  `taskHash` VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'taskId UTF-8 SHA-256 索引',
  `taskId` LONGTEXT COMMENT '完整 taskId，hash 命中后核对原文',
  `taskPath` LONGTEXT COMMENT 'SDK writesSortKey 的任务路径',
  `idx` INTEGER NOT NULL DEFAULT 0 COMMENT '普通写序号；特殊写使用 WRITES_IDX_MAP 负序号',
  `channelName` LONGTEXT COMMENT '完整 channel 名称',
  `valueType` VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'serde typed 写值编码',
  `writePayload` LONGBLOB COMMENT 'typed pending write 值',
  `writeRef` JSON COMMENT '私有不可变typed载荷引用',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '数据库变更时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE `d2c_agent_write` ADD UNIQUE INDEX `uk_d2c_agent_write_key` (`sessionId`, `namespaceHash`, `checkpointId`, `taskHash`, `idx`);

CREATE TABLE IF NOT EXISTS `d2c_message_attachment` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '内部自增主键',
  `attachmentId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '附件业务标识',
  `sessionId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属会话标识',
  `messageId` VARCHAR(64) DEFAULT NULL COMMENT '关联用户消息；未发送为空',
  `userId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '上传用户；访问仍校验会话归属',
  `fileName` VARCHAR(200) NOT NULL DEFAULT '' COMMENT '原始展示文件名',
  `mimeType` VARCHAR(100) NOT NULL DEFAULT '' COMMENT '实际图片媒体类型',
  `size` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '二进制字节数',
  `sha256` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '二进制 SHA256',
  `width` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '图片像素宽度',
  `height` INTEGER UNSIGNED NOT NULL DEFAULT 0 COMMENT '图片像素高度',
  `objectLocator` JSON COMMENT 'Storage 不可变定位；无授权材料',
  `expiresAt` DATETIME(3) DEFAULT NULL COMMENT '未发送附件到期时间；关联后为空',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

ALTER TABLE `d2c_message_attachment` ADD UNIQUE INDEX `uk_d2c_attachment_id` (`attachmentId`);

ALTER TABLE `d2c_message_attachment` ADD INDEX `idx_d2c_attachment_message` (`sessionId`, `messageId`);

ALTER TABLE `d2c_message_attachment` ADD INDEX `idx_d2c_attachment_expiry` (`expiresAt`);
