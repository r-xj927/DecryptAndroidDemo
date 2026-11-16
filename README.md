# DecryptLog · 网页版

DecryptLog（本地文件解密工具）的 Flutter Web 在线版，同时提供 Windows / macOS 桌面客户端下载。

- 在线使用：<https://r-xj927.github.io/DecryptAndroidDemo/>
- Windows 客户端：[downloads/DecryptLog.exe](downloads/DecryptLog.exe)（安装包，约 11 MB）
- macOS 客户端：[downloads/DecryptLog.dmg](downloads/DecryptLog.dmg)（约 24.4 MB）

## 这个仓库是什么

本仓库不是源码仓库，而是 GitHub Pages 站点的**部署产物**仓库：

| 路径           | 内容                                                                     |
| ------------ | ---------------------------------------------------------------------- |
| 根目录          | `flutter build web` 发布产物（index.html、main.dart.js、canvaskit/、assets/ 等） |
| `downloads/` | 桌面客户端安装包，网页内「下载桌面客户端」按钮直接引用                                            |

源码另存于项目仓库，不随本仓库公开。

## 本地构建（维护者）

需要 Flutter 3.47+，在 **PowerShell** 中执行：

```powershell
flutter build web --release --base-href=/DecryptAndroidDemo/ --no-web-resources-cdn
```

三个要点都不能少：

- `--base-href=/DecryptAndroidDemo/`：Pages 项目站点挂在 `/DecryptAndroidDemo/` 子路径下
- `--no-web-resources-cdn`：canvaskit 自托管。默认构建会从 gstatic CDN 加载 canvaskit，  
  该 CDN 国内基本不可达，不自托管的话国内用户大概率白屏
- 必须用 PowerShell：Git Bash 的 MSYS 路径转换会把 `/DecryptAndroidDemo/` 参数改坏  
  （非要用 Git Bash 的话得加 `MSYS_NO_PATHCONV=1`）

构建后产物约 75 MB，其中 canvaskit 目录有约 24 MB 是本构建永不加载的变体  
（skwasm / skwasm_heavy / wimp / webparagraph / *.symbols），部署脚本会自动剪枝，  
剪枝后约 51 MB。

## 部署

本地 `build/web/` 就绪后，运行项目脚本 `scripts/deploy-github-web.cmd`（双击即用）：  
自动 clone 本仓库 → 剪枝 canvaskit → 全量替换根目录 → 恢复本 README → 提交推送 master。  
GitHub Pages 约 1 分钟内生效。

## 技术栈

- Flutter 3.50.0 / Dart 3.14.0，当前版本 v3.3.0
- 渲染器 CanvasKit（Skia 编译为 WebAssembly，自托管，全浏览器兼容）
- 桌面客户端：Windows 用 Inno Setup 打包，macOS 发 DMG

## 离线可用（Service Worker）

站点用自定义 `web/flutter_bootstrap.js` 把 Flutter loader 指向 `web/sw.js`。
首次在线访问时会预缓存引擎、两套 CanvasKit、解密 Worker 及其依赖（未压缩约 16MB），
之后断网也能打开页面并解密日志——私钥本就编译在 `main.dart.js` 里，解密不发任何网络请求。

- 缓存版本取自构建注入的 `serviceWorkerVersion`，每次 build 自动失效旧缓存
- 刻意不缓存 `downloads/`（34MB 安装包）与 `assets/NOTICES`
- 占位符 `{{flutter_service_worker_version}}` 替换结果是「带引号的字符串 + 注释」，
  只能当表达式用，不能嵌进字符串字面量
- `localhost` / `127.0.0.1` 的 debug dev server 不注册 SW（DDC 模块不在清单里，
  拦截会干扰热重载）；生产域名才启用
- **解密结果不做持久化**：会话元数据在 localStorage，正文只在内存中，
  刷新后需重新解密。日志动辄几百 MB，base64/JSON 副本与刷新时全量读回会拖垮页面
- 部署脚本全量替换产物时会自动带上 `sw.js` 与自定义 bootstrap，无需额外配置
