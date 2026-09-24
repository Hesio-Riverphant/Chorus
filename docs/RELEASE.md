# Chorus release workflow / 发布流程

## 0.5.1 验收范围

Windows 11 x64 是本轮实际验收平台。Ubuntu 24.04 x64 提供相同源码的构建入口与 CI；本轮未运行 Linux，尚未完成双端等价验收。源文件、界面测试、真实模型调用和发行包启动分别记录。未签名的安装器可能触发系统信誉提示。

## 构建

在对应平台的 Node.js 24 开发环境执行：

```sh
npm ci
npm test
npm run test:ui
npm run test:rooms
npm run test:capabilities
npm run test:workbench
npm run test:i18n
npm run check:release
npm run package:release
```

- `npm run package:win`：Windows x64 安装器、便携 zip 与独立卸载启动包。卸载启动包只调用当前用户登记的 Chorus 卸载程序，保留聊天数据。
- `npm run package:linux -- --homepage <真实项目网址>`：Linux x64 deb 与 zip，需要 Linux 本机构建环境。公开仓库后也可在 package.json 设置 homepage；CI 使用当前仓库地址。
- `npm run package:desktop`：生成可逐文件核验的便携运行目录。
- `node scripts/package-desktop.js --source --strict`：生成公开源码候选目录。

Linux 无显示环境需使用 Xvfb 执行 Electron 检查；原生 node-pty 构建需要 Python、make 和 C++ 工具链。以仓库 CI 的平台依赖与命令为准。Windows 与 Linux 产物不能互换。

## 产物与数据

安装器和 zip 均从经过发布检查的应用目录生成，保留 Electron、Chromium、终端组件许可。`LICENSES.chromium.html` 是 Chromium 第三方许可。

Windows 使用 `Chorus.exe`；zip 必须完整解压。成功构建后 `dist/CURRENT-RELEASE.json` 指向最新完整候选，失败候选不会更新此入口。用户数据路径保持 Windows `%APPDATA%/agent-room`、Linux `${XDG_CONFIG_HOME:-~/.config}/agent-room`。安装和升级不迁移聊天数据；退出应用后备份整个数据目录。卸载程序保留聊天数据。

源码发行范围是 `src/`、`scripts/`、锁定包清单、Git 忽略规则、许可、README、CI，以及公开架构/计划/参考/发布文档。运行数据、原生配置、凭据、日志和开发交接不进入发行文件。

## 验证

```sh
node scripts/check-release.js
node scripts/check-release.js --bundle "dist/<portable-directory>"
node scripts/package-desktop.js --smoke-existing "dist/<portable-directory>"
```

发布检查验证锁文件、运行依赖、源码语法、文档链接、个人路径和高置信度凭据特征。疑似凭据只报告文件与行号。便携产物的 `RELEASE-MANIFEST.json` 记录文件 SHA-256；新增、缺失和被改动文件都会失败。

包内隔离 smoke 启动真实 Electron、renderer、preload、IPC、xterm 和原生 PTY，在带随机标记的临时数据目录运行合成终端命令后退出。真实用户聊天库保持原位。检查成功说明这一入口通过，真实 CLI、MCP、账号、模型权限和长期运行需要单独证据。

GitHub Actions 配置运行平台矩阵与构建。本地准备流程不会自动发布仓库或 Release；远端执行结果以实际 Actions 记录为准。公开仓库前检查完整 Git 历史与待提交文件，不能仅依赖源码包的白名单检查。

## English

Build on the target x64 platform with Node.js 24 and locked dependencies. Run the unit, Electron UI, room, capability, workbench, language and release checks above, then `npm run package:release`. Explicit commands are `package:win` for the Windows installer/zip and `package:linux -- --homepage <actual-project-url>` for deb/zip. Linux CI uses Xvfb and the native module build toolchain.

Windows 11 is the actual validation platform for this revision. Ubuntu 24.04 build configuration is prepared; Linux execution and feature parity remain unverified. Do not treat workflow configuration as a passed remote build.

Packages preserve the existing `agent-room` user-data directory and bundled third-party licenses. Exit the application before backing up all data. Installer removal retains user data. Builds are unsigned.

Curated source and application inputs exclude runtime data, credentials, native Agent configurations and development handoffs. Source audits, file hashes and isolated packaged startup verify different boundaries. The packaged smoke test starts the real renderer/IPC/terminal using temporary synthetic data; it does not validate every Agent or model. Publishing requires a separate review of Git-visible files and repository history.
