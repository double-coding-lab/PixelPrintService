# 项目配置

`npm run setup` 从示例生成 `project.config.json` 和随机登录密码、会话密钥、凭据加密密钥。已有文件不会覆盖。所有运行配置在进程启动时读取，修改后重启。`PIXELPRINT_CONFIG` 可指定配置文件路径。

| 字段 | 作用与取值 |
| --- | --- |
| server.host / port | HTTP 监听地址和端口，容器使用 0.0.0.0:8080 |
| server.publicUrl | 浏览器实际访问的完整来源，部署 HTTPS 时填写 HTTPS 地址 |
| database | 标准 MySQL 地址、端口、数据库名、用户名和密码 |
| redis.url | redis:// 或 rediss:// 连接串，可包含部署方提供的认证信息 |
| auth.sessionSecret | 初始化生成，用于 Cookie 签名；更换后已有登录失效 |
| auth.sessionTtlSeconds | 登录有效期秒数 |
| auth.users | 本地用户数组，id 为稳定账号，name 为显示名称，passwordHash 为 scrypt 哈希 |
| auth.users[].apiToken | 可选，至少32字符，用于插件接口 Bearer 认证，不要暴露给其他用户 |
| logging.level | trace / debug / info / warn / error / fatal / silent |
| storage.driver | local 或 s3 |
| storage.directory | local 文件目录，默认 .data/files |
| storage.publicUrl | 外部可读的文件根地址；local 用主站 /files，S3 用公开桶或 CDN 的根地址 |
| storage.bucket / region | S3 桶名与区域；local 模式不使用 |
| storage.endpoint | S3 兼容服务的 API 地址，AWS S3 可留空 |
| storage.accessKeyId / secretAccessKey | S3 凭据；留空时使用 AWS SDK 标准凭据链 |
| storage.forcePathStyle | MinIO 等兼容服务通常 true |
| network.proxyUrl | 外网 Figma 请求代理，直连时留空；模型与存储使用各自客户端 |
| runtime.modelConfigs | 模型列表，至少一个支持工具调用的模型 |
| runtime.modelConfigs[].MODEL_BASE_URL | 兼容 OpenAI 的 /v1 根地址，不是完整 /chat/completions 路径 |
| runtime.modelConfigs[].MODEL_NAME / MODEL_API_KEY | 服务端接受的模型标识和凭据 |
| runtime.modelConfigs[].contextBudgetTokens | 单次上下文预算，不是累计计费 Token；不要超过服务实际支持的窗口 |
| runtime.modelConfigs[].requestTimeoutMs | 单次模型 SDK 请求超时，毫秒；默认180000，范围1000–600000，主/子模型及摘要共用；整轮时限独立 |
| runtime.modelConfigs[].reasoningPolicy | 默认 provider-default，其他取值请以 src/config/d2c.ts 的模型契约为准 |
| runtime.d2c.execution.workRoot | 每轮任务独立临时执行根目录，需要可写 |
| runtime.d2c.execution.concurrency | 单实例同时执行的轮次数，默认2 |
| runtime.d2c.execution.pollIntervalMs | 领取待执行任务的兜底检查间隔 |
| runtime.d2c.execution.heartbeatMs / leaseMs | 执行续租频率与租约时长，后者必须大于前者两倍 |
| runtime.d2c.execution.runTimeoutMs | 单轮执行总时限，毫秒 |
| runtime.d2c.execution.maxTurns | 执行轮次上限，不是用户会话数量 |
| runtime.d2c.network.allowedExternalHosts | 外部资源主机名白名单，支持 *.example.com，不填路径 |
| runtime.d2c.storage.enabled | 启用文件持久化，默认 true |
| runtime.d2c.secrets.activeKeyId | 当前 Figma 凭据加密密钥版本 |
| runtime.d2c.secrets.keys | 版本到真实密钥材料的映射，初始化生成，服务端直接使用；没有外部密钥解析器 |
| runtime.d2c.contentStorage / checkpointStorage | 新建配置默认 external、schemaReady=true；分别控制文件正文和检查点/中间写入，阈值默认262144字节 |
| runtime.d2c.contentStorage.encryption / checkpointStorage.encryption | setup分别生成32字节随机密钥的Base64；持久保存并保留历史keyId |
| runtime.d2c.limits.textFileBytes | 单个文本文件写入上限，示例默认100MiB（104857600字节），包括源码和受控节点缓存 |
| runtime.d2c.limits.filesPerSession | 单会话文件数量上限 |
| runtime.d2c.limits.uploadBytes | 单次上传最大字节数，默认30MB |

S3 模式需提前创建桶并配置对象读取方式。上传接口不会创建桶或更改访问策略。保存的文件记录包含真实公开 URL、大小和 SHA-256；历史文件下载会校验路径和内容。

已有实例可将 `project.config.json` 的 `runtime.d2c.limits.textFileBytes` 改为 `104857600` 后重启。`npm run setup` 保留已有配置；文本写入限额与二进制上传限额分别配置，模型上下文预算也保持独立。应用限额不会修改反向代理的请求大小限制或数据库的包大小设置。

## 增加账号

可使用相同初始化脚本生成临时配置，复制其中的用户记录后删除临时文件：

```bash
node scripts/setup.mjs --config new-user.private.json --user alice
```

将其 `auth.users[0]` 加入正式配置的 `auth.users` 数组，然后重启。仅复制用户记录，不要替换正式配置中的会话和凭据加密密钥。临时配置也含随机密钥，删除前妥善处理且不要提交。

新默认值适用于使用初始化脚本创建的配置。已有配置保持原值；缺省存储块仍按旧库模式读取。已有数据库必须先补齐两阶段引用列，再启用schemaReady；新建库由db:init或容器入口创建字段。
