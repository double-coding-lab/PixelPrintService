---
id: project-architecture
revision: 8
summary: "Fastify全栈入口、登录、日志、数据连接与部署"
primary: module
confidence: inferred
sourceDoc: ".Knowledge/stock-docs/项目架构终稿.md"
---
# 项目架构

Node.js 24 在一个 Fastify 应用中提供 React 页面、API 和预览资源。

## 核心规则

- `src/index.ts` 启动监听和关闭流程；`src/app.ts` 装配工具、身份、路由、静态文件与预览网关。
- `src/hooks/tools/index.ts` 挂载 `logging`、`redis`、`mysql`、`runtimeConfig`；连接失败和关闭时释放资源。
- 身份由本地账号、GitHub OAuth 或签名临时访客提供，业务统一使用 `request.getUser()`；账号命名空间、PKCE/Redis回调和访客留存见[请求身份](../stock-docs/项目架构终稿.md#请求身份与接口响应)。GitHub与访客的AI任务必须绑定本人的模型凭据。
- `/api/d2c` 统一注册工作区、团队、会话、凭据、文件、预览、版本和插件接口；页面来自 `dist/public`。上传解析器由 `uploadRoutes` 在上传模块作用域注册一次，限制单文件大小和表单部分数量。
- `connectMysql()` 仅认证与注册模型；`npm run db:init` 显式创建缺失表，不负责修改已有表结构。
- `project.config.json` 是运行配置入口，配置修改需要重启。详细字段见 `project-config`。
- 默认Compose部署应用、MySQL、Redis；compose.external.yaml只部署应用，运行配置接入外部服务。compose.build-proxy.yaml只传构建代理，不继承到运行环境。
- 应用镜像用于部署整个服务；预览使用本机固定 Node/Vite 子进程和 Chromium。前端镜像构建的Node堆上限为4GiB，只作用于构建阶段；单机部署需预留构建内存。应用编译、图片工具和预览浏览器分别构建缓存层，失败重试复用已完成步骤。
- 函数使用 JSDoc；近距离引用可用相对路径，跨模块可用 `@/`，省略后缀由 tsx/esbuild 解析。

## 边界

本地执行与主进程共享账号和机器资源；浏览器预览仍执行 iframe sandbox、CSP 与资源校验。日志和响应使用明确字段投影，凭据与任意原始异常不能直接上报。

## 适用场景

项目架构、Fastify、前后端一体、登录、Pino、MySQL、Redis、部署、启动、建表。

## 详细资料

[项目架构终稿](../stock-docs/项目架构终稿.md)

## 数据库错误日志

`common/databaseDiagnostics.ts`沿cause/parent/original有界提取固定数据库错误码、数值错误号与合法SQLState，HTTP访问日志和后台执行共用该安全投影。错误正文、SQL、绑定值、密钥及堆栈保持私有；预览工具的数据库失败保留工具归属。大字段查询的读取策略见[工作区主题](d2c-workspace-foundation.md#大字段排序与数据库诊断)。

## 自动部署

- 分支和PR由GitHub Actions检查；main且配置部署变量后自动发布。独立部署密钥仅允许固定命令，指纹核验、服务端锁和最新main比对保护发布顺序。
- 精确归档源码与校验的CI产物统一组装，运行依赖指纹绑定实际镜像；切换前保存独立回滚标签，模板检查失败不激活，健康失败恢复上一镜像。配方、依赖和额外构建文件参与失效，私有配置与数据卷保留。详见[部署指南](../../docs/deployment/自动部署.md)。
- src/paths.ts按模块定位固定模板、静态页面和预览资源，支持src/dist及异地cwd；用户数据和私有配置仍按各自配置解释。
