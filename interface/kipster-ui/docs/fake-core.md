# Fake Core

`src/fake-core` is an in-memory implementation of the Core HTTP/SSE boundary for
browser and desktop demos. It uses the dedicated origin
`https://demo.kipster.invalid`. It does not execute providers or persist backend
connections. Reloading the page creates fresh sample state.

```ts
import {
  createFakeCore,
  DEMO_ORIGIN,
  installFakeCoreTransport,
} from '../src/fake-core/index'

const core = createFakeCore()
const uninstall = installFakeCoreTransport(core.handle)
// Pass DEMO_ORIGIN to the ordinary Core client.
// On teardown: uninstall(); core.dispose().
```

The ordinary entry dynamically loads this module only when demo mode is enabled. Installing it intercepts
fetch and XMLHttpRequest for the exact demo origin; other origins use the native
transport. XHR upload progress, cancellation and timeout remain available.
The handler uses standard Request/Response objects and can also be hosted by a
server adapter. No Vite middleware is required for embedded use.

Bootstrap reports `coreVersion` (`0.0.0-demo`) and `protocol` (`{ current: 1, oldest: 1 }`).
Pass `coreVersion` or `protocol` to `createFakeCore` to start with others.
The handler supplies bootstrap and directory discovery, direct chats, text
submissions and receipts, application/thread snapshots and SSE, work controls
and interaction answers, notifications, media, settings, identity files,
administration and lifecycle operations. It intentionally has no backward
history endpoint. Snapshots page messages/work and threads/notifications using
Core's cursors; a mutation between pages requires a fresh snapshot. Events have
separate application/thread replay logs, bounded to 2,000 events per scope.

Sample data includes three organizations, shared agent appearances, an
installation administrator, every work state, questions, an approval,
delegation, a failure with held follow-ups, publications and a synthetic audio
sample. New submissions progress every 1.8 seconds through running, a draft,
and a question; answering completes the work. The synthetic transcription
provider returns sample text and does not transcribe uploaded audio.

## Deterministic tests

`createFakeCore({ autoAdvance: false, testControls: true })` disables the clock
and enables the following test-only routes on the demo origin. They are disabled
by default in the handler API. Demo startup enables them; real production builds
exclude this module. UI components do not access the test routes.

| Method and route          | Body / result                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET `/__demo/inspect`     | IDs, chats, thread records, notifications and offline state                                                    |
| POST `/__demo/advance`    | `{ threadId?, steps? }`; advance one or all threads                                                            |
| POST `/__demo/scenario`   | `{ threadId, scenario }`; choose `question`, `approval`, `delegation`, `failure` or `complete` for active work |
| POST `/__demo/retention`  | `{ threadId? }`; expire replay through the current head and request resync                                     |
| POST `/__demo/connection` | `{ offline }`; return unavailable responses and interrupt streams while offline                                |
| POST `/__demo/operation`  | `{ operationId, waiting }`; hold or release pending lifecycle cleanup                                          |
| POST `/__demo/release`    | `{ protocol: { current, oldest }, coreVersion? }`; change the version and protocol range bootstrap reports     |
| GET `/__demo/updates`     | Inspect software update status, simulated app state, release catalog and accepted installs                     |
| POST `/__demo/updates`    | Set a software update scenario; see below                                                                      |
| POST `/__demo/reset`      | `{}`; reset all sample state and interrupt existing streams                                                    |

Additional test controls accept complete protocol records: `/__demo/message`
(`threadId`, `message`), `/__demo/work` (`threadId` and optional `work`,
`interaction`, `delegation`) and `/__demo/notification` (`notification`). They
emit versioned events; older records do not replace newer canonical state.
`/__demo/identity` changes `installationId` and/or `callerId` and forces stream
resynchronization for persistence-scope tests.

Playwright's test-only Vite adapter hosts isolated handler sessions under
`/__test-core/`. Browser fetch and uploads still use the embedded transport and
ordinary app entry. Pages sharing a session share Core state. Test-only storage
faults and synthetic notification drivers are excluded from normal builds.

The control routes remain reachable while offline. Ordinary endpoints keep Core
error envelopes and do not accept test scenario parameters. Idempotent receipts
are immutable copies of the original result. Stopping work holds ordinary
follow-ups; Resume releases them without restarting cancelled work. Identity
writes use content hashes and retained backups. Lifecycle deletion copies or
removes owned publications and updates surviving message references.

Software update scenarios use `{ state }`: `idle`, `available`, `checking`,
`scheduled`, `installing`, `disconnect`, `installed`, `rolled-back`, `failed`,
`pinned` or `backups`. Supply `step` for install progress and `disconnectMs` for
the restart outage. `core` and `backups` override status fields; `app` sets the
simulated app’s state, version, availability or error. App pinning through the UI
stays device-local. The fake serves the shared `/v1/settings/updates` and
`/v1/updates` routes, and emits `updates-changed`; app simulation uses a separate
demo-only event. Neither simulation contacts the public update service.

Use Node.js 26.10.0, with the sibling Core package built, to run:

```sh
npm run test:fake-core
node tests/fake-core-transport.mjs
```

Conformance specs import only the public `@kipster/core/protocol` export through a
development dependency. The fake runtime does not import Core. Bootstrap and
media shapes, which have no exported schema, have explicit assertions. The
transport check uses installed Chrome and Playwright WebKit. These tests do not
prove actual provider execution, persistence across process restarts or native
microphone support.
