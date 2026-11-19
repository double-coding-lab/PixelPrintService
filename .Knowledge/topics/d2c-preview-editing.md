---
id: d2c-preview-editing
revision: 3
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
