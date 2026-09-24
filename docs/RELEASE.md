# Chorus release workflow / 发布流程

## 0.6.1 变更

Codex、Claude Code 和 Kimi 的真实提问工具完成问答往返验证；问题等待一分钟后保留待答，之后可显式续接。点名消息限定接收成员，错误与部分输出进入续接上下文，派发停止显示具体原因。修正房间主持角色、头像背景和模型选项文字。Windows 卸载入口随安装器和 ZIP 提供，按已验证清单删除；未知内容会中止并要求检查，升级保留数据。其他 CLI 的交互支持、个人硬件和长期负载仍需分别验证。

关闭终端与应用退出会等待原生终端的退出事件；超时保留失败状态，避免发出终止请求后立即退出。Windows 卸载哈希校验直接使用 .NET，不依赖 PowerShell 模块自动发现。

## 0.6.0 变更

原生 Codex/Claude 授权与提问卡片、超时问题显式续接、仅阻止新派发的用量软预算、进程终止/Unicode 流边界修复、房间主持角色同步和 CLI 头像。Windows 包内附卸载启动器；独立卸载 zip 继续提供。`npm run test:stress` 覆盖真实受控进程的跨房间停止、失败重试和终止竞态，双端 CI 执行。各 Agent 真实账号授权、长期负载与 Windows 10 实机验收仍需单独验证。

Windows 支持范围以当前 Electron 和终端运行要求为准：Windows 10 1809+ / 11、Intel/AMD x86-64；本项目仅发布 x64，未提供 32 位和 ARM64 原生包。

## 0.5.1 验收范围

Windows 11 x64 完成本地验收，Windows runner 与 Ubuntu 24.04 x64 完成相同源码的自动界面和包启动验收。Ubuntu 还验证 ZIP 沙箱设置、DEB 安装、普通用户启动和卸载。个人桌面硬件、各 Agent 账号及长期使用分别验证；CI 不代表这些场景全部通过。未签名的 Windows 安装器可能触发系统信誉提示。

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

- `npm run package:win`：Windows x64 安装器与便携 zip，二者均附带针对自身目录的卸载入口。完整卸载会展示当前应用和共享数据的删除范围，确认后按清单删除；未知文件、链接和项目目录重叠会中止。
- `npm run package:linux -- --homepage <真实项目网址>`：Linux x64 deb 与 zip，需要 Linux 本机构建环境。公开仓库后也可在 package.json 设置 homepage；CI 使用当前仓库地址。
- `npm run package:desktop`：生成可逐文件核验的便携运行目录。
- `node scripts/package-desktop.js --source --strict`：生成公开源码候选目录。

Linux 无显示环境需使用 Xvfb 执行 Electron 检查；原生 node-pty 构建需要 Python、make 和 C++ 工具链。以仓库 CI 的平台依赖与命令为准。Windows 与 Linux 产物不能互换。

Ubuntu 24.04 CI 为当前构建目录设置限定路径的 AppArmor userns 授权，保持 Chromium sandbox。ZIP 验收撤销该授权后按 README 设置 root 所有的 `chrome-sandbox`（4755）；DEB 安装自带 `/opt/Chorus/chorus` 的 AppArmor profile。应用目录权限为 0755，用户无需用 root 启动应用。ZIP 便携指无需安装应用，沙箱仍有首次配置要求。

## 产物与数据

安装器和 zip 均从经过发布检查的应用目录生成，保留 Electron、Chromium、终端组件许可。`LICENSES.chromium.html` 是 Chromium 第三方许可。

Windows 使用 `Chorus.exe`；zip 必须完整解压。成功构建后 `dist/CURRENT-RELEASE.json` 指向最新完整候选，失败候选不会更新此入口。用户数据路径保持 Windows `%APPDATA%/agent-room`、Linux `${XDG_CONFIG_HOME:-~/.config}/agent-room`。安装和升级不迁移聊天数据；退出应用后备份整个数据目录。Windows 完整卸载确认后删除共享聊天数据；升级保留数据。Linux 系统包卸载保留用户数据。

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

Windows 11 has local validation; Windows and Ubuntu 24.04 runners execute the same UI and packaged-startup checks. Ubuntu additionally verifies ZIP sandbox setup, Debian installation, normal-user startup and removal. The ZIP needs the sandbox setup documented in README; the Debian package installs a path-scoped AppArmor profile. Individual desktop hardware, accounts and long-running use remain separate acceptance tasks. See actual Actions results for each revision.

Packages preserve the existing `agent-room` user-data directory and bundled third-party licenses. Exit the application before backing up all data. Windows complete uninstall removes validated shared data after explicit confirmation; upgrades preserve it. Linux package removal retains user data. Builds are unsigned.

Curated source and application inputs exclude runtime data, credentials, native Agent configurations and development handoffs. Source audits, file hashes and isolated packaged startup verify different boundaries. The packaged smoke test starts the real renderer/IPC/terminal using temporary synthetic data; it does not validate every Agent or model. Publishing requires a separate review of Git-visible files and repository history.
