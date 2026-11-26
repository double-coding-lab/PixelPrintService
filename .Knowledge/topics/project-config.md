---
id: project-config
revision: 8
summary: "本地配置字段、模型预算、存储与生效时机"
primary: config
confidence: inferred
---
# 项目配置

区分平台运行配置与工作区的业务配置，明确填写方式和重启边界。

## 核心规则

- `src/config/project.ts` 在启动时读取 `project.config.json`；`PIXELPRINT_CONFIG` 可指定其他文件，校验失败只报告字段路径。
- `npm run setup` 从公开示例生成随机会话/凭据密钥及账号，已有配置不覆盖；真实配置必须保持私有。
- `server`、`database`、`redis`、`auth`、`logging`、`storage`、`network` 和 `runtime` 对应独立职责。`auth.github`配置OAuth App，回调从server.publicUrl派生；`auth.guest`配置临时访客开关和固定时限，旧配置缺省关闭。详见[部署配置](../../docs/deployment/configuration.md#github-登录和访客)。
- `RuntimeConfig` 提供已加载的 `runtime`，不会自动订阅远程变更；配置修改后重启。
- `runtime.modelConfigs` 是模型列表，首项为默认模型；不是自动回退链。`contextBudgetTokens` 是单次上下文预算，`maxTurns` 是主/子模型与摘要共享的请求上限。
- `runTimeoutMs` 单位为毫秒；`concurrency` 控制单实例不同会话的并行轮次；`leaseMs` 必须大于 `heartbeatMs` 的两倍。
- `network.proxyUrl` 显式配置Figma与GitHub的运行代理，直连时留空；模型与存储使用各自客户端。compose.build-proxy.yaml仅配置构建下载，基础镜像拉取由Docker daemon/BuildKit管理；浏览器入站访问独立。外部主机白名单只写主机或通配后缀。
- 凭据密钥由 `runtime.d2c.secrets.activeKeyId/keys` 直接提供材料；模型和存储密钥只在服务端读取。
- 工作区可编辑的 `pp-d2c` 配置是业务数据，入库并按修订冻结，不因修改平台配置而覆盖。

## 边界

模型窗口、输出限制和价格由实际接入方决定，配置不会扩展供应商能力。样例值仅为示例；不要在文档、日志或仓库中保存真实密钥。

## 适用场景

project.config.json、配置填写、运行配置、modelConfigs、contextBudgetTokens、maxTurns、runTimeoutMs、密钥、代理、配置生效。

## 详细资料

[项目配置](../stock-docs/project-config.md)

## 文本写入上限

- 示例runtime.d2c.limits.textFileBytes为104857600（100MiB），用于源码及受控缓存的单文件文本写入；uploadBytes与模型上下文预算独立。
- 新实例通过setup继承示例值；已有project.config.json保持原配置，需要显式修改此字段并重启。应用限额不改写反向代理请求限额和数据库包大小。

## 单次模型请求超时

- modelConfigs 每个模型可设置 requestTimeoutMs，单位毫秒，默认 180000，范围 1000–600000。新轮次保存模型快照；已有显式快照不被配置覆盖，旧快照缺少字段时回退默认值。主/子模型及摘要共用此字段，整轮 runTimeoutMs 和 maxTurns 继续独立生效。

## 新建部署的正文外置默认值

- 示例及setup生成的runtime.d2c.contentStorage与checkpointStorage默认mode=external、schemaReady=true，阈值262144字节；setup分别生成独立32字节标准Base64正文密钥。
- 新建表由db:init或容器入口创建引用列。已有project.config.json不覆盖，省略存储块仍兼容旧库；已有数据库先补齐两阶段引用列再启用，不能仅复制新默认值。

## 个人模型凭据

- 顶栏“模型凭据”由本人填写Base URL、模型名称和API Token，整体按既有密钥加密为新修订；地址与模型名仅向本人回填，Token不回显或存入浏览器。地址支持HTTP(S)，禁止内嵌账号、查询参数、片段和控制字符；支持工具调用的服务由用户自行提供。
- 普通新会话自动绑定创建者当前active模型凭据；空会话可在首条消息前配置个人连接，首条入队时补绑定。后续保存新修订用于新会话，已绑定会话及恢复轮次固定原凭据；主模型、子模型与摘要沿该地址、名称和Token执行，共用管理员的预算及超时配置。
- 个人连接可独立于管理员默认模型，执行先核对当前发起人、凭据ID、状态及快照连接；错误或失效明确拒绝，不能回退平台Key。旧的仅Token修订继续绑定原管理员连接，旧空绑定历史仍沿平台模型；当前默认连接改变时旧Token修订须重配。
- POST /credentials/model兼容旧token单字段调用，个人完整配置须同时提交baseUrl、modelName及token；新能力复用既有密文列和modelCredentialId，无新增迁移。已有旧库仍先完成docs/sql/personal-model-credentials-migration.sql，新库按模型建表。回归见modelCredentials：真实HTTP密钥归属、跨用户、修订及连接校验。

## 自主部署配置

- 默认compose.yaml提供应用、MySQL、Redis和本地文件；compose.external.yaml只提供应用，可连接部署方已有数据库与缓存。S3兼容存储按需启用，OSS等需验证兼容接口；当前MySQL没有TLS证书字段，Redis使用单节点连接串。
- publicUrl须与浏览器访问来源、HTTPS和OAuth回调一致；通配证书与DNS解析分别配置。完整示例及维护步骤见[配置终稿](../stock-docs/project-config.md#部署组合与代理边界)。
