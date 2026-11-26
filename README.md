# PixelPrint Community

前后端一体的设计转代码工作台：Fastify 提供 API、React 页面和静态文件，Deep Agents / LangGraph 执行生成任务。

保留工作区、会话、团队协作、Figma 切图、子 Agent、暂停与继续、实时进度、文件编辑、H5 / React Native Web 预览、截图对比和版本 ZIP 下载。运行配置直接读取 `project.config.json`，无需远程配置中心、企业 SDK 或外部 Sandbox 服务。

## 使用与部署文档

- [文档目录](docs/README.md)：按使用者与部署者需要阅读。
- [使用指南](docs/使用指南.md)：创建会话、持续修改、交互验收和保存作品。
- [功能说明](docs/使用指南.md)与[架构与流程图](docs/架构与流程图.md)。
- [D2C 生成与验收流程](docs/D2C生成与验收流程.md)：扫描、素材、规则、出码与验收证据。
- [部署与配置](docs/deployment/部署与配置.md)及[完整配置字段](docs/deployment/configuration.md)。

## 快速部署

准备 Node.js 24 和 Docker Compose。在本目录执行：

```bash
node scripts/setup.mjs --docker
```

终端会显示首次登录账号和随机密码。编辑生成的 `project.config.json`：

- `runtime.modelConfigs[0]`：保留平台预算和可选默认模型连接；用户可登录后在“模型凭据”独立填写支持工具调用的服务地址、模型名和 API Key，新会话使用个人设置。
- `server.publicUrl`：用户实际访问的地址。默认 `http://localhost:8080`。
- `storage.publicUrl`：同一地址加 `/files`，例如 `https://your-domain.example/files`。
- `database.password`：与 Compose 的 `PIXELPRINT_DB_PASSWORD` 一致；上线时替换示例密码。

```bash
# 如修改数据库密码，在启动前设置相同值。
export PIXELPRINT_DB_PASSWORD='你的数据库密码'
docker compose up --build -d
```

访问 `http://localhost:8080`，登录后在页面保存 Figma Token、创建工作区和会话。容器首次启动会创建缺失的数据表，不会删除现有数据。请为此发行版使用独立数据库。

新建配置默认将 `runtime.d2c.contentStorage` 和 `runtime.d2c.checkpointStorage` 设置为 `external`、`schemaReady: true`，初始化脚本会分别生成正文加密密钥。首次启动或 `npm run db:init` 创建的新表包含引用列；小于阈值或超过单对象限额的正文仍留库。已有 `project.config.json` 不会被覆盖；已有数据库升级时需先执行两个阶段的增量 SQL，再调整对应配置并重启。

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

完整字段见 [配置说明](docs/deployment/configuration.md)，系统关系见 [架构说明](docs/架构与流程图.md)。

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

## 项目知识库

[知识库索引](.Knowledge/index.md) 提供架构、配置、工作区、Agent 执行、预览编辑与团队协作的阅读入口。内容按社区版实现整理，已移除内部接入方式和运行数据，并接入本仓库的 Flow2Spec 路由。脱敏范围见 [知识库说明](.Knowledge/README.md)。

## 分发说明

此目录是独立副本，不含原项目 Git 历史、内部知识库原文、真实配置、用户产物或聊天数据。未替项目作者选择开源许可证；正式公开发布前，应确认自有代码和上游资源的授权，并补充 LICENSE。

数据库结构与历史升级统一见 [docs/sql](docs/sql/README.md)，完整工具及执行链路见[文档目录](docs/README.md)。

### 后台WebP封面

`project.config.json` 的 `runtime.d2c.imageVariants.enabled` 控制普通图片上传后的后台WebP生成，省略默认true。原图成功后后台生成宽度最多320px、质量80的WebP并上传，名称为原文件名加 `_.webp`；运行截图封面不受此开关影响。需要已准备的图片压缩Python环境和Redis。缩图失败不阻塞原图或正常流程；广场和已保存作品优先使用就绪WebP，未就绪或坏图回退原图。
