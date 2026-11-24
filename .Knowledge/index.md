# Flow2Spec Knowledge Index

> **路径约定**：下文 **`.Knowledge/`**、**`manifest-routing.json`** 等路径均相对于**本仓库根目录**（即已运行 `flow2spec init` 的当前项目）。

本文件是 **人读导航**：主题说明、关联文档摘要、语义边界。  
**机读事实源** 以 `.Knowledge/manifest-routing.json` + `taskToTopicRules[].matcherPath` 指向的 `.Knowledge/matchers/*.json` 分片为准（不再使用 `.Knowledge/manifest-matchers.json`）。

---

## 推荐阅读顺序

1. `.Knowledge/manifest-routing.json`（任务路由、`topicPaths`、`topicDependencies`、`fallbackTopic`）
2. 按需：由 `matcherPath` 读取 `.Knowledge/matchers/<id>.json`（`includeAny` / `includeAll` 资格词、`excludeAny` / `excludeAll` 否决词）
3. 按需：本 `index.md`（主题语义与边界）
4. `.Knowledge/topics/<topic>.md`（执行约束与流程）
5. 按需：`.Knowledge/stock-docs/`、`.Knowledge/req-docs/`
6. 仍不足再下钻业务代码

---

## 主题一览

| 主题 | 路径 | 适用场景 | 关联文档（摘要） |
| --- | --- | --- | --- |
| implement-tech-design | `.Knowledge/topics/f2s-implement-tech-design.md` | 按技术方案实现代码 | 待补充：按实际任务提供技术方案 |
| f2s-doc-routing | `.Knowledge/topics/f2s-stock-docs-vs-req-docs.md` | stock-docs / req-docs 目录分工 | 无；目录分工见主题摘要 |
| fallback-triage | `.Knowledge/topics/f2s-fallback-triage.md` | 未命中或低置信度：分诊与澄清 | 无；分诊流程见主题摘要 |
| config-precheck | `.Knowledge/topics/f2s-config-precheck.md` | 执行 `f2s-*` 前读 `flow2spec.config.json` / 编排开关 | Codex 长文：仓库根 `.codex/topics/f2s-config-check.md`；[路由摘要](topics/f2s-config-precheck.md) |
| f2s-task | `.Knowledge/topics/f2s-task.md` | 变更追踪、`.task/` 任务清单与跨会话续作 | 长文：配置根 `rules/f2s-task.*`；Codex：`.codex/topics/f2s-task.md` |
| f2s-req-plan | `.Knowledge/topics/f2s-req-plan.md` | 需求/方案规划与实现；始终维护 `.task/` | 技能：`skills/f2s-req-plan/SKILL.md`；依赖 `f2s-task` |
| flow2spec-dsh-adapter | `.Knowledge/topics/flow2spec-dsh-adapter.md` | `flow2spec init dsh` 与 DeepSeek Harness 项目技能发现 | Flow2Spec 上游能力；本仓库入口见主题摘要 |

每主题保留 **1–3 条** 可点击摘要链接；全量路径对照写入 `.Knowledge/migration-report.md`（迁移场景）。  
其中 **`implement-tech-design`**、**`f2s-doc-routing`**、**`config-precheck`**、**`f2s-task`** 在 `topics/` 内为**路由摘要**；执行长文见配置根 **`rules/f2s-*.md(c)`**；使用 Codex 时见 **`.codex/AGENTS.md`**、**`.codex/topics/f2s-*.md`**（`f2s-config-check` 与 `AGENTS` 前置同源，按需打开）。**`f2s-knowledge-preflight`** 与 **`f2s-kb-feedback-closing`** 是普通问答首读 / 源码补答收口门禁，作为配置根规则 / Codex 专题长文生效，不写入 `topicPaths` 或 `taskToTopicRules`。

---

## 社区版业务主题

以下内容按当前社区版源码整理，已移除内部地址、账号、真实配置与历史运行记录。

| 主题 | 路径 | 适用场景 | 关联文档（摘要） |
| --- | --- | --- | --- |
| 项目架构 | [主题摘要](topics/project-architecture.md) | Fastify全栈入口、登录、日志、数据连接与部署 | [实现终稿](stock-docs/项目架构终稿.md) |
| 项目配置、单次模型超时 | [主题摘要](topics/project-config.md) | 本地配置字段、个人模型凭据、模型预算、存储、100MiB文本上限与生效时机 | [实现终稿](stock-docs/project-config.md) |
| D2C 工作区与文件 | [主题摘要](topics/d2c-workspace-foundation.md) | 工作区、会话、代码存储与数据库大字段、加密正文外置与兼容迁移、排序与安全诊断、文件修订、节点缓存紧凑存储、模型字段精简、切图、凭据、版本与图片目录映射只读查看、补切缓存路径兼容、Figma参数与子树、切图请求/响应诊断、进行中会话快捷入口 | [实现终稿](stock-docs/d2c-workspace-foundation.md) |
| Deep Agents 执行与恢复、子模型超时与有限重试、UI规则无进展交接与图片证据聚合 | [主题摘要](topics/deep-agents-execution.md) | 模型循环、检查点大字段、历史归档、摘要、子Agent稳定ID恢复、失败交接、预算和诊断、按完成收取、修复截图复验与交互增量与版本计划复用、耗时收益验收、UI准入与编译反馈、子任务职责与用量诊断、会话错误统计与排查明细、上下文读取去重与UI资料引导、报告单节点准入、真实交付核验与编辑版本回执、检查点及中间写入外置与旧BLOB兼容 | [实现终稿](stock-docs/deep-agents-execution.md) |
| 预览、截图与在线编辑 | [主题摘要](topics/d2c-preview-editing.md) | 本地Vite预览、会话版本默认首页入口、普通及全屏手机比例与横竖屏、缓存、截图、元素审查、在线编辑与临时构建诊断与按实际依赖链等待与缺依赖去重 | [实现终稿](stock-docs/d2c-preview-editing.md) |
| 团队与共享权限 | [主题摘要](topics/d2c-team-collaboration.md) | 团队成员、共享工作区、操作者、凭据隔离与工作区归属标注 | [实现终稿](stock-docs/d2c-team-collaboration.md) |

同步范围与脱敏约定见 [知识库说明](README.md)。

---

## 命中与执行（与统一入口一致）

- **路由**：`taskToTopicRules` 给出任务 → 主题集合；**关键词**在 matcher 分片(`includeAny` / `includeAll` 资格门 + `excludeAny` / `excludeAll` 否决门；否决优先于 `task` 精确命中)。
- **依赖**：命中主主题前，按 `topicDependencies` 先读依赖主题。
- **兜底**：`fallbackTopic` 指向分诊主题（如 `fallback-triage`），仅低置信度上下文，**不得**当作最终命中直接改代码。
- **执行链**：`match → expand → verify → act`；`expand` 须含依赖展开，并保留次高候选做校验。
- **全量补检索**：仅当无命中、候选分差过小、缺口检查失败，或用户明确要求「全量检查」时允许跨 matcher 补检索。

---

## 目录职责

| 目录 | 职责 |
| --- | --- |
| `topics/` | 专题规则与执行流程 |
| `matchers/` | matcher 分片（`matcherPath` 指向） |
| `stock-docs/` | 存量沉淀（架构、终稿等） |
| `req-docs/` | 需求与技术方案（驱动实现） |
| `template/` | 终稿与方案模版 |

路由清单由 `f2s-*` 技能链路维护，不依赖额外 CLI 子命令。

---

## 常见缺口怎么处理（与统一入口一致）

| 情况 | 你怎么做 |
| --- | --- |
| 有文档但没配到（1a） | 维护侧：`f2s-kb-build` / `f2s-kb-sync` / `f2s-kb-add` 补路由与 matcher 词表(`includeAny` / `includeAll` / `excludeAny` / `excludeAll`)。执行侧：分诊主题澄清任务类型，**不**用全仓扫替代 manifest。 |
| 配到了但不够（1b） | 走依赖与次高候选 → `verify` 点名缺哪篇文档；仍缺则向用户要路径或补 `req-docs`。 |
| 库里没有（2） | 承认缺口 → 代码下钻或请用户补需求/方案文档。 |
| 反复读 manifest 费 token（2a） | 同一任务线内 routing 只当快照；只读命中项的单个 matcher；不遍历整个 `matchers/` 目录枚举；`index.md` 勿与 routing 循环互刷。 |

**说明**：「路由/知识已更新」指 `f2s-*`（如 `f2s-kb-build`、`f2s-kb-sync`、`f2s-kb-add`、`f2s-kb-fix` 等）产出或手改 `manifest-routing` / `matchers` 分片；**`flow2spec init` 不撰写业务文档**，以模板补齐与配置根落盘为主，勿与知识库内容更新混为一谈。

| 会话广场与个人作品 | `.Knowledge/topics/d2c-session-plaza.md` | 个人分支续聊与本人凭据、登录用户公开浏览、隔离编辑、广场下的个人作品与内嵌编辑、左右卡片与运行截图封面、创建时间与保存记录删除与来源会话跳转；旧个人会话发布兼容、代码预览并排编辑、对话抽屉与用量、运行截图封面、路径导航与作品来源、用量查询与子任务按需读取 | [能力说明](stock-docs/D2C会话广场与个人作品_终稿.md)、[三表迁移](req-docs/d2c-session-plaza_迁移.sql) |
