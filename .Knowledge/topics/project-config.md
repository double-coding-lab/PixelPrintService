---
id: project-config
revision: 5
summary: "本地配置字段、模型预算、存储与生效时机"
primary: config
confidence: inferred
---
# 项目配置

区分平台运行配置与工作区的业务配置，明确填写方式和重启边界。

## 核心规则

- `src/config/project.ts` 在启动时读取 `project.config.json`；`PIXELPRINT_CONFIG` 可指定其他文件，校验失败只报告字段路径。
- `npm run setup` 从公开示例生成随机会话/凭据密钥及账号，已有配置不覆盖；真实配置必须保持私有。
- `server`、`database`、`redis`、`auth`、`logging`、`storage`、`network` 和 `runtime` 对应独立职责。
- `RuntimeConfig` 提供已加载的 `runtime`，不会自动订阅远程变更；配置修改后重启。
- `runtime.modelConfigs` 是模型列表，首项为默认模型；不是自动回退链。`contextBudgetTokens` 是单次上下文预算，`maxTurns` 是主/子模型与摘要共享的请求上限。
- `runTimeoutMs` 单位为毫秒；`concurrency` 控制单实例不同会话的并行轮次；`leaseMs` 必须大于 `heartbeatMs` 的两倍。
- `network.proxyUrl` 配置 Figma 外网代理，直连时留空；外部主机白名单只写主机或通配后缀。
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

- 顶栏“模型凭据”仅保存本地账号自己的API Token；MODEL_BASE_URL与MODEL_NAME沿管理员modelConfigs首项，浏览器不提交自选服务地址。凭据使用runtime.d2c.secrets现有密钥加密并保留修订；备份或轮换密钥时继续保留已有材料。
- 新建广场会话分支必须绑定本人Figma及model凭据；modelCredentialId固定到会话和执行快照，执行按发起账号解密，同一轮次主子模型与摘要共用；个人凭据失败返回CREDENTIAL_UNAVAILABLE，历史NULL会话沿平台模型。默认模型连接改变后重新保存个人Token。
- 已有数据库在发布前备份并审核执行docs/sql/personal-model-credentials-migration.sql，扩展d2c_credential.kind和新增d2c_session.modelCredentialId；程序和db:init不自动ALTER已有表，全新库按注册模型创建。个人Token不进入源码、日志、公开数据、明文快照或浏览器存储。
