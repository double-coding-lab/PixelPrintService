# 检查点与中间写入外置：第二阶段

2026-11-21。用户授权双仓同步实现，内仓兼容旧检查点和中间写入。代码独立于第一阶段提交，分支codex/content-storage-phase2。当前实施和离线验证，不执行目标库DDL/DML、真实上传、历史迁移或清理。

## 范围与观测

部署方截图显示检查点表约24.8GiB、中间写入约7.7GiB，二者约占所列七张表总分配空间的94%。最新五条检查点样本单条约6MiB、属于同一会话。相同大小不能证明相同内容或写入故障，表空间估算不能当作全部有效载荷净字节。

本阶段迁出checkpointPayload、metadataPayload和writePayload中的大型序列化字节。namespace、thread/session、checkpointId/parent、taskId/path、通道、idx、typed编码、索引及租约控制仍在数据库，原序列化格式、父链delta replay、pending write顺序和原生interrupt语义保留。时间线和历史保留/回收另行安排。

## 兼容存储

- 新增d2c_agent_checkpoint.checkpointRef/metadataRef及d2c_agent_write.writeRef三列可空JSON。旧BLOB列保留，默认模型投影不选择新列；独立checkpointBody scope在新schema就绪后读取引用。应用不自动alter已有库。
- 二进制引用pixelprint.blob.v1记录原始字节数/摘要、密文大小、压缩标志、密钥版本和私有定位。任意typed bytes原样往返，不转为UTF-8文本或Base64正文。gzip仅在压缩获益时使用，解压输出有界。
- AES-256-GCM、随机不可变对象及上传后回读校验复用第一阶段传输基础；加密绑定行身份和typed编码，防止跨会话/namespace/检查点/任务载荷移用。私有定位及密钥不返回前端、不进入日志。
- 旧BLOB非NULL时优先读取，兼容旧writer的更新；仅有引用时严格验证再解密/解压。损坏、缺失、密钥错误或取消明确失败，不以空检查点或重跑替代原执行状态。
- 按现有单对象能力及uploadBytes设置上限，超出能力的合法载荷继续inline，不降低框架原BLOB可保存范围。本阶段不分块，也不自动删除未引用对象。

## 独立配置

项目配置project.config.json的runtime.d2c.checkpointStorage。第一阶段contentStorage与本阶段分别启用，不会互相自动切换。新建配置生成独立checkpoint-primary密钥，已有部署自行准备和备份。

```json
{
  "schemaReady": false,
  "mode": "inline",
  "thresholdBytes": 262144,
  "concurrency": 2,
  "encryption": {
    "activeKeyId": "checkpoint-primary",
    "keys": { "checkpoint-primary": "<32字节随机密钥的标准Base64>" }
  }
}
```

inline保存原BLOB；shadow保留BLOB并记录已核验引用；external对合格大载荷仅存引用，小载荷和超过传输上限的载荷仍留库。阈值为候选值，按真实负载调整。schemaReady进程内固定，补列后启用必须重启；mode可以回退，但仍需保持schemaReady、对象与历史密钥以读取已有引用。

## 执行及恢复边界

1. 先序列化并在事务外压缩/加密/上传/核验，再进入原租约事务保存引用；对象上传期间不会持有会话/轮次租约数据库锁。
2. 上传完成不代表获得提交资格。仍由leases.commit在原锁序检查session、run owner、期限及停止状态，失租或事务失败不能提交新引用。
3. 普通pending write保持first-wins，特殊负idx保持last-wins，批次内数据库更动原子提交。未被采用的上传对象暂保留为孤立对象，不能删除可能被历史引用的对象。
4. 读取先在一致读事务冻结单个tuple及所需parent/pending描述，再在事务外还原字节及反序列化；读失败保留原恢复状态。列表有界分页并逐个返回，外部对象IO不在长事务内。
5. 原检查点重复包含完整channel_values是当前saver的恢复契约；不能通过丢弃旧消息或newVersions中未出现的通道缩小载荷。改成通道级增量存储或历史保留策略须另行设计恢复/分支/归档保留测试。

## 历史迁移与回滚

先审核d2c-checkpoint-storage_迁移.sql、备份元数据/对象/正文密钥，再部署新代码、启用schemaReady并重启；先shadow观测，确认旧写入实例退出后才external。第一阶段三表的建列不能代替本阶段两表三列。

```sh
npm run checkpoint:migrate -- --help
npm run checkpoint:migrate -- --dry-run --table checkpoints --batch-size 10
npm run checkpoint:migrate -- --apply --table checkpoints --batch-size 10
npm run checkpoint:migrate -- --apply --table checkpoints --resume
npm run checkpoint:migrate -- --apply --table writes --batch-size 10
npm run checkpoint:migrate -- --apply --restore --table checkpoints
npm run checkpoint:migrate -- --apply --restore --table writes
```

external apply需额外--confirm-external。两表分别运行，shadow转external或参数策略变化时从头使用新state-file，已完成的shadow游标不代表external完成。固定BIGINT上界、只分页ID、逐行读取/处理。迁移在事务外准备对象，在会话→载荷行短事务中重验原BLOB、引用、身份及会话空闲状态；活动或暂停中会话保留原数据，待空闲后重试。故障/并发冲突停在失败行之前，--resume原点重试，整行检查点和元数据同时更新，显式保留原更新时间，避免把迁移当作最新执行保存。

默认只预演，不进行对象IO或数据库写；控制游标为本地0600文件，仅含动作、表组、上界与最后成功ID。restore按精确typed字节回填BLOB，保留引用与对象，不删除历史或改变执行状态。回滚旧程序前先停止外置写入，将两表所需BLOB全部回填并核验，不能仅改mode或删密钥。

## 验收与后续阶段

离线验证旧schema SQL、旧BLOB/新引用/混合模式、任意二进制、压缩边界、篡改/缺失/取消、失租/提交回滚、重复writes语义、父链和真实StateGraph的interrupt及失败任务恢复。再验证archive、摘要、子图、新saver实例恢复，双仓同步类型/构建/测试及安全诊断。目标环境还需验证真实MySQL隔离行为、网络故障、跨Worker恢复和写入/恢复延迟。

第三阶段候选：时间线大私有正文、检查点历史保留与安全对象回收、通道级增量/内容复用。先测第二阶段结果，不自动删旧checkpoint或改图恢复算法。外置减少数据库正文压力，压缩减少传输和存储；它们不承诺自动释放InnoDB已分配空间，也不保证立刻修复所有数据库内存问题。
