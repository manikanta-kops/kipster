---
'@kipster/core': minor
'@kipster/claude-cli': minor
'@kipster/codex-cli': minor
---

Kips reach connected plugins through two Kipster tools, `search_plugin_tools` and `run_plugin_tool`, instead of every plugin tool at once. Core keeps a copy of each connected plugin's tools, finds them by exact name, then by meaning (keywords when no embedding provider answers), and runs a call with the account the kip chooses. The first use of each tool asks the person, who can allow it once, for the conversation or always, the same for every adapter. Running a tool adds a progress note to the work block, and files a tool returns are saved for the kip to send. The instructions name the connected plugins. Executions no longer carry `mcpServers`, and the adapters no longer pass the plugin server to the provider.
