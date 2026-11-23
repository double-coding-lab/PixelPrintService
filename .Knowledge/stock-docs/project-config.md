# 社区版配置说明

## 配置来源

`npm run setup` 创建 `project.config.json`，已有文件保持原样。示例结构在根 `project.config.example.json`；本主题不复制部署方真实值。配置默认相对进程工作目录解析，也可通过 `PIXELPRINT_CONFIG` 指定文件。

`src/config/project.ts` 负责顶层配置校验，`src/config/d2c.ts` 负责模型和 D2C 执行配置。`src/hooks/tools/config.ts` 的 RuntimeConfig 返回启动时读取的运行参数。修改配置需要重启；本轮已经冻结的业务快照不会自动改写。

## 取值规则

| 配置 | 如何填写 |
| --- | --- |
| `server.host/port/publicUrl` | 服务监听与浏览器实际访问来源，反向代理后填写用户访问的公开来源 |
| `database` | 部署方标准 MySQL 连接信息 |
| `redis.url` | 部署方 Redis 连接串 |
| `auth.sessionSecret` | 初始化生成的随机材料，至少 32 字节；更换会使已有签名失效 |
| `auth.users` | 稳定用户 ID、显示名称和 scrypt 密码哈希，可选个人 API Token |
| `storage.driver` | `local` 或 `s3`，按部署实际选择 |
| `storage.directory/publicUrl` | 本地目录和外部可读的文件根地址；S3 可使用桶或 CDN 地址 |
| `storage.bucket/region/endpoint` | S3 桶、区域及兼容服务 API 地址，桶由部署方预先创建 |
| `network.proxyUrl` | 通用 HTTP 代理，直连时为空；不把模型和存储请求自动改走 Figma 代理 |
| `runtime.modelConfigs` | 至少一个支持工具调用的模型配置，地址填兼容接口的根路径 |
| `runtime.d2c.network.allowedExternalHosts` | 主机名或明确通配后缀，不填写完整 URL、端口或路径 |
| `runtime.d2c.limits` | 单文件文本上限示例为100MiB（104857600字节），会话文件数和二进制上传限额独立 |

完整字段表见 [项目配置](../../doc/configuration.md)。

## 预算、并行与租约

- `contextBudgetTokens` 限制单次模型上下文，不能当作整场对话累计用量或费用。估算器与供应商分词可能不同，实际使用量以返回值为准。
- `maxTurns` 限制模型请求次数，主 Agent、子 Agent 和摘要共享；不是用户消息数、图节点步数或工具调用总数。
- `runTimeoutMs` 限制单轮活跃执行时间。1 小时是 3600000 毫秒，3 小时是 10800000 毫秒；需按部署资源与任务规模确定。
- `concurrency` 控制当前服务实例同时执行的轮次，不允许同会话绕过原单轮占用并发执行。
- `heartbeatMs` 是续租周期，`leaseMs` 是有效期；后者必须严格大于前者的两倍。
- `workRoot` 是私有临时执行根目录。持久文件保存在 MySQL 和对象存储中，不能只依赖临时目录。

这些参数在消息入队时形成无密钥快照。执行时按固定模型地址和名称查找服务端密钥；不能在历史快照中保存调用凭据。

## 密钥与业务配置

Figma Token 用 AES-256-GCM 加密保存。`activeKeyId` 选择当前加密材料，`keys` 保存历史版本所需的真实材料；服务端直接派生密钥，没有额外解析服务。删除旧材料可能使旧凭据无法解密。

模型 API Key、S3 凭据、Cookie 签名和 Figma 加密材料分开管理。所有真实值只保存在部署配置中；文档使用字段说明或公开占位符。

工作区的生成配置通过页面编辑后入库，资源升级只影响明确选择的工作区修订；会话历史不因模板仓更新而自动改变。预览固定采用本地执行，使用模板自带的运行参数，不需要填写远程执行平台配置。

每模型可配置 requestTimeoutMs（毫秒，默认180000，范围1000–600000），按模型快照生效；详见[单次模型超时](../topics/project-config.md#单次模型请求超时)。

## 新建配置默认外置正文

示例与setup默认对contentStorage和checkpointStorage启用external，并分别生成正文密钥；新建表准备好引用列后运行。已有配置保持原值，已有数据库升级先补列再切模式。配置位置与初始化边界见[项目配置主题](../topics/project-config.md#新建部署的正文外置默认值)。
