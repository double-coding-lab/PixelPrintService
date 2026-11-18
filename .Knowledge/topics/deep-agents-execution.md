---
id: deep-agents-execution
revision: 1
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

## 适用场景

Deep Agents、Worker、检查点、LangGraph、自动摘要、子Agent、暂停、继续、租约、maxTurns、模型用量、执行诊断。

## 详细资料

[Deep Agents 执行与恢复](../stock-docs/deep-agents-execution.md)
