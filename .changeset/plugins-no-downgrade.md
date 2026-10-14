---
'@kipster/core': patch
---

Never start a Kipster Plugins server older than the newest that already ran with the installation's plugin data, for example after a Core restore. Core records that version in `<home>/plugins-host/highest-version`; an older server fails with a reason that names the version to install, plugins stay off, and the update check offers and installs only a release at or above it. A newer version counts as soon as its server process has started, ready or not, since the server migrates the plugin data first: a newer release that fails before it is ready keeps plugins off until a release at or above it is installed. Core stages a newer version before it spawns the server and completes the record right after, so a newer server never runs unrecorded, even across a Core restart.
