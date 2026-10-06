# Driving the isolated Kipster instance

Use only the factory-provided instance. Agents never run `start.mjs`, start a Core
or UI server, or stop/restart instances. The factory supplies `url`, `checkout`
and `evidenceDir`; navigate with `new URL(url).origin` (readiness is `/health`).
The first allocated port serves the production UI and same-origin API/media/SSE;
the second serves real Core. Do not navigate to fixed ports or installed apps.

## Test identity and fixture behavior

Factory Owner is the trusted owner, Factory Garden the initial organization and
Kip the protected root admin. There is no login/password. Obtain IDs with
`GET /v1/bootstrap` and `GET /v1/directory`. Each instance gets an empty generated
PostgreSQL 18 database with pgvector and a home inside its disposable checkout.
No owner credentials, provider homes or real adapters are used.

Ordinary messages return `Fixture reply: <text>`. Special messages start with
`__question__` (Blue/Red question), `__approval__` (inert color proposal),
`__hold__` (wait until Stop), or `__fail_once__` (fail once per run, succeed after
Retry). A message containing `write a rich doc` creates Trip plan; submission
revises its heading and resolves submitted comments. Transcription reports
unavailable and preserves original voice bytes. Updates use an empty local
catalog and an unmanaged backend; they never install anything.

## Tools and commands

The installed Node/npm workspace provides Playwright. The driver uses installed
Google Chrome with a fresh profile and an isolated HOME, without the owner's
browser session. Chrome must be installed on the tester host. A missing Chrome
is a tester-tool blocker, not grounds to use a persistent browser profile.

Run from the factory-provided checkout, setting these two variables from its
handle (the example values are placeholders, never fixed ports):

```sh
export APP_URL='<origin from factory handle>'
export EVIDENCE_DIR='<evidenceDir from factory handle>'
node .kipster/verify/drive.mjs --list
node .kipster/verify/drive.mjs conversations
```

Replace the example values before execution. Every feature-map command is an
installed, runnable Node command with the same environment. `scenarios.mjs`
contains the exact Playwright role names/selectors and assertions. Scenarios
open a fresh browser context, select Kip through `.installation-agents button`,
perform the named user actions and compare UI/Core state. They never create or
terminate the app instance. Run one scenario at a time; they mutate shared Core.
Direct endpoint inspection must use `$APP_URL` only, for example:

```sh
curl --fail --silent --show-error "$APP_URL/v1/bootstrap"
curl --fail --silent --show-error "$APP_URL/v1/directory"
```

Do not run the repository's real-core-suite, test-mode preview, backend, app,
installer CLI, launchctl, or provider CLI to drive this instance. Read the
[isolation and check guide](../context/factory-verification.md) before changing
verification scripts.

## Evidence and state

Each driver command writes `<scenario>.png`, `<scenario>-trace.zip` and
`<scenario>.json` under EVIDENCE_DIR. Failure writes an additional screenshot and
returns nonzero. Attach the JSON plus representative images/traces as artifacts;
a command succeeding is proof only of that command's assertions. Record the
factory-observed commit and scenario verdict, including unverified areas.
Keep console/network logs in evidenceDir, never the repository. Use separate
scenario evidence subdirectories when repeating a command to retain old proof.

Each scenario uses unique names/messages and a fresh browser context. Re-running
adds Core state; browser storage reset alone does not clear backend data. For a
clean database/home ask the factory workflow for a fresh instance; agents never
reset a database or manipulate another handle. Stop/resume and inbox scenarios
settle their work. A failed scenario may leave pending work; report that state.
Appearance restores its prior displayed mode, permissions returns to Auto, while
sleep time restores its prior value and instructions remain changed in the disposable instance.
No restart durability claim follows from a browser reload.

## Feature maps

- [Connection](features/connection.md): same-origin connection, compatibility and reconnect.
- [Conversations](features/conversations.md): threads, follow-ups, reload and uncertain submission recovery.
- [Work](features/work.md): questions, approvals, Stop/Resume and Retry.
- [Inbox](features/inbox.md): durable notices, reading and pending interactions.
- [Administration](features/administration.md): organizations, kips, membership/group model and lifecycle.
- [Settings](features/settings.md): appearance, permissions, instructions, learning schedule and adapters.
- [Identity](features/identity.md): kip identity files and backups.
- [Rich docs](features/rich-docs.md): answers, checklists, handoff and revisions.
- [Media](features/media.md): managed attachments and generated voice recording.
- [Updates and desktop](features/updates-desktop.md): version display and safe local catalog checks; native exclusions.

These commands were derived from source/tests. Onboarding's evidence records the
static checks and deterministic gate; live boot is verified by verify-kit and
feature driving by the independent tester. Do not treat an unrun command as proof.
