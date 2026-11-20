---
id: d2c-workspace-foundation
revision: 8
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

- web/src/workspace/navigation.css 将桌面会话栏限制为视口减顶部两层栏的可用高度；标题、创建、搜索和分页保留在栏内，长会话列表通过纵向滚动访问。导航内容保持挂载，列表滚动不带动外层页面。
- 950px及以下会话栏改为正常文档流，高度取420px与半屏高度的较小值；折叠后仅保留操作栏。极短窗口中导航内容可滚动，保留控件访问能力。浏览器以真实样式、二十条隔离示例数据核验桌面1280×720和窄屏390×600，不代表线上业务联调。
