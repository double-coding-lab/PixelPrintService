-- 新程序默认schemaReady=false时不查询新列。先备份，在目标环境审阅后执行，再启用schemaReady。
-- 只增加可空引用，不搬迁或清理正文，不修改既有二进制objectLocator。
ALTER TABLE `d2c_file` ADD COLUMN `contentRef` JSON NULL COMMENT '私有不可变文本正文引用';
ALTER TABLE `d2c_version_file` ADD COLUMN `contentRef` JSON NULL COMMENT '冻结文本正文引用';
ALTER TABLE `d2c_saved_work_file` ADD COLUMN `contentRef` JSON NULL COMMENT '作品冻结文本正文引用';
-- d2c_preview的snapshot引用保存在原JSON中，无额外列。
