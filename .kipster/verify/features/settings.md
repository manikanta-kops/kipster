# Settings

## Sub-features

- Core-owned palette/theme, alerts, permissions and persistent approvals.
- Organization defaults and agent overrides with effective-source display and adapter readiness.
- Organization instructions, installation/agent learning switches and sleep times.

## How to get to it (user point of view)

Open Settings in the sidebar and choose Appearance, Notifications, Permissions, Organization, Kips, Adapters or Learning. Organization → Instructions edits shared guidance. Kips opens per-kip execution/identity pages.

## Driving it

| User action                                                   | Exact command                                 | Observable result                                                                            |
| ------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Choose Dark and reload, then restore the prior displayed mode | `node .kipster/verify/drive.mjs appearance`   | Core interface theme is dark and the Dark radio remains checked after reload.                |
| Choose Supervised and reload, then return to Auto             | `node .kipster/verify/drive.mjs permissions`  | Core permission mode is supervised and the corresponding radio remains checked after reload. |
| Save and reopen organization instructions                     | `node .kipster/verify/drive.mjs instructions` | Saved appears and reopening the editor returns the exact new instruction text.               |
| Change and restore the default sleep time                     | `node .kipster/verify/drive.mjs learning`     | Core reports the chosen 03:15 or 03:16 time, then the prior time.                            |
| Inspect the adapter catalog                                   | `node .kipster/verify/drive.mjs adapters`     | Settings lists deterministic-fixture.                                                        |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

Only deterministic-fixture/fixture-model is available. No real providers or embeddings are configured; learning schedule persistence does not prove memory learning, extraction, consolidation, sleep execution or vectors. Effective settings inherit from organizations unless the kip overrides them. Execution-setting saves, clearing overrides, notification toggles and grant removal need additional proof. Do not persist new product settings in browser storage; update the Core admin catalog/skill and parity tests.
