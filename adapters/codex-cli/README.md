# Codex CLI adapter

Install this package beside `@kipster/core` and register its resolved entry in Core's adapter registry. The adapter requires a locally authenticated `codex` CLI with App Server support; see [isolation and authentication](#isolation-and-authentication). Readiness discovers the live model catalog; a listed model may still fail when a turn starts, so keep execution failures visible. When Codex lists `gpt-6-luna`, readiness reports it as the default model, with `high` effort when the model supports it; Core uses it for agents that choose no model. Each execution starts an owned App Server process. Conversation execution uses the selected user Codex home; maintenance disables native multi-agent. Cancellation acknowledgement is separate from a terminal turn observation. Steering and native resume are not advertised.

Core supplies the Kipster tools of each execution in `context.tools`: name, description, JSON Schema, and for a tool that leaves the run waiting, what it waits on. The adapter offers them to Codex as dynamic tools unchanged and forwards each call to the Core-bound attempt host under the same name; a call to a tool Core did not offer is refused without reaching Core. Core's instructions, which explain the tools, become the thread's base instructions. A provider turn may make one question or approval call. Native agent messages and tool publications have separate provider identities. The adapter receives no database credentials or embedding provider for these tools. Core's rendered `context.prompt` is the turn's text input, with retrieved memories and file references as untrusted evidence. Each turn uses the persistent Core-owned agent home as its working directory. Provider options are unsupported; a nonempty `settings.options` is rejected before provider startup.

## Permission modes

Core sends the installation's permission mode with each conversation execution as `context.permissionMode`. The
adapter starts the thread with these settings; a missing or unknown mode runs as `supervised`:

| Mode | `sandbox` | `approvalPolicy` | `approvalsReviewer` |
| --- | --- | --- | --- |
| `supervised` | `read-only` | `untrusted` | `user` |
| `acceptEdits` | `workspace-write` | `on-request` | `user` |
| `auto` | `workspace-write` | `on-request` | `auto_review` |
| `fullAccess` | `danger-full-access` | `never` | `user` |

The workspace Codex may write in is the agent's Core-owned home, the execution's working directory. With
`workspace-write`, edits there and sandboxed commands run without asking; leaving the sandbox, for example to write
elsewhere or use the network, asks. In `auto`, Codex's reviewer subagent decides those requests instead of the person.
Requests that still reach the person become approval cards. Every execution starts a new thread, so a changed mode
applies from the next turn. Maintenance stays read-only and never asks.

## Memory maintenance

Readiness declares maintenance support with recovery version 1 in the `shared-codex-home` scope. A conversation launch failure reports not ready. A maintenance isolation or authentication failure disables maintenance while leaving conversation execution available, with the reason in readiness. Each maintenance task, an extraction, a sleep consolidation or an identity promotion, runs in its own App Server process as an ephemeral thread with the agent's configured model and effort. The thread gets no Kipster tools, and the process starts with Codex's shell, exec, web search, image, goal, sleep and skill-search tools turned off, in addition to the isolation below. The turn requests structured output with the schema Core supplies for the task in `outputSchema`. An unknown task fails before launch. Every agent message is reported as a final result, so Core rejects malformed, missing and repeated results. Any other item, such as a tool call, or a request from Codex stops the App Server's process group and fails the attempt; processes a tool started in another session are outside that group.

The turn runs inside the App Server's process group, which may include a launcher and its child. An attempt is reported as ended only once that whole group is gone; otherwise its end is reported as unconfirmed. Before the first provider event the adapter atomically writes the process ID and a start identity, readable only by the user, under `maintenance/processes` in the data directory. The identity is the boot ID and start time in clock ticks on Linux, and the start time fixed at fork on macOS, so setting the clock does not change it. Other platforms have no identity, and maintenance fails before any turn starts. After a Core restart, durable reconciliation reports `ended` only when the recorded process group is gone, or when the process ID now belongs to a process with a different identity. A running process or group is `active`. A process that cannot be inspected, or a live process without a matching record, is `unknown`, so Core keeps the capacity reserved. The record is removed once the end is confirmed.

## Configuration and authentication

Register `@kipster/codex-cli` with adapter ID `codex-cli`. Core passes the optional adapter `config` object to this package unchanged. This adapter validates and interprets these settings:

| Setting | Default and purpose |
| --- | --- |
| `executable` | `codex` on the service's `PATH`; alternatively an absolute executable path. |
| `codexHome` | `CODEX_HOME`, then the operating system user's `~/.codex`. Must be an existing absolute directory. |
| `environment` | Additional string environment variables for conversation processes and their plugins. `HOME` and `CODEX_HOME` cannot be overridden here. |

The adapter keeps its own records in the private data directory Core provides (`<Kipster home>/providers/codex-cli`). No developer username or machine path is built into the adapter. The operating system account running the service determines the default home; a service running as another user needs explicit configuration and access to that user's login. launchd does not load shell profiles, so configure its `PATH` or `executable` explicitly.

Conversations preserve the selected home's configuration, authentication, skills and supported plugins. Codex memories are switched off (`features.memories=false`), because Core owns kip memory. The adapter passes a bounded environment including standard shell, locale, proxy, certificate and Codex authentication variables; pass additional plugin variables explicitly through `environment`. Core database credentials are not inherited automatically. Sharing a home permits Codex desktop to discover the same persisted sessions, but does not make a CLI process desktop-owned or guarantee access to the desktop's in-app browser. Available tools depend on the running Codex version, plugins and host.

Windows and WSL are separate execution environments: a Windows account home such as `C:\Users\you` differs from the Linux account home inside WSL. Configure paths and authenticate where Kipster actually runs. Native Windows execution has not been validated; durable maintenance process recovery currently supports macOS and Linux.

## Maintenance isolation

Maintenance uses the selected Codex home and its login, starting in the adapter's private data directory. Every launch passes strict command-line overrides that disable apps, plugins, hooks, skills, memories, browser/computer use, native multi-agent, daemon startup and project instruction discovery. A short-lived process first reads the configured MCP servers; the maintenance process then starts with each one switched off. Maintenance is refused if a server stays enabled or Codex offers any MCP tool, for example for a server name containing a dot, which cannot be addressed by an override. The global instructions file in the Codex home (`AGENTS.md`) cannot be switched off and is included. Maintenance inherits basic shell, locale, proxy, certificate and Codex authentication variables, and receives no conversation environment overrides or Kipster action tools.

CLI updates may change supported strict settings; recheck readiness after updating Codex. Maintenance cannot start if its required settings or login are unavailable.

## Human interactions and cleanup

Native command and file approvals, permission requests, user questions, and supported MCP form requests become Core interaction cards. The adapter stops the waiting process and reconstructs the next attempt with the saved answer. Approval answers are bound to the exact requested action, including file changes. Unsupported requests fail visibly instead of waiting indefinitely; secret inputs, URL elicitations and nested MCP forms are unsupported.

Each conversation thread has an adapter-owned record under `conversation-sessions` in `dataDirectory`, including its Codex home. When Core forgets provider state, only recorded shared-home thread rollouts and matching maintenance records are removed. Changing `codexHome` does not lose the recorded location. Personal shared-home sessions without an ownership record are preserved. Codex's own SQLite metadata is not edited, so cleanup does not guarantee immediate removal from the desktop sidebar.

Administration changes with a receipt require an explicit `operationId`. Core
reconciles retries under that identity across provider call IDs and attempts;
a different ID remains a separate operation. The adapter supplies Core's bounded
saved operation receipts as factual context after retry. Human approval requests
remain bound to their exact approval cards.

## Image inputs

Available JPEG, PNG, WebP and GIF attachments are supplied as native Codex image
inputs, in addition to their original artifact descriptions and paths. Each image
is labeled with its message, part and artifact identity. Conversation tools remain
inherited from the user's Codex configuration; maintenance isolation is separate.

HEIC/HEIF attachments use the bundled libheif WASM decoder and the JPEG-only
`jpeg-js` encoder to prepare a temporary JPEG of the primary image. Output uses
quality 90 and retains the decoded dimensions without resizing. The original is preserved;
auxiliary images, depth data, HDR and original metadata are not preserved in the
8-bit JPEG view. This is a compatibility derivative, not an archival replacement.

Decoding runs off the main thread with a 20-second timeout, 25 MiB input and
64-megapixel limits, and a 20 MiB output limit. Temporary views are removed when
the execution ends or the adapter closes. Preparation failure is explicit in the
model context and does not discard the original or prevent other inputs from
being delivered. This adapter change does not add HEIC previews to the UI.

The JPEG encoder is JavaScript; libheif-js supplies its HEVC decoder as WASM.
No separately installed image tool or native Sharp/libvips dependency is required.
Mac execution is tested; Windows and Linux require their own release validation.
