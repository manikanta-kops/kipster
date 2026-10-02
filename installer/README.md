# Kipster installer

The macOS installer runs as the backend owner. Core and the updater are system
LaunchDaemons with `UserName`, so they can start before login without running as
root. Service registration needs sudo once; updates use the private host-control
socket and a launchd hold file.

Core releases live in `<home>/releases/<version>`, behind `<home>/current`.
The updater has independent versions under `<home>/updater` and a stable launcher
under `<home>/bin`. It verifies channel tarballs before installing them, snapshots
the database before staging, then refreshes the snapshot after Core stops.
`kipster-host setup` performs migrations while Core is held down. Health checks
require `/v1/bootstrap` to report the requested Core version.

A durable journal records activation and restore work. An interrupted activation
rolls back on the next updater run. Restore clears application schemas and loads
the database snapshot together in one transaction, including removal of objects
introduced by failed migrations. Failed recovery keeps Core held down and retains
the journal and backup for another attempt.

The shared request contains only a target version. File-driven installs select
stable for stable versions and next for prereleases. Each configured adapter uses
the newest version in that channel. Restore uses the versions recorded with its
backup. Core owns update settings, scheduling and the idle-work policy.
