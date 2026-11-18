---
id: d2c-workspace-foundation
revision: 2
summary: "工作区、会话、文件修订、切图、凭据和版本"
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

## 适用场景

工作区、会话、文件修订、版本暂存、切图、Figma Token、工具纠错、工具失败、SCRIPT_FAILED、图片压缩、截图附件、作品库。

## 详细资料

[D2C 工作区与文件](../stock-docs/d2c-workspace-foundation.md)

## 节点缓存与模型字段精简

- fetch-node与inspect-node使用同一模型视图，只沿children处理节点属性：删除locked/exportSettings/overrides，省略指定空元数据；effects/strokes/characterStyleOverrides仅去掉空数组，styleOverrideTable仅去掉空对象。
- background只有与fills数组按顺序和完整属性完全一致时才省略；fills、全部节点、父子顺序、文字、零值、false、非空渲染/交互/变量绑定及未知字段保留。
- 节点缓存仅去除JSON排版空白，全部原始字段和值保留；临时副本和稳定存储使用相同字节与摘要，规则检查、切图及原文回查继续读取完整数据。缓存先紧凑再执行文本写入限额，其余文件保持原样。
- Token收益针对精简前后的紧凑节点结果估算，文件体积变化与整轮用量分别计量；回归验证输入隔离、节点/属性保留、重复背景边界及工具真实输出。
