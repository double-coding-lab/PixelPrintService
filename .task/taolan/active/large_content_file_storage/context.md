# 大正文文件存储续作上下文

- 2026-11-21用户授权实现并兼容已有部署数据；第一阶段代码已接入，部署默认inline/schemaReady=false。
- 范围：content/store/runtime/backend/install、文件及Figma缓存、Agent持久化恢复、版本/作品、预览及编辑，历史迁移CLI和回填。
- 新schema：三表contentRef可空JSON，预览snapshot内引用。旧scope默认排除此列；已就绪进程用contentBody scope显式读取。schemaReady变更需重启，mode回inline仍保留读取引用能力。
- 兼容期inline优先，shadow双写后external；旧程序回滚须先restore所有正文及预览。随机不可变密文对象、独立密钥及摘要核验，公开DTO只有已授权源码。
- 上传及还原在事务外，原权限/锁序/租约/修订CAS保留；迁移使用representation-only行锁，不改业务修订或事件。
- 迁移游标固定BIGINT上界，失败/冲突/活动预览保留安全位置；dry-run无远程对象IO/数据库写，控制状态文件仅本地元数据。
- 当前未执行真实数据库/存储操作、历史清理、GC或部署；实现与测试已提交；本轮不推送。
- 第二阶段时间线、检查点与pending writes格式保持，评估见第一阶段方案。
- 实施/灰度/回滚说明：.Knowledge/req-docs/large-content-storage_第一阶段方案.md；待测容量和部署事项见user-todos.md。
- 知识库已通过revision预演/apply/build/check，未改其他活跃任务的delta。

## 第一阶段独立提交
- 分支：codex/content-storage-phase1。
- f8e30a1 [tech] test: 覆盖第一阶段正文外置与故障恢复场景
- 81b9ef5 [tech] feat: 新增社区版第一阶段加密正文存储与兼容迁移
- 第二阶段尚未修改源码，后续实施从独立分支推进。
