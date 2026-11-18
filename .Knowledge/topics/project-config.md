---
id: project-config
revision: 1
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
