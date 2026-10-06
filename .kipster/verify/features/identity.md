# Kip identity and memory

## Sub-features

- Global soul.md, identity.md and AGENTS.md files.
- Editable identity guidance, compare-and-swap writes, backups and restore.
- Memory, provenance and learned identity promotion remain Core capabilities.

## How to get to it (user point of view)

Settings → Kips selects a kip. Its file rows open identity/soul/instructions editors and saved backups. Identity belongs to the global kip across memberships.

## Driving it

| User action                                           | Exact command                             | Observable result                                                  |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Inspect Kip and read its seeded identity through Core | `node .kipster/verify/drive.mjs identity` | Kips shows Kip and the identity endpoint returns file identity.md. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

This command is read-only and proves neither editing nor restore UI. Inspect the identity editor in IdentityFiles.tsx when extending driving. Do not read provider-home AGENTS.md or owner files. No embedding provider is configured, so memory recall, learning and promotion cannot be driven here; isolated Core database tests exercise them with fixtures. Preserve owner-authored text outside Learned markers.
