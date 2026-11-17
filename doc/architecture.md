# 架构与存储

```mermaid
flowchart TD
  Browser[React 工作台] --> App[Fastify 应用]
  Config[project.config.json] --> App
  App --> MySQL[(MySQL 业务数据和检查点)]
  App --> Redis[(Redis 缓存和通知)]
  App --> Worker[后台 Worker]
  Worker --> Agent[Deep Agents / LangGraph]
  Agent --> Model[兼容 OpenAI 的模型服务]
  Agent --> Tools[Figma / 读写文件 / 切图 / 校验 / 子任务]
  Tools --> Files[本地磁盘或 S3]
  App --> Preview[本地 Node/Vite 编译]
  Preview --> Browser
  Preview --> Capture[Playwright Chromium 截图]
```

## 一次生成

1. 用户登录，创建个人或团队工作区，复制固定版本 Skill 与配置。
2. 创建会话、保存 Figma Token、提交消息；消息与执行记录先进入 MySQL。
3. Worker 领取执行租约并续租，读取检查点和会话资源后调用 Agent。
4. Agent 调用注册工具；图片、文件和执行记录持续保存，通过 SSE 向页面传递更新。
5. 暂停或异常后保留已保存内容；继续时从可用检查点恢复，外部操作仍需校验已有文件以避免重复写入。
6. 暂存版本异步冻结文件、打包上传，完成后在作品库查看或下载。
7. 在线编辑基于临时副本，保存后增量编译并刷新预览，用户可以将修改应用回会话工作文件。

## 文件关系

| 目录 | 内容 |
| --- | --- |
| src/index.ts | 启动入口、监听端口与关闭信号 |
| src/app.ts | 初始化通用工具、HTTP Hook、登录、接口、静态资源和预览 |
| src/config | 项目配置和业务运行参数契约 |
| src/hooks/tools | MySQL、Redis、日志、存储和凭据加密适配 |
| src/hooks/http | 本地登录身份、守卫和访问日志 |
| src/functions/d2c | 工作区、会话、后台执行、预览、编辑与版本业务 |
| src/models | Sequelize 模型及 LangGraph 检查点模型 |
| src/functions/d2c/run | Agent 运行时、模型连接、工具和执行调度 |
| web | React 工作台与 Monaco 编辑器 |
| pixelprint | 从公开上游同步的固定 Skill、脚本和模板 |
| preview-template | H5 / RN Web 预览模板和本地编译器 |
| preview-browser | Chromium 截图工具 |
| image-compression | Python 图片处理依赖与脚本 |
| scripts | 初始化、依赖准备、数据库建表与更新命令 |

## 数据位置

- MySQL：工作区、团队、会话、消息、文件修订、执行、时间线、版本和检查点等持久数据。
- Redis：缓存、通知和并发协调；不是唯一聊天历史来源。
- `.data/files` 或 S3：图片、归档和资源对象；数据库保存内容或对象引用及修订关系。
- `.runtime`：单轮临时执行目录、预览缓存和编辑副本，不能取代持久数据。
- `project.config.json`：模型密钥、数据库配置、登录账号和加密密钥，仅服务器可读。

本发行版没有远程 Sandbox 服务，也没有预览内部的 Docker 执行器。提供的 Dockerfile / Compose 用于部署整个应用，和预览引擎是两回事。浏览器 iframe 的 sandbox 属性仍保留。

## 执行边界与恢复

LangGraph 的节点调度预算与模型请求次数分别控制。每段图允许 2048 步；遇到原生图步数异常时，先核对检查点、授权文件与最新规则检查。交付完整且不存在未配对工具或等待用户回答时直接收取结果。

存在检查点且有持久文件或报告进展时，向同一图传入 null 继续，单次执行最多自动续作两段，不重新追加用户消息。无进展或达到恢复次数时，子任务返回未完成项和原任务标识，由主 Agent 接管或恢复原子任务。模型请求预算、取消、租约及存储故障处理不因此放宽。

## 生成期间的预览

源码可能先于样式保存。任务仍在排队或执行，且本次构建明确缺少尚未保存的同目录源码或样式时，界面显示“等待文件保存”，保留上一份成功预览；保存新修订后沿用文件变更通知更新预览。

这只是前端状态投影，数据库仍保留真实构建诊断。任务结束或暂停后恢复缺文件错误；缺少第三方包、语法错误、越界路径和版本预览不会进入等待状态。
