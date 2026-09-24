# Agent CLI support

Chorus runs locally installed command-line agents. Install and sign in to each agent separately, then enable it in **Settings → Agent connections**. Discovery checks for its executable; **Test connection** checks the selected model. Neither action proves every tool or model is available.

## Supported launch contracts

| Agent | Noninteractive transport | Permission mapping | Validation |
| --- | --- | --- | --- |
| Claude Code | Bidirectional stream-json, `--permission-prompts host --permission-prompt-tool stdio` | Native read-only tool allowlist, accept-edits, or bypass-permissions; host approval/question cards | Real local question/answer/model continuation, official SDK contract and application regression tests |
| Codex | Native app-server JSON-RPC | Read-only, workspace-write, or unrestricted; real app-hosted question tool | Real local question/answer/model continuation and application regression tests |
| Kimi Code | Bidirectional ACP | Explicit full access required; ACP session overrides leave global configuration intact | Local 0.28.1 real question/answer/model continuation, model discovery and ACP settings checks |
| CodeBuddy Code | `--print --output-format stream-json` | Read-only tools, accept-edits, or bypass-permissions | Official protocol and offline tests; local account execution not verified |
| Gemini CLI | Piped input, `--output-format stream-json` | Native plan, auto-edit, or YOLO | Official source and offline process/parser tests; local account execution not verified |
| Qwen Code | `--prompt --output-format stream-json` | Native plan, auto-edit, or YOLO | Official source and offline process/parser tests; local account execution not verified |
| GitHub Copilot CLI | `--prompt --silent` | Read-only `view` allowlist or full permissions; workspace isolation unavailable | Official CLI reference and offline process tests; local account execution not verified |
| Cursor Agent | `--print --output-format stream-json` with piped input | Native Ask mode or `--force`; workspace isolation unavailable | Official Windows/Linux installation and CLI references; offline discovery, process, parser, and cancellation tests |
| Factory Droid | `exec --output-format json` with piped input | Native read-only default, low-risk edits, or unrestricted | Official Windows/Linux installation and CLI references; offline discovery, process, parser, and cancellation tests |
| ZCode | Official `--prompt --output-format stream-json` | Explicit full access (`--mode yolo`) only; strict read-only/workspace mapping not verified | Official source, parser and isolated process/cancellation tests; installed CLI/account execution not verified |
| Pi | `--print --mode text --no-session` | Read tools or full access; workspace isolation unavailable | Official source and offline tests; local account execution not verified |
| OpenCode | `run --format json` with piped input | Per-process permission overlay; automatic sharing disabled | Official source and offline tests; local account execution not verified |
| Hermes | `-z` final text | Chat-only or full access; workspace isolation unavailable | Official source and offline tests; local account execution not verified |

Native plan/auto-edit modes are agent policies, not OS filesystem sandboxes. Agents other than Claude/Codex/Pi may keep their own session history. Existing native MCP servers, hooks, plugins, and network access follow each agent's configuration. Chorus currently provides per-room MCP/plugin overrides for Claude Code and Codex.

Gemini and Qwen report token counts when their structured result supplies them. Plain-text transports do not provide token measurements. Missing measurements remain unavailable.

Cursor emits complete assistant messages and tool events; its print protocol suppresses thinking. Droid currently returns its final structured result in Chorus; its separate JSON-RPC tool/progress transport is not integrated. Both preserve native account and extension configuration. Their local account execution has not yet been verified.

Question cards use Codex dynamic tools, Claude AskUserQuestion, and Kimi native ACP single-choice requests. Kimi 0.28.1 provides one question and supplied options only; free-text replies are not exposed by its ACP bridge. Other current print transports use text questions; structured interactive replies are not implemented for them. Questions expire after 60 seconds and remain answerable as a new targeted invocation. No native global configuration is changed.

## Model selection and thinking

- **Codex:** Refresh requests `model/list` from the native app server. Local metadata and labelled suggestions remain available if refresh fails.
- **Kimi:** Read the native provider model aliases and capabilities. Select the complete provider/model alias when more than one provider exposes the same model.
- **Claude:** Refresh reads the **user-level** provider's `/v1/models` interface. For gateways with an `/anthropic` route, a 404 can fall back to that same host's shared model directory. Credentials stay in the main process and are never returned to the UI. Project-specific Claude configuration may differ. OAuth-only accounts or providers without this endpoint retain native aliases and custom model input.
- **Gemini:** `auto`, `pro`, `flash`, and `flash-lite` are official aliases, not a live account model list.
- **ZCode:** This integration uses the native default model. The official headless argument parser has no model override flag, so Chorus hides custom selection and rejects nonempty model overrides. Select the model in ZCode itself. Streaming text, reasoning, tools, final result, and supplied usage/context counters are parsed. Strict read-only/workspace access and a tool-free connection test are not verified; Chorus rejects them rather than elevating permissions. Native extensions and history remain governed by ZCode.
- **Other agents:** Use their native default or a custom model identifier. Chorus does not claim to enumerate all account models for these agents.

A returned model name is a directory entry, not proof of permission or available quota. Model connections can be tested separately. The Kimi connection test calls the configured provider without launching agent tools; other CLI tests can initialize native extensions.

Kimi thinking controls depend on both the model and installed CLI. Version 0.28.1 exposes only **on/off** over ACP, even when a model declares detailed effort levels; always-thinking models expose **on** only, which uses their native default effort. The verified 2.1.1 protocol exposes model-specific levels. Chorus shows their supported intersection and checks the native acknowledgement before sending a prompt. It never substitutes an unsupported level. Available K3 levels may differ by provider and version; the native catalogue is authoritative.

## Working directory

For each member invocation, the working directory is the first configured value in this order:

1. Member's working directory.
2. Room's project directory.
3. Application default working directory.
4. Application fallback directory.

Leave the member directory blank to follow the room. The room's file explorer and terminal use the room directory; a member with its own override can work elsewhere.

## Other products

TRAE's public documentation currently describes its IDE, SOLO, and plugin surfaces. A headless invocation contract was not verified in the inspected pages; this does **not** establish that a CLI cannot exist. ZCode's official open-source repository now provides the verified headless contract used above.

Amp documents local execute mode (`amp -x`) and piped input, but its current supported Windows route is WSL. Chorus does not launch WSL or bridge its paths and credentials; Amp is therefore not exposed as a native Windows adapter.

Continue documents a native Windows installation and `cn -p`, `--format json`, and `--silent`. Its published CLI README does not specify a per-invocation model override or the permission contract needed to map Chorus's access modes. That mapping is not yet verified; Continue is not presented as an implemented adapter. A custom CLI entry can be used only when its exact executable, input, output, and permission behavior are known.

## Protocol references

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [model configuration](https://code.claude.com/docs/en/model-config)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Kimi command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command), [ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp), [0.28.1 ACP source](https://github.com/MoonshotAI/kimi-code/blob/efacf0452d46f5dbd67499eabc053869495d5213/packages/acp-adapter/src/config-options.ts), [2.1.1 ACP source](https://github.com/MoonshotAI/kimi-code/blob/be7d5f5fea7800778e4660cd5f36780ba783bddd/packages/acp-server/src/config-options.ts)
- [CodeBuddy CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference)
- [Gemini headless reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md), [event schema](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
- [Qwen launch configuration](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/config.ts), [JSON output contract](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/nonInteractive/io/BaseJsonOutputAdapter.ts)
- [GitHub Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Pi arguments](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/args.ts), [OpenCode run command](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts), [Hermes oneshot](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/oneshot.py)
- [TRAE documentation](https://docs.trae.ai/), [ZCode official guide](https://docs.bigmodel.cn/cn/coding-plan/tool/zcode)
- [Cursor headless CLI](https://cursor.com/docs/cli/headless), [parameters](https://cursor.com/docs/cli/reference/parameters), [output protocol](https://cursor.com/docs/cli/reference/output-format), [Ask mode](https://cursor.com/docs/cli/using)
- [Factory Droid Exec](https://docs.factory.ai/droid-exec/overview), [installation](https://docs.factory.ai/droid-cli/quickstart)
- [Amp supported platforms](https://ampcode.com/docs/markdown/cli), [execute mode](https://ampcode.com/docs/markdown/cli/execute-mode), [Continue CLI reference](https://github.com/continuedev/continue/blob/main/extensions/cli/README.md)

References checked on 2026-09-24. Upstream CLI releases can change these contracts.

ZCode sources: [official CLI](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli), [arguments](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/arguments.ts), [prompt output](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/prompt-command.ts), [permission rules](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/core/src/permission/service.ts), [event mapping](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts).
