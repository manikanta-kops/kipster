# Kipster UI

React/TypeScript client for Kipster Core, with a small Tauri host boundary and an
in-memory demo Core. Core owns durable state and execution; the client
provides conversations, work controls, inbox, settings and administration.

## Development

Use Node.js 26.10.0 and npm from this directory:

```sh
npm ci
npm run dev                       # Embedded fake Core (demo mode)
npm run dev:core                  # Real client; connect to an existing Core
npm run check                     # Lint, formatting, TypeScript and production build
npm run build                     # Real client
npm run preview                   # Serve the built client
```

The real client uses its saved connection, or shows connection setup and saves
the address you enter; change it later in Settings. Addresses must be HTTPS
origins, or loopback HTTP origins. Demo mode (`--mode demo`) never reads or
overwrites a saved real connection and has no connection setting. Both data
sources render the same Workspace. `npm run desktop:dev` runs the desktop shell
in demo mode.

When Core and UI origins differ, allowlist the exact UI origin through Core's
`startTextServer` options. See [Core development](../../core/README.md) for runtime
composition and the trusted-owner access boundary. Environment assignments use
POSIX shell syntax.

## Connected capabilities

The client reads Core's directory and paged snapshots, then follows application
and current-thread SSE streams. Resource revisions prevent state regression.
Reconnects and reloads restore saved state without dispatching work.

- **Conversations:** organization and installation-admin chats, streamed text,
  files and voice notes. Original file bytes are saved locally before upload.
  Recording is available when Core reports a ready transcription provider; Core
  preserves the original recording if transcription fails.
- **Work:** queued cancellation, Stop, Resume, Retry, questions, approvals and
  delegated-child activity. Answers bind to the exact interaction, run, attempt
  and proposal. Unsupported steering is explicitly unavailable.
- **Inbox:** durable notifications linked to their original context. Marking an
  item read does not answer or resolve its interaction.
- **Administration:** organizations, global agents, memberships and groups.
  Membership removal keeps history readable under Former members. Archived
  agents have read-only history and can be restored. Permanent deletion requires
  typed-name confirmation. The archive panel tracks progress and waiting cleanup;
  deletion can wait for confirmed provider termination. The root admin is protected.
- **Settings:** saved and effective execution settings, adapter readiness,
  organization instructions, learning switches and sleep times. Effective values
  show their source; saves change only edited fields.

Drafts, attachment bytes and pending submissions persist in IndexedDB, scoped by
connection, installation, caller and conversation. Concurrent draft edits offer
conflict recovery. Uncertain sends and controls use receipt lookups and explicit
retries with their original IDs. Uncertain execution-settings saves retain their
original ID and patch across closing or reloading Settings, without automatic
replay. Administration requests retain stable operation
IDs; directory events determine current state rather than old receipts. Archive
and deletion preserve recoverable drafts and rejected sends, including attachment
downloads. Deleted authors retain their last names, marked as deleted.

## Browser and desktop demo

```sh
npm run build:demo
npm run preview:demo -- --port 4196
npm run desktop:demo              # Kipster Demo macOS bundle
npm run build:desktop-demo        # Same embedded demo web assets only
```

Demo builds ignore saved connections.
The [fake Core](docs/fake-core.md) answers HTTP/SSE and media requests in-page for
both browser and desktop, without a server. It simulates work, media and settings;
it does not execute providers. Reload resets sample data. Device-local preferences
and drafts persist separately. Normal production assets exclude the fake runtime
and its test controls.

The desktop demo is named **Kipster Demo**, uses identifier `app.kipster.demo`, and
writes its bundle to `src-tauri/target/release/bundle/macos/`. Normal desktop
builds use `npm run desktop:build`; root `npm run app` builds an unconfigured real
client. Browser checks and demo web builds do not establish packaged-platform
support. Native connectivity, permissions and distribution need release validation.

## Testing

```sh
npm run test:entry                # Built/dev entry and connection regression checks
npm run test:fake-core            # Core protocol conformance
npm run test:e2e                  # Browser tests in Chromium
npx playwright install webkit
npx playwright test -c playwright.webkit.config.ts
npm run test:screenshots          # Visual review captures
node tests/publication-recovery.mjs
```

The Playwright configuration builds and previews the test mode (`--mode test`,
demo plus test controls) on port 4187. `npm run test:screenshots` runs the visual
specs and saves captures under ignored `test-results/screenshots/`.

Run every real-Core UI check (durable text, lost acknowledgements, generated
recording, management, lifecycle, startup cleanup and publication recovery) with:

```sh
npm run test:real-core
```

This requires built Core (`core/dist`), its compiled deterministic test adapter,
installed Chrome and Playwright WebKit, and PostgreSQL 18 with pgvector on `PATH`.
From a fresh checkout, prepare Core before running the command:

```sh
(cd ../../core && npm ci && npm run build && npx tsc -p tsconfig.fixture.json)
```

Add the PostgreSQL 18 binary directory to `PATH` and install pgvector for that
server version. The UI dependencies must already be installed with `npm ci`.

The command uses Core's `with-test-database.mjs` wrapper to create and remove a
private disposable cluster. It starts only temporary Core/UI servers, runs both
browser engines, and connects the UI to the temporary Core automatically. No
provider credentials or persistent daemon are used. Failure artifacts go to
`test-results/`. Set `TMPDIR=/tmp` if needed for Unix socket path limits.

## Client structure and desktop attention

`features/workspace/Workspace.tsx` composes the connected client;
`data/text.ts`, `core-work.ts`, `management-core.ts` and `core-settings.ts`
implement protocol boundaries. Zustand holds navigation; Dexie holds local
recovery/preferences.
Fetched projections are rebuilt from Core snapshots and events.

Host integration stays in `platform`; see [platform adapters](docs/platform-adapters.md).
Desktop alerts require explicit enable/test. Background dispatch never requests
permission. Same-browser delivery claims reduce duplicate attempts across tabs;
OS visibility and cross-device deduplication are not guaranteed. Fully closed-app
delivery and native notification-click routing are not implemented.

## Install and connect

The production desktop app saves an existing backend URL through its connection screen. See [Mac client installation](docs/install-macos.md); adding a client does not create a backend.
