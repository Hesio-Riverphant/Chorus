# Architecture

Chorus is a Windows-first Electron application. Runtime packages are pinned to `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 and `node-pty` 1.1.0. The isolated renderer communicates through a narrow preload API; only the trusted main frame can invoke IPC handlers. External processes receive prompts through stdin where possible. Custom executable definitions do not grant execution capability automatically.

## Ownership

- `src/renderer`: display, independent drafts, dialogs, side conversation pane and command selection.
- `src/main/store`: local records, atomic replacement, recoverable archives and compatibility migration.
- `src/main/orchestrator`: room membership, routing, transcript slices, bounded relay and per-room cancellation.
- `src/main/adapters`: native CLI/JSON-RPC contracts, streaming normalization and process lifecycle.
- `src/main/nativeCapabilities.js`: reduced native metadata and per-invocation selections. It does not copy native credentials or edit native configuration.
- `src/main/workbench`: project-bound file/Git reads, native terminal processes and isolated browser views.
- `src/renderer/navigation-ui.js` and `src/renderer/workbench.js`: project groups, display order, pane sizes and temporary tool tabs.
- `src/shared`: validated appearance, member and reasoning settings.

Side conversations retain original member IDs and persist their effective profiles in `room.memberProfiles`. Global profiles remain in bots.json; side edits never write them. Dispatch and renderer use the shared roomProfiles resolver. `settings.agentCapabilities` defines Agent defaults and `room.memberCapabilities` defines per-room member overrides. Side creation snapshots the effective extension selection. Existing rooms migrate after a separate backup; historical authors remain intact. Global member deletion preserves side snapshots and historical messages.

Ordinary bot turns use temporary native sessions where supported. Other CLIs retain their native persistence behavior. Codex goals use persistent native threads because its goal protocol requires them. The application sends a bounded transcript slice. Model billing can include several internal model calls; native context and cached input usage are separate fields. A cancelled or failed Agent does not relay its partial answer.

Ordinary Codex chat uses the same native RPC transport as Plan, with ephemeral threads. Native token snapshots preserve unknown fields and distinguish cumulative totals from the last model request. `selectTranscript` is shared by preview and dispatch: it filters eligible messages before applying the count and optional estimated-token limit to preceding history. Current-round messages are never cut by this budget. The static room instructions are compact but each temporary invocation retains the persona.

The user message stores the latest run's real start/end boundaries. Restart recovery marks incomplete boundaries interrupted without inventing a finish time. Codex phase fields and Claude tool-use boundaries separate public progress from final text; ambiguous text remains visible. Elapsed controls fold the entire activity container after a conclusion boundary, retaining final text and each activity expansion state. Search and archive viewing include public progress through a shared content function. Archive scans run in cancellable workers with bounded results and explicit partial-read warnings. Project display names do not move directories; moving a room to a project explicitly changes its and its side chats' working directory, with confirmation.

Custom prices live in `settings.agentPricing`, keyed by Agent and exact model identifier. Cached input is a subset of total input; the remaining input uses the uncached rate. A required unknown native usage counter produces no computed cost. Optional off-peak tariffs use an explicit IANA timezone and weekly peak intervals. Invocation-start settings and the selected tariff are preserved in costInfo; estimates can differ from multi-request billing across a tariff boundary.

Claude Goal sends the built-in `/goal` through its native streaming control protocol, validates the acknowledgement, and queries the native Stop hook after the result. It does not implement a separate application goal loop. Claude's `ended` state confirms the hook no longer holds an active goal; its print API does not distinguish an objective met from other terminal outcomes. Codex uses its native goal RPC and terminal statuses.

Plan and goal are conversation draft modes passed with the human message. Routing resolves explicit mentions first, then mode-specific defaults. The composer and main process share recipient resolution. Per-message scope survives retry and copying; cloned members require recipient ID remapping. Persistent Bot configuration is separate from the active composer mode.

Native extension inventories are reduced to safe metadata and stored in the application's data directory, keyed by Agent and working directory. Opening management reuses this inventory; manual Update performs discovery. Execution consumes the inventory and applies invocation-specific overrides. Native configuration, credentials and installations stay with their Agent.

Native subagents are normalized only from explicit Claude and Codex protocol events. Dispatching member, child identity, task, status and available output remain attached to the parent message, outside room reply routing. Missing native output is not reconstructed from arbitrary CLI history files. Per invocation, the adapter retains at most 100 child records and 16,384 characters of output per child; truncation is marked. The workbench displays the available record rather than claiming a complete native transcript.

## Workbench and data

Room navigation groups effective project directories and pinned rooms. Room order and category folds are presentation settings; dragging within a group does not change the working directory, member order or execution routing. Side-chat titles open that side room's settings.

The workbench stores validated sidebar width, side-area width, bottom-area height and pane visibility. It supports collapsed panes, a side area expanded across the main workspace, and an overlaid main-conversation preview. Tool tabs, ConPTY processes and browser sessions are in-memory state; closing the application disposes them. Saved room and side-chat records are independent of this lifecycle.

Async terminal creation checks the current window generation before starting a process. Project-directory changes close existing project tool tabs and their processes. Browser tabs exclusively occupy one of six nonpersistent Session slots; a slot is reused only after page destruction and storage, cache, authentication and connection cleanup. Failed cleanup quarantines that slot until restart.

`node-pty` drives real Windows ConPTY sessions rendered by xterm, with bounded buffered output and flow control. Terminals run in the selected room directory with the user's local shell permissions. Browser tabs use separate nonpersistent sandboxed `WebContentsView` sessions with Node access disabled; navigation is limited to HTTP/HTTPS. Project file viewing and Git change/diff inspection are read-only and constrained to the resolved room directory. External file opening is an explicit user action through the default or chosen application.

Source and packaged entry points select `%APPDATA%/agent-room` before taking the instance lock; logs live under that directory. `AR_DATA_DIR` isolates development test data, while packaged smoke tests select a separately validated temporary store. Older project-local records need reconciliation before the legacy entry is retired. Runtime application state is excluded from public source and portable packages.

## Failure boundaries

JSON writes use atomic replacement. Completed messages are persisted immediately, streaming text is flushed periodically, and interrupted messages become retryable on restart. Disk errors remain visible; abrupt termination can lose the latest unflushed stream. A single process lock prevents competing desktop writers.

Native discovery, output buffers, activity histories and pending RPC requests are bounded. A Stop request cancels capability preparation and active Agent processes. Live native questions survive renderer refreshes. On question timeout or transport failure, unanswered questions are saved with the partial message; an explicit answer starts a targeted continuation, preserving the original mode and prior output. Superseded questions cannot launch work. This is a new invocation, not a restored process checkpoint. Other rooms remain independent.

Codex command, file and permission requests use the native approval protocol. Claude host permission requests and AskUserQuestion use stream-json control replies. Session approvals never write persistent permission rules. Expired authorization is declined. A native tool restriction remains authoritative: a read-only Claude invocation cannot expose excluded mutating tools merely by displaying a card. Other adapters without an implemented interactive contract do not claim these controls.

Optional per-round token and cost allowances use reported invocation totals. They stop new dispatches, including launches after asynchronous capability preparation; already running work completes. A retry counts earlier attempts in the same human round. Unknown usage stays unknown. Native provider limits remain outside this application policy.

Windows cancellation captures the owned tree with taskkill before closing stdin; POSIX launches use a dedicated process group. Timeout/cancel flags are set before termination and late buffered results cannot turn them into success. A failed tree kill falls back to the root and surfaces an unconfirmed-cleanup notice. Deliberately detached descendants and processes orphaned before discovery are outside this mechanism's guarantee. UTF-8 stream decoders retain split code points; protocol parsers handle BOM and final lines without a newline.

Model-provided messages and activity descriptions are escaped or rendered by a small safe formatter. Errors and tool summaries are redacted before display; credentials remain in the native CLI environment. Public packages use explicit file allowlists.

## Local desktop tradeoffs and acceptance

The preload API is a local transport boundary, not a remote API. Web or remote operation would require a separate authenticated transport, filesystem authority and process ownership design. This application deliberately keeps that boundary local. Renderer files still use explicit script order and shared globals; they are not ES modules and have no tree-shaking. Pure shared logic is independently tested, while UI changes receive real Electron smoke checks. Migrate a module when it removes a concrete dependency problem rather than rewriting the UI solely to introduce a bundler.

Electron bundles Chromium and Node; that affects idle memory and download size. Native CLI processes usually add the workload-dependent portion. node-pty remains a native dependency for the real terminal: the lockfile, native-platform build, packaged terminal smoke test and per-platform CI catch incompatible binaries. End users install the tested package, not a separate rebuild toolchain. An Electron upgrade must pass those checks again.

`npm run test:stress` uses isolated data and real controlled Node processes. It checks simultaneous rooms, stopping one while the other completes, visible 429/503 failures, successful manual retry and ten stop/exit races with descendant liveness assertions. It is a bounded reliability test, not a long-duration load or provider-account certification. Run it on both release platforms. Longer soak tests should use explicit concurrency/time limits and record resident memory, dispatch latency, residual processes and disk growth; real provider traffic needs its own cost allowance.
