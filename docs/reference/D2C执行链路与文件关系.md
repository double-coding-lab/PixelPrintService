# D2C 执行链路与文件关系

核对日期：2026-11-24。按当前工作树解释调用关系。完整部署、存储与图示见[架构与流程图](../架构与流程图.md)，可汇报能力见[系统能力清单](../系统能力清单.md)。

## 1. 先分清四个对象

```text
工作区 workspace：固定 Skill / 脚本资源修订，共享生成配置
  ├─ 会话 session A：独立文件、设计稿、对话与模型上下文
  │    ├─ 轮次 run 1：生成页面
  │    ├─ 轮次 run 2：根据截图调整标题
  │    └─ 版本 version 1：用户显式暂存的冻结产物
  └─ 会话 session B：另一份独立产物
```

调整当前页面沿用原会话。空闲时一条新消息通常创建一个 Run；一个 Run 可多次请求模型、调用工具和派发子 Agent。业务提问回答恢复同一个 Run；按钮继续已中断任务则创建关联原任务的新 Run。运行中普通消息先进入待发送队列，尚未成为新 Run。

## 2. 从用户点击发送开始读

下列路径位于 `src/functions/d2c/`。

| 顺序 | 文件 / 关键对象 | 做什么 | 状态保存在哪里 |
| --- | --- | --- | --- |
| 1 | `session.ts` | 注册 messages、queue、answer、stop、resume 等接口，核对用户和写请求 | HTTP 层负责校验，业务服务负责事务 |
| 2 | `session/messages.ts` | 空闲发送时保存消息、输入快照、queued Run，按请求 ID 幂等 | MySQL 会话、轮次、时间线 |
| 3 | `session/queue.ts` | 运行中消息排队；空闲后逐条投递；支持删除与立即引导 | MySQL Timeline 的队列事件 |
| 4 | `run/worker.ts` | 定期扫描可领取 Run，按空槽及数据库准入启动执行 | MySQL 队列；内存只跟踪活动取消句柄和 Promise |
| 5 | `run/leases.ts` | 领取、续租、阻止过期执行器写回，受保护提交和终态结算 | MySQL 租约与会话活动关系 |
| 6 | `run/execute.ts` | 恢复固定文件，创建工具/持久化回调，处理心跳、取消和失败 | 临时执行目录 + 持久记录 |
| 7 | `run/agent/run.ts` | 接入模型、历史、检查点、图像和执行记录 | MySQL 与服务端图像读取接口 |
| 8 | `run/agent/agent.ts` | 注册工具，创建 Deep Agents，消费框架执行流 | 模型/工具循环由 Deep Agents / LangGraph 驱动 |
| 9 | `run/tools.ts` | 执行 read/write、Figma、切图、规则和预览等真实操作 | 稳定源码进 MySQL，二进制进 文件存储（local/S3） |
| 10 | `run/persistence.ts` | 将文件、修订、用量、消息/工具事件按租约保存 | MySQL 事务，提交后发布通知 |
| 11 | `session/events.ts`、`notifications.ts` | Redis/本地通知后按 seq 读取新事件，通过 SSE 返回页面 | 通知短暂存在，事件正文持久保存于 MySQL |


## 3. 模型到底怎样调用工具

```text
用户消息及稳定历史
  → agent.ts 创建 Deep Agents，传模型、工具、middleware、checkpointer
  → 模型返回工具调用（例如 read_file 的 path）
  → 框架调用平台注册的工具函数
  → tools.ts 检查取消/租约/参数，进行真实读取或写入
  → persistence.ts 提交结果及事件
  → 工具结果回到框架上下文
  → 模型继续调用工具或回复
```

模型决定调用哪个已注册工具及其参数；服务端实现真正的网络、文件和数据库操作。平台没有开放任意 shell 或任意服务端代码执行给模型。预览使用本地 Node/Vite 子进程编译，运行截图使用本地 Chromium；固定依赖、环境白名单、停止与超时回收由服务管理。

`delegate_agent` 将明确任务交给独立子上下文，保存启动描述后先返回 `accepted/agentId`。最多两个子任务在后台执行，主 Agent 同时编写自己的区域，为子区块保留接口和占位；需要子产物或开始组合、整页检查及预览时才调用 `wait_subagents` 收取结果。

`design/review` 只读，`rule_scan/ui` 按精确路径授权写入；父子写入范围互斥，共享 Run 的预算、取消和租约。子任务的启动描述和结果复用既有检查点，暂停恢复时接续原子图，已完成结果直接交付。主 Agent 负责组合与最终 merge 检查，子 Agent 不另建顶层 Run。

## 4. 切图与文件保存

| 文件 | 作用 |
| --- | --- |
| `run/tools.ts` | `prepare_slices` 的平台工具接线及前置条件处理 |
| `run/slices.ts`、`slicePlan.ts` | 当前正式服务端函数切图：获取节点、计划切片、导出/下载、逐张稳定保存 |
| `run/sliceNetwork.ts` | 可配置代理、白名单、重定向/响应限制、超时与取消 |
| `run/sliceCache.ts` | 核对资源/配置/设计输入后复用完整缓存 |
| `run/sliceProgress.ts` | 结构化切图数量/阶段，随实际执行反馈给时间线 |
| `utils/assetUrls.ts` | 将本地相对图片路径映射到真实 文件存储（local/S3） 地址 |
| `run/designReference.ts` | 保存实际 Figma 根设计稿截图和定位元数据 |

正式 `prepare_slices` 使用本仓库维护的函数实现，不要求每次运行外部 `reskin-slice.mjs`。PixelPrint 固定资源仍提供 Skill、规则和相关脚本；原 CLI 留作调试对照。函数实现变化需要修改本服务，更新 PixelPrint 资源不会自动改变服务端切图算法。

图片稳定上传后登记定位、大小和摘要；部分成功保存断点，重试验真后补缺失项。完整清单仅在满足完整性检查后成立，不能把“本地磁盘看到了文件”当作所有存储步骤已经完成。

## 5. 历史、摘要和检查点各管什么

| 文件 | 职责 |
| --- | --- |
| `run/agent/history.ts` | 将已保存历史转换成框架消息 |
| `run/agent/checkpoint.ts` | LangGraph Saver，保存图检查点和中间写，受租约保护 |
| `run/agent/summary.ts` | 接近预算时生成摘要，控制摘要输出体积及收敛 |
| `run/agent/context.ts` | 请求前上下文控制、大工具正文处理和预算计算 |
| `run/agent/archive.ts` | 将完整资料保存在私有检查点命名空间，模型按已知路径读取 |
| `run/agent/recovery.ts` | 核对恢复状态，避免把未知工具结果当成功 |
| `run/agent/guidance.ts` | 在下一次主模型调用前接收已保存的运行中引导 |

公开时间线用来展示；检查点保存框架运行状态；源码表保存稳定产物。三者职责不同。自动摘要不是每次“继续”都必须发生，也不能保证所有大输入都能压到预算内；是否复用取决于固定输入与保存水位。

## 6. 页面上的停止、回答和继续

| 用户操作 | 实际流程 |
| --- | --- |
| 停止运行 | 保存停止请求，Worker 协作取消模型/工具，等待退出并结算；保留已提交文件 |
| 回答 Agent 问题 | answer 保存回答，同一 Run 重新 queued，按精确中断检查点恢复 |
| 继续暂停/中断任务 | resume 创建关联原轮次的新 Run，恢复稳定历史和文件，不公开插入固定恢复提示聊天气泡 |
| 运行中普通发送 | 保存待发送消息，前一轮结束且会话可投递后创建下一 Run |
| 运行中立即发送 | 保存引导，在下次主模型调用前接收；在途工具先完成 |
| 关闭浏览器 | 关闭订阅，后台任务与已保存队列继续存在 |

停止、超时和进程丢失都有不同结算路径；不保证未提交的内存内容可以恢复，也不自动重复结果未知的上传、写入等副作用。

## 7. 预览、编辑与版本

- 当前会话：`preview/session.ts` 冻结稳定输入，`preview/service.ts` 排队并复用输入摘要；构建成功进入本机 `.runtime/previews/`，不要求先暂存版本。
- 临时编辑：`edit/routes.ts` → `edit/service.ts` → Redis 副本；`preview/warmRunner.ts` 增量构建，输出到 `.runtime/edit-previews/`。入口切换保存并构建，Monaco 搜索后按原始行列定位。
- 应用修改：`editRunControl.ts` 在浏览器侧协调暂停/恢复；后端 `files/service.ts` 事务检查租约和同文件冲突，成功才改变稳定文件。
- 运行截图：`preview/inspection.ts` 产生真实图，`run/screenshots.ts` 将图上传并保存聊天附件，前端显示图片，后续模型可读取。
- 版本暂存：`version/service.ts` 冻结文件和配置、后台打包；`version/gallery.ts` 提供本人/全部作品公开投影。冻结版本不跟随当前文件变化。

## 8. 断点排查从哪里开始

| 现象 | 建议起点 |
| --- | --- |
| 消息没有入队 | `session.ts` 路由、`session/messages.ts` 或 `session/queue.ts` 的事务 |
| 已入队迟迟未执行 | `run/worker.ts` 的 tick、`run/leases.ts` 的准入与领取 |
| 工具参数/路径错误 | `run/tools.ts` 对应工具，查看工具安全摘要与失败分类 |
| 切图网络或进度卡住 | `run/slices.ts` → `sliceNetwork.ts`，区分网络、下载、上传及断点保存 |
| 文件保存失败 | `run/persistence.ts`、`src/hooks/tools/storage.ts`，按 storageOperation 区分步骤 |
| 上下文或输出限制 | `run/agent/context.ts`、`summary.ts`、`model.ts` 与 Run 固定配置 |
| 预览失败 | `preview/diagnostics.ts`、`runner.ts` / `warmRunner.ts`，区分构建中断与源码编译错误 |
| 模型请求用量或耗时 | `run/agent/modelActivity.ts`、`usage.ts`、`run/diagnostics.ts` |

用页面排查编号、runId、sessionId 对照 Pino 日志 的安全诊断；原始凭据及业务内容不直接打印。断点暂停超过租约期限可能产生额外的租约失效，应与原始故障分开判断。

## 9. 验收边界

本文件是当前调用链说明。真实模型、MySQL、Redis、文件存储（local/S3）、代理、本地账号认证、编译依赖与截图浏览器需要在目标环境验证；检查点保留治理、异常强杀后的遗留进程与目录回收及长会话质量仍需持续验证。测试通过、Run 成功、编译成功、规则通过与视觉验收分别判断。

## 预览执行方式

预览固定使用 `local`：在应用所在服务器或容器内用 Node/Vite 编译、Chromium 截图。Docker Compose 部署整个应用；编译与截图仍在应用容器执行。依赖准备见[部署与配置](../deployment/部署与配置.md)。
