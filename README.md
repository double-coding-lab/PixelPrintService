# PixelPrint Community

前后端一体的设计转代码工作台：Fastify 提供 API、React 页面和静态文件，Deep Agents / LangGraph 执行生成任务。

保留工作区、会话、团队协作、Figma 切图、子 Agent、暂停与继续、实时进度、文件编辑、H5 / React Native Web 预览、截图对比和版本 ZIP 下载。运行配置直接读取 `project.config.json`，无需远程配置中心、企业 SDK 或外部 Sandbox 服务。

## 快速部署

准备 Node.js 24 和 Docker Compose。在本目录执行：

```bash
node scripts/setup.mjs --docker
```

终端会显示首次登录账号和随机密码。编辑生成的 `project.config.json`：

- `runtime.modelConfigs[0]`：填写支持工具调用的 OpenAI Chat Completions 兼容服务地址、模型名和 API Key。
- `server.publicUrl`：用户实际访问的地址。默认 `http://localhost:8080`。
- `storage.publicUrl`：同一地址加 `/files`，例如 `https://your-domain.example/files`。
- `database.password`：与 Compose 的 `PIXELPRINT_DB_PASSWORD` 一致；上线时替换示例密码。

```bash
# 如修改数据库密码，在启动前设置相同值。
export PIXELPRINT_DB_PASSWORD='你的数据库密码'
docker compose up --build -d
```

访问 `http://localhost:8080`，登录后在页面保存 Figma Token、创建工作区和会话。容器首次启动会创建缺失的数据表，不会删除现有数据。请为此发行版使用独立数据库。

首次构建需要下载 npm 包、Python 包、Chromium 和系统依赖。构建网络需能访问公共软件源；可按部署网络配置标准 HTTP_PROXY / HTTPS_PROXY。后续预览和截图不在请求中下载依赖。

容器内的 `localhost` 指向容器自身；模型运行在宿主机时，填写可从容器访问的地址。macOS / Windows Docker Desktop 通常可用 `host.docker.internal`。

## 本地开发

```bash
npm ci
npm run setup
# 编辑 project.config.json 中的模型配置
# 启动本地数据库和缓存，或改为已有的 MySQL / Redis 地址
docker compose up -d mysql redis
npm run db:init
npm run prepare:images
npm run prepare:preview
npm run dev
```

开发默认访问 `http://localhost:8080`。前端变更自动重建，后端由 tsx 监听重启。Linux 预览安装脚本面向 Debian / Ubuntu，安装浏览器系统依赖需要 root 或 sudo；也可直接使用提供的部署镜像。

```bash
npm run typecheck
npm test
npm run build
npm start
```

## 配置和数据

完整字段见 [配置说明](doc/configuration.md)，系统关系见 [架构说明](doc/architecture.md)。

| 能力 | 本发行版实现 |
| --- | --- |
| 数据库 | 标准 MySQL 8 + Sequelize / mysql2 |
| 缓存与通知 | 标准 Redis，持久任务和时间线仍以 MySQL 为准 |
| 日志 | Pino，输出到 stdout / stderr，由部署环境采集 |
| 登录 | 本地账号、scrypt 密码哈希、签名 Cookie |
| 图片和文件 | 默认本地磁盘；可改为 S3 兼容对象存储 |
| 运行配置 | 项目内 JSON，重启生效 |
| Agent | Deep Agents / LangGraph，MySQL 检查点 |
| 预览和截图 | 本地 Node/Vite 编译、Playwright Chromium |

Compose 持久卷保存 MySQL、Redis、文件和临时执行数据。`project.config.json` 单独保管并备份，不会进入镜像或 Git；容器启动时复制为仅应用用户可读的文件，然后以非 root 用户运行应用。凭据加密密钥必须与数据库一起备份，不能随意重置。

本地文件默认经 `/files` 公开读取；S3 使用配置的公开文件 URL。不要把私密文档当公开图片上传。预览采用本地进程，保留 iframe sandbox、CSP 和资源校验；此部署方式适合受信团队，不能把它视为可运行任意不可信代码的强隔离平台。

## 更新 PixelPrint 资源

```bash
npm run pixelprint:update
```

从公开 GitHub 源更新 Skill 和脚本，记录上游版本与修订，更新时应用公开资源处理策略。工作区固定使用创建时复制的资源，已有工作区需手动升级。发行版模板经过通用化处理，不等同于未经修改的上游原件。

## 分发说明

此目录是独立副本，不含原项目 Git 历史、内部知识库、真实配置、用户产物或聊天数据。未替项目作者选择开源许可证；正式公开发布前，应确认自有代码和上游资源的授权，并补充 LICENSE。
