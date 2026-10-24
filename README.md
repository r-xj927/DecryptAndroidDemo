# DecryptLog · 网页版

DecryptLog（本地文件解密工具）的 Flutter Web 在线版，同时提供 Windows / macOS 桌面客户端下载。

- 在线使用：<https://r-xj927.github.io/DecryptAndroidDemo/>
- Windows 客户端：[downloads/DecryptLog.exe](downloads/DecryptLog.exe)（安装包，约 10.8 MB）
- macOS 客户端：[downloads/DecryptLog.dmg](downloads/DecryptLog.dmg)（约 23.9 MB）

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

构建后产物约 74 MB，其中 canvaskit 目录有约 23.8 MB 是本构建永不加载的变体  
（skwasm / skwasm_heavy / wimp / webparagraph / *.symbols），部署脚本会自动剪枝，  
剪枝后约 49.7 MB。

## 部署

本地 `build/web/` 就绪后，运行项目脚本 `scripts/deploy-github-web.cmd`（双击即用）：  
自动 clone 本仓库 → 剪枝 canvaskit → 全量替换根目录 → 恢复本 README → 提交推送 master。  
GitHub Pages 约 1 分钟内生效。

## 技术栈

- Flutter 3.47.8 / Dart 3.13.7，当前版本 v2.0.0
- 渲染器 CanvasKit（Skia 编译为 WebAssembly，自托管，全浏览器兼容）
- 桌面客户端：Windows 用 Inno Setup 打包，macOS 发 DMG
