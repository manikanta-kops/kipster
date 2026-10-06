# Updates and desktop integration

## Sub-features

- Shared update policy, backend/app/protocol version details and local catalog checks.
- Managed backend updates, backup restore and testing-channel pins in supported installations.
- Native app updater, permissions, login/window preferences, notifications and badges.

## How to get to it (user point of view)

Settings → Updates shows versions and Check for updates. Other Settings pages expose General and Notifications. Testing controls appear only in next-version builds, and native app controls depend on the platform.

## Driving it

| User action                                            | Exact command                            | Observable result                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Check the empty local catalog and open Version details | `node .kipster/verify/drive.mjs updates` | Real Core records checkedAt, reports unmanaged with no available release, and version details match bootstrap's Core version. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

Factory instances are browser production builds with an unmanaged backend and no updater, installable releases or backups. Never operate the installed Kipster app, launchd jobs or updater. Actual installation/rollback, channel pins, OS permissions, native notifications, signing/notarization and native self-update remain unverified. Deterministic installer/launcher tests are distinct from operating an installed app.
