# 大正文文件存储续作上下文

- 2026-11-21用户授权实现并兼容已有部署数据；第一阶段代码已接入，部署默认inline/schemaReady=false。
- 范围：content/store/runtime/backend/install、文件及Figma缓存、Agent持久化恢复、版本/作品、预览及编辑，历史迁移CLI和回填。
- 新schema：三表contentRef可空JSON，预览snapshot内引用。旧scope默认排除此列；已就绪进程用contentBody scope显式读取。schemaReady变更需重启，mode回inline仍保留读取引用能力。
- 兼容期inline优先，shadow双写后external；旧程序回滚须先restore所有正文及预览。随机不可变密文对象、独立密钥及摘要核验，公开DTO只有已授权源码。
- 上传及还原在事务外，原权限/锁序/租约/修订CAS保留；迁移使用representation-only行锁，不改业务修订或事件。
- 迁移游标固定BIGINT上界，失败/冲突/活动预览保留安全位置；dry-run无远程对象IO/数据库写，控制状态文件仅本地元数据。
- 当前未执行真实数据库/存储操作、历史清理、GC或部署；实现与测试已提交；本轮不推送。
- 第二阶段保留typed格式并新增检查点/pending writes外置引用；时间线仍留库，配置与迁移见第二阶段方案。
- 实施/灰度/回滚说明：.Knowledge/req-docs/large-content-storage_第一阶段方案.md；待测容量和部署事项见user-todos.md。
- 知识库已通过revision预演/apply/build/check，未改其他活跃任务的delta。

## 第一阶段独立提交
- 分支：codex/content-storage-phase1。
- f8e30a1 [tech] test: 覆盖第一阶段正文外置与故障恢复场景
- 81b9ef5 [tech] feat: 新增社区版第一阶段加密正文存储与兼容迁移
- 第二阶段已从第一阶段提交切出codex/content-storage-phase2续作。

## 第二阶段续作
- 分支codex/content-storage-phase2，继承第一阶段三个提交。独立checkpointStorage开关默认关闭，不随contentStorage启用。
- 检查点保留序列化typed bytes、父链、namespace及pending-write顺序；只改变大BLOB的物理表示。
- 第三阶段候选为时间线外置和历史保留/回收，当前不自动实施。

## 第二阶段实现与回归
- 独立checkpointStorage默认关闭；两表三列引用，BLOB优先兼容旧writer。大typed bytes获益时gzip后加密，SHA256及scope绑定原字节和行身份。
- 对象上传/还原在事务外，提交保留租约；first-wins预检避免重复上传，大批次逐项准备避免自触BUSY。
- 读取每个tuple冻结一致状态后还原，list分页yield并复核filter；不维持跨页长事务。
- 迁移空闲会话，dry-run无对象IO或写锁，原更新时间显式保留，冲突/取消保留安全游标，可restore精确BLOB。
- 交叉审查发现的等待租约取消漏洞已修复：callback入口及callback结束再次检查，factory保留原取消原因；新增等待锁和写后取消的事务回滚测试。
- 当前仅离线替身/真实框架回归，未执行目标DDL/DML、真实对象上传、清理或部署；第二阶段实现与测试已本地提交，知识库与部署说明随本次文档提交保存；本轮不推送。

## 第二阶段独立提交
- 分支：codex/content-storage-phase2。
- 9bbcaac [tech] test: 覆盖检查点外置与执行恢复场景
- 0e7b459 [tech] feat: 新增社区版检查点与中间写入外置存储
- 知识库构建与校验通过；仅本地提交，未推送，未执行实际迁移。

## 合并到集成分支（2026-11-21）
- 两阶段代码、测试及知识库合并到main，保留已集成的Figma参数兼容与子树读取改动。
- 知识库索引、matcher、终稿与主题按并集合并并提升主题revision；部署配置仍默认关闭，未运行目标库迁移。
