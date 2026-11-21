-- 第二阶段独立增量；先备份和审核，执行后重启再启用checkpointStorage.schemaReady。
-- 保留旧BLOB及所有恢复索引，不自动迁移、清理或删除对象。本轮未执行。
ALTER TABLE `d2c_agent_checkpoint`
  ADD COLUMN `checkpointRef` JSON NULL COMMENT '私有不可变检查点载荷引用',
  ADD COLUMN `metadataRef` JSON NULL COMMENT '私有不可变检查点元数据引用';
ALTER TABLE `d2c_agent_write`
  ADD COLUMN `writeRef` JSON NULL COMMENT '私有不可变中间写载荷引用';
