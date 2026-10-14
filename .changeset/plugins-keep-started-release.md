---
"@kipster/core": patch
---

Keep a plugins release that started but did not become ready, instead of rolling back to a version its plugin data refuses, so restarts recover it. A plugins route called after the plugin server gave up starts it again, and Core no longer passes `KIPSTER_PLUGINS_CLIENT_METADATA_URL` to the plugin server.
