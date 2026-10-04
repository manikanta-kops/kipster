# Kipster installer

Install the `@kipster/installer` tarball from its GitHub release with npm. It
provides the `kipster` command. Prepare macOS on Apple Silicon, Node.js 26.10 or
later in major 26 (the repository's `.nvmrc`), PostgreSQL 18, pgvector, and matching
`psql`, `pg_dump` and `pg_restore` tools. Use a dedicated database owned by its
configured login. The installer checks these requirements and reports fixes.
Full restore recreates pgvector and preserves object owners and grants, so the
updater needs a PostgreSQL superuser maintenance login. Core can keep a normal
database-owner login. Put `{ "databaseUrl": "postgresql://..." }` for the same
database in a mode-0600 file and pass `--maintenance-config <file>`. The updater
saves it privately in `updater.json`; it never accepts credentials from a request.
Without this option it uses the host database login and checks its privileges.

Prepare a private host configuration following the [Core host guide](../core/docs/host-macos.md),
including provider options and private ingress allowlists. Pass it by filename;
keep credentials out of arguments. Installer-managed execution entries use
`node_modules/@kipster/<package>/dist/index.js`. Embedding and transcription
modules identify their packaged providers. The installer rewrites provider roots
through `current`, preserving IDs and options. With no configuration file,
`KIPSTER_DATABASE_URL` supplies the database, and Codex is the default adapter.

```sh
chmod 600 /absolute/path/host-input.json
kipster install --home /absolute/path/kipster --config /absolute/path/host-input.json --maintenance-config /absolute/path/maintenance.json
/absolute/path/kipster/bin/kipster status
/absolute/path/kipster/bin/kipster update
/absolute/path/kipster/bin/kipster update --to 0.2.0
/absolute/path/kipster/bin/kipster rollback
/absolute/path/kipster/bin/kipster permissions
/absolute/path/kipster/bin/kipster runtime --node /absolute/path/to/node
kipster uninstall --home /absolute/path/kipster
```

`install` defaults to stable; use `--channel next` or `--version <version>` to
select another release. `update --to` selects stable for stable versions and next
for prereleases; without `--to`, it uses the initial install channel. The CLI
starts manual updates immediately. Core's settings and scheduler decide its
file-driven updates. A pending Core request must finish before a CLI update.
`rollback` asks for confirmation and restores the latest backup and its Core
version. Use `--yes` only to confirm a scripted restore; it replaces database
changes made since the backup. A restore takes a fresh backup of the current
database first.

Repeating `install` on an installed home safely reports its current version.
`uninstall` stops Core, unloads and removes both login jobs, and removes installed releases, updater versions and launchers. It preserves the
database, home data and backups. Run `install` again with the same configuration
to reinstall. `uninstall --delete-data` also clears the dedicated database and
deletes home files, including backups and private configuration. It asks for
confirmation; `--yes` confirms deletion in a script. The database itself, its
login and pgvector remain available for a fresh install.

Use `--pg-bin <directory>` when matching PostgreSQL clients are outside PATH.
`--no-launchd` runs a disposable/manual installation and prints the generated
plists without registering them. `--catalog <URL>` uses an alternate HTTPS catalog;
loopback HTTP is supported for local tests. `--health-timeout <milliseconds>`
sets a bounded health deadline (default 60000, maximum 300000).

The macOS installer runs as the backend owner, without sudo. Core and the updater
are per-user login jobs in `~/Library/LaunchAgents`, loaded into the owner's login
session (`launchctl bootstrap gui/<uid>`). They start when the owner logs in and
keep running while the screen is locked, until logout. Running in the login session
gives kips the owner's login keychain (where the Claude CLI keeps its sign-in), the
GUI for browsers, and macOS consent dialogs. After a restart, nothing runs until the
owner logs in. Updates use the private host-control socket and a launchd hold file.

Both jobs start `<home>/backend/Kipster.app` (bundle ID `app.kipster.backend`),
a small signed launcher, in its `host` or `updater` role. It starts the Node
recorded in `<home>/runtime.json`, stays its parent, forwards termination
signals and exits with Node's status. macOS therefore shows Core, the updater
and everything kips run (Codex, shell commands, MCP servers) as **Kipster**, and
one grant survives Node, Core and installer updates. The jobs name the app with
`AssociatedBundleIdentifiers`.

Give Kipster Full Disk Access once, so kips' file access does not depend on
per-folder prompts: run `<home>/bin/kipster permissions`. It shows the app in Finder and opens
System Settings → Privacy & Security → Full Disk Access; drag Kipster into the
list (or click + and press Command-Shift-G for the path) and turn it on. Core
gets the access when it next starts. The installer never changes privacy
settings itself.

`<home>/bin/kipster` runs commands through the app with the recorded Node. After
installing another Node, select it with `kipster runtime --node <absolute path>`;
it checks the version, restarts Core and selects the previous Node again if Core
does not start. It works even when the recorded Node has been removed. No login
job changes.

Updates replace the app at the same path, while Core is held, when a new
installer ships a different build; rollback restores the previous app.

Do not run the installer as root. Generated plists contain runtime paths and log
paths; Core/provider credentials stay in mode-0600 `host.json` and maintenance
credentials in mode-0600 `updater.json`. launchd receives an explicit runtime PATH
and the owner's HOME. Installation and uninstall refuse to replace or remove a
login job whose plist differs from this home's.

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

Files in `<home>/updates` use the shared version-1 `request.json` and `status.json`
contract. Requests contain `target` as a semver string and an optional backup UUID
for restore. URLs or paths supplied in requests are ignored; the updater fetches
catalogs itself. Unknown request fields are ignored, and the original request
stays in place so Core can reapply its update settings after a restore. The
installer sets `updates.managed: true` in `host.json`, including when updating an
existing installation or restoring an older backup. Core requires this flag to
accept or schedule installations. Writes use a private temporary file, fsync and
atomic rename.
`apply` ignores terminal requests it has already handled. launchd watches requests
and retries every 60 seconds, including after reboot. The updater retains the
current and previous Core releases, the last three complete database backups,
and current/previous updater versions. A pruned Core release can be downloaded
again from `releases.json` for restore, with its recorded provider versions.

Updater activation runs its entry point's self-check in a child before switching
the independent pointer. The stable launcher falls back to the previous updater
if the current one cannot import. Migration children wait for a startup grant
until their PID is durably recorded, so a killed updater cannot leave an
unjournaled migration running. Recovery waits for an existing child to exit and
never signals a PID read from disk. Proven-dead Core ownership can be reclaimed
only with a hold and the same instance; ordinary host commands still refuse stale
ownership. An older Core without that recovery helper needs manual stale-socket
inspection. Keep the journal and backup when recovery reports a failure.
A failed first install restores the original database and Core home files and keeps startup held;
retry `install` with the same home and configuration to finish setup. It reuses
already registered identical jobs and refuses to overwrite a differing job.
Retries also preserve orphaned Core home files left by older failed installers
under `backups/failed-install-home-*` before setting up an empty database again.
Setup failures include their cause in stderr, `updates/status.json`, and
`logs/installer-error.log`, with database URLs and credentials redacted.

PostgreSQL snapshots cover this dedicated database, including application tables,
schema, extension and grants. The file home and external provider sessions remain
in place. This is not a PostgreSQL server/role backup or a cross-machine export.
Restore requires the same database endpoint and keeps its current login credentials.
Preserve required database roles and provider authentication separately. New
runtime dependencies are installed by npm with lifecycle scripts disabled.

`npm run build:macos -w installer` compiles the app into `launchers/macos`, where
`npm pack` includes it. Without `--identity` it is signed ad hoc, which suits tests
but gives no lasting privacy identity; system-job installations refuse an app
without a signing team. Releases are Developer ID signed, notarized and stapled
(see [releasing](../docs/releasing.md)).

Validation: `npm run test:postgres -w installer` starts a disposable PostgreSQL 18
cluster and tests local catalogs, fake Core processes, backup/restore, crashes and
retention. With `KIPSTER_TEST_DATABASE_URL` pointing to a disposable admin database,
`npm run test:e2e:macos -w installer` tests real packed Core/adapters on macOS,
including CLI rollback and plist linting. Build Core first. These tests generate
service files; they do not register login jobs. Live launchd behavior after
login needs an explicitly deployed host test.
