---
"@kipster/installer": minor
"@kipster/core": minor
---

Add a macOS backend installer with verified channel downloads, database snapshots,
unprivileged supervised updates, automatic recovery and confirmed rollback.
Respect updater holds during host startup and recover proven-dead host ownership
only while startup is held for recovery.
Mark installer-managed hosts for Core updates and retain restore requests so Core
can reapply the owner's update settings after startup.
