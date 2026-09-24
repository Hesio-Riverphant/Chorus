# Chorus

[English](README.en.md) · 简体中文

让多个 Agent 在同一个房间讨论、分工和协作。

Chorus 是本地桌面应用，连接已安装的 Agent CLI。把不同模型加入房间，用 `@成员` 指定发言，也可以让成员依次讨论或由主持人协调。聊天、设置和归档留在本机，模型调用沿用各 Agent 的账号与工具。

## 开始使用

需要 **Windows 11 x64 或 Ubuntu 24.04 x64**，以及至少一个已安装、已登录的 Agent CLI。安装包内置桌面运行环境，无需另装 Node.js。

1. 运行 `Chorus-0.5.1-windows-x64-setup.exe` 安装，或完整解压同版本 zip 后运行 `Chorus.exe`。
2. 打开 **设置 → Agent 接入**，扫描并启用 Agent；创建成员，获取模型列表并测试连接。
3. 新建房间，选择项目目录和成员，输入任务。调用过程中可以查看工具、文件变更、用量，也可以随时停止。

[下载安装包](https://github.com/Hesio-Riverphant/Chorus/releases/latest)。Windows 提供安装器和 zip，均为 x64，包未签名；Ubuntu 提供 `.deb` 和 zip。

卸载可使用开始菜单中的 **Uninstall Chorus**，或下载同版本卸载启动包、解压后运行 `Uninstall Chorus.cmd`；它会打开系统登记的卸载程序，聊天数据保留。便携版退出后删除解压目录即可。

Ubuntu 推荐安装 `.deb`，然后从应用菜单打开 Chorus：

```sh
sudo apt install ./Chorus-0.5.1-linux-amd64.deb
# 卸载，保留聊天数据
sudo apt remove chorus
```

Ubuntu zip 需完整解压；首次在解压目录执行以下命令设置 Chromium 沙箱，然后启动。不要以 root 运行应用。

```sh
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
./chorus
```

两端均通过自动界面与包启动检查；Ubuntu 24.04 CI 还验证了安装/卸载。个人桌面环境和各 Agent 账号需分别验证。

## 怎么协作

Chat 用于日常会话；Plan 和 Goal 交给支持这些模式的原生 Agent 执行。房间还可以选择发言方式：

| 模式 | 行为 |
| --- | --- |
| 并行 | 多个成员同时处理当前输入，适合比较方案 |
| 顺序 | 成员依次发言，后续成员可读到前面的回复 |
| 主持人 | 主持人协调下一位成员，适合多轮讨论 |
| 侧聊 | 从主房间分出独立讨论，继承创建时的成员配置 |

`选择项目 → 加入成员 → 发出任务 → 查看过程与结论`

用 `/` 查看当前可用命令；`/model` 调整成员模型，`/context` 查看原生用量。Ctrl+K 搜索消息和归档。成员互相 @ 的轮数和并行数有上限，可在接力控制中调整。

## 是否适合

适合已经使用编程 Agent，希望在同一窗口比较回答、分工、审查代码，并保留本地会话的人。Chorus 负责房间与消息流，模型、工具权限和原生技能仍由各 CLI 提供。

模型列表代表原生配置或服务返回的型号，是否可调用以账号权限和实际连接结果为准。工具可能读写项目文件或执行命令，使用前选择合适的权限；Kimi 当前无交互工具执行要求明确选择全权限。

## 数据与设置

- Windows 数据目录：`%APPDATA%/agent-room`。退出应用后备份整个目录；升级沿用现有聊天，卸载保留数据。
- Linux 数据目录：`${XDG_CONFIG_HOME:-~/.config}/agent-room`。
- 普通房间共用成员资料；侧聊在创建后独立编辑。成员工作目录优先于房间目录，未设置时使用房间目录，再使用默认目录。
- MCP/插件按 Agent 默认和房间成员覆盖管理；技能登记引用原文件。
- 费用可按 Agent/模型设置缓存命中输入、未命中输入、输出三类单价，支持高峰和空闲时段。缺少原生用量时显示未知。

Chorus 不需要云端账号或自建服务，不内置遥测。云模型仍会接收本次请求，原生 Agent 和工具按各自配置联网。

## 从源码运行

需要 Node.js 24 LTS；原生终端依赖可能需要 Python 和 C++ 构建工具。

```sh
npm ci
npm start
```

```sh
npm test
npm run test:ui
npm run check:release
npm run package:win
```

[Agent 接入与限制](docs/CLI.md) · [构建与验收](docs/RELEASE.md) · [架构](docs/ARCHITECTURE.md) · [计划](docs/PLAN.md) · [第三方许可](THIRD_PARTY.md)

源码采用 [MIT](LICENSE) 许可。
