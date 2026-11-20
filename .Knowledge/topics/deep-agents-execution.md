---
id: deep-agents-execution
revision: 4
summary: "模型循环、检查点、摘要、子Agent、预算和诊断"
primary: module
confidence: inferred
---
# Deep Agents 执行与恢复

定位消息入队后的执行调用链和恢复边界。执行前须先读依赖主题 `d2c-workspace-foundation`。

## 核心流程

- `session/messages.ts` 保存消息与 Run；`run/worker.ts` 领取任务，再由 `run/execute.ts`、`run/agent/run.ts`、`run/agent/agent.ts` 调用 Deep Agents。
- Worker 是后台调度代码，不是消息存储；MySQL 队列和租约决定领取、续租与结算。不同会话受实例并发数约束，同会话保持单轮占用。
- `thread_id` 绑定会话，图状态与工具结果保存为检查点；检查点是框架执行状态，不是模型自行编写的进度总结。
- 摘要在有效上下文接近预算时执行，完整历史先归档；摘要和子 Agent 请求计入同一模型预算。
- 子 Agent 有独立上下文及精确角色权限，后台委派结果由主 Agent 收取；本地文件、模型等待和数据库事务不混成一个长事务。
- Run 执行状态、规则检查状态与视觉结果分别判断；有文件或模型口头完成不代表已经通过校验。

## 恢复与诊断

- 取消、超时、服务重启和租约失效保留原原因。未知工具副作用先核对文件和历史，不盲目重放。
- 图每段允许 2048 步，有持久进展和有效检查点时最多续作两段；模型请求次数、执行时间与权限仍受原限额控制。
- 每次模型请求记录开始、首个有效输出、结束和用量。没有上报用量不等于零消耗；首块等待也不能直接当作模型服务排队时间。
- 入口实现见 `run/agent/checkpoint.ts`、`summary.ts`、`subagentCheckpoint.ts`、`modelActivity.ts` 和 `run/diagnostics.ts`。

## 边界

真实模型、长会话和视觉质量需要实际验收。已保存的未知结果不能由前端补造，前端断开 SSE 不取消后台执行。

## 检查点与历史归档占用

- `d2c_agent_checkpoint.checkpointPayload/metadataPayload` 与 `d2c_agent_write.writePayload` 为LONGBLOB；模型属性分别为 `checkpoint/metadata/value`。图状态及中间写可能包含消息、工具结果或代码片段。
- `run/agent/archive.ts` 将 `/history/` 原文及工具归档保存到检查点表的独立namespace，正文位于 `channel_values.archive.content`，单归档正文上限8MiB。上下文摘要减少模型输入时，完整历史仍保存在数据库，Token量与存储占用分别计量。
- `d2c_run.checkpoint` 保存文件修订与恢复控制等元数据。跨表占用以[存储字段说明](../stock-docs/d2c-workspace-foundation.md#数据库大字段与增长来源)为入口，单条最大字节、总字节和记录数分别核定，实际排名须查询目标库。

## 适用场景

Deep Agents、Worker、检查点、LangGraph、自动摘要、子Agent、暂停、继续、租约、maxTurns、模型用量、执行诊断。

## 详细资料

[Deep Agents 执行与恢复](../stock-docs/deep-agents-execution.md)

## 后台子任务稳定身份恢复

- 显式resumeAgentId只在当前job、thread与精确进度namespace中定位原记录，继续使用原存储key和子图；角色、节点及完整writePaths必须匹配。不匹配返回RESUME_SCOPE_CHANGED，找不到返回RESUME_NOT_FOUND，不新建ID或覆盖原记录。
- 同授权的缓存输入变化或已保存文件变化保留agentId、原子图和交接上下文；contextHash及实际文件摘要用于记录inputChanged、changedPaths、missingPaths，未知写入仍先对账。失效的完成缓存不能当作当前成功，变化或缺失文件只在原授权内复核。
- pending恢复差异跨open/start中断持续保存，仅真实执行结算成功后清除；恢复收到具体变化及先回读授权资料的要求；settled且仍有效的结果直接交付，不重跑模型或写入。settled结果过期时向父Agent交接RESUME_INPUT_CHANGED及真实已保存文件，原结果保留供审计，由父Agent沿原ID复核或接管。
- 恢复原任务不消耗新委派次数，实际模型请求仍计入共享预算。在途回执也必须匹配显式恢复ID；自动恢复的已知拒绝或节点调整通过wait_subagents返回结构化失败，父图保存回执后才标记观察，避免因同一拒绝反复中断。存储损坏、读取/写入故障、权限、停止、失租和未知异常继续上抛。
- 验证入口：backgroundAgentGraph与subagentCheckpoint离线真实图/保存器回归，覆盖恢复、缓存变化、文件缺失、结果重送、额度、授权隔离及数据保留；不自动改写历史failed轮次。

## 子模型网络故障与有限重试

- SDK 的 APIConnectionTimeoutError/APIConnectionError 可能没有状态码或网络 code，按真实异常类型及固定网络码识别；不使用任意错误正文猜测。模型请求包装可沿 cause 检查；取消、权限、存储、失租和共享预算异常继续阻止重试。每次实际请求计入原预算，最多追加两次，等待可被取消。
- 重试在当前主/子图模型调用内进行，复用已有消息与成功工具结果；不重建子任务、不重放已完成工具。超时耗尽保留 NETWORK_TIMEOUT/模型阶段与安全 SDK 类型，普通模型失败保留 MODEL_REQUEST_FAILED，不被 execute 边界覆盖为 SUBAGENT_FAILED。settle/observe 故障仍属于存储；未知异常不自动重试。
- 每模型 requestTimeoutMs 默认 180000，允许 1000–600000 毫秒；主模型、子模型、摘要和思考变体均沿同一配置。旧配置及缺少字段的旧快照使用默认值，已显式保存的值按快照保持。该值是单次 SDK 请求设置，整轮时间与请求预算仍独立限制；不是已验证的最优值。
- 验证包括实际 SDK 异常、真实图中的原子任务身份与工具不重放、次数耗尽/停止、分类优先级及配置透传。历史失败仍保留原状态，不自动启动历史任务，也不能据时长推断具体网络故障。
