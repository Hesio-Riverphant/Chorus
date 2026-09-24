# Design references

The application uses its own implementation. The following projects informed specific design decisions; listing a source does not mean its runtime or code was embedded.

| Source | Applied idea | Application area |
| --- | --- | --- |
| [AionUi](https://github.com/iOfficeAI/AionUi) | Separate Agent configuration and model choice | Member settings and connection checks |
| [CC Switch](https://github.com/farion1231/cc-switch) | Visible native capability sources and management boundaries | Native Skill references |
| [ACP Components](https://github.com/zvzuola/acp-components) | Independent transport and presentation contracts | Adapters, normalized activity UI, theme variables |
| [ChatNut](https://github.com/runno-ai/chatnut) | Separate message transport from routing policy | Orchestrator and adapter boundary |
| [agentschat](https://github.com/nvganta/agentschat) | Adapter contracts and per-Agent context | Bot turns and transcript construction |
| [AutoGen](https://github.com/microsoft/autogen) | Explicit team termination and cancellation boundaries | Existing relay guards; new capability-preparation cancellation |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Separate team collaboration from explicit workflow state | Room/side-chat ownership and per-run state |
| [Coze Studio](https://github.com/coze-dev/coze-studio) and the supplied Coze desktop reference | Manage reusable resources separately from the conversation; make project context visible | Agent-grouped extension management and working-directory display |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons) | Agent identity icons | Provider avatars; bundled MIT notice |
| Codex desktop layout described in the product requirements and [VS Code](https://github.com/microsoft/vscode) | Project groups, resizable panes, temporary tool tabs and a separate terminal area | Workbench navigation and panel layout; implemented locally |

AutoGen is in maintenance mode according to its current upstream README. Its code has an MIT license in `LICENSE-CODE`; documentation has separate licensing. CrewAI is MIT. Both are Python orchestration frameworks; adding either runtime would duplicate the native-CLI execution boundary, so this project adopts the relevant design ideas without adding those dependencies. The cancellation and ownership changes are local implementations, not copied source.

Apple/Google interface conventions informed visual hierarchy, restrained color and clear states. Native behavior is defined by installed CLI help and protocol schemas, including Codex ephemeral threads and collaboration modes, and Claude's model, effort and permission options.

Coze Studio's public README describes resource management for plugins, knowledge and prompts, and notes that model services and plugin authentication must be configured separately. These are useful ownership boundaries for this local application. The supplied desktop reference and Coze Studio are distinct evidence sources; its public README does not verify the desktop product's local-Agent integration. No Coze runtime or source code is bundled.

The concise introduction, separate language documents and installation-first README structure were informed by [Chatbox](https://github.com/chatboxai/chatbox), [Cherry Studio](https://github.com/CherryHQ/cherry-studio) and [Gemini CLI](https://github.com/google-gemini/gemini-cli). Product claims, licensing and compatibility remain specific to Chorus.
