---
"@kipster/core": minor
---

Check the update channel for `@kipster/plugins` too. Core installs a newer plugins release itself, by itself in automatic mode or with `POST /v1/updates/plugins/install` and the `updates.plugins_install` approval, and restarts only the plugin server, rolling back when it does not become ready.
