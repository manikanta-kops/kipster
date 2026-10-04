---
'@kipster/codex-cli': patch
---

Approved Codex actions now run: a saved approval matches Codex's retried request even though each retry carries a new timestamp, approval ID and reason.
Supervised now runs in the workspace sandbox with network, still asking before every edit and command, so an approved network command can succeed.
