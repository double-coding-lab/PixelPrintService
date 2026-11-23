---
id: deep-agents-execution
revision: 14
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

- `d2c_agent_checkpoint.checkpointPayload/metadataPayload` 与 `d2c_agent_write.writePayload` 保留LONGBLOB兼容读取，合格大载荷可独立切换加密外置引用；模型属性分别为 `checkpoint/metadata/value`。图状态及中间写可能包含消息、工具结果或代码片段。
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

## UI任务准入与编译反馈

- 正式执行器具备scanRules时，UI启动前核对授权区块的rule-hits.json结构、当前原生扫描指纹与疑难判断完成情况。缺失或未完成报告返回UI_PREREQUISITES_REQUIRED、dependencies和逐区块rule_scan的nextActions，此时不启动UI模型、不消耗执行委派次数；父级收取区块报告后继续。整页报告不能替代区块报告。
- 已持久化的旧后台任务经原身份保存依赖交接，保留源码、检查点和上下文。UI仍禁止修改规则报告，实际源码违规继续由真实检查和有界无进展交接处理。路径占用反馈要求先收取相关任务，授权范围保持不变。
- UI读取以本区块报告、节点、素材表及必要规则文档为主；bin检查器实现由父级排查。完整缓存和历史继续保留，进度说明复用已确认基线，聚焦区块与实际变化。
- edit_file在参数解析和实际编辑两层返回摘要类型/长度、空原片段及无变化的具体反馈，不回传正文、不代填摘要；并发摘要冲突仍需重新读取。
- 主模型请求前只读已有自动预览的失败诊断，按预览标识、修订及诊断去重，结果仍计入上下文预算。此反馈不启动编译、截图或额外模型请求；规则、编译和视觉验收分别判断。

## 会话错误统计与排查明细

- `GET /api/d2c/sessions/:id/errors` 只读当前用户有权访问的会话，默认统计全部轮次；runId/category/scope仅筛选明细，服务端总数不随已加载聊天或诊断步骤窗口改变。响应禁缓存，无新增表或运行配置。
- 从已保存的模型失败、工具反馈、子任务失败及轮次终态提取安全元数据；人工暂停、取消和等待不计错误。执行错误与工具纠正组成错误总数，规则未通过单列，不混入执行错误。
- 实际模型请求每次失败保留独立记录；同一错误向外包装时复用errorId，通过明确编号合并跨层上报，不按相近时间或相同文案猜测重复。重试后成功仍保留失败记录；缺少可靠证据时恢复状态未知。
- 明细包含时间、固定分类说明、runId、Agent身份、工具/命令、errorId、网关请求编号、尝试次数和恢复状态；不读取私有SDK正文或检查点，也不返回任意异常堆栈、上游响应或凭据。
- 首屏冻结snapshotSeq，before是去重筛选后条目偏移，每页默认50、最大100；服务端有界扫描并明确coverage与历史仅已保存事件口径，截断和缺失数据不能表示全量零错误。
- 诊断抽屉随时间线更新，支持会话/当前轮次、类别和主/子任务筛选、展开详情、复制排查信息及分页；加载或读取失败显示未知状态，刷新保留稳定错误条目的展开选择。
- 实现入口：`run/errorDiagnostics.ts`、`run/errors.ts`、`agent/modelActivity.ts`、`web/src/workspace/ErrorDiagnostics.tsx`；回归覆盖去重、分页、归属、重试、脱敏与前端请求竞态。

## 检查点和中间写入外置

- `d2c.checkpointStorage`独立于文件正文开关，新建配置默认`schemaReady=true/mode=external`，省略配置的旧部署保持`schemaReady=false/mode=inline`；配置位于project.config.json的runtime.d2c。三列新引用就绪后重启启用，旧schema默认SELECT/INSERT不依赖新列。
- 两表保留typed BLOB，新增checkpointRef/metadataRef及数据库writeRef（模型valueRef）；shadow双写兼容旧writer，external仅外置合格大载荷，旧BLOB始终优先读取。回退inline仍保留schemaReady、历史密钥和对象；旧程序回滚前必须restore全部所需BLOB。
- `content/binaryStore.ts`保存任意typed bytes，gzip获益时压缩，再以独立密钥AES-256-GCM加密；引用pixelprint.blob.v1绑定行身份、namespace、checkpoint/task/idx及typed编码，回读校验且解压有界。超出传输能力的合法载荷留库，定位/密钥不公开、不进入日志。
- 序列化/上传及还原/反序列化在租约事务外。提交仍经原leases.commit；失租、取消或提交失败保留旧状态。普通write重复first-wins，特殊负idx last-wins，整批提交原子；重复普通写预检跳过无用上传，最后仍重验租约。
- getTuple在单个一致读内冻结状态/元数据及所需pending描述，再事务外还原；list按最多50个候选分页、逐个还原/yield并复核filter，保留namespace/before/order/limit。每个tuple一致，跨页可见并发变化；不在长事务中下载对象或累积全部历史正文。
- `checkpoint:migrate`提供checkpoints/writes固定表组、dry-run、BIGINT上界/分页、逐行CAS、0600游标续迁和精确BLOB回填。预演无对象IO或更新锁；apply按父会话→载荷行锁定，活动会话及并发变化停在安全游标，不改图状态或删除历史。DDL及实际迁移由部署方执行。
- 原typed格式、全部channel_values、父链delta replay、归档和原生interrupt继续保留；损坏引用不静默变成新图。时间线外置、历史保留/对象GC和通道级增量属于后续独立范围，不按相同大小删除快照。
- 配置/SQL/启用与回滚说明见[执行终稿](../stock-docs/deep-agents-execution.md#检查点和中间写入外置)。

## 工具参数纠错与历史排查边界

- 工具输入解析失败按注册Zod对象契约反馈出错顶层字段、固定校验类型、必填性、合法枚举及类型/长度/数值范围，最多12条；仅从受信契约生成提示，参数值、嵌套字典键和自定义异常正文保持私有。edit_file摘要类型与长度沿用专门反馈，错误调用不执行副作用，模型可修正后继续。
- read_file默认读取会话文件，offset/length允许省略；figma的非相关可选字段、ask_user选项和预览entryPath允许省略。真正必填项、命令枚举、数字范围和子Agent权限仍按契约校验，字符串数字及错误模式不自动猜测转换。
- prepare_slices的slug为1至64位小写英文、数字或连字符，首位为英文或数字；check_rules接收目录path和block/merge模式。同一文件编辑串行使用上次成功回执的新sha256，真实冲突仍需重新读取；last-page等缓存由平台维护，执行进度写入页面目录.d2c-tasks.md。
- 子Agent失败事件保存固定异常类型、系统码、框架码、HTTP状态及执行阶段的安全投影；抽屉详情和复制诊断沿同一白名单读取。历史缺少原始字段时原因保持未知，不用最近一次已修复的工具反馈解释后来异常；失败阶段以真实边界为准。
- 工具错误只有在同轮次、同Agent、同工具及同操作对象存在完整起止配对和明确的后续成功时才标记subsequent_success；错误数量保留。缺身份、调用号重复、对象截断、分页水位外的成功、结果不明及取消均保持未知，不按时间相近推断恢复。
- 历史INVALID_ARGUMENT未保存具体字段时不能倒推出当时参数；同一子任务的通用失败与父级交接失败须关联分析，不能直接算作两个独立根因。真实规则失败、摘要冲突和片段不唯一保留校验。回归见toolArgumentDetail、editArgumentFeedback、errorDiagnostics、failureDetails及subagentFailureBoundary。
- H5检查器共享cssMatch词法与作用域解析：完整类名、静态SCSS嵌套&、多父选择器及分组at-rule按真实主体收集直接声明，避免.card读取.card-title或子级声明；R05共用相同规则。它不执行Sass mixin、循环或动态插值，也不模拟浏览器条件和级联。回归见ruleClassBoundary、ruleCssParsing及ruleAssetEvidence，规则脚本可脱离node_modules运行。
- 已冻结工作区须更新对应规则资源；部署新平台代码不会自动改写线上旧脚本或历史结果。字体问题独立处理，本轮未调整字体资源。

## 执行前置条件与减少无效重试

- 一次`rule_scan`委派只允许一个`nodeId`对应一份`rule-hits.json`；多个区块分别委派，避免用同一个节点生成多个区块报告。多报告请求在扫描、保存和子模型执行前拒绝；旧后台描述也不得按歧义范围续扫。UI准入反馈的`nextActions`逐项列出独立扫描任务，待报告真实完成后再继续UI，报告写权限保持分离。
- 生产子任务因自身模型请求或输出上限退出时，先复核实际交付。仅授权文件齐全、报告完整且当前指纹及必要最新检查均通过时，保存真实成功回执，不再追加模型请求；部分报告、缺文件或待检查仍按缺口交接。共享请求预算、取消、存储和租约等可信故障不能被局部限额吞掉。
- `rule_scan`的`write_file.content`兼容字符串，也可传结构化报告对象，由程序序列化；原生增量仍需当前`nativeScan.fingerprint`及真实`nativeReview`，保留合并、命中和最终交付校验，不用空对象冒充完整报告。
- `edit_file.expectedSha256`允许省略或null：只使用本Agent最近一次真实读取、整文件保存或局部编辑回执中的完整摘要。每个Agent独立、最多保留256个路径；重启后的新执行若无回执须先重读。显式摘要原样核验，外部并发变更和非唯一片段仍拒绝；不查询当前内容后自动覆盖，也不猜测或截短摘要。
- 安全目录尾斜杠在调度锁及子任务授权前统一规范化；路径穿越、兄弟或越权目录仍拒绝。主Agent写平台维护的`.d2c-cache/last-page.json`返回`skipped/PLATFORM_MANAGED_CACHE`，明确未写入且无需重试；其他受保护写入不放开，执行进度写页面目录`.d2c-tasks.md`。
- 切图命名未齐使用`SLICE_NAMES_REQUIRED`及有界`needsNames`提示补齐，保留时间线但不计入执行错误、工具纠正、规则失败或错误总数；真正无效参数与历史`INVALID_ARGUMENT`仍保留原错误计量。历史记录不会因新版本自动改写。
- 实现见`agent/agent.ts`、`agent/fileVersions.ts`、`agent/delegationScheduler.ts`、`agent/subagentTools.ts`、`run/slices.ts`与`run/errorDiagnostics.ts`。回归覆盖副作用前拒绝、局部限额的完整/部分交付、版本回执隔离及真实冲突、目录授权和命名统计；无需新增数据库表或运行配置。预览去重见[生成期缺依赖等待](d2c-preview-editing.md#生成期缺依赖等待)。

## 上下文复用与资料读取

- 主、子Agent和原生摘要共用`modelContextView`。同一请求中，对工具配对完整、调用身份明确且结果逐字一致的`read_file`与`figma inspect-node`，保留最近一份完整回执，旧回执改为含工具调用号、原路径和结果摘要的短引用。不同文件、资源作用域、分页或版本，以及失败、未知、多媒体和歧义配对均保留原结果；用户输入及规则检查结果不按此折叠。
- 视图按当前有效消息每次重算，摘要后原文不在上下文时可正常重读；没有跨请求“已经看过”的缓存。消息数量、ID和工具调用配对保持原顺序，图检查点与时间线仍保存真实调用及原始结果。触发摘要时先存完整JSON快照，再让摘要消费精简视图。
- 已成功保存的大段`write_file`内容和`edit_file`片段仅在后续模型视图压缩，结构化规则报告也适用；阈值按预算10%取值，最低128、最高2048估算Token。失败、未知和缺回执的写入保留原参数；partial/merge标记、真实用量及响应元数据继续保留，压缩不表示任务完成。
- 重建模型消息显式复制公共消息字段，保留ID、正文、工具身份及必要元数据，避免把消息实例内部的`lc_kwargs`反复嵌套进序列化视图。原始历史及业务文件不因此改写。
- UI固定资源视图将H5/RN生成Skill的`bin/`实现脚本、依赖脚本和源码映射替换为普通阅读引导，发现/搜索接口仅展示可消费资料，直接读取或下载也不提供实现原文。先读本区块报告的hits/constraints/deferredChecks、命中规则文档与实际违规证据；检查器实现争议交由父Agent排查。规则Markdown、配置、模板和授权业务源码正常读取；主Agent、review和rule_scan继续具备原有只读范围，执行检查器及规则验收不变。
- 图片只在当前模型请求边界物化，重复引用保留定位与来源说明；设计稿/素材与运行截图分别解释，未载入和视觉拒绝仍如实标记。后续请求按当前历史重新准备视觉输入，不能用跨请求标记代替模型真实看图。
- 实现入口为`agent/context.ts`、`agent/summary.ts`、`agent/images.ts`、`agent/readPolicy.ts`及`agent/resources.ts`。离线回归覆盖真实Agent工具循环、原生摘要原文归档、不同版本与分页、未知写入、角色边界和图片去重；模型请求次数与Token的实际收益须由发布后的真实会话确认，无新增DDL或运行配置。
