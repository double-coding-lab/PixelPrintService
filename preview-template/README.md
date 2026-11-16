# 页面预览模板与本地 Vite 构建

本目录是独立的 React + TypeScript + SCSS 工程。模板版本为 `h5-react-scss-v3`，默认展示模板自检页。

## 本地运行

在项目根目录使用 Node 24 执行：

```sh
npm --prefix preview-template ci
npm --prefix preview-template run dev
```

访问 <http://127.0.0.1:4180/>。修改页面文件后自动更新；端口占用时直接报错。

```sh
npm --prefix preview-template run typecheck
npm --prefix preview-template test
npm --prefix preview-template run build
npm --prefix preview-template run serve
```

`build` 输出到 `preview-template/dist/`，`serve` 在同一端口查看构建结果；先停止开发服务再运行。构建错误直接显示在终端，开发错误由 Vite 页面浮层展示。

## 放入生成的页面

1. 将 React 页面及关联组件/样式放进 `pages/`，保留产物的相对目录关系，替换示例 `pages/page/`。
2. 在 `preview.config.ts` 中填写入口，例如 `pages/shouye/index.tsx`；入口使用默认导出的 React 组件，自行 import 样式，不需要修改 `src/main.tsx`。
3. 图片优先使用平台产物中的实际 CDN 地址。若产物引用 `/static/...`，将对应文件放到 `public/static/`；部署到子目录时，需使用正确的资源前缀，Vite 的 `base` 不会重写运行时字符串里的绝对地址。
4. 执行类型检查和构建。模板的 `@/` 指向本目录；其他框架别名或页面依赖须显式适配，模板预装 React、SCSS 与 React Native Web；`react-native` 已映射到 `react-native-web`。

`src/main.tsx` 直接渲染页面，没有工作台样式、固定手机宽度或缩放。可以用浏览器设备模式检查 375px / 750px 视口，实际尺寸和单位由生成页面决定。

本地调试的 `preview.config.ts` 中可设置 `target` 与 `unit`，默认 H5、vw、750；实际平台构建使用暂存版本的outputBase作为换算基准。H5预览始终将CSS/SCSS编译产物中的px转换为vw，不论生成源码的outputUnit是px还是vw；已有vw、字符串、URL和依赖CSS不重复转换。默认750基准下750px转换为100vw。RN保持StyleSheet/rpx缩放，不套H5的CSS插件。PostCSS不改写React内联style或JS数值。修改插件或模板后需重新部署模板及固定依赖；H5运行环境修订已更新为v3，旧预览保留原结果，新请求使用新修订构建。

## 服务端部署（Node 24）

开源版固定使用 local 预览。根目录执行 `npm run prepare:preview`，从公开 npm 仓库安装模板和截图依赖，并从 Playwright 官方 CDN 下载版本匹配的 Chromium；可通过 HTTP_PROXY/HTTPS_PROXY 配置下载代理。

部署容器建议使用官方 `node:24-bookworm` 基础镜像，在构建阶段完成准备，并将 `preview-template/`、`preview-browser/` 及各自的依赖和 `.browsers/` 随应用发布。运行时无需 Docker daemon、远程执行平台密钥或依赖下载。

服务通过 `process.execPath` 启动固定 `container/build.mjs`，以 `PIXELPRINT_PREVIEW_ROOT` 指向本轮临时目录；脚本在 `input/` 读取输入、在 `work/` 编译、向 `output/` 写静态产物。该变量由服务内部传入，无需用户配置。`container/` 目录保留为原脚本路径，脚本直接在本机 Node 运行。

- 固定 Vite 配置使用 `configFile:false`、`envFile:false`，内联 PostCSS，并禁用 Babel 配置发现；不执行用户包管理脚本、配置或任意依赖安装。
- 输入路径、文件数量与大小、模块和 Sass 访问范围继续校验；H5 保留 px→vw，RN 保留 Web、rpx 和静态图片兼容。
- 子进程只接收工具需要的环境白名单，不继承模型、数据库及上传密钥或 `NODE_OPTIONS`。默认 Node 堆上限 512 MiB；这不是整个进程树的内存或 CPU 硬配额。
- 构建默认 120 秒；取消、超时和正常退出终止进程组，随后回收临时目录。在线编辑按 editId 复用常驻进程与 Rollup 缓存，默认两个上下文、空闲两分钟回收。
- 本地进程与主服务共享机器资源和服务账号权限；采用受控模板降低风险，不能声称具备容器级隔离。生成页面仍由浏览器 iframe sandbox 与 CSP 隔离运行。

截图浏览器的系统依赖和安装说明见 [截图运行环境](../preview-browser/README.md)。生产镜像需要构建时能下载固定依赖及浏览器，并具有可写临时目录和缓存目录。

## 静态图片与匿名预览前缀

保留全部源码相对目录关系。`static/图片.png` 自动镜像到 `public/static/图片.png`；只有 `public/static/图片.png` 时，也镜像回工作区 `static/图片.png` 供相对 import 加载。其他二进制资源同样按其原路径镜像到 public。不要同时提供同一路径的不同图片内容。

固定入口用 TypeScript AST 将 JS/TS/JSX/TSX 中以 `/static/` 开始的字符串、JSX 属性、模板字符串头改为 `./static/`，CDN URL 不变。Vite 以 `base:'./'` 输出相对模块和 CSS 资源；`assetsInlineLimit:0` 保留独立图片资产。因此入口位于 `/H5_Preview/<id>/<token>/index.html` 或 RN 对应目录时，模块、图片、CSS 均留在相同 token 前缀，不会请求站点根 `/static/`。复杂表达式如 `'/' + variable` 无法静态改写，生成器应直接输出相对地址或真实 CDN URL。

HTML、模块和 CSS 需由网关按 runner MIME 返回；opaque iframe 的匿名模块请求需 `Access-Control-Allow-Origin: *`。用户鉴权、短票据、版本/存储、独立来源、CSP 与 iframe sandbox 由接入方完成。RN Web 使用运行时样式，网关的 style 策略须兼容；模板本地 dev 服务不构成执行沙箱。

## 定向验证

```sh
npm --prefix preview-template test
npx --no-install tsx --test test/publicPreview.test.ts
```

验证 H5/RN Web、SCSS、图片、单位、增量缓存、取消和文件清理。生成页面 JavaScript 的运行效果另由本地 Chromium 验证。

## RN兼容与错误定位

RN运行修订为`rn-web-v3`。缺少`@/utils/rpx`时使用屏宽/375的可信兼容helper，版本内真实helper优先；静态图片`require`在构建时转为ESM URL与RN Web的`{uri}`。`@Images`精确路径优先，仅在缺失时使用输入图片的唯一后缀/文件名匹配，歧义/缺失报错。动态或非图片require不通过预览构建，不安装缺失包或执行任意模块。H5不启用RN兼容插件。

页面可显示固定错误分类、相对文件/模块和行列，编译进程及服务不返回原始源码、堆栈或主机路径。改模板后重新部署应用；依赖变化时执行 `npm run prepare:preview`，再重新生成预览；原版本文件保持不变。
