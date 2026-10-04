# Claude CLI adapter

Install this package beside `@kipster/core` and register its resolved entry in Core's adapter registry with adapter ID `claude-cli`. The adapter runs the locally installed and signed-in [Claude Code](https://code.claude.com) CLI (`claude`) in headless stream-json mode. Each execution starts its own `claude -p` process in its own process group.

Readiness runs `claude auth status` and then asks the CLI for its live model catalog through the initialize control request; neither spends tokens. Model IDs are the CLI's own names, such as `opus`, `sonnet` and `claude-opus-4-8`, with the efforts each supports. The model the CLI marks as its default is reported as the default model, with `high` effort when the model supports it. Steering and native resume are not advertised.

## Conversations

Core supplies the prompt, instructions and tools of each execution. The adapter sends `context.prompt` as the user turn and appends Core's instructions to Claude Code's system prompt. Each turn uses the persistent Core-owned agent home as its working directory and runs without session persistence, so the CLI keeps no transcript; Core reconstructs history in every turn.

Core's tools reach Claude through a loopback MCP server the adapter hosts: `mcp__kipster__<tool name>`, always loaded rather than deferred behind tool search. Each execution has its own bearer token, written only to a private per-attempt configuration file. A call is forwarded to Core under the same name; a tool Core did not offer is refused without reaching Core. A provider turn may make one question or approval call.

Available JPEG, PNG, GIF and WebP images and PDF documents are attached as native content, labeled with their message, part and artifact identity, newest first within a bounded total. Every available attachment is also readable at its path through an exact `Read` permission for that file; a path containing whitespace, commas or parentheses gets no grant and is read only with permission.

Claude Code's own tools, MCP servers, skills, plugins, hooks and settings come from the user's Claude configuration. Claude Code's auto memory is switched off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), because Core owns kip memory. Passing Kipster's MCP server makes the CLI wait for the user's MCP servers before a turn starts, so `MCP_TIMEOUT` defaults to 5000 milliseconds; an unreachable server would otherwise delay every turn. Both defaults can be changed through `environment`.

## Human interactions

Claude Code's permission prompts reach the adapter through `--permission-prompt-tool`. A prompt for a Kipster tool is allowed, since Core decides those. Any other prompt becomes a Core approval card bound to the exact tool and input, leaving out labels Claude regenerates (a command's `description`, WebFetch's `prompt`). AskUserQuestion questions become Core question cards with free text. The adapter stops the waiting process and the next attempt continues with the saved answer: an approval allows that action once, and a decline is returned to Claude with the person's comment.

## Permission modes

Core sends the installation's permission mode with each conversation execution as `context.permissionMode`, and the
adapter passes Claude Code the nearest `--permission-mode`: `supervised` → `default`, `acceptEdits` → `acceptEdits`,
`auto` → `auto` and `fullAccess` → `bypassPermissions`. A missing or unknown mode is `default`. Claude Code runs
`auto` as `default` for a model that does not support it, such as Haiku, so those turns still ask. Each execution is
a new Claude process, so a changed mode applies from the next turn. Maintenance never uses tools or asks.

## Memory maintenance

Readiness declares maintenance with recovery version 1 in the `claude-cli-process` scope. Each maintenance task runs in its own process with the agent's configured model and effort, Core's output schema through `--json-schema`, no built-in tools, no MCP servers, safe mode (no CLAUDE.md, skills, plugins or hooks) and no session persistence, in a private workspace under the data directory. The adapter fails the attempt if Claude reports any tool other than structured output or any MCP server, or uses a tool. The structured output is returned to Core, which validates it again.

Before the turn starts, the adapter atomically records the process ID and start identity, readable only by the user, under `maintenance/processes` in the data directory. After a Core restart, durable reconciliation reports `ended` only when the recorded process group is gone or its process ID now belongs to another process; a running group is `active`, and a process that cannot be inspected is `unknown`. Process identity is supported on macOS and Linux.

## Configuration and authentication

Core passes the optional adapter `config` object unchanged. This adapter accepts:

| Setting | Default and purpose |
| --- | --- |
| `executable` | `claude` on the service's `PATH`; alternatively an absolute executable path. |
| `environment` | Additional string environment variables for Claude processes. `HOME` cannot be overridden. |

Processes receive a bounded environment: the user's home, shell and locale basics, proxies, certificates, `ANTHROPIC_*` variables and the Claude Code authentication and provider selectors (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock and Vertex settings). Core database credentials are not inherited. The adapter keeps its own records in the private data directory Core provides (`<Kipster home>/providers/claude-cli`).

Sign in with `claude auth login` as the operating system user that runs Kipster. On macOS a signed-in CLI keeps its credentials in the login keychain, which a background service such as the installed Kipster host may not be able to read, and cannot read before login. For such hosts run `claude setup-token` once, which prints a long-lived token for your Claude account, and pass it as `CLAUDE_CODE_OAUTH_TOKEN` in this adapter's `environment` in `host.json`. If Claude stays unavailable with "not signed in" while `claude auth status` succeeds in a terminal, the service cannot read the keychain. launchd does not load shell profiles, so configure its `PATH` or `executable` explicitly.
