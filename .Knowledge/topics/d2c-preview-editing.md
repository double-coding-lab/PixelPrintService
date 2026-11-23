---
id: d2c-preview-editing
revision: 18
summary: "本地Vite预览、缓存、截图、元素审查和在线编辑"
primary: module
confidence: inferred
sourceDoc: .Knowledge/stock-docs/d2c-preview-editing.md
---
# 预览、截图与在线编辑

说明社区版如何在本机编译工作文件、提供预览、截图并显式应用编辑副本。

## 适用场景

预览、在线编辑、Monaco、实时编译、预览缓存、元素审查、截图、px2vw、RN Web、全文搜索、waiting_files。

## 执行环境与配置

- [engine.ts](../../src/functions/d2c/preview/engine.ts) 固定为 `local`；[runner.ts](../../src/functions/d2c/preview/runner.ts) 通过当前 `process.execPath` 启动固定 `preview-template/container/build.mjs`。`container/` 是脚本路径，预览运行不依赖 Docker daemon 或远程 Sandbox 服务。
- 部署准备使用 Node 24 和 `npm run prepare:preview`，提前安装模板、Playwright 依赖和匹配的 Chromium；请求期间只使用已安装依赖。截图由本地 `preview-browser/capture.mjs` 完成，须具备浏览器系统库、字体以及可写的临时目录和缓存目录。
- 服务配置由 [project.ts](../../src/config/project.ts) 在启动时读取项目 `project.config.json`，可用 `PIXELPRINT_CONFIG` 指定路径，修改后重启。预览图片白名单来自 `storage.publicUrl`（缺省回落到 `server.publicUrl` 下的 `/files/`）；页面单位另取构建输入的生成配置快照，勿把两种配置混为一谈。

## 输入、构建与访问流程

1. 区分三类输入：当前会话使用已保存的稳定文件与配置修订；暂存版本使用冻结文件集合；在线编辑从会话创建 Redis 临时副本，未应用的编辑只更新副本。
2. 由 [service.ts](../../src/functions/d2c/preview/service.ts) 按输入摘要、入口和运行修订选择或构建预览；相同输入优先复用。重建使用固定输入快照，不读取最新会话文件替换原批次。
3. 冷构建在临时 `input/work/output` 目录内执行固定 Vite 模板，收集静态 HTML/CSS/JS。校验相对路径、数量、大小和入口，拒绝项目配置与包脚本；模板关闭 Vite/env/Babel 配置自动发现，模块与 Sass 访问范围受限，不临时安装缺失包。构建默认超时 120 秒，取消或退出回收进程组与临时目录。
4. 由 [runtime.ts](../../src/functions/d2c/preview/runtime.ts) 的 `/H5_Preview/:previewId/:ticket/*` 或 `/RN_Preview/:previewId/:ticket/*` 静态网关返回页面；Vite 使用相对资源前缀。会话资产读取本地缓存，公开版本资产按登记清单从对象存储读取并核对大小和摘要。
5. 私有会话票据默认有效 5 分钟，资源读取时复查绑定用户的访问权；版本链接使用可长期复用的公开 token。票据只授权对应预览资源，不授权源码或业务 API；公开链接应按持有链接即可访问的分享入口处理。

## 单位与视觉检查

- H5 的 CSS/SCSS 编译产物始终执行 px→vw，与源码 `outputUnit` 无关；基准取生成配置快照的 `unit.outputBase`，默认 750。已有 vw、字符串、URL 和依赖 CSS 不重复转换，React 内联 style 与 JavaScript 数值不由 PostCSS 改写。
- RN 使用 React Native Web、StyleSheet、rpx 与静态图片兼容，不套用 H5 的 px→vw 插件。RN Web 效果须另做原生设备验收。
- [inspection.ts](../../src/functions/d2c/preview/inspection.ts) 为 `inspect_preview` 提供真实截图与诊断，并通过接线保存聊天附件。结合图片、运行错误、缺图与截断标记判断效果；`capture_unavailable` 只能说明编译完成而截图不可用，不能宣称视觉验收通过，也不应为浏览器环境问题修改页面源码。

## 缓存、等待文件与在线编辑

- 通用会话缓存位于 `.runtime/previews`，默认按最后使用时间约 30 天及 2 GiB 容量清理。命中需通过批次完整性校验；本机缓存缺失需按快照重建，多实例需考虑请求与缓存所在机器。
- 版本公开 token 的长期复用与本地缓存期限分开判断：公开版本网关读取对象存储中的登记产物，不能笼统描述为所有预览均依赖本机缓存。
- 编辑状态 TTL 为 2 小时，编辑预览使用独立 `.runtime/edit-previews` 缓存；[warmRunner.ts](../../src/functions/d2c/preview/warmRunner.ts) 按 editId 复用本地增量编译上下文，默认最多两个上下文、空闲两分钟回收。
- 仅当前会话存在排队或执行中的 run，且 `MODULE_NOT_FOUND` 符合 [missingPreviewFile](../../src/functions/d2c/preview/session.ts) 的同目录待保存文件判定时，展示 `waiting_files`；界面保留最近成功预览。run 结束恢复真实错误；依赖缺失、语法错误、越界请求和版本预览不以此状态掩盖。
- Monaco 提供目录、源码编辑、全文搜索和源码定位。显式应用时，[edit/service.ts](../../src/functions/d2c/edit/service.ts) 校验副本归属、修订与锁，再交由文件服务检查基线冲突和活动执行并事务写回；成功后通知会话文件更新，失败保留副本。
- 元素审查由网关注入受控脚本，通过随机通道传递选择器、尺寸和样式；[PreviewInspector.tsx](../../web/src/workspace/PreviewInspector.tsx) 核对当前 iframe 窗口、opaque origin、通道和有界消息负载，供源码定位与反馈修改。

## 安全与职责边界

- 浏览器 iframe 保留 `sandbox="allow-scripts"`，网关 CSP 保留 opaque origin，并禁止 connect、frame、worker、object 和表单提交；路径、登记资产与 MIME 校验持续生效。不要加入 `allow-same-origin` 或向页面注入登录凭据、模型与存储密钥。
- 构建进程接收环境白名单，不直接继承业务密钥、代理或 `NODE_OPTIONS`；这不构成宿主文件系统访问隔离。子进程与服务共享账号和机器资源，Node 的 512 MiB 堆上限也不是整个进程树的内存或 CPU 硬配额。
- 截图使用独立无登录态浏览器上下文和临时 loopback 静态服务。主进程只预取配置白名单路径下的字面量图片 URL，不跟随重定向或携带 Cookie/凭据；浏览器只访问本批静态文件及预取图片，其他请求阻断。[capture.mjs](../../preview-browser/capture.mjs) 设置 `chromiumSandbox:false`，页面 CSP 与 iframe sandbox 保留，勿将其描述为 Chromium 操作系统沙箱隔离。
- 本主题覆盖预览、截图和编辑链路；账号登录、会话权限、存储配置的完整规则由对应模块维护。编译成功或取得截图均不等同视觉还原通过。

## 详细资料

[本地预览、截图与在线编辑](../stock-docs/d2c-preview-editing.md)

## 临时预览失败诊断

- 工作区、广场和个人作品临时编辑器的失败按snapshot、input、build、output、cache、publish分类，页面显示固定说明和排查编号；编译错误同时提供经过白名单校验的文件定位。图片读取或校验失败、编译失败和缓存保存失败分别提示。
- 通用服务日志关联errorId、editId、来源ID、修订及输入相对文件路径，只保留固定网络码、storageStage、状态码和结构化编译诊断；原始异常、堆栈、源码、存储凭据及外部响应正文保持私有。
- 日志回调失败不影响构建结算；主动取消、关闭和任务替换保持作业与修订边界。历史仅有通用错误的记录无法补回原因，重新保存产生新作业后获取诊断；不会自动重放构建或覆盖草稿。

## 全屏手机比例预览

- 当前会话运行预览、在线编辑副本（含广场/作品复用）、已保存版本及设计稿截图共用PhonePreview。视口尺寸与显示缩放分别选择，默认390×844、100%，提供常见手机尺寸及“适合窗口”响应式视口；模拟CSS视口，不修改UA、DPR或系统安全区。
- 固定视口在100%下按CSS像素原尺寸显示，超出预览区域可滚动；25%至200%仅缩放展示，iframe保持选定宽高。缩放选择“自动适应”时按可用区域等比缩小并显示实际百分比；视口选择“适合窗口”时按可用区域和当前缩放计算响应式宽高，随窗口变化更新。进入、退出及尺寸/缩放切换复用同一iframe，不重签票据、不发起编译、不修改源码或预览缓存。
- 优先使用用户点击触发的浏览器Fullscreen API；不支持或拒绝时使用页面内全屏。退出按钮、Esc、浏览器退出全屏、预览隐藏/失效和卸载均清理状态，恢复焦点、页面滚动及背景inert状态；原sandbox allow-scripts和无same-origin边界保持。
- 实现位于web/src/workspace/PhonePreview.tsx、phoneViewport.ts与phonePreview.css；真实浏览器回归覆盖真实iframe尺寸、100%原尺寸、百分比缩放、适合窗口、原生和降级全屏、交互状态保留与只加载一次，参见test/phonePreviewBrowser.test.ts。

## 大字段读取与自动编译反馈

- 会话和版本预览列表、当前预览及构建输入涉及大字段时先按标识排序分页，再读取正文；保留输入修订与权限过滤。数据库排序缓冲不足的诊断见[工作区主题](d2c-workspace-foundation.md#大字段排序与数据库诊断)。
- 源码变化后，主Agent下一次模型请求可只读查询当前输入的自动预览状态。失败按previewId、有效修订及诊断去重，最多保留64个已反馈键；等待文件、排队和构建中保持原状态，无变化时跳过，不因反馈启动新构建。
- 本地Sass编译将未定义变量映射为STYLE_UNDEFINED_VARIABLE，提供工作区相对文件与行列；其他样式解析错误使用SYNTAX_ERROR，原始异常和源码保持私有。历史错误记录只展示当时已保存字段，新分类对新构建生效；编译成功与视觉通过分开判断。

## 预览加载与空状态

- 当前会话代码未就绪、等待文件或正在构建时使用紧凑提示；构建完成而首帧仍在加载时显示紧凑骨架屏。缺少入口与构建失败分别展示对应信息。无已就绪画面时，手机视口退出布局，预加载iframe保持挂载；已有画面在后续构建期间持续保留。会话、编辑副本与版本共用手机视口可用性控制。
- 页面入口切换在画面区域显示独立于缩放的半透明遮罩、旋转指示器及目标路径，覆盖入口请求、构建、票据和新iframe加载阶段；首帧加载完成后结束，等待文件或失败时恢复对应提示。遮罩期间旧画面保持显示但暂停交互，尺寸与入口工具栏仍可操作；在线编辑与冻结版本复用相同样式。
- 会话构建状态按当前选择入口隔离，切换后立即显示加载；已显示旧入口的成功状态与迟到的加载事件不能提前结束新入口的遮罩。
- 画面就绪后，当前会话页面入口与屏幕尺寸选择合并在同一工具条，横竖屏使用带说明的图标按钮；窄容器保持单行并允许工具条横向滚动。
## 原设计稿截图页签

- 会话文件区与冻结作品详情在运行预览、源码与资源旁提供设计稿截图页签，共用 `DesignReferencePanel`。
- 只选择文件摘要中 asset/attachment 类型且路径为 `design-reference/root-<nodeId_safe>.png` 的完整根基准图；不把运行截图或切图当原设计稿。
- 使用现有文件摘要中的图片 URL，共用 PhonePreview 的固定手机视口，默认390×844、100%，可选择视口尺寸、显示缩放及全屏；图片按视口宽度等比显示，长图在视口内滚动，保留点击放大原图、节点/修订信息及多根图选择。截图信息与操作分组展示，窄面板按组换行；缺图显示空状态，图片加载使用紧凑提示，加载失败可单独重新加载图片。
- 会话随现有文件刷新读取当前稳定图，作品版本只读冻结文件；页面不重新调用 Figma，也不自动补造旧会话缺失的设计基准图。
- 截图页签随会话文件列表自动更新，工具栏提供全屏入口；同一文件修订与地址保持原图显示，修订或地址变化后加载新图。图片加载失败时提供独立重试，冻结作品保留只读截图。

## 会话版本默认首页入口

- 进入作品库会话版本详情时，入口仅从该冻结版本的 TSX/JSX 源码选择，按目录语义优先首页：`pages/home|index|page|main/index`（支持 `src/` 前缀），其次平铺首页、根 App/index/main、其他页面及通用源码；`blocks`、`components`、测试目录内组件排后。同级按路径深度、数值自然路径顺序稳定选择。
- 截图场景默认选 `pages/page/index.tsx`，保留区块入口供手动切换。文件列表重排不覆盖仍有效的手动选择；已选文件移除时回退到首选页面；切换版本重新选择默认入口。目录规则无法推断任意业务首页时，用户仍可手动指定。
- 实现为 `previewEntry.ts`、`PreviewPanel.previewEntries`；回归见 `previewUi` 与 `libraryManagementBrowser`。此规则作用于作品库冻结版本，不修改编译器或会话执行流程。

## 生成期缺依赖等待

- 同会话、入口、运行修订、目标、配置及资源范围内，最近持久化的`MODULE_NOT_FOUND`可作为等待依据：入口到实际缺失点的导入链及依赖解析保持有效、缺口仍未补齐时，其他已有区块的正常脚本和样式正文修改可继续等待；新增导入、样式依赖声明改变、二进制或解析不确定时保守交回编译器。排队worker领取后也复核，避免前一构建刚失败而新快照已经入队的竞态；依据来自既有预览记录，服务重启后仍可读取。
- 依赖补齐后自动继续真实编译；旧文件改变、删除，新增二进制或路径大小写冲突时保守交回编译器。显式重试可绕过等待去重；缺包、非法路径、语法错误、较新的真实失败或成功不能被旧缺依赖记录覆盖。
- 仅有活动run时把真实缺文件状态投影为`waiting_files`；run结束仍显示实际失败。冻结版本及临时编辑构建不套用生成期等待，不用占位源码或伪造成功；原失败输入快照保持不变，不将新修订声称为已编译。
- 实现见`preview/session.ts`的`unchangedMissingPreviewFile`及`preview/service.ts`；`previewDependencyWaiting.test.ts`覆盖连续无关修订、依赖分阶段补齐、作用域隔离、队列竞态、显式重试和重启恢复。本次无需新增DDL或配置。

## 预览与下拉控件

- 冻结版本预览就绪后持续显示，保留刷新、元素审查、调试及全屏操作；取消单独的关闭/重开预览状态。刷新仍只重取票据，不重新构建。
- 主站原生单选select统一使用受信SVG箭头，右侧12px、尾部36px留白；RTL箭头换侧，高对比模式沿用系统控件。原生多选/列表框和Ant Design Select保持各自行为，生成预览iframe内控件沿原页面源码。
- 缺口等待只证明已知依赖仍不存在，样式其他问题可在依赖补齐后的真实编译暴露；请求端与队列worker均复核，重启沿用持久记录。修复阶段的截图批次与检查点边界见[执行复验](deep-agents-execution.md#生成期调度与修复复验)。

## 受控交互动作与截图覆盖

- inspect_preview除entryPath外接受actions和focusSelector；最多12个声明式click/swipe/scroll/expect操作。CSS选择器唯一定位，expect支持可见、文本、属性、scrollLeft范围及水平居中；触摸走真实浏览器输入，鼠标走按下/移动/松开，不开放任意脚本。结果逐步返回固定原因与有界观测。
- focusSelector滚动到目标并截取该位置视口，适合长页面下方交互；截图仍受12000px、10MiB及现有网络、进程和时限保护。coverage记录page/focused、实际文档坐标及范围，区分height_limit、byte_limit和nested_scroll，覆盖限制与真实运行异常分别判断；截图局部覆盖不能作为整页验收。
- 同previewId加归一动作/聚焦参数指纹缓存并构造附件身份：重复相同计划复用，不同操作或区域保留独立图片。聊天分别说明定点、内部滚动、高度或字节限制，历史缺覆盖信息仅说明局部截图，不推断为高度超限。
- 原有无动作截图像素与隔离边界保持；交互收敛见执行主题。真实本地Chromium测试覆盖点击、双向手势、循环边界、聚焦下方、断言失败及网络阻断；Docker仅验证既有协议，不表示真实容器浏览器联调。
