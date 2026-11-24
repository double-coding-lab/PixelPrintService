# 大正文文件存储：第一阶段实施与部署

新部署默认：setup生成的contentStorage与checkpointStorage均为external、schemaReady=true，并生成独立密钥；运行前由db:init或容器入口创建新表。下文inline/shadow配置用于已有库的分阶段升级，已有配置不会自动改写。
2026-11-21。双仓已接入当前文本、Figma节点缓存、暂存版本、个人作品及预览快照。既有部署默认沿用数据库正文；本轮仅离线验证，未执行目标库DDL/DML、真实上传、历史迁移、清理或部署。目标环境容量和性能仍待测量。

## 数据和读取边界

| 对象 | 元数据和正文表示 | 读取入口 |
| --- | --- | --- |
| 当前文件/Figma缓存 | d2c_file.content或私有contentRef | files、改名、Agent写入/恢复 |
| 暂存版本 | d2c_version_file.content/contentRef | 冻结、ZIP、gallery、版本预览 |
| 个人作品 | d2c_saved_work_file.content/contentRef | 保存、源码、下载、再次编辑 |
| 会话预览 | buildManifest.snapshot的content/contentRef | 构建Worker、缓存失效重建、临时编辑 |
| 临时编辑副本 | Redis中的实际字符串 | Monaco、差异、应用、导出，沿用原生命周期 |

模型默认scope排除新列；schemaReady关闭时旧表可继续查询和写入。二进制objectLocator语义不变。空字符串是有效文本。公开接口继续返回授权后的源码字符串，不返回正文引用、密钥或私有对象定位。

## 存储协议和事务

content/store.ts以随机不可变对象保存AES-256-GCM密文，AAD绑定对象身份、scope、密钥版本、UTF-8长度和摘要。put上传后回读核验，read校验密文/认证标签/明文摘要；历史密钥须保留。单独的正文密钥不复用登录或票据密钥。并发默认2（1～8），等待数量和字节都有界，不缓存正文。

内仓复用既有文件客户端，外仓复用local/S3；对象内容始终是密文。下载适配支持取消和流式限额。内仓单对象上限30,000,000字节（密文封装额外36字节），外仓协议上限128MiB；还受当前uploadBytes限制。超过可外置范围的合法文本保留inline，维持原业务限额，本阶段不分块。

业务写入先在事务外上传并核验，再按原锁序重验修订/租约并提交引用。版本、作品和预览冻结复制同一不可变引用。临时编辑先冻结描述、事务外还原正文、再短事务重验权限/输入身份和编辑副本CAS。失败不覆盖旧对象；孤立对象暂保留。

## 配置和兼容顺序

配置位置：内仓system-config.json的d2c.contentStorage；外仓项目配置同路径。外仓新setup生成独立正文密钥；已有部署须自行准备密钥备份。示意配置（密钥占位须替换，不能照抄启用）：

```json
{
  "schemaReady": false,
  "mode": "inline",
  "thresholdBytes": 262144,
  "concurrency": 2,
  "encryption": { "activeKeyId": "body-primary", "keys": { "body-primary": "<32字节随机密钥的标准Base64>" } }
}
```

1. 备份元数据、对象和正文密钥；审阅docs/sql/content-storage-migration.sql。已有库仅补三列可空JSON；新建外仓库由现有初始化脚本创建模型，不重建已有库。
2. 执行获准的增量DDL后，配置schemaReady=true并重启实例。schemaReady在进程内固定；mode、阈值、密钥可随配置读取，存储并发在首次创建正文客户端时固定。
3. 先用shadow：合格新正文同时保留inline和引用，兼容旧实例读写。读取inline优先；旧实例改写后残留的旧引用不覆盖新正文，冻结会核对大小和摘要、剔除陈旧引用。
4. 观察与校验后，确认旧写入实例已退出，方可切external：大正文仅保留引用，小正文和超出传输能力的文本仍inline。262144只是初始候选阈值，需按真实容量、频率、内存及延迟调参。
5. 关闭外置写入可设mode=inline，但schemaReady继续为true，保留密钥/存储供读取历史引用。回滚旧程序前须执行restore回填所有相关表及预览，验证完成并停止外置写入后再切旧程序。仅关mode不等于旧程序可读外置数据。

## 审计、迁移和恢复命令

以下命令由部署方在审批、备份和窗口确认后执行，本轮未执行。审计脚本仅生成固定字段聚合SELECT，需自行在只读副本或观察窗口测量，不返回正文。JSON容量为序列化估算。

```sh
npm run content:audit -- --help
npm run content:migrate -- --help
npm run content:migrate -- --dry-run --table files --batch-size 25
npm run content:migrate -- --apply --table files --batch-size 25
npm run content:migrate -- --apply --table files --resume
npm run content:migrate -- --apply --table files --confirm-external --resume
npm run content:migrate -- --apply --restore --table files
```

分别对files、versions、works、previews运行；每次默认一批，可用--max-batches限定批数。dry-run仅读库校验，不上传/下载对象、不改数据库，但会写本地控制游标。external实际执行须--confirm-external。shadow与external建议用不同--state-file：由shadow切external需要从头验证，不沿用已完成的shadow游标。restore使用独立动作游标。

固定BIGINT上界、ID分页、逐行正文读取避免批量加载大字段；引用准备在事务外，锁内比较源正文/摘要/修订/定位或整个预览manifest。提交成功才推进游标；上传故障、校验失败、CAS冲突或活动预览均停止在失败行之前，排除原因后--resume重试。迁移不改变业务修订、不发file_changed、不删除对象。并发新写或上界后新增记录需另开一轮。

游标默认在.runtime/content-migration，以0600原子写入，仅含版本、动作、表组、是否预演、上界及最后成功ID；跨机器续迁需安全传递对应文件。日志只有计数、ID与固定错误码。保留对象和历史密钥，恢复时同样核验摘要；不应降低读取通道限额至历史引用以下。

## 第二阶段评估

| 范围 | 原有约束 | 建议 |
| --- | --- | --- |
| Timeline的sdkItem/工具结果 | seq顺序、模型重放、公开安全投影 | 先测容量；未来只外置大私有payload，展示元数据留库 |
| checkpointPayload/metadataPayload | thread/checkpoint身份与事务恢复一致 | 保留现有二进制格式，另设计引用版本及恢复矩阵后实施 |
| pending writes/writePayload | 任务/通道顺序和高频原子追加 | 先测延迟收益，避免每小写都访问对象存储 |

本阶段保持上述存储格式。两段式标识排序、原业务索引和分页继续保留；文件化不能代替排序优化，也不承诺解决全部MySQL或Node.js内存问题。

## 部署验收

离线覆盖旧schema投影/INSERT、三模式、旧writer残留引用、冻结复用、公开DTO、ZIP/预览/编辑/Agent恢复、对象损坏/丢失/超时/限额、取消、上传失败、提交回滚、CAS冲突和断点恢复。真实数据库/对象存储连通、多实例可达性、容量下降和延迟/堆峰值应在目标环境另行验证；local多实例须使用共享持久卷，不能依赖单机临时目录。GC与旧对象清理不在本阶段。
