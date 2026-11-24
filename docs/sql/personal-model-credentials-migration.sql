-- 已有部署：备份数据库，停止旧服务后由部署方审核并执行一次，再启动新服务。
-- 程序及 db:init 不自动 ALTER 已有表；必须先完成下面两项变更。
-- 确认 SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='d2c_credential' AND COLUMN_NAME='kind';
-- 及 SHOW COLUMNS FROM d2c_session LIKE 'modelCredentialId'; 避免重复加列。
ALTER TABLE `d2c_credential`
  MODIFY COLUMN `kind` ENUM('figma','model') NOT NULL DEFAULT 'figma';
ALTER TABLE `d2c_session`
  ADD COLUMN `modelCredentialId` VARCHAR(64) NULL DEFAULT NULL
  COMMENT '本人固定模型 Token 修订，NULL 沿用平台模型' AFTER `credentialId`;
-- 历史行保持 NULL，沿用平台默认模型；不得把平台 Key 回填到凭据或快照。
-- 新分支由服务端选取本人 active model 凭据并绑定；Token 修订保留历史密钥材料。
-- 回滚代码前先停止个人模型分支执行；不要直接删列、删旧修订或删除加密密钥。
