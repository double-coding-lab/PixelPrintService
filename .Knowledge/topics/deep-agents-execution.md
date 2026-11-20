---
id: deep-agents-execution
revision: 7
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

## UI规则修复无进展交接

- 主Agent统一管理切图、全局图片映射、页面入口和最终整合；UI子Agent只实现边界清晰、写路径互斥的真实sub区块，小区块及micro-sub按固定Skill处理。分工提示不保证模型耗时，需同稿实测。
- `agent/ruleRepair.ts` 在UI原生图的下一模型请求前，对齐最近真实check_rules(block)工具结果；按区块独立比较rule、nodeId、file、expected和actual，忽略行号、源码片段及报告顺序。只有合法的非空失败报告参与无进展判断。
- 首次失败建立基线；此后连续两次检查的违规内容相同，即第三次相同失败时结束子图修复循环，以RULE_REPAIR_STALLED交回父级。违规减少、节点或实际差异变化时重新建立基线；成功检查清除该范围的失败计数。
- 计数、最近工具标识和违规摘要随原生检查点保存。清单/源码写入不重置计数；触发交接后相同输入恢复不重放检查或请求模型。新用户输入或已核实的设计/文件变化允许重新建立有限修复机会。
- 主Agent消费stalledScopes、真实文件及contextPath，只接管剩余缺口；不原样恢复或新派相同循环。交接保持success=false，规则失败与待检查状态保留，相关block和最终merge仍需真实验收；存储、取消、失租及共享预算故障沿原分类上抛。
- 图片“已登记但产物未引用”须核对JSX/样式中的实际引用，反复修改assets.txt不能证明修复。子区块通过后整页出现同类问题，先核对检查范围、资源证据与页面整合，不直接从头重做子区块。
- 回归入口为test/ruleRepair.test.ts及子任务交付/规则检查测试；覆盖同项重复、真实改善、检查点恢复、父图继续接管和存储失败。历史任务不自动重跑；冻结工作区脚本更新须遵循资源版本约定。

### 区块与整页图片证据

- H5/RN图片规则聚合页面根清单与实际静态依赖所属区块的assets.txt；未引用旧块及越界/符号链接清单不能提供放行证据。入口依赖不确定时仅使用已解析到的图片证据，其他规则保留原有保守检查。
- R02继续要求产物引用，只有清单登记仍失败；自由格式清单不推断nodeId到语义文件名映射。R03沿用原有切图判定，只修正证据读取范围；不通过过滤报告或改写违规来制造通过。
- 平台交接保护部署后生效；规则脚本属于冻结资源，已有工作区需升级固定资源后使用新检查器。离线真实脚本回归见test/ruleAssetEvidence.test.ts，覆盖清单聚合、旧块隔离、真实缺图及路径边界。

## 子Agent执行诊断

- 新模型事件由平台注入agentId：null为主Agent，UUID为对应子图；子图摘要沿用子图身份。历史generation仍可归主任务，缺身份的其他角色/摘要只列入未归属请求，不按时间或同角色猜测。
- 子任务事件diagnosticVersion=1记录入队、启动、任务摘要、授权路径、交付文件和缺口。任务摘要来自已脱敏委派说明，模型名称来自本轮固定快照；只读诊断不回放工具或修改历史状态。
- 请求按operationId去重，分别累计完成、失败、中断、未结束及实际retryIndex>0的重试请求；摘要计入其所属Agent。Token按明确报告累计，缺失显示未知；完整新采集明确零次请求时记零用量，部分用量标为不完整；重试安排不等于已发生请求。
- 子任务耗时累计本轮各次入队至结束区间，恢复间空闲不计；排队时间缺少起点时未知。模型耗时与首块等待各自显示记录覆盖数；工具耗时只认真实起止配对且含等待。并行子任务时长不能相加作为整轮耗时。
- 每次UI区块检查只记录规则/节点摘要、数量与完整违规签名；相同数量不代表无改善。普通工具及平台恢复复核均记录起止，完整expected/actual报告继续保留在私有工具历史中。
- diagnostics保留最近200条主步骤窗口，子任务统计另读最多4000条模型、8000条子任务元数据；排除助手正文和思考。超限complete=false并明确展示局部范围，工具明细最多60条、每个子任务规则检查最多80次、每次违规明细最多64项，省略均有标记。
- 诊断抽屉展示主任务/历史未归属用量及各子任务职责、状态、耗时、请求、Token和交付；卡片默认收起详情，工具记录另可展开。仅打开时读取并随相关SSE合并刷新，子会话正文/思考分片不触发重读；本地秒表不新增请求。
- 无新增DDL、配置或模型请求；发布后新执行开始记录精确归属，历史缺失不补造。检查点仍只读会话最新保存时间，不反序列化完整对话或大字段。
- 回归覆盖test/subagentDiagnostics.test.ts、test/subagentDiagnosticsRead.test.ts、test/subagentDiagnosticsFrontend.test.ts及test/ruleRepair.test.ts：并行身份、用量未知、事件去重、交接继续、窗口完整性和窄屏展示。
