# Kipster Core

The backend package for Kipster. Core includes a versioned text protocol,
PostgreSQL/pgvector persistence, pg-boss wakeups, repeatable bootstrap, current
execution settings, durable text submissions, and HTTP/SSE delivery. Execution
adapters are separate packages. Core manages its own dependencies and lockfile.

## Development

Install dependencies once from the repository root, with the Node version pinned
in `.nvmrc`, then work in `core`:

```sh
nvm install
npm ci
cd core
npm run check
```

- `npm run build` emits JavaScript and TypeScript declarations into `dist/`.
- `npm run check` runs type checks, import-boundary checks, unit tests and
  isolated package-consumer tests. Database tests run only with PostgreSQL;
  see Testing.
- `npm pack` validates and builds Core before creating a local package tarball.

## Testing

`npm run test:unit` builds Core and runs the tests serially; each test opens
several connection pools and relies on real deadlines. It then runs the memory
scenarios in `tests/memory-scenarios` (`npm run test:scenarios`, three files at a
time): short stories of conversations across days, organizations and nightly
sleeps, driven through the dispatcher with the deterministic fixture adapter
scripting every model answer and an injected clock. Tests that need
PostgreSQL are skipped outside `npm run test:postgres`.

`npm run test:postgres` runs the full suite against a throwaway cluster. It
creates the cluster with `initdb` in a private temporary directory, serves it
only on a Unix socket in that directory, runs `test:unit` and always stops and
removes it. It needs PostgreSQL 18 with pgvector installed and `initdb` and
`pg_ctl` on `PATH`, and it cannot run as root because `initdb` refuses to. For
example, with Homebrew:

```sh
PATH="$(brew --prefix postgresql@18)/bin:$PATH" npm run test:postgres
```

## Streaming

Adapters emit accumulated drafts; Core coalesces pending revisions while a write
is in progress. Text writes share the capacity guard, allowing concurrent threads
while excluding multi-thread lifecycle changes. First drafts and final messages update application summaries;
subsequent drafts update only the detailed thread stream. Stopped or interrupted
answers are sealed in place. Failed and cancelled runs remain excluded from
execution history by the normal history policy.

SSE delivery uses one shared PostgreSQL `LISTEN` connection and transactional
notifications. Reconnection reads from the durable cursor. Connections send a
comment heartbeat every 20 seconds and defensively check for missed events every
30 seconds. Replay retains 2,048 events per stream, pruning every 128 writes;
older cursors require a snapshot. Canonical messages and work are not pruned.

## Public exports

| Import | Contents |
| --- | --- |
| `@kipster/core/protocol` | JSON value types and runtime text submission, receipt, read, snapshot, directory and event parsers. |
| `@kipster/core/client` | JSON types and `defineClientOptions` for HTTP(S) URL configuration. |
| `@kipster/core/adapter` | Injected text execution context, opt-in maintenance context for extraction, consolidation and identity promotion tasks, readiness catalog, events, controls, reconciliation and durable recovery references. |
| `@kipster/core/transcription` | Replaceable provider contract for derived audio text; no provider is selected by importing it. |
| `@kipster/core/runtime` | Node-only `openRuntime`, `AdapterRegistry`, `TextDispatcher`, `textPublicationHost` and `startTextServer`. All startup is explicit. |
| `@kipster/core/maintenance` | Node-only inspect/list/status reads plus idempotent `requestAction` intents for default-disabled maintenance. Importing it starts nothing; only the running coordinator executes intents. |

Pass an optional `onError(error)` to `openRuntime` to observe background failures that Core recovers from on its own: database connections lost while idle and job-queue errors. A background queue error does not fail later submissions; `runtime.jobs.error` holds it until the job worker next receives jobs. Observer failures are ignored.

One `TextDispatcher` per database holds the coordinator lock on a dedicated connection. Every claim and issue checks in the same transaction that this lock session still holds the lock, so a silently dropped connection cannot let two dispatchers run work. When the loss is detected, the dispatcher stops claiming and issuing, leaves wakeups for the lock holder, lets in-flight attempts settle, and retries the lock with backoff (0.5 s, doubling to 10 s). Another dispatcher may take the lock meanwhile; turns whose attempts it recovers are cancelled here. The dispatcher resumes only after it holds the lock again and has recovered abandoned work, excluding work it still prepares or runs itself. The optional `coordinatorLock(state, error)` dispatch hook reports `lost`, `retry-failed` and `restored`.

Register a separately installed adapter with `AdapterRegistry.register(id, installationRoot, entryRelative, signal?, config?)`. The optional configuration object is passed to the adapter factory as its second argument; Core does not interpret provider-specific fields. Pass a persistent generation directory as the registry constructor's second argument. The installation root must contain the adapter and its transitive runtime dependencies; registration snapshots and hashes its bytes, rejects symlinks, checks the contract and readiness, then atomically replaces the route. `remove(id)` stops new admission and drains active attempts. `refresh()` probes each adapter's readiness again; an adapter that is not ready takes no new work until a later probe finds it ready. An issued attempt with a lost execute acknowledgement retains its generation until confirmed settlement. Close the dispatcher before closing the registry and runtime. Model catalog discovery validates a selection but does not guarantee that a provider will accept a turn. Configured option keys must be advertised by the adapter catalog; unsupported keys fail during preparation.

An adapter may implement `forgetProviderState({ threadIds })`. When conversations are permanently deleted, Core passes it the provider thread IDs its attempts reported in `provider` events, so it can remove the state it keeps for them, such as session files. The call must be safe to repeat and ignore unknown IDs. Core routes each ID to the adapter that ran the attempt; an adapter without the method, or one that is no longer registered, leaves the state in place and the deleting operation reports it.

Pass an `EmbeddingProvider` from `@kipster/core/embedding` as `openRuntime`'s `embedding` option. Hosts load one provider from `embedding: { module, options }` in host.json; Ollama is available in `@kipster/embedding-ollama`. The provider ID and model identify the vector space. Changing either automatically queues all retained memory and vector text for re-embedding on the next start.

Core retains memory text and provenance before indexing; its bounded worker resumes pending and failed intents after restart. `runtime.memory.indexPending()` permits an explicit retry. A profile change atomically activates a new generation and queues current source revisions for reindexing. Search uses only active-generation vectors and labels lexical fallback while indexing is pending or unavailable. Historical vectors remain stored but are not searched. Memory retrieval supplies bounded, scoped evidence to each new execution, including continuations.

`runtime.vectors` provides named agent or active-organization collections independently of automatic memory retrieval. The `vectors.space` Core tool supports `create`, `discover`, `describe`, `get`, `upsert`, `search`, `delete_record`, and `delete_collection`. Target owner is explicit; Core binds the acting agent and current attempt. Collection names are lowercase identifiers (up to 40 characters); records use stable keys (up to 100 characters) and revision checks (`expectedRevision: 0` creates). Text is limited to 8 KiB and metadata to 2 KiB. A record keeps only its current source. A collection holds at most 1,000 records and 8 MiB of retained source bytes. An owner holds at most 100 collections. Limits reject writes explicitly. Lists and searches return at most 20 items per page. Search cursors bind the query, collection revision and embedding generation; a source or index change invalidates the cursor and requires restarting pagination. Search returns `availability`, `pending`, and `failed` alongside compatible active-generation matches. Canonical text remains readable while indexing is pending or the provider is unavailable. Collection and record deletion remove retained sources and derived embeddings.

`runtime.relationships` provides owner-local, typed memory links through `memory.link`, `memory.relationship_get`, `memory.relationship_list`, `memory.relationship_update`, and `memory.unlink`. Links carry a weight from 0 to 1 and 1–8 revision-bound memory evidence references. `supports` and `derived_from` are directed; `contradicts` and `related_to` are symmetric. Correction or republishing marks prior evidence stale until an explicit revision-checked update. Each change retains its evidence references and hashes; unlink closes the stable link and a later link creates a new ID. Organization links require explicit organization-owned memories and evidence. Each owner may retain up to 2,000 links, each keeping its latest 64 changes; list and history pages contain at most 20 entries. Reads use a coherent database snapshot and recheck the current attempt and owner before return. History continuation supplies `historyAfter` and the prior `revision` as `historyRevision`; a changed link requires restarting pagination.

`startTextServer` trusts its configured listening host and actual bound port, including an ephemeral port. Every request must use that authority in `Host`; optional `allowedHosts` adds explicit authorities such as `kipster.example` or `localhost:8080`. When binding a wildcard address, list the actual client-facing hosts explicitly. The server never derives trust from a request's `Host` or forwarded headers.

Browser requests may use the exact listening origin or an exact HTTP(S) origin in `allowedOrigins`. For a reverse proxy that preserves `Host: kipster.example`, configure both `allowedHosts: ['kipster.example']` and `allowedOrigins: ['https://kipster.example']`; a separate UI origin belongs only in `allowedOrigins`. Adding a browser origin does not authorize its Host, and adding a Host does not authorize its Origin. Originless trusted clients remain supported using the listening or explicitly allowed Host.

These checks reject browser-origin/authority spoofing, including matching untrusted Host/Origin pairs, before reads or mutations. They are not user authentication: a non-browser client can supply trusted headers. Keep this trusted-owner server behind the installation's private access boundary; configure proxy access controls separately.

Managed files use `/conversations/media`: capabilities, bounded binary upload with a stable upload ID, receipt lookup, artifact metadata and content download. Uploads belong to their installation or organization context. Only verified ready originals can enter ordered message parts; a file-only message is valid. Downloads verify bytes and use attachment disposition. Output tools write bounded UTF-8 files in the current attempt, publish immutable agent-owned snapshots, and can explicitly copy one into the active organization. An attempt may write up to 32 output files and make up to 32 publications, subject to byte limits. File associations do not change ownership. Interrupted disk/SQL publication is reconciled as a verified upload or an explicit failed operation; failed operation files are cleaned during normal recovery. Historical files with unavailable managed bytes remain explicit unavailable input parts, so later text work can continue without claiming their contents were read.

Agents can discover authorized peers and delegate bounded work through Core-bound tools. Each delegation creates a private child run with a durable parent relationship; the child uses its own agent identity for memory and files. Human questions from a child appear on the originating thread and answers return to that child. Parent continuation receives saved child results in request order after the parent provider turn ends. Stop propagates to active descendants; uncertain provider termination retains capacity until reconciliation.

Each agent home holds `AGENTS.md`, `soul.md` and `identity.md`; every execution reads them fresh. Core changes them only by compare-and-swap: the caller supplies the SHA-256 it read, and a file that changed since then fails with `409 conflict` instead of being overwritten. A write syncs a temporary file, checks the live file again and renames it into place, so a crash leaves the previous or the new file, never a partial one; it may leave a hidden temporary file, which is never read. The replaced version is kept under `backups/<file>/` in the agent home, and only the latest five backups of each file remain. The owner may change any of the three files with `GET` and `PUT /v1/agents/{agentId}/identity/{file}` (`{ "version": 1, "content": string, "expectedSha256": string }`), list and read backups with `GET .../backups` and `GET .../backups/{backupId}`, and restore one with `POST .../backups/{backupId}/restore` (`{ "version": 1, "expectedSha256": string }`). A restore is itself a write and keeps a backup. Kipster itself may change only the text between `<!-- kipster:learned:begin -->` and `<!-- kipster:learned:end -->` in `identity.md`, and appends that section when it is absent; all other text is changed only by the owner. Identity files must be regular UTF-8 files of at most 64 KiB. An edit saved outside Core in the instant between the final check and the rename can still be lost.

Task-data tools require PostgreSQL 18 and a separate restricted login supplied as `taskDataConnectionString` to `openRuntime`. Provision that login with `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, no role memberships and no grants on Core tables. Revoke database `TEMPORARY` from `PUBLIC` and schema `public` `CREATE` from `PUBLIC` before enabling it. Core verifies effective grants and database identity, then grants only its fixed attempt guard, receipt insert/read, and task namespace creation. It refuses an overprivileged login. Without this option, conversations continue and task-data tools are unavailable.

`data.space` accepts an explicit agent or active-organization owner and bounded typed operations for task tables, columns, B-tree indexes and UUID-keyed rows. It does not accept raw SQL, custom expressions, defaults, functions or extensions. A mutation and its call receipt commit together under a live attempt guard; schema registration is a separate guarded transaction. Rows, result bytes, lock waits and transaction duration are bounded. The acting agent and the owner must be live. Owner deletion removes registered task namespaces after active work is fenced.

Pass a `TranscriptionProvider` directly to `openRuntime` after constructing the independently installed provider. Core validates the contract and declared MIME types, saves original voice-note parts and derived preparation status, and dispatches the original on bounded transcription failure. Ordinary audio remains an attachment until an agent invokes `audio.transcribe` on an authorized artifact. The initial implementation is `@kipster/transcription-spokenly`; it requires an absolute CLI executable and accepts optional time/output limits. Spokenly manages its own model and processing route outside the CLI contract.

Text types are inferred from the same schemas that validate runtime values.
All text mutations require `version: 1`, reject extra fields and require explicit
values. Read parsers allow extra response fields but reject an unsupported major
version. IDs and cursors are opaque. A submission receipt is scoped to the
installation, caller and submission ID; after authorization, a repeated ID must
return the original receipt even when the retry supplies different content.
Clients must use a new ID for new content. Read limits are 1–100.
The exported `textEvent` schema accepts only the current protocol's event kinds.
Clients skip event kinds they do not know and show a neutral fallback for
unknown enumeration values, as [decision record 5.1.7](../docs/initial-implementation-plan/05-kipster-protocol.md)
requires; they must not infer meaning from an unrecognized payload.

Every exported schema has `describe()`, which returns the JSON shape it accepts.
`protocol-shape.json` records the request and response shapes. After changing the
protocol, run `npm run protocol:shape -w core` and commit the file. CI compares
it with the base branch and fails when a request stops accepting what released
clients send, or a response or event loses, loosens or retypes a field, unless
`protocolRange.current` was raised.

`GET /v1/directory` returns the owner's directory: organizations, agents, agent
memberships and organization groups with their ordered appearances, with the
application cursor to follow changes from. It is read from one database
snapshot. Agents and organizations carry a `lifecycle` and a `revision`. A
deleted agent stays listed with its last name and `lifecycle: "deleted"`, so
history can name it; deleted organizations are not listed. Memberships and
groups are listed only for active organizations. Every appearance names a
membership, so an agent shown in several groups opens one direct chat.

The application stream carries `organization-changed`, `agent-changed`,
`membership-changed` and `group-changed` with the full record, and
`organization-removed`, `membership-removed` and `group-removed` with the
removed IDs. A client merges them by these rules:

- A record replaces the one held when its revision is not older. A removal
  always applies; IDs are never reused.
- An organization that leaves `active`, or is removed, drops its memberships
  and groups.
- A removed membership also leaves every group's appearances.
- An agent that is `deleting` or `deleted`, or an organization that leaves
  `active`, takes its chats with it; see gone chats below.
- A former-member chat is an organization chat, known from thread summaries
  (`contextKind`, `contextId`, `agentId`), in an active organization with no
  membership for that agent. It is read-only and returns to the member list
  when the agent is added again.

A client that loads both the directory and the application snapshot follows the
stream from the older of their two cursors. Replaying an event already reflected
in the newer snapshot changes nothing, because every merge checks revisions.

Administration is owner-only:

| Route | Purpose |
| --- | --- |
| `POST /v1/organizations` | Create an organization with a name, optional description and default settings. The owner becomes a member and the organization home is seeded. |
| `PUT /v1/organizations/{id}` | Change the name, description or default settings. |
| `POST /v1/agents` | Create a global agent with a name, optional description and settings. `organizationId` also adds it to that organization. The admin agent is created only at bootstrap. |
| `PUT /v1/agents/{id}` | Change the name, description or explicit settings. |
| `POST /v1/agents/{id}/archive` | Move an agent to the archive. The admin agent cannot be archived. |
| `POST /v1/agents/{id}/restore` | Bring an archived agent back. |
| `DELETE /v1/organizations/{id}` | Permanently delete a confirmed organization; global agents and independently owned resources survive. |
| `DELETE /v1/agents/{id}` | Permanently delete an archived agent (`copyFilesToOrganizations`, default off). Returns the agent as `deleting`; the cleanup continues as an operation. |
| `GET`/`PUT /v1/organizations/{id}/instructions` | Read or replace the organization's instructions (up to 64 KiB). |
| `POST /v1/organizations/{id}/memberships` | Add an agent (`agentId`). Adding a current member returns its membership. |
| `DELETE /v1/memberships/{id}` | Remove an agent from the organization, with its group appearances. |
| `POST /v1/organizations/{id}/groups` | Create a group (`name`) after the existing ones. |
| `PUT /v1/organizations/{id}/groups/order` | Order the groups (`groupIds`, every group once). |
| `PUT`/`DELETE /v1/groups/{id}` | Rename a group, or delete it with its appearances. |
| `POST /v1/groups/{id}/appearances` | Place a membership (`membershipId`) at the end of the group. |
| `PUT /v1/groups/{id}/appearances/order` | Order the group's appearances (`membershipIds`, every one once). |
| `DELETE /v1/groups/{id}/appearances/{membershipId}` | Take a membership out of the group. |
| `GET /v1/settings` | Saved settings of every agent that is not deleted and every active organization, with the application cursor. |
| `PUT /v1/agents/{id}/settings` | Set or clear an agent's own settings (`settings`), including the admin agent's. |
| `PUT /v1/organizations/{id}/settings` | Set or clear an organization's default settings (`settings`). |
| `GET /v1/agents/{id}/effective-settings?organizationId={id}` | The settings the agent's next execution would use in that organization, or in the installation without `organizationId`. |
| `GET /v1/execution-adapters` | The dispatcher's adapters, with the application cursor. |
| `POST /v1/execution-adapters/refresh` | Probe every adapter's readiness again (`{ "version": 1 }`) and return the list. |
| `GET /v1/operations/{operationId}` | An operation recorded under the owner's operation ID: `state`, current `step`, `waitingFor`, `result` and `error`. |

Each write except an instructions save or an adapter refresh carries an
`operationId`. A repeated ID returns the result recorded the first time, with
`alreadyApplied: true`, when the validated request matches. Reusing an ID
with changed fields or a different target is a `conflict`. Settings are `{ "set": value }`
or `{ "clear": true }` per field; an omitted field is unchanged. A creation stays hidden until its
home is seeded. After an interruption, retrying the same `operationId`, or the
next start, finishes it with the same IDs. The instructions file in the
organization home is their only copy: a save replaces it atomically, the latest
save wins, and the next execution reads it. At startup Core seeds homes only
for active agents and organizations, so a deleted organization's home is not
recreated. An order lists every current item once; the latest save wins, and a
list that no longer matches the current items is a `conflict`. `DELETE` requests
carry `{ "version": 1, "operationId": … }` as their body.

Execution settings are `adapterId`, `modelId`, `effort` and `options`. An agent's
own value overrides its organization's default; clearing it restores the default.
A field neither sets comes from the default adapter, the first one the host
registers, and from that adapter's default model and effort, which it reports as
`defaultModel`. The default effort applies only with the default model. Those
values report the source `default`. The admin agent works in the installation, so
only its own settings and the defaults apply.
Effective settings report `status` (`ready`, `unknown-catalog`, `missing` or
`incompatible`), a `reason` when the selection cannot run, the values and their
`sources`. They are checked against the dispatcher's available adapters, so a
selection whose adapter or model is unavailable keeps its saved values and
reports why, and work that uses it fails with that reason. The agent need not be
a member of the organization: accepted work of a former member still runs with
these settings. Settings changes, including those through `PUT /v1/agents/{id}`
and `PUT /v1/organizations/{id}`, publish `settings-changed` with the saved
record; its revision counts settings changes only. A client replaces a record
when the event's revision is not older, and drops the settings of an agent or
organization that leaves the directory.

The adapter list names each adapter with its `version`, `available`, a `reason`
when unavailable, `models` with their `efforts`, `supportedOptions` and
`capabilities`. An unavailable adapter keeps its last known catalog. The
dispatcher records the list at start, after a refresh, and when the registry
registers, loses or removes an adapter; each change publishes one
`adapters-changed` event with the whole list and the next revision. A direct
adapter whose readiness probe throws, times out after 30 seconds or reports not
ready is listed as unavailable with the reason, and the dispatcher still starts.
Work that selects an unavailable adapter first probes it again, at most once
every 30 seconds per adapter, so a passing readiness failure heals without a
refresh; the work is refused only if the adapter is still unavailable. A refresh
cannot revive an adapter whose runner exited; register it again. Without a
dispatcher, the adapter routes return `503 unavailable`.

Removing an agent from an organization keeps its chat. The chat is read-only:
new submissions, new delegations to the agent and opening a new chat require the
membership, and each takes a key-share lock on the membership row, so a
concurrent removal either waits for it or refuses it. Work accepted before the
removal still runs with the organization's defaults, including answers to its
questions, delegated children, Resume and Retry, and a repeated submission ID
still returns its receipt. Delegating, and writing organization memory or task
data, require the membership when the tool is called.
Adding the agent again opens the same chat with its history; its group
placement is not restored. Deleting a group keeps its agents and their
memberships.

Archiving an agent stops its work at once, as described for lifecycle changes
below: queued and waiting work is cancelled and stays visible, running work is
asked to stop, pending questions are cancelled, and a parent waiting on work
delegated to the agent receives a failure. Nothing is removed: memberships,
group appearances, settings, memory, files and the home stay, and its chats stay
readable. The directory lists the agent with `lifecycle: "archived"` and
publishes `agent-changed`; `agents.list` no longer offers it. Submissions, new
chats and delegations to an archived agent are refused with the code
`agent-archived` (HTTP 409), and it neither learns nor sleeps. Restoring sets it
`active` again with everything it had. Work stopped by the archive stays
stopped; failed work can be retried.

Organization deletion has no archive stage. It fences organization-context work,
waits for confirmed provider termination, then removes chats, organization-owned
resources, organization-homed learning, memberships and the home. Global agents
and their independent resources survive. A tombstone prevents bootstrap from
recreating the organization after restart.

`admin.agents.archive`, `admin.agents.delete` and `admin.organizations.delete`
request Core-authored human approval cards. Each card binds the exact target ID
and deletion options; approval and the lifecycle operation commit together.
Decline or cancellation changes no target resources. Restore needs no approval.
Clients handle `notification-removed` (`id`, `threadId`) when cleanup removes a
notification and `thread-removed` when its thread disappears.

Only an archived agent can be deleted permanently; any other agent is a
`conflict`. The agent becomes `deleting` at once and the operation's steps run
in the background; `GET /v1/operations/{operationId}` shows the progress. The
steps wait until no work in its chats and no memory task of the agent can still
write. With `copyFilesToOrganizations`, each of its files shown in an
organization's chats is first copied into that organization, unless the
organization already has a copy it published. The provider state of every
removed attempt is then handed to the adapter that ran it (see
`forgetProviderState`); the operation's result lists what an adapter could not
forget under `providerState.residue`. After that the agent's chats are removed
with their threads, messages, runs, questions, notifications and receipts, and
so are the threads in which it ran work delegated to it from other chats. Its
memory and learning state, vector collections, task-data schema, files and home
(identity files and their backups included) follow. Last, its memberships,
group appearances and settings are removed, and the row stays as a `deleted`
tombstone that keeps its last name.

What belongs to others stays. Organization-owned files, including those the
agent published or copied, stay readable. A delegation recorded in another
agent's thread keeps its request, result and both agent IDs; its
`childRunId` or `parentRunId` becomes null where the run was the deleted
agent's, so clients name the agent through its tombstone ("Scout · deleted").
A surviving message that showed one of the agent's files shows the
organization's copy instead, or a `{ "kind": "removed", "artifactId" }` part.
Clients receive `agent-changed` (`deleting`, then `deleted`),
`membership-removed`, and one `thread-removed` (`{ threadId, chatId }`) for each
removed thread of a chat.

The admin agent administers the installation from its installation chat through
`admin.*` Core tools that call the same services as these routes, so they produce
the same records and events. Core sets `administrationEnabled` in the execution
context only for the admin agent's own work in the installation context, and
checks again on every call; organization chats and delegated work get no
administration tools. Reads are `admin.directory.get`, `admin.organizations.get`,
`admin.agents.get`, `admin.organizations.instructions_get`,
`admin.settings.list`, `admin.settings.effective`, `admin.adapters.list` and
`admin.operations.get`. Writes are `admin.organizations.create`, `.update` and
`.instructions_set`; `admin.agents.create` (with `organizationId` it also adds
the agent) and `.update`; `admin.memberships.add` and `.remove`;
`admin.groups.create`, `.rename`, `.delete` and `.reorder`;
`admin.appearances.add`, `.remove` and `.reorder`; `admin.agents.restore`
(`{ agentId }`); `admin.settings.set`
(`{ target, id, adapterId?, modelId?, effort?, options? }`) and `.clear`
(`{ target, id, fields }`); and `admin.adapters.refresh`. Arguments are the
route bodies without `version`, plus the target IDs the route
takes in its path, within the same size limits. A call must come from the
current attempt of a running run that is not stopping; while the run waits on a
question or approval, calls are refused. A write that commits before a Stop
stands; after it, calls are refused. Each write, an instructions save included,
is recorded under the admin agent with its explicit `operationId`. Reusing that
ID with the same validated request returns its recorded result across attempts;
changed fields or targets conflict. A different ID is a separate request even
when its fields match. `admin.operations.get` reads the receipt by ID. New
attempts receive bounded factual receipts for earlier operations in the same
run, including operations whose tool reply was lost. This reconciles stable
operation identities, not similar intentions expressed under new IDs. Approval
requests retain their exact-card identity; adapter refresh has no saved mutation
receipt.

Agents and organizations take new work only while they are live: provisioned
and `active` (`kipster.live_agent`, `kipster.live_organization`). Every writer of
agent- or organization-owned state, from submissions, delegation and dispatch to
memory, relationships, vectors, task data, files, voice, publications,
extraction and sleep, checks its owner in its own transaction under a key-share
lock on the owner row, taken after the installation's execution lock and before
thread and run rows. A lifecycle change takes the execution lock, then locks the
row for update, and when the owner leaves `active` it fences the owner's work in
the same transaction, as Stop does: queued and waiting runs are cancelled and
stay visible, pending questions are cancelled, running work is marked stopping
and its adapter is asked to cancel, and maintenance not yet issued is cancelled.
The process that drives an attempt delivers the cancellation within seconds,
whichever process committed the change. A
stopped delegated child fails back to a parent that is still working. So a write
either commits before the change and is then stopped, or waits for it and is
refused; a late provider output is rejected. Chats of an archived agent stay
readable, and `POST /v1/direct-chats` still opens an existing one; a new chat
needs a live agent. Indexing skips owners that are not live, and a lease that ends after
the change writes nothing.

Long administration operations run in steps from the `administration` job
queue, only while the dispatcher coordinates, with at most one waiting wake-up
per operation. Each step does one bounded batch in a transaction that also
records its progress and any follow-up wake-up, so a batch commits exactly once.
A step waits, with its reason in `waitingFor`, while a provider could still
write, and never forces. Cancellations a step requests are delivered right after
it commits. At start, every unfinished operation continues where it stopped.
`GET /v1/operations/{operationId}` also reads operations the admin agent
started, by their `<attemptId>:<callId>` ID.

Snapshots and events define separate application and thread cursor scopes and
resource revisions. Each snapshot includes page pointers. Fetch the next page
with `at` set to the first page's cursor; if state changed between pages, the
server returns `resync-required` and the client restarts the snapshot. Subscribe
from that first cursor after completing the pages. An expired stream cursor returns
`resync-required` and requires a fresh snapshot.

The application snapshot lists the caller's notifications oldest first, by
`createdAt`. Each carries a `revision`, and an interaction notification carries
its interaction's current `interactionState` (`pending`, `settled`, `cancelled`
or `superseded`). Marking it read changes only the notification. When the
interaction is answered, cancelled (Stop, a stopped parent or a lifecycle fence)
or superseded, Core publishes the notification again with the new state and the
next revision, so a snapshot after an expired replay shows each notification as
it currently is. A client replaces a notification when the event's revision is
not older.

A chat is gone when it no longer exists, when its agent is being deleted
(`deleting` or `deleted`), or when its organization is being deleted. Reading or
controlling a gone chat, its threads, their notifications or their questions
returns `410 gone`, and an open thread stream ends with an `event: gone` frame.
Snapshots omit gone chats, and their threads publish no further application
events, so a client drops the thread summaries and notifications of an agent or
organization when the directory shows it being deleted. New work is refused with
a stable code: `410 organization-deleted` in an organization being deleted,
`403 membership-removed` for an agent that is no longer a member, while its chat
stays readable, and `409 agent-archived` for an archived agent.

The internal work reducer defines preparation, issued dispatch, actual permit
ownership, uncertainty, cancellation and queue advancement. The deterministic
adapter under `tests/fixtures` is test-only.
`defineClientOptions` normalizes a backend URL without making network requests.

Memory maintenance learns from completed conversations only while learning is on. The installation switch is off by default and each agent's switch is on by default; an agent learns only while both are on. Turning the installation switch on requires an embedding profile. `runtime.learning` reads and changes the switches and sleep times for the installation owner, as do `GET /v1/settings/learning`, `PUT /v1/settings/learning` with `{ "version": 1, "enabled"?: boolean, "sleepTime"?: "HH:MM" }` and `PUT /v1/agents/{agentId}/learning` with `{ "version": 1, "enabled"?: boolean, "sleepTime"?: "HH:MM" | null }`; each body needs at least one of the two fields. Each change publishes one `learning-changed` application event carrying the new revision, switch and sleep time. A conversation that completes while its agent is not learning is never captured. Switching learning off skips queued sources with reason `learning_disabled`, including a claimed source that has not reached its provider; running extraction finishes but commits nothing. A switch change waits for an extraction commit already in progress. Turning learning back on does not revive skipped sources; a skipped conversation is learned only if its content later changes while learning is on. Use an adapter that declares maintenance support and compatible durable recovery. Extraction runs share ordinary execution capacity and retain permits when provider termination is uncertain. Text reserves a permit for due maintenance only while an available adapter declares maintenance support; this check does not consider which adapter each source's agent uses. Repair scans use PostgreSQL 17 or later transaction timeouts.

Each memory has a strength, `importance × (1 − 0.5^evidence) × 0.5^(age / (30 × evidence))`, that ranks retrieval and decides forgetting. Deliberate saves and explicit requests have importance 1. Any other learned memory takes the importance its extraction reports (0.2 to 1, default 0.5) when it forms. Evidence counts the distinct conversations that support a memory; the agent's own words count once. New support adds evidence and resets age. Recall into an execution, as automatic context or through `memory.search` or `memory.get`, resets age without adding evidence. Only relevant memories count as recalled: automatic context includes a memory only when its relevance reaches 0.3 (`MEMORY_RECALL.minRelevance`), and `memory.search` refreshes only results at that relevance, although it still returns weaker ones. Lexical matching ignores very common English words, so a memory that shares only such words with a conversation is not recalled and keeps fading. Age counts the agent's active days: days on which it starts work while learning, so an idle agent, or one that is not learning, forgets nothing. Retrieval scores relevance × (0.6 + 0.4 × strength). Organization memories do not age.

Each agent that learns sleeps once a day, at its sleep time in the host's local time zone: its own, or the installation default of 01:00. A sleep is due once that time has passed and the agent has not slept since, so an agent that never worked still sleeps, and after downtime an agent sleeps once, not once per missed day. `openRuntime` accepts a `clock` function for this schedule and the UTC active-day counter. Sleep starts only while none of the agent's executions is in flight, pauses whenever one starts, and commits bounded batches under the capacity lock. Consolidation reads a coherent, read-only vector snapshot outside that lock with a 30-second budget; enqueueing rechecks the exact sleep, learning and idle state under the unchanged eight-second mutation budget. A timed-out snapshot fails and is deferred, rather than treated as empty input. Its progress is recorded in `memory_sleeps`, so an interrupted sleep resumes after a restart and a finished one is not repeated for its day; the latest seven sleeps of each agent are kept. Switching learning off for the agent or the installation records an unfinished sleep as skipped. Forgetting happens only during sleep: it deletes the agent's memories whose strength fell below 0.05, with their sources, provenance, vectors, extraction claims, save and correction receipts, and every link to or from them; a surviving link drops only its citations of a forgotten memory. Deliberate saves follow the same rule and last longer.

Before forgetting, a sleep consolidates. It takes up to 40 learned memories that formed, or gained evidence, since they were last consolidated and whose vectors are ready, and pairs each with its three nearest memories visible under the organization home rule below, so memories homed in different organizations are never paired. With no such memory, or with a single memory and no pair, there is no model call. Otherwise one maintenance run, with the agent's own configured model, judges each pair as `same`, `contradicts`, `related` or `none`, and may distil up to three lessons that each cite at least two of the memories. The run shares maintenance capacity, durable recovery and the commit fence with extraction; the sleep waits for it. Its result applies in one transaction: `same` absorbs a learned memory into the other as evidence, keeping a deliberate save or lesson, else a global memory, else the older one, and never changes a deliberate save's text, and an absorbed memory's links are removed with it; `contradicts` and `related` add links until the agent has 1,500; a lesson forms as a global memory with origin `lesson`, the distinct conversations of the memories it cites as evidence and their highest importance. Anything naming a memory that changed since the sleep began, and any lesson that breaks these rules, is skipped. The sleep's own output never becomes new material. If learning stops before the result applies, nothing applies and the sleep is skipped; an answer that does not follow the format fails the run without changes and the memories are offered again at the next sleep. A run whose answer was lost in a crash is asked again once after reconciliation.

After forgetting, a sleep promotes the agent's strongest knowledge into its identity. The promotable set is the agent's global memories, never those homed in an organization, at strength 0.75 or above, at most the 40 strongest. Reaching 0.75 takes an importance of at least 0.75 and at least two supporting conversations. A memory already promoted stays while its strength is at least 0.7, so a memory near the threshold does not enter and leave on alternate nights. Core records which memory revisions the Learned section of `identity.md` was last built from. While the set is unchanged there is no model call. When it changes, one maintenance run with the agent's own model receives the set and the current section, including any owner edits to it, and returns `{ "section": string }`: the new section, at most 2,048 bytes of UTF-8 without the section markers, so a memory that weakened or was forgotten drops out. A set that became empty while the section is already empty is recorded without a call. The section is written through the identity writer's compare-and-swap against the `identity.md` version the sleep read; `soul.md`, `AGENTS.md` and all text outside the markers are never changed. Text the owner wants to keep regardless of memory belongs outside the markers. An edit to `identity.md` after the sleep read it wins: nothing is written and the next sleep tries again, as it does after an answer that is too large or malformed, or a file with malformed markers. If learning stops before the result applies, nothing is written. The sleep report records each promotion as `{ memories, added, removed, bytes }` or `{ failure }`.

A memory learned from an organization conversation has that organization as its home and surfaces only in executions of that organization: in automatic context, `memory.search`, `memory.get`, link expansion and the relationship tools. The home is set when the memory forms; later support, recall or correction never moves it, except that an explicit request repeating a learned memory makes it global with importance 1. Every other agent memory is global and surfaces in every context: deliberate saves, explicit requests and memories learned outside organizations. An explicit request is a human message that asks the agent to remember something or to adopt a standing instruction, such as “remember…” or “from now on…”; the extraction marks it, and Core accepts the mark only for a human author. An execution outside organizations, such as an installation conversation, sees only global memories. `memory.publish` accepts a memory only in the organization where it is visible. Deleting an organization deletes the memories homed there. `runtime.memory.get`, `search`, `context` and `correct` apply the same rule to the organization they are given, which is none by default for `correct`.

Operators can use the installed package without starting another coordinator:

```js
import { status, list, inspect, requestAction } from '@kipster/core/maintenance'
import { readHostConfig } from '@kipster/core/host'
const connectionString = (await readHostConfig('/path/to/host.json')).config.databaseUrl
console.log(await status({ connectionString }))
console.log(await list({ connectionString, status: 'recovery', limit: 20 }))
console.log(await inspect({ connectionString, sourceRunId }))
await requestAction({ connectionString, opId: crypto.randomUUID(), action: 'reconcile', target: { runId } })
```

Read functions open and close their own database connections. Pass `installationId` when the database holds more than one installation. `requestAction` appends an idempotent intent; the running coordinator applies it. Available actions are `skip-source`, `requeue-source`, `cancel`, and `reconcile`. `requeue-source` is refused while the source's agent is not learning. `requeue-source` requeues the revision that matches the source's current content; its result includes `alreadyQueued` when that revision was already pending. Content that is edited and then restored is extracted from its earlier revision when that revision was never extracted. Inspection omits source message text: `inspectRun` reports a run's task, `extract`, `consolidate` or `identity`, and its staged output only as a count and digest, and staged output is discarded when a run leaves `running`. `status` includes the latest background failure from a tick, repair scan or sweep until a later tick completes without one. Reconciliation releases capacity only after compatible provider confirmation; an unknown outcome keeps it reserved.

## Boundaries

- Protocol and client exports stay browser-safe and free of backend imports.
- Domain modules access other modules through `public.ts` and cannot import
  transports, runtime composition or cross-module workflows.
- Adapters receive host services explicitly; importing a contract must not
  create a Core runtime.
- Liveness is tested with `kipster.live_agent` and `kipster.live_organization`;
  the boundary check rejects raw `provisioned` guards.

The package tests install a tarball outside the repository and verify exports,
declarations, import side effects, browser bundling and adapter host injection.

## Host commands

A host's first start creates the Playground starter from `src/starter/playground`:
the Playground organization, Admin, and four agents in two groups, each with
starter identity files. A later start never adds them again.

The package supplies `kipster-host setup|serve|start|stop|restart|status|doctor|service-template --config <file>`. Read the [macOS host setup guide](docs/host-macos.md) before configuring dependencies or registering a service. Doctor is passive unless `--probe` is explicitly requested.

## Database migrations

Migrations are forward-only. A file merged into `next` is shipped: never edit,
delete, move or renumber it, including the existing 001–013 files. Every schema
change or fix adds `NNN_name.sql` in the owning module's migrations directory,
with a unique three-digit number above the highest on the base branch, and adds
its path to `loadMigrations()` in `src/runtime.ts` in number order.

Run `npm run check:migrations -- --base origin/next` from `core` before merging.
CI checks PRs against their base and pushes to `next` against the previous commit;
`test:postgres` also upgrades a populated database made from that base's SQL.
If another PR takes your number, update from `next` and renumber your unshipped
addition before merging. A collision already merged requires owner recovery;
stop rollout rather than editing shipped files.

Rollback restores the database backup taken before the upgrade and runs the
matching Core version. Core refuses newer, changed or incomplete migration
histories; there are no down migrations. Backup and updater tooling is deferred.
