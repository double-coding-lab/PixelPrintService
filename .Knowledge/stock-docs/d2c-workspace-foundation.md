# 工作区、产物与版本

## 工作区和会话

工作区保存一份固定资源包与可编辑的业务配置。新建时从 `pixelprint` 的模板复制，后续明确升级才生成新资源修订；同一修订下的会话可以复现所用 Skill 和配置。

会话保存目标 H5/RN、可选设计稿链接、凭据引用、文件修订与独立 Agent 上下文。有效链接创建的会话可以保存首条生成请求并入队；无链接可先创建空会话。默认会话名可在读取绑定设计稿最外层节点后更新，用户自定义名称保留。

个人工作区和团队共享工作区通过数据库权限区分。业务身份来自服务端当前用户，凭据使用实际发起人的记录。工作区及会话使用软删除，删除条件仍需检查活跃执行，不直接删除数据库行来解决占用。

## 存储位置

| 内容 | 事实源与用途 |
| --- | --- |
| 工作区、配置和资源修订 | MySQL 业务记录，资源对象由统一存储保存 |
| 会话、用户消息、轮次、事件 | MySQL；时间线支持数据库游标补读 |
| Agent 检查点和中间写 | 专用 MySQL 模型，与稳定文件修订分别保存 |
| 文本内容和文件修订 | 文件服务经数据库事务保存；对象类文件保存定位与摘要 |
| 图片、资源包、附件、版本 ZIP | 本地对象目录或 S3，通过统一客户端读写 |
| 通知、编辑临时状态和协调 | Redis，通知只提示按持久游标补读 |
| 单轮脚本、缓存与执行副本 | `workRoot` 下的私有临时目录，不能作为唯一存储 |

稳定文件带路径、大小和 SHA-256。并行工具的文件提交串行核对修订；恢复后使用已保存摘要跳过未变文件，避免重复上传。上传冲突时核对内容并使用有界后缀，不覆盖已发布对象。

## 数据库大字段与增长来源

- 当前源码保存在 `d2c_file.content`，按 `sessionId + pathHash` 定位文件；路径命中后核对完整 `path`。同一当前文件更新正文与修订，暂存版本和作品保存各自冻结副本。

| 表 | 大内容字段（数据库列名） | 内容与增长来源 |
| --- | --- | --- |
| `d2c_file` | `content`（LONGTEXT） | 当前源码、样式、JSON及内部文本；`.d2c-cache` 的完整Figma节点缓存也保存在此处 |
| `d2c_version_file` | `content`（LONGTEXT） | 每次暂存版本冻结的文件正文；版本增多会累积源码副本 |
| `d2c_saved_work_file` | `content`（LONGTEXT） | 个人作品按修订冻结的源码正文 |
| `d2c_preview` | `buildManifest`（JSON） | 会话预览的 `snapshot[].content` 保存参与构建的源码；输入变化可新增快照，清单还含构建资源定位 |
| `d2c_timeline` | `sdkItem`、`displayPayload`（JSON） | 私有消息、工具参数/结果及公开展示投影，可能含代码或文件片段，随事件累积 |
| `d2c_agent_checkpoint` | `checkpointPayload`、`metadataPayload`（LONGBLOB） | Agent图状态与元数据；独立namespace还保存内部历史归档 |
| `d2c_agent_write` | `writePayload`（LONGBLOB） | 框架中间写值，可能包含消息、工具结果与状态 |

- `d2c_run` 的配置/模型快照、`checkpoint`、`pendingInteraction`、`error`、`modelUsage`，以及工作区配置、会话校验状态属于JSON元数据，通常小于完整正文与历史；按实际数据核定占用。`d2c_session.contextSummary` 为LONGTEXT，当前会话创建置NULL，上下文摘要与恢复应按执行专题检查图状态和归档。
- 图片、ZIP及二进制附件由统一存储客户端保存在本地对象目录或S3，文件表的 `objectLocator` 记录定位、大小和摘要。在线编辑临时副本的源码/快照在Redis，本地编译缓存按运行目录管理，分别统计。
- 占用排查同时比较单条最大字节、总字节与记录数；优先统计检查点、中间写、时间线、当前文件、版本文件和预览清单，个人作品按修订另行统计。模型类型与上述增长来源是代码事实，线上占用排名须实际查询；SQL字段使用数据库列名，区分模型属性 `checkpoint/metadata/value/usage` 与列名 `checkpointPayload/metadataPayload/writePayload/modelUsage`。
- 核验入口：`src/models/D2cFile.ts`、`D2cVersionFile.ts`、`D2cSavedWorkFile.ts`、`D2cPreview.ts`；`run/persistence.ts.write/record`、`version/service.ts`、`savedWork/service.ts`、`preview/service.ts` 的快照写入。

## Figma 与切图

主 Agent 通过服务注册的 `figma`、`prepare_slices` 等工具查询和处理设计稿。Token 由可信工具解密注入，模型不能要求用户输出密钥；外网请求执行显式主机白名单和可选代理。

`fetch-node` 保存节点缓存，完整根缓存用于后续只读查询和规则证据。节点缓存保存前去除排版空白并保留全部原始属性；模型视图按明确字段省略冗余信息，具体条件见[节点精简规则](../topics/d2c-workspace-foundation.md#节点缓存与模型字段精简)。`prepare_slices` 生成真实图片、清单和断点，复用需要设计、配置、资源摘要与实际文件一致；已有文件本身不等于完成切图。

切图或补切后的真实公开地址写入 `.d2c-cache/<fileKey>/asset-urls.json`，生成源码应读取该地址表。图片按主题复用目录，同名不同内容使用后缀；页面源码目录使用英文区块别名，原图层名与节点编号用于溯源。

上传前按图片策略执行无损优化，仅采用更小且内容要求不变的结果，取消仍中断。清单 miss、下载失败和上传失败分别保留，不伪造完整交付；切图业务确认通过对话处理。

## 工具反馈与脚本诊断

`toolFeedback.ts` 将问题区分为 adjust、retry、user。缺文件或明确的节点/参数问题交回模型；网络故障沿用有限重试与 Retry-After；凭据、权限或较长等待提示用户处理。次数耗尽、未知故障和严重执行保护不能被成功答复绕过。

`scriptFailure.ts` 解析旧固定 CLI 的失败信封，包括退出码 1 的输出。精确缺失节点模板返回 `FIGMA_NODE_NOT_FOUND`，缺失导出地址返回 `FIGMA_IMAGE_NOT_FOUND`。分类优先使用可信网络诊断，任意上游正文中的状态码不授予重试。

通过 errorId/runId 查询服务端诊断中的 `scriptReason`、`scriptPhase`、`nodeId`、`exitCode` 和已知状态/网络码。原始 stdout/stderr、完整地址和错误正文仅留内存 cause 链；历史没有保存的字段无法事后补回。取消、失租、超时、输出限额和文件保护保持优先。

## 版本、附件与作品

版本暂存冻结某次已保存文件修订，后台打包并上传；Agent 运行期间也可暂存已保存内容。名称可默认生成，后续工作文件变化不改写版本。下载 ZIP 使用固定版本文件集合。

对话附件保存真实图片及元数据，消息引用附件 ID。源码与资源支持只读查看，图片不是可编辑文本。作品库展示已经暂存完成的版本，公开链接仍受资源定位和完整性检查。

页面关闭只结束浏览器订阅，后台 Run 和打包继续运行。数据库记录、对象存储和服务端日志一起排查，不能把 Redis 断连或旧告警直接认定为当前工具失败原因。

图片目录映射的只读查看边界见[工作区主题](../topics/d2c-workspace-foundation.md#图片目录映射只读查看)。

## 大字段查询与诊断

排序分页先选择标识、再读取正文，沿用原筛选、事务和锁。字段范围与固定错误码边界见[工作区主题](../topics/d2c-workspace-foundation.md#大字段排序与数据库诊断)。
