---
"@kipster/core": minor
---

Expose Kipster Plugins: `/v1/plugins` routes relay the plugin server's control API, `GET /plugins/callback` returns sign-ins through Core, bootstrap reports `capabilities.plugins` while the plugin server is ready, Kip gets a `plugins` area in the administration catalog, and conversation executions receive the plugin server as the `plugins` MCP server. A return address off Core's own callback is refused with `return-address-refused`; an unreadable plugin server answer is `502 plugin-server-failed`.
