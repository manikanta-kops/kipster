# Decision block 8 — macOS backend privacy identity

Status: accepted and implemented, 2026-10-04. Release signing and the owner's
Full Disk Access grant are verified on a real Mac before 0.1.0.

## Outcome

macOS privacy (TCC) names installer-managed Core, the updater and everything
they start **Kipster**, not `node`. One grant survives Node, Core, installer and
app updates. The desktop client stays independently installed and versioned.

Before this change the system LaunchDaemons ran the nvm Node binary directly.
TCC attributed kips' work (Codex, shell commands, stdio MCP servers) to `node`;
a daemon cannot show a consent dialog, so undecided access was denied ("Data
Access Blocked"), and any grant was lost when the Node path changed. Root does
not bypass TCC.

## Platform constraints

From Apple's [file permission guidance](https://developer.apple.com/forums/thread/678819):

- A bundled TCC client needs a native Mach-O main executable.
- A persistent decision needs a stable code signing identity.
- Responsibility passes to children; launchd-started jobs are responsible for
  themselves.
- Launch jobs name their app with `AssociatedBundleIdentifiers`.
- Consent dialogs need a GUI login session; a daemon gets an existing decision
  or a denial.

## Bundle and process model

The installer package ships `launchers/macos/Kipster.app`, installed at the fixed
path `<home>/backend/Kipster.app`: bundle ID `app.kipster.backend`, name and
display name Kipster, the Kipster icon, `LSUIElement`, Files and Folders usage
descriptions. Its main executable is a small Objective-C launcher using only
Foundation. Release builds are Developer ID signed (team 4VU397N56A) with the
hardened runtime, notarized and stapled. The designated requirement is the
default one (identifier and team), so every release keeps the same identity.
The bundle holds no configuration or Core code.

```text
launchd (system job, UserName = owner)
  Kipster --role host --home <home>          responsible process
    <node from runtime.json> <home>/bin/core.mjs
      Core adapter runner, Codex app-server, shell commands, stdio MCP servers

launchd (system job, UserName = owner)
  Kipster --role updater --home <home>
    <node> <home>/bin/kipster.mjs apply
```

- Roles: `host` runs `bin/core.mjs`; `updater` runs `bin/kipster.mjs apply`;
  `cli` runs `bin/kipster.mjs` with the given arguments.
- The launcher reads `<home>/runtime.json` (`{ "version": 1, "node": "<absolute>" }`),
  which must be a private file owned by the job's user, as must the home. It
  prepends the Node directory to the child PATH.
- It starts Node with `posix_spawn`, stays its parent in the same process group,
  forwards SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 and SIGUSR2, and exits with
  Node's status. A terminating signal is re-raised; a crash signal is reported
  as 128 + signal so Kipster itself does not crash. It never daemonizes or
  execs Node.
- In the `cli` role, `runtime --node <path>` uses that candidate, so a removed
  Node can always be replaced.
- Both plists run the launcher through `ProgramArguments` and set
  `AssociatedBundleIdentifiers` to `app.kipster.backend`. Owner, HOME, PATH,
  hold file, watch interval, logs, umask and labels are unchanged.

The Codex adapter keeps `detached: true`. Measured on macOS 27 under launchd,
children started with `setsid` (a new session and process group), and their
children, keep the launcher as their responsible process, so no adapter change
is needed. External MCP servers already running outside this tree are not
covered.

## Consent: Full Disk Access

The owner wants kips to have full access, without per-folder restrictions.
`kipster permissions` reveals `<home>/backend/Kipster.app` in Finder, opens
System Settings → Privacy & Security → Full Disk Access
(`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`)
and tells the owner to add and enable Kipster. Core gets the access when it next
starts. Installation never edits the TCC database, copies `node` grants or
resets permissions; System Settings stays in control. There is no GUI
permissions role.

## Runtime selection

`<home>/bin/kipster` is a shell script that runs the launcher in its `cli` role,
so it no longer depends on an nvm path in a shebang. `kipster runtime --node
<absolute-path>` checks the candidate (Node 26.10+ in major 26, macOS arm64),
records it, restarts Core and checks health. If Core does not start, the
previous Node is selected again and Core restarted. Node upgrades need no
privileged plist change.

## Installation, updates and uninstall

- A new installation verifies the packaged app (valid seal, identifier, a
  signing team for system jobs), copies it with `ditto`, verifies the copy,
  registers it with Launch Services, writes `runtime.json` and the entry points,
  then registers the launcher-based jobs.
- Updates stage the new installer, including its app. When the app differs
  (path, mode and byte digest) and Core is held, the updater swaps it in at the
  same path and keeps the previous one, recorded in the update journal, until
  commit. Rollback and interrupted-update recovery put the previous app back.
  The updater replaces only an app that is already installed.
- Uninstall removes the app and `runtime.json` with the other executable
  assets. It does not reset the owner's privacy decisions.

## Existing installations: `kipster repair-services`

A one-time interactive command moves older installations to the Kipster app:

1. Each installed system job must equal this home's recorded plist in
   `<home>/services` or already be the new one; anything else is refused before
   any change.
2. It installs and verifies the app, `runtime.json` (the running Node, or
   `--node`), the entry points and the new plists. A failure here restores the
   home's files.
3. It saves the installed plists to `<home>/backups/services-<time>`, holds and
   stops Core, prints each sudo step, then runs `launchctl bootout`,
   `install -o root -g wheel -m 644` and `launchctl bootstrap` for each job.
4. It releases the hold and checks Core's health. On any failure it boots out
   the new jobs, reinstalls and bootstraps the saved plists, restores the
   home's files and restarts Core.

Already migrated jobs need no sudo; rerunning the command repairs the app,
runtime and entry points. The installer lock excludes a concurrent updater run.
There is no multi-phase journal before 0.1.0.

## Release signing

The installer builds on a macOS runner. In the `release` environment the
workflow imports the Developer ID certificate into a temporary keychain,
compiles for arm64, signs with the hardened runtime and a secure timestamp,
submits a `ditto` ZIP with `notarytool --wait`, prints the log, staples and
validates the app and checks Gatekeeper, then deletes the keychain and key
files. `npm pack` includes the stapled app. `scripts/release.mjs` refuses to
pack, and again after extracting the tarball, unless the app satisfies the
Developer ID requirement for team 4VU397N56A and `app.kipster.backend`, has a
valid stapled ticket and passes `spctl`. Missing secrets fail the release.
Pull request CI compiles the app ad hoc on macOS and runs the launcher tests,
without release secrets.

## Deviations from the proposed design (closed PR #26)

- Full Disk Access replaces per-folder consent and the GUI permissions role.
  The owner wants full access for kips, and a single grant is simpler to give
  and keep. Proving that a GUI-acquired folder consent applies to the system
  job is no longer needed.
- `repair-services` uses a backup and restore instead of a multi-phase journal;
  before 0.1.0 a simple, interactive, recoverable migration is enough.
- The Codex adapter is unchanged: measurement showed detached children keep the
  launcher's responsibility.

## Acceptance

Automated: launcher roles and argument handling, manifest validation, signal
and exit propagation, process parentage and group, packed app integrity after
npm extraction, app refresh and rollback during updates, runtime switching and
its restore, plist generation, migration ownership checks and restore on
failure, release signing checks.

On a real Mac before 0.1.0, with a Developer ID build: Full Disk Access shows
Kipster; after the grant a kip reads a protected folder through Codex, a shell
command and a stdio MCP server; access survives a Core update, a Node switch and
an app update; `repair-services` migrates the live installation; the
notification and Login Items show Kipster.
