# PixelPrint

把 Figma 设计稿生成可预览、可编辑的页面代码。支持 H5、React Native Web、持续对话修改、截图对比、交互验收、团队协作和作品分享。

**[官网与版本入口](https://pp.lantao.work/) · [在线工作台](https://pp.lantao.work/workbench)**

支持 GitHub 登录和临时访客。登录后，在“模型凭据”填写自己的 **模型地址、模型名称和 API Key**，并配置个人 Figma Token，再创建工作区开始生成。访客身份有有效期，需要长期保留的工作建议使用 GitHub 登录。个人密钥仅在服务端加密保存。

## 可以做什么

- 从设计稿读取节点、导出切图，生成页面及组件代码。
- 持续对话调整样式和交互，查看任务进度、子任务诊断和模型用量。
- 在浏览器运行预览、在线编辑源码、截图对比并下载版本 ZIP。
- 保存会话版本和作品，在广场分享，也可创建自己的分支继续修改。
- 查看源码和资源，图片支持后台 WebP 缩略图与历史图片补生成。

操作步骤见[使用指南](docs/使用指南.md)，生成与验收机制见[D2C 流程](docs/D2C生成与验收流程.md)。

## 自己部署

一台服务器即可运行完整应用。默认 Compose 同时启动 **应用、MySQL、Redis**，文件保存在本地持久卷；也支持接入自己的数据库、缓存和 S3 兼容对象存储。

准备 Git、Node.js 24、Docker Engine 和 Docker Compose 插件，然后执行：

```bash
git clone https://github.com/double-coding-lab/PixelPrintService.git
cd PixelPrintService
node scripts/setup.mjs --docker
```

保存终端输出的首次登录账号和随机密码。编辑生成的私有文件 `project.config.json`：

1. `server.publicUrl` 填自己的访问地址；`storage.publicUrl` 填同一地址加 `/files`。
2. `database.password` 替换为自己的数据库密码；在仓库根目录创建 `.env`，写入相同的 `PIXELPRINT_DB_PASSWORD=你的密码`。
3. 每位用户登录后单独设置模型连接和 Figma Token；管理员可按需配置平台默认模型。

```bash
chmod 600 project.config.json .env
docker compose config --quiet
docker compose up --build -d
docker compose logs --tail=100 app
```

访问自己配置的地址，默认端口为 `8080`。首次构建会下载系统依赖、npm/Python 包和 Chromium，耗时取决于网络；后续构建复用缓存。新库启动时创建缺失表，已有库升级请按[SQL 说明](docs/sql/README.md)执行迁移。

**公网使用请配置域名和 HTTPS**，再提交个人 API Key。完整步骤、GitHub OAuth 配置、备份和故障排查见[部署指南](docs/deployment/部署与配置.md)。

## 部署方式与依赖

| 项目       | 单机默认                             | 可外接方式                                                    |
| ---------- | ------------------------------------ | ------------------------------------------------------------- |
| MySQL      | Compose 内 MySQL 8.4                 | 配置已有 MySQL 的地址、数据库及账号                           |
| Redis      | Compose 内 Redis 7                   | 配置 `redis://` 或 `rediss://` 连接串                         |
| 图片与文件 | 本地 `.data` 持久卷                  | S3 兼容对象存储，如 AWS S3、MinIO；OSS 等需核对 S3 接口兼容性 |
| 运行配置   | 私有 `project.config.json`，重启生效 | 可由自己的发布系统挂载该文件；当前没有远程配置中心适配器      |
| 模型       | 用户在应用内设置连接                 | 支持工具调用的 OpenAI 兼容接口                                |
| 编译与截图 | 应用容器内 Node/Vite、Chromium       | 当前部署方案使用本机进程                                      |

MySQL 和 Redis 是必需的服务，可以使用 Compose 提供的实例，也可以使用已有服务；对象存储按需外接。外部服务部署使用独立的 [`compose.external.yaml`](compose.external.yaml)，具体配置见[外接服务](docs/deployment/部署与配置.md#外接-mysqlredis-和对象存储)。

下载代理与应用运行代理分别配置。提供的 [`compose.build-proxy.yaml`](compose.build-proxy.yaml) **仅作用于构建下载**，不会把代理写入运行中的应用。说明见[部署代理](docs/deployment/部署与配置.md#下载代理与运行代理)。

## 文档入口

- [文档目录](docs/README.md)：按使用、部署和实现查找资料。
- [配置字段](docs/deployment/configuration.md)：账号、模型、存储、超时和并发设置。
- [架构与流程图](docs/架构与流程图.md)：应用、任务、数据和预览之间的关系。
- [自动部署](docs/deployment/自动部署.md)：推送 main 后检查、发布、健康检查与镜像回滚。
- [本地开发](docs/deployment/部署与配置.md#本地开发)：依赖安装、开发启动与检查。
- [知识库](.Knowledge/index.md)：维护实现约定与故障定位入口。

配置、数据库、文件和加密密钥应一起备份；历史密钥丢失会影响已保存凭据和正文的读取。预览与主应用共享机器资源，适合受信团队使用，隔离边界见[部署指南](docs/deployment/部署与配置.md#资源与访问边界)。

## PixelPrint 资源与分发

`npm run pixelprint:update` 从公开上游更新 Skill 和脚本。已有工作区保留创建时的资源，升级方式见部署指南。

本仓库为独立社区版，不包含真实配置、用户产物或聊天数据。项目尚未提供自有代码的 LICENSE；使用和再分发前应核实项目及上游资源的授权条件。
