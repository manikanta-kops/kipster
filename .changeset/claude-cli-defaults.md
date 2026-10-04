---
"@kipster/claude-cli": patch
"@kipster/codex-cli": patch
---

Kips no longer use the provider's own memory: Claude Code's auto memory and Codex memories are switched off, because Kipster owns kip memory. The Claude CLI adapter bounds MCP server startup to 5 seconds, so an unreachable MCP server in the user's Claude configuration no longer delays every turn by about 26 seconds.
