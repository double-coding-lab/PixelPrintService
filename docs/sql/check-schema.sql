-- 只读：选择目标库后执行；仅检查元数据，不读取业务大字段。
SELECT DATABASE() AS selected_database;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME IN ('d2c_file', 'd2c_version_file', 'd2c_saved_work_file')
      AND COLUMN_NAME = 'contentRef')
    OR (TABLE_NAME = 'd2c_agent_checkpoint'
      AND COLUMN_NAME IN ('checkpointRef', 'metadataRef'))
    OR (TABLE_NAME = 'd2c_agent_write' AND COLUMN_NAME = 'writeRef')
    OR (TABLE_NAME = 'd2c_credential' AND COLUMN_NAME = 'kind')
    OR (TABLE_NAME = 'd2c_session' AND COLUMN_NAME = 'modelCredentialId')
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('d2c_session_share', 'd2c_saved_work', 'd2c_saved_work_file')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('d2c_session_share', 'd2c_saved_work', 'd2c_saved_work_file')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
