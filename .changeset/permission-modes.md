---
"@kipster/core": minor
"@kipster/codex-cli": minor
"@kipster/claude-cli": minor
"@kipster/ui": minor
---

Choose what kips may do without asking: Supervised, Auto-accept edits, Auto (the default) or Full access. Core keeps the installation's permission mode, serves it at `/v1/settings/permissions`, lets Kip read and change it (Full access needs the person's approval) and gives it to every text execution as `permissionMode`. The Codex and Claude adapters map it to their providers' sandbox, approval and permission settings and no longer accept the `sandbox`, `approvalPolicy` or `permissionMode` configuration keys. Settings has a Permissions picker that asks for confirmation before Full access.
