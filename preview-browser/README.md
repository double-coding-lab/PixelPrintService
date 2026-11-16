# 本地 Chromium 截图与审查

开源版只运行本地 Playwright Chromium。主服务通过当前 Node 的绝对路径启动 `capture.mjs`，经 stdin 传入构建资产及有界图片清单，stdout 返回 PNG 和固定诊断。运行时不安装依赖、不下载浏览器、不需要 Docker daemon 或远程执行平台密钥。

## 准备环境

在 Node 24 下执行：

```sh
npm run prepare:preview
# 仅准备截图环境
npm run build:preview-browser
```

npm 使用 https://registry.npmjs.org/。Chromium 从 Playwright 官方 CDN 下载；需要代理时显式设置 `HTTP_PROXY` 或 `HTTPS_PROXY`，亦支持相应小写变量。脚本不提供默认代理或自定义下载站。

Linux 部署以官方 `node:24-bookworm` 为底座，使用 Playwright `install --with-deps chromium` 安装浏览器和系统库，并安装 procps、fontconfig、fonts-noto-cjk。准备阶段需要 root 或非交互 sudo，运行阶段无需特权。macOS 直接安装浏览器。`build.sh` 检查 Linux 动态库并实际启动浏览器、验证中文字形和截图，检查失败会返回非零。

发布时保留本目录的 `node_modules/` 与 `.browsers/`；浏览器路径固定在本目录，不依赖运行账号 HOME。部署容器构建时完成准备，运行时不调用容器执行器。

## 资源和浏览器边界

截图页面使用独立无 Cookie 的浏览器上下文和临时 loopback 静态服务器。HTML 继续采用 CSP `sandbox allow-scripts`，保持 opaque origin；模块仅从本次 dist 加载。connect、frame、worker、object、表单提交保持禁止。

截图主机仅从 `projectConfig.storage.publicUrl` 配置的存储路径（缺省由 `server.publicUrl` 解析 `/files/`）预取字面量图片 URL；不跟随重定向、不传 Cookie 或凭据。最多 2000 个资源、每张 10 MiB、总计 64 MiB，四路并发且有截止时间。浏览器只接收已经预取的图片数据，其他网络请求被阻断；缺图和网络失败会显式返回诊断。相对图片直接来自构建资产，不需要外部 CDN。

Chromium 使用 `chromiumSandbox:false` 以兼容部署容器；页面 CSP 和 iframe sandbox 继续保留。服务和浏览器进程共享宿主资源，部署方可用容器或 systemd 为整个进程树设置资源限额。截图入口只传递 PATH、临时目录、LANG 与固定浏览器路径，不传递业务密钥、NODE_OPTIONS 或代理。取消、超时及退出会回收浏览器后代进程。

截图视口固定为指定宽度和 900px 高，滚动触发懒加载后以 CDP 截取长图，最长 12000px、PNG 最大 10 MiB；超限裁切并返回 truncated。运行错误、缺图、嵌套滚动裁切各自报告，截图成功不等于视觉还原验收通过。
