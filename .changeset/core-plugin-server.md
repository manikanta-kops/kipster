---
"@kipster/core": minor
---

Run the Kipster Plugins server named by host.json `plugins.module`: Core keeps its token and port in `<home>/plugins-host`, restarts it with backoff, reports it in status and doctor, and gives `runtime.plugins.endpoint()` while it is ready. Without it, plugins are off and the rest of Core keeps working.
