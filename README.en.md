# Chorus

English · [简体中文](README.md)

Bring multiple agents into one room to discuss, divide work and collaborate.

Chorus is a local desktop app that connects installed Agent CLIs. Add different models to a room, mention a member, run a discussion in order or let a moderator coordinate it. Chats, settings and archives stay on your computer. Each agent uses its existing account and tools.

## Get started

Requires **Windows 11 x64** and at least one installed, authenticated Agent CLI. Desktop packages include the runtime; Node.js is not required.

1. Run `Chorus-0.5.1-windows-x64-setup.exe`, or extract the complete matching zip and run `Chorus.exe`.
2. Open **Settings → Agent connections**, scan and enable an agent, then create a member, fetch its model list and test the connection.
3. Create a room, choose its project directory and members, and send a task. Inspect tools, file changes and usage as it runs, or stop it at any time.

[Download the latest release](https://github.com/Hesio-Riverphant/Chorus/releases/latest). Windows offers an installer and a zip, both x64 and unsigned. Linux is under validation; no Linux package is offered yet.

To uninstall, use **Uninstall Chorus** in the Start menu, or extract the matching uninstall launcher package and run `Uninstall Chorus.cmd`. It opens the registered uninstaller and retains chat data. For the portable edition, close the app and delete its extracted directory.

## How it works

Chat handles regular conversations. Plan and Goal use agents that support those native modes. Rooms also offer these speaking patterns:

| Mode | Behavior |
| --- | --- |
| Parallel | Members handle the same input together; useful for comparing approaches |
| Sequential | Members respond in order and can read earlier replies |
| Moderator | A host coordinates which member responds next |
| Side chat | A separate discussion inherits member settings when created |

`Choose a project → Add members → Send a task → Review the process and result`

Type `/` for available commands. Use `/model` to change a member's model and `/context` to view native usage. Ctrl+K searches messages and archives. Relay limits and concurrency can be adjusted in Settings.

## Who it is for

Chorus is for people who already use coding agents and want one workspace for comparing answers, delegating work, reviewing code and keeping local conversations. Chorus manages rooms and message flow; models, permissions and native skills remain with each CLI.

Model lists show native configuration or provider results. Account access and a real connection determine whether a model works. Tools may edit project files or run commands, so choose appropriate permissions. Kimi noninteractive tool execution currently requires explicit full permission.

## Data and settings

- Windows data: `%APPDATA%/agent-room`. Close the app before backing up the entire directory. Upgrades retain chats; uninstalling retains data.
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
