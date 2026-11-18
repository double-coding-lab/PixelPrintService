-- 会话广场与个人作品：仅新增三张表；请在发布前人工审核执行。
-- 不修改现有会话、文件、版本表，不回填或默认公开已有会话。

-- 每个会话的发布开关，撤回后不再允许广场读取。
CREATE TABLE IF NOT EXISTS `d2c_session_share` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '内部自增主键',
  `sessionId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '唯一会话业务标识',
  `shareId` VARCHAR(36) NOT NULL DEFAULT '' COMMENT '当前发布 UUID；重新发布轮换，撤销期间不可访问',
  `enabled` TINYINT(1) NOT NULL DEFAULT false COMMENT '是否对全部已登录用户公开',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发布状态首次创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发布状态最后更新时间',
  PRIMARY KEY (
  `id`)
) ENGINE=InnoDB COMMENT '每个会话的发布开关，撤回后不再允许广场读取。' DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `d2c_session_share` ADD UNIQUE INDEX `uk_d2c_session_share_sessionId` (`sessionId`);
ALTER TABLE `d2c_session_share` ADD UNIQUE INDEX `uk_d2c_session_share_shareId` (`shareId`);
ALTER TABLE `d2c_session_share` ADD INDEX `idx_d2c_session_share_enabled_createdAt` (`enabled`,
  `createdAt`);

-- 归属于当前用户的独立长期作品，保存后可再次编辑。
CREATE TABLE IF NOT EXISTS `d2c_saved_work` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增主键',
  `workId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '个人作品业务标识',
  `ownerEid` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '服务端身份；所有查询必须匹配',
  `name` VARCHAR(200) NOT NULL DEFAULT '' COMMENT '个人作品名称',
  `target` ENUM('h5', 'rn') NOT NULL DEFAULT 'h5' COMMENT '固定预览目标',
  `revision` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '作品乐观锁修订',
  `editId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '首次保存的副本标识；后续不改',
  `editRevision` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '首次保存的副本修订；后续不改',
  `lastSaveKey` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '最近一次 editId/revision 摘要；重试重放',
  `sourceId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '来源标识，仅溯源，无外键或生命周期依赖',
  `baseFileRevision` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '最近保存时的副本基线修订',
  `entryPath` TEXT COMMENT '固定预览入口',
  `entries` JSON COMMENT '冻结入口清单',
  `configSnapshot` JSON COMMENT '仅预览运行时白名单，不保存模型或凭据',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (
  `id`)
) ENGINE=InnoDB COMMENT '归属于当前用户的独立长期作品，保存后可再次编辑。' DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `d2c_saved_work` ADD UNIQUE INDEX `uk_d2c_saved_work_id` (`workId`);
ALTER TABLE `d2c_saved_work` ADD UNIQUE INDEX `uk_d2c_saved_work_owner_edit` (`ownerEid`,
  `editId`,
  `editRevision`);
ALTER TABLE `d2c_saved_work` ADD INDEX `idx_d2c_saved_work_owner_updated` (`ownerEid`,
  `datachange_lasttime`);

-- 个人作品的不可变文件修订，文本入库、图片保留存储定位。
CREATE TABLE IF NOT EXISTS `d2c_saved_work_file` (
  `id` BIGINT UNSIGNED NOT NULL auto_increment  COMMENT '自增主键',
  `workId` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所属个人作品',
  `ownerEid` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '服务端身份；文件查询必须匹配',
  `workRevision` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '不可变作品快照修订',
  `path` TEXT COMMENT '固定相对文件路径',
  `pathHash` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '相对路径 SHA-256',
  `kind` ENUM('source', 'asset', 'attachment') NOT NULL DEFAULT 'source' COMMENT '可预览或下载产物',
  `content` LONGTEXT COMMENT '冻结源码正文',
  `objectLocator` JSON COMMENT '不可变存储定位；不含凭据',
  `size` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '文件字节数',
  `sha256` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '内容 SHA-256',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  `datachange_lasttime` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (
  `id`)
) ENGINE=InnoDB COMMENT '个人作品的不可变文件修订，文本入库、图片保留存储定位。' DEFAULT CHARSET=utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `d2c_saved_work_file` ADD UNIQUE INDEX `uk_d2c_saved_file_owner_revision_path` (`ownerEid`,
  `workId`,
  `workRevision`,
  `pathHash`);

