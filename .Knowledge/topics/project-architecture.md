---
id: project-architecture
revision: 2
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
- 身份来自 `auth.users` 配置的本地账号、签名 Cookie 或个人 API Token；业务使用 `request.getUser()`，不接受客户端自报归属。
- `/api/d2c` 统一注册工作区、团队、会话、凭据、文件、预览、版本和插件接口；页面来自 `dist/public`。
- `connectMysql()` 仅认证与注册模型；`npm run db:init` 显式创建缺失表，不负责修改已有表结构。
- `project.config.json` 是运行配置入口，配置修改需要重启。详细字段见 `project-config`。
- 应用镜像用于部署整个服务；预览使用本机固定 Node/Vite 子进程和 Chromium。
- 函数使用 JSDoc；近距离引用可用相对路径，跨模块可用 `@/`，省略后缀由 tsx/esbuild 解析。

## 边界

本地执行与主进程共享账号和机器资源；浏览器预览仍执行 iframe sandbox、CSP 与资源校验。日志和响应使用明确字段投影，凭据与任意原始异常不能直接上报。

## 适用场景

项目架构、Fastify、前后端一体、登录、Pino、MySQL、Redis、部署、启动、建表。

## 详细资料

[项目架构终稿](../stock-docs/项目架构终稿.md)

## 数据库错误日志

`common/databaseDiagnostics.ts`沿cause/parent/original有界提取固定数据库错误码、数值错误号与合法SQLState，HTTP访问日志和后台执行共用该安全投影。错误正文、SQL、绑定值、密钥及堆栈保持私有；预览工具的数据库失败保留工具归属。大字段查询的读取策略见[工作区主题](d2c-workspace-foundation.md#大字段排序与数据库诊断)。
