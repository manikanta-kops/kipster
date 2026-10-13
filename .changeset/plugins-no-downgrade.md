---
'@kipster/core': patch
---

Never start a Kipster Plugins server older than the newest that already ran with the installation's plugin data, for example after a Core restore. Core records that version in `<home>/plugins-host/highest-version`; an older server fails with a reason that names the version to install, plugins stay off, and the update check offers and installs only a release at or above it. A server whose newer version cannot be recorded is stopped with the reason instead of running unrecorded.
