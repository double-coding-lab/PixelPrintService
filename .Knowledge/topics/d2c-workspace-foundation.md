---
id: d2c-workspace-foundation
revision: 16
summary: "工作区、会话、代码存储、数据库大字段、切图、凭据和版本"
primary: module
confidence: inferred
---
# D2C 工作区与文件

说明工作区资源、独立会话、稳定产物与版本的业务事实源。

## 核心流程

1. 创建工作区时从 `pixelprint` 复制完整 Skill、脚本与目标配置，保存资源修订与摘要；工作区可选择升级资源。
2. 会话有独立 Agent 上下文，冻结工作区配置和资源；Figma 凭据关联实际发起用户。设计稿链接、默认命名和消息创建由服务检查。
3. 消息与 queued Run 在数据库事务中保存，Worker 在请求结束后继续执行；关闭浏览器不会取消任务。
4. 稳定文本、图片定位、摘要和修订持久保存；文件变更经事务写时间线，提交后通知 SSE 按游标补读。
5. 文件预览、在线编辑、版本暂存和公开作品分别使用明确修订，不把未保存的执行目录当作最终产物。

## 工具、切图与失败

- `prepare_slices` 使用平台切图能力，清单、真实图片、断点及内容摘要用于复用；图片失败保持真实 miss，不以文字确认替代。
- 图片压缩按固定策略无损优化并核对收益，失败保留原字节；上传与本地稳定内容使用同一份字节。
- 图片真实地址以 `asset-urls.json` 为准；不能根据 Figma 名称或本机路径猜公开 URL。
- 缺文件、节点或参数问题返回可纠正反馈；已知网络问题有限重试，存储、取消、失租和未知异常保留终态。
- 规则检查状态与 Run 成功状态分开记录；源码变化会使旧检查失效。

## 实现入口与边界

`src/functions/d2c/workspace/`、`session/`、`run/tools.ts`、`run/persistence.ts`、`files.ts`、`version/` 和 `credential/`。

工作区、会话软删除仍受归属和活跃轮次检查。具体执行恢复见 `deep-agents-execution`，预览编辑见 `d2c-preview-editing`，权限见 `d2c-team-collaboration`。

## 代码存储与数据库大字段

- 当前源码在 `d2c_file.content`；版本暂存、个人作品保存分别复制到 `d2c_version_file.content`、`d2c_saved_work_file.content`。三者均为LONGTEXT，按文件或快照修订分别统计。
- 会话预览的 `d2c_preview.buildManifest.snapshot[].content` 还保存参与构建的源码；时间线与Agent检查点保存消息和工具状态，可能包含代码片段或完整历史。
- 单条大内容与多版本/事件/检查点累积分别计量；数据库列名、字段清单和统计范围见[存储字段说明](../stock-docs/d2c-workspace-foundation.md#数据库大字段与增长来源)。图片等二进制使用本地对象存储或S3，数据库保存定位；Redis编辑副本和本地构建缓存独立统计。

## 适用场景

工作区、会话、文件修订、版本暂存、切图、Figma Token、工具纠错、工具失败、SCRIPT_FAILED、图片压缩、截图附件、作品库。

## 详细资料

[D2C 工作区与文件](../stock-docs/d2c-workspace-foundation.md)

## 节点缓存与模型字段精简

- fetch-node与inspect-node使用同一模型视图，只沿children处理节点属性：删除locked/exportSettings/overrides，省略指定空元数据；effects/strokes/characterStyleOverrides仅去掉空数组，styleOverrideTable仅去掉空对象。
- background只有与fills数组按顺序和完整属性完全一致时才省略；fills、全部节点、父子顺序、文字、零值、false、非空渲染/交互/变量绑定及未知字段保留。
- 节点缓存仅去除JSON排版空白，全部原始字段和值保留；临时副本和稳定存储使用相同字节与摘要，规则检查、切图及原文回查继续读取完整数据。缓存先紧凑再执行文本写入限额，其余文件保持原样。
- Token收益针对精简前后的紧凑节点结果估算，文件体积变化与整轮用量分别计量；回归验证输入隔离、节点/属性保留、重复背景边界及工具真实输出。

## 图片目录映射只读查看

`.d2c-cache/image-directories.json` 保存主题与上传目录的稳定映射，源码文件接口仅对这个准确的根级缓存路径额外开放只读查看。读取仍校验工作区权限、会话归属、路径及内容摘要；禁止编辑和删除，其他根级内部缓存继续受保护。验证见 `test/imageDirectoryRead.test.ts`。

## 大字段排序与数据库诊断

- 涉及TEXT、JSON或BLOB的预览、文件与版本、会话、工作区、时间线及检查点查询，使用 `utils/orderedRead.ts` 先选择稳定标识排序分页，再按原筛选读取正文并恢复顺序。原权限筛选、事务、更新锁和属性投影保留，空页不读取正文。
- 文件使用原会话或版本范围内的pathHash，时间线使用会话内seq，检查点使用namespaceHash/checkpointId。全局领取锚点只读取workspaceId；普通轻量投影不增加正文读取。存储位置、表结构及数据库参数沿用部署配置。
- ER_OUT_OF_SORTMEMORY可由带大字段的查询排序触发，不能仅据STORAGE_FAILED判断为写库失败。后台和HTTP日志保留白名单数据库码、数值错误号及合法SQLState；SQL、绑定值、凭据和异常正文保持私有。

跨会话队列候选扫描使用全局唯一的entryId作为分页与正文回填标识；只有已按sessionId限定范围的时间线读取才可使用seq，避免不同会话同序号记录相互覆盖。

## 会话导航高度与滚动

- web/src/workspace/navigation.css 将桌面会话栏限制为视口减顶部两层栏的可用高度；标题、创建、搜索和分页保留在栏内，长会话列表隐藏滚动条且不预留轨道宽度，保留滚轮、触控板及键盘纵向滚动。导航内容保持挂载，列表滚动不带动外层页面。
- 950px及以下会话栏改为正常文档流，高度取420px与半屏高度的较小值；折叠后仅保留操作栏。极短窗口中导航内容可滚动，保留控件访问能力。浏览器以真实样式、二十条隔离示例数据核验桌面1280×720和窄屏390×600，不代表线上业务联调。

## 补切缓存与目标路径

- 旧冻结CLI可能按节点和格式命中缓存并返回旧文件名；平台在exportImage.ts将返回路径归一为当前工作区产物路径。换名复用只接受当前fileKey/nodeId已登记且SHA-256一致的图片，为本次目标创建副本并保留原图；目标已有不同内容时保留原文件并返回纠错。
- 路径穿越、内部资源、符号链接、越界绝对路径、其他节点及摘要不符均拒绝。产物缺失或不可用返回FIGMA_EXPORT_FILE_MISSING（adjust），由现有有限纠错流程处理；JSON或成功信封非法仍按SCRIPT_OUTPUT_INVALID分类。停止、失租和真实存储故障继续中断。
- 目标图仍经过既有图片同步、压缩/校验、上传、地址表及节点来源登记，全部成功后才返回稳定目标path与url。兼容层不额外请求Figma、不改冻结脚本或已有工作区资源，无新增配置；历史失败记录保持原值。
- 回归入口test/exportImage.test.ts使用真实H5/RN旧CLI与离线缓存，覆盖换名、幂等、同节点摘要、目标冲突、路径边界、缺文件和执行保护，不代替真实设计稿视觉验收。

## 切图请求与响应诊断

- prepare_slices按社区版proxyUrl配置选择代理或直连；每次调用独享请求与重试状态，diagnostics.slice.proxyUsed记录实际是否使用代理。
- 后台日志只投影SliceDiagnosticError中的固定phase/reason与可得的nodeId、statusCode、bytes、attempt及proxyUsed：阶段区分fetch_node/export_image/download_image/manifest，原因区分HTTP错误、网络/TLS失败、响应超限、节点或导出地址缺失、JSON/图片及清单校验失败。解析层缺少状态码时保持缺失，读取缓存不伪造网络信息。
- RESOURCE_UNAVAILABLE/FIGMA_REQUEST_FAILED及权限、限流、取消、租约和有限重试规则保持原分类；完整请求URL、代理地址、Token和响应正文不进入新增日志或公开失败。历史日志无法补回未记录的原因，新字段在更新服务后的实际执行中产生。
- 实现及回归入口：run/sliceDiagnostics.ts、sliceNetwork.ts、slices.ts、tools.ts、errors.ts；test/sliceDiagnostics.test.ts、sliceNetwork.test.ts和nativeSlices.test.ts覆盖错误区分、节点/字节/状态、重试、代理/直连及脱敏。

## Figma 参数兼容与子树读取

- `subtree` 是平台 `inspect-node` 的子树读取选项：`true` 从选中节点及其后代按 `offset/limit` 分页；浅层读取使用 `depth`，分页默认40、最多100条。
- `run/figmaArguments.ts` 在主工具与执行子工具入口清理空值；非 `inspect-node` 命令仅兼容无操作含义的 `offset=0`、`subtree=false`。非零偏移、非空分页条数或开启子树仍拒绝，避免静默丢弃有效请求。浅层读取携带分页时保持原范围，反馈要求显式开启子树或删除分页参数。
- 参数组合冲突返回固定 `FIGMA_ARGUMENT_CONFLICT`（adjust）及具体字段提示，纠错耗尽按 `TOOL_ARGUMENT_INVALID` 结算。提示只使用程序固定文字；权限、缓存归属、路径、取消、租约与真实存储故障沿用既有门禁。
- `agent/feedback.ts` 按工具、可信调用命令、错误码、路径及资源类型累计纠错，普通纠错每组允许10次，第11次要求用户处理；成功不重置；`RULES_FAILED` 沿用规则修复流程。网络重试仍按工具共享两次额外机会，主子模型继续共享整轮请求上限。
- 部署服务即可生效，无新增配置、数据库迁移或冻结资源升级。历史失败保持原记录。`test/figmaArguments*.test.ts`、`test/exportImage.test.ts` 和 `test/deepFeedback.test.ts` 离线覆盖实际导图默认值、浅层分页冲突、范围保持及预算隔离。

## 大正文文件存储

- `content/runtime.ts`已装配当前文件/Figma缓存、Agent恢复、版本/作品冻结、ZIP/广场源码、预览冷重建和临时编辑。三张文件表的可空`contentRef`及预览snapshot记录不可变引用；二进制`objectLocator`沿用原语义。
- `d2c.contentStorage`新建配置默认`schemaReady=true/mode=external`，省略配置的旧部署保持`schemaReady=false/mode=inline`，默认模型投影和旧INSERT不依赖新列；审阅增量建列并重启后设置`schemaReady=true`。此开关进程内固定；回退写模式时仍保持它为true，以读取历史引用。
- `shadow`保留正文与引用兼容旧写入；有inline时优先读取，复制冻结前剔除与当前大小/摘要不符的陈旧引用。确认旧writer退出后才可`external`；低于阈值或超出当前传输能力的正文保留inline。候选阈值262144字节，目标性能待测量。
- `content/store.ts`以AES-256-GCM、可信scope、独立版本密钥、随机不可变对象、上传回读及大小/摘要核验保护正文；底层复用平台文件客户端，有界并发/排队和流式下载限额，不缓存正文。引用/密钥/定位只在服务端，浏览器与编辑DTO仍返回授权字符串。
- 上传和正文还原在业务事务外执行，提交前重验权限、修订及租约/CAS；版本、作品、预览复用同一不可变对象。数据库失败保留旧状态及未引用对象；当前阶段不做GC。
- `content:audit`仅生成容量SELECT；`content:migrate`提供固定表组、默认dry-run、BIGINT分页、逐行正文、原子私有游标、分批resume及restore回填。外置apply要求显式确认；冲突/活动预览/故障保留失败行之前游标。目标库DDL、迁移和性能验证由部署方执行。
- 回滚旧程序前先停止外置写入、恢复全部所需inline并核验，保留元数据/对象/历史正文密钥；仅关mode不能让旧程序读取引用。执行时间线保持现有存储；检查点与pending writes的独立外置开关及恢复边界见执行专题。
- 可执行配置、迁移顺序及阶段划分见[工作区基础终稿](../stock-docs/d2c-workspace-foundation.md#大正文文件存储)。

## 规则检查状态展示

- 前端版本及作品的规则检查文案将stale、not_checked和缺失状态统一展示为“待检查”；passed仍显示“通过”，failed显示“未通过”，未知状态保留明确提示。
- 后台继续保留stale与修订绑定；源码修改使旧结论失效，暂存版本保存当时检查状态，展示文案不改变校验或恢复逻辑。
