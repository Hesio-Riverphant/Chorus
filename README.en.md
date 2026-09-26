# Chorus

English · [简体中文](README.md)

Bring multiple agents into one room to discuss, divide work and collaborate.

Chorus is a local desktop app that connects installed Agent CLIs. Add different models to a room, mention a member, run a discussion in order or let a moderator coordinate it. Chats, settings and archives stay on your computer. Each agent uses its existing account and tools.

## Get started

Requires **Windows 10 (1809+)/11 x64 or Ubuntu 24.04 x64** and at least one installed, authenticated Agent CLI. The x64 package runs on Intel/AMD x86-64 processors. Windows 11 is tested; Windows 10 has not had a hardware acceptance run. Desktop packages include the runtime; Node.js is not required.

1. Run the current `Chorus-<version>-windows-x64-setup.exe` from the Release page, or extract the complete matching zip and run `Chorus.exe`.
2. Open **Settings → Agent connections**, scan and enable an agent, then create a member, fetch its model list and test the connection.
3. Create a room, choose its project directory and members, and send a task. Inspect tools, file changes and usage as it runs, or stop it at any time.

[Download the latest release](https://github.com/Hesio-Riverphant/Chorus/releases/latest). Windows offers an installer and a zip, both x64 and unsigned. Ubuntu offers a `.deb` and a zip.

Both Windows editions include `Uninstall Chorus.cmd`. Close all Chorus copies, run it, and confirm the exact scope: this app directory and the chats, settings and caches shared by all Chorus copies. Upgrades retain data. Unknown files, links or overlapping project paths stop removal for inspection. External projects and native Agent configuration are preserved.

On Ubuntu, install the recommended `.deb`, then open Chorus from the application menu:

```sh
sudo apt install ./Chorus-0.6.3-linux-amd64.deb
# Uninstall while retaining chat data
sudo apt remove chorus
```

For the Ubuntu zip, extract the complete archive and run these commands from its directory once to configure the Chromium sandbox, then launch. Run the app as a normal user.

```sh
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
./chorus
```

Both platforms pass automated UI and packaged-startup checks. Ubuntu 24.04 CI also verifies installation and removal. Individual desktop environments and Agent accounts require separate validation.

## How it works

Chat handles regular conversations. Plan and Goal use agents that support those native modes. Rooms also offer these speaking patterns:

| Mode | Behavior |
| --- | --- |
| Parallel | Members handle the same input together; useful for comparing approaches |
| Sequential | Members respond in order and can read earlier replies |
| Moderator | A host coordinates which member responds next |
| Side chat | A separate discussion inherits member settings when created |

`Choose a project → Add members → Send a task → Review the process and result`

Explicit `@member` messages limit both dispatch and later context to their recipients. Use `@all` for shared discussion. Native failures retain their error and partial work; retry or mention the interrupted member to continue.

Type `/` for available commands. Use `/model` to change a member's model and `/context` to view native usage. Ctrl+K searches messages and archives. Relay limits and concurrency can be adjusted in Settings.

Codex and Claude support question and approval cards; Kimi supports native single-choice questions. Unanswered questions are retained after one minute; answering starts an explicit continuation. Other CLIs currently use text questions. Session approvals apply only to that native invocation. Optional usage budgets stop new dispatches after usage is reported while active tasks finish.

## Who it is for

Chorus is for people who already use coding agents and want one workspace for comparing answers, delegating work, reviewing code and keeping local conversations. Chorus manages rooms and message flow; models, permissions and native skills remain with each CLI.

Model lists show native configuration or provider results. Account access and a real connection determine whether a model works. Tools may edit project files or run commands, so choose appropriate permissions. Kimi currently requires explicit full permission.

## Data and settings

- Windows data: `%APPDATA%/agent-room`. Close the app before backing up the entire directory. Upgrades retain chats; confirmed complete removal deletes shared data.
- Linux data: `${XDG_CONFIG_HOME:-~/.config}/agent-room`.
- Regular rooms share member profiles. Side chats can be edited independently after creation. A member's working directory overrides the room directory, followed by the default directory.
- MCP/plugin settings use agent defaults and room member overrides. Skill registration references original files.
- Set cached input, uncached input and output prices per agent/model, with optional peak and off-peak schedules. Missing native usage stays unknown.

Chorus needs no hosted service or Chorus account and has no built-in telemetry. Cloud providers still receive model requests, and native agents and tools connect according to their own settings.

## Run from source

Use Node.js 24 LTS. Native terminal dependencies may also require Python and a C++ toolchain.

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

[Agent compatibility](docs/CLI.md) · [Build and validation](docs/RELEASE.md) · [Architecture](docs/ARCHITECTURE.md) · [Plan](docs/PLAN.md) · [Third-party notices](THIRD_PARTY.md)

Source code is [MIT](LICENSE) licensed.
