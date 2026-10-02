# Proposed decision — macOS backend privacy identity

Status: proposed; implementation and real-Mac acceptance are pending.

## Outcome and platform constraints

Files and Folders consent for installer-managed Core and its execution children
should belong to a signed backend application named **Kipster**, rather than the
selected Node executable. Node, Core and helper updates should retain that consent.
The desktop client remains independently installed and independently versioned.

Apple's [file permission guidance](https://developer.apple.com/forums/thread/678819)
establishes the relevant constraints:

- Bundled TCC clients need a native Mach-O main executable.
- Persistent decisions require a stable code signing identity.
- Responsibility is inferred across helpers and children; daemonization can
  break that association.
- Launch jobs can declare their associated application with
  `AssociatedBundleIdentifiers`.
- Files and Folders prompts require a GUI login session. Outside that session,
  macOS uses an existing decision or denies an undecided request.

These rules support the design below, but do not prove attribution for Kipster's
specific process tree. Real-Mac acceptance is a release gate.

## Bundle and process model

Ship a small Apple Silicon application in `@kipster/installer`. Install it at the
fixed path `<home>/backend/Kipster.app`, with bundle ID `app.kipster.backend`,
`CFBundleName` and `CFBundleDisplayName` both `Kipster`, the Kipster icon, and
appropriate Files and Folders usage descriptions. Use the desktop application's
Developer ID team with the backend's own signing identifier. Keep these identities
constant across stable and next releases and across installations on the same host.
This implies that backend installations using this identity share the owner's
consent; it does not create per-installation access isolation.

The main executable is native Objective-C using system frameworks. It reads an
owner-private runtime manifest outside the signed bundle, containing the absolute
Node path and a format version. The job supplies the installation home and a
restricted role (`host` or `updater`); a `cli` role supports manual commands.
The launcher selects the stable Core/updater script for that role, preserves
argument boundaries, prepends the selected Node directory to child PATH, starts Node,
and remains its parent until exit. It forwards termination, waits for shutdown,
and propagates exit status. It neither daemonizes nor replaces itself with Node.
The signed bundle contains no mutable configuration or versioned Core code.

```text
system launchd (job runs as backend owner)
  Kipster.app native launcher, role=host
    selected Node -> <home>/bin/core.mjs -> current Core
      Codex app-server
        tool commands and stdio MCP servers

system launchd (job runs as backend owner)
  Kipster.app native launcher, role=updater
    selected Node -> <home>/bin/kipster.mjs apply
      migration and maintenance children
```

Both generated system plists invoke the native executable directly using
`ProgramArguments`, and associate `app.kipster.backend` using
`AssociatedBundleIdentifiers`. Preserve the owner, HOME, explicit PATH, hold
file, watch interval, logging, umask and existing job labels. `BundleProgram` is
not appropriate for these manually registered jobs; it requires SMAppService
registration. No dependency on an installed desktop client is introduced.

The adapter currently launches Codex with `detached: true` and stops its process
group. Test that exact behavior before changing it. If it loses responsibility,
replace session detachment with a native child entry point that establishes a
process group without creating a new session, then executes Codex. Preserve
group termination, cancellation and MCP descendant cleanup. Do not just remove
`detached` while retaining negative-PID signals. External MCP servers that are
already running outside this tree cannot be promised the backend's attribution.

## Consent while retaining startup before login

Retain the system LaunchDaemons and their existing startup model. Add an explicit
`kipster permissions` command that opens this same backend bundle through Launch
Services in the backend owner's GUI session, in a permissions role. It presents
the folders the owner chooses to enable and performs a minimal native access to
each selected standard location, letting macOS show its own consent dialog.
Do not use an open-panel grant as evidence of persistent Files and Folders consent.
The permission process exits without starting another Core or updater.

Document this first-run step and how to repeat it when a kip needs a new protected
folder. A request from the system daemon cannot promise an interactive dialog;
denial should point the operator to the GUI consent command. Existing `node`
grants are not copied or edited: expect one initial Kipster consent. Denied
decisions remain controlled by System Settings. No automatic Full Disk Access
grant, TCC database modification or global permission reset is part of installation.

Before accepting this approach, prove that consent acquired in the GUI process is
honored by the system job running as the same owner. If it is not, stop and revise
the service architecture. Moving Core into a GUI LaunchAgent would allow ordinary
interactive requests but would change startup-before-login behavior; that is a
separate product decision.

## Build, signing and release

The installer release matrix entry moves from Ubuntu to a macOS runner. Add a
native-helper build step before `npm pack`; leave the npm installer CLI usable
for Linux fixture tests without invoking a native build during ordinary `npm ci`.
Place the generated bundle under `launchers/macos/Kipster.app`. That directory is
already included by the package's file list and copied by the shipped updater,
so older updaters can stage the complete new package before service migration.

Use the existing release-environment Apple certificate, password, signing identity
and App Store Connect API secrets. Import the certificate into a temporary
keychain, compile for arm64, sign nested native executables before the outer app
with Developer ID Application, hardened runtime and a secure timestamp, then
verify signatures and the designated requirement. Keep the standard requirement
based on the backend identifier and Developer ID team; do not pin a binary hash
or individual signing-certificate hash. The launcher does not embed Node, so it
does not need Node JIT or library-validation exceptions itself.

Archive the app with `ditto`, submit that ZIP with `notarytool --wait`, check the
result and log, staple and validate the ticket on the app, then pack the final
bundle into the installer tarball. ZIP and npm tarballs cannot themselves receive
an app's stapled ticket. Hash the final packed bytes for the existing `release.json`
and catalog format. See Apple's
[notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Delete temporary keychain and API-key files on success and failure.

Published installer releases must fail when signing or notarization is missing
or unsuccessful; do not silently publish an unsigned permission identity.
Unsigned local development artifacts are explicitly separate from production
permission validation. PR CI adds native compile and process-lifecycle coverage
on macOS without release credentials. Any pre-merge Developer ID test artifact
needs an owner-approved signing route; release secrets must not be exposed to
arbitrary PR code.

## Installation, migration and updates

Fresh installation verifies the bundled code against the expected Developer ID
team and backend identifier, installs the sealed bundle at its fixed path, writes
the private runtime manifest and stable scripts, then registers both jobs. Register
the bundle with Launch Services for the owner and offer the explicit GUI consent
step. Verify bundle integrity again after npm extraction and copying.

Move the stable JavaScript updater entry to `<home>/bin/kipster.mjs`. The executable
`<home>/bin/kipster` becomes a small shell entry that invokes the bundled native
launcher in its `cli` role with correctly quoted arguments. It no longer embeds
an nvm Node path in its shebang, so removing an old Node does not strand the CLI
needed to select its replacement. The native `cli` role must recognize
`runtime --node <absolute-path>` and use that explicit candidate to run the
JavaScript runtime-switch command even when the stored Node no longer exists;
normal CLI commands use the stored runtime. Validate the candidate before
committing the manifest. Privacy consent itself uses Launch Services, not this
Terminal-invoked wrapper.

Existing installations need a one-time interactive `kipster repair-services`
migration. The current updater writes service files only at first install and
refuses differing installed plists; an automatic Node-to-helper swap is therefore
not sufficient. The migration must:

1. Verify the installed jobs match this home's recorded legacy service files.
2. Stage and verify the helper and runtime manifest before stopping anything.
3. Hold and gracefully stop Core, wait for the updater to be idle, and journal
   old/new service definitions, stable scripts, runtime and helper state. Activate
   the compatible new updater alongside the migration.
4. Print the exact sudo steps, unload the two owned jobs, install the replacement
   plists and bootstrap them. Never overwrite unrelated or modified jobs.
5. Check health, then commit the service migration. Recover interruption or
   failure by restoring the known previous helper, manifest and job definitions.

Ordinary automatic updates stay unprivileged. Staging an installer update includes
its native bundle under `launchers`, alongside `src` and `package.json`. Validate the
replacement before activation. When helper bytes change, journal a recoverable
replacement at the same installed bundle path; keep a previous complete bundle
until commit. Stop the host launcher before replacement. An updater already
running the old helper may finish before the next scheduled invocation uses the
new one. Test that transition and crash recovery explicitly. Do not modify the
signed bundle in place or make its installation path follow a Core release.

Core updates and restores keep the same backend identity. Restoring an older Core
does not restore the old Node-direct service definitions. Helper activation is
part of the updater journal, with rollback to a compatible known-good helper on
failure. The runtime manifest likewise has an atomic, recoverable update path;
an explicit `kipster runtime --node <absolute-path>` validates the supported Node
version before switching and restarting Core. Preserve the previous usable Node
path on failure. Node upgrades require no privileged plist replacement.

Uninstall unregisters only verified owned services and removes the installed
helper with other executable assets. It does not reset the owner's macOS consent.
Keep existing data, database and backup preservation rules.

## Acceptance before calling the feature complete

Use a disposable installation and test files in protected folders on a real Mac
without Full Disk Access or a preexisting backend grant. Use the production
Developer ID identity. Record macOS version, signed bundle identity/designated
requirement, job domain, and process/attribution diagnostics. Capture the actual
dialog and its displayed name, rather than inferring it from the plist.

Verify all of the following:

- GUI permission access shows **Kipster** and grants or denial persist on relaunch.
- The actual system job can read the test file after GUI consent, and an undecided
  folder fails outside a GUI session as documented.
- A real Core conversation launches Codex through the adapter; shell access and
  a test stdio MCP server access are attributed to the same backend identity.
  Exercise the existing detached launch first and verify any replacement's
  cancellation and descendant cleanup.
- Updating Core through the installed updater, then restarting, retains access
  and does not request consent again. Confirm the reported Core version changed.
- Switch between distinct supported Node installations with different absolute
  paths and bytes; repeat Codex and MCP access without another permission prompt.
- Replace the helper with a different signed build/version having the same
  designated requirement; repeat access without another prompt.
- Validate legacy service migration, ordinary restart, Core restore, helper
  rollback and recovery after interruption. Authored data and ownership survive.
- Verify the published bundle after extraction with `codesign`, `spctl` and
  `stapler`, including Gatekeeper behavior with quarantine present.

Automated tests cover argument/path handling, signal and exit propagation,
runtime validation, service migration ownership checks, activation/recovery,
package contents and release signing/notarization failures. Existing installer
database and recovery tests still run. Generated plists, mocked TCC, ad hoc
signatures and a Terminal-owned child are not substitutes for the real-Mac checks.

Implementation adds a patch changeset for `@kipster/installer`; include
`@kipster/codex-cli` if its launch behavior changes and `@kipster/core` if host
diagnostics change. Keep protocol changes additive. Open the implementation PR
against `next` and leave merging to the owner.
