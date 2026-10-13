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
several connection pools and relies on real deadlines. Tests that need
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
| `@kipster/core/client` | JSON types, `defineClientOptions` for HTTP(S) URL configuration and `createClient(options, fetch?)`, which reads bootstrap and calls the plugin routes. |
| `@kipster/core/adapter` | Injected text execution context with the Kipster tool definitions and extra MCP servers (`mcpServers`) of the execution, opt-in maintenance context for the steps of Kip memory's nightly run, readiness catalog, events, controls, reconciliation and durable recovery references. |
| `@kipster/core/transcription` | Replaceable provider contract for derived audio text; no provider is selected by importing it. |
| `@kipster/core/runtime` | Node-only `openRuntime`, `AdapterRegistry`, `TextDispatcher`, `textPublicationHost` and `startTextServer`. All startup is explicit. |

Pass an optional `onError(error)` to `openRuntime` to observe background failures that Core recovers from on its own: database connections lost while idle and job-queue errors. A background queue error does not fail later submissions; `runtime.jobs.error` holds it until the job worker next receives jobs. Observer failures are ignored.

One `TextDispatcher` per database holds the coordinator lock on a dedicated connection. Every claim and issue checks in the same transaction that this lock session still holds the lock, so a silently dropped connection cannot let two dispatchers run work. When the loss is detected, the dispatcher stops claiming and issuing, leaves wakeups for the lock holder, lets in-flight attempts settle, and retries the lock with backoff (0.5 s, doubling to 10 s). Another dispatcher may take the lock meanwhile; turns whose attempts it recovers are cancelled here. The dispatcher resumes only after it holds the lock again and has recovered abandoned work, excluding work it still prepares or runs itself. The optional `coordinatorLock(state, error)` dispatch hook reports `lost`, `retry-failed` and `restored`.

Register a separately installed adapter with `AdapterRegistry.register(id, installationRoot, entryRelative, signal?, config?)`. The optional configuration object is passed to the adapter factory as its second argument; Core does not interpret provider-specific fields. Pass a persistent generation directory as the registry constructor's second argument. The installation root must contain the adapter and its transitive runtime dependencies; registration snapshots and hashes its bytes, rejects symlinks, checks the contract and readiness, then atomically replaces the route. `remove(id)` stops new admission and drains active attempts. `refresh()` probes each adapter's readiness again; an adapter that is not ready takes no new work until a later probe finds it ready. An issued attempt with a lost execute acknowledgement retains its generation until confirmed settlement. Close the dispatcher before closing the registry and runtime. Model catalog discovery validates a selection but does not guarantee that a provider will accept a turn. Configured option keys must be advertised by the adapter catalog; unsupported keys fail during preparation.

An adapter may implement `forgetProviderState({ threadIds })`. When conversations are permanently deleted, Core passes it the provider thread IDs its attempts reported in `provider` events, so it can remove the state it keeps for them, such as session files. The call must be safe to repeat and ignore unknown IDs. Core routes each ID to the adapter that ran the attempt; an adapter without the method, or one that is no longer registered, leaves the state in place and the deleting operation reports it.

Pass an `EmbeddingProvider` from `@kipster/core/embedding` as `openRuntime`'s `embedding` option. Hosts load one provider from `embedding: { module, options }` in host.json. With `embedding.server`, the host supervises Kipster's installed llama.cpp `llama-server` (`EmbeddingServerSupervisor`) and gives `@kipster/embedding-llama-cpp` its actual endpoint; see the [host guide](docs/host-macos.md). Format text for EmbeddingGemma 2 with `embeddingQuery(text)` and `embeddingDocument(text, title?)` from `@kipster/core/embedding`. The provider ID and model identify the vector space. A changed embedding profile activates a new generation on the next start and queues vector collection records for re-embedding; searches use only active-generation vectors. Kip memory searches only rows embedded with the current model and is not re-embedded: changing its model is not offered yet ([decision record 10](../docs/initial-implementation-plan/10-kip-memory.md), section 7). Kip memory is described [below](#kip-memory).

`runtime.vectors` provides named agent or active-organization collections independently of automatic memory retrieval. The `vector_collections` Core tool supports `create`, `discover`, `describe`, `get`, `upsert`, `search`, `delete_record`, and `delete_collection`. Target owner is explicit; Core binds the acting agent and current attempt. Collection names are lowercase identifiers (up to 40 characters); records use stable keys (up to 100 characters) and revision checks (`expectedRevision: 0` creates). Text is limited to 8 KiB and metadata to 2 KiB. A record keeps only its current source. A collection holds at most 1,000 records and 8 MiB of retained source bytes. An owner holds at most 100 collections. Limits reject writes explicitly. Lists and searches return at most 20 items per page. Search cursors bind the query, collection revision and embedding generation; a source or index change invalidates the cursor and requires restarting pagination. Search returns `availability`, `pending`, and `failed` alongside compatible active-generation matches. Canonical text remains readable while indexing is pending or the provider is unavailable. Collection and record deletion remove retained sources and derived embeddings.

`startTextServer` trusts its configured listening host and actual bound port, including an ephemeral port. Every request must use that authority in `Host`; optional `allowedHosts` adds explicit authorities such as `kipster.example` or `localhost:8080`. When binding a wildcard address, list the actual client-facing hosts explicitly. The server never derives trust from a request's `Host` or forwarded headers.

Browser requests may use the exact listening origin or an exact HTTP(S) origin in `allowedOrigins`. For a reverse proxy that preserves `Host: kipster.example`, configure both `allowedHosts: ['kipster.example']` and `allowedOrigins: ['https://kipster.example']`; a separate UI origin belongs only in `allowedOrigins`. Adding a browser origin does not authorize its Host, and adding a Host does not authorize its Origin. Originless trusted clients remain supported using the listening or explicitly allowed Host.

These checks reject browser-origin/authority spoofing, including matching untrusted Host/Origin pairs, before reads or mutations. They are not user authentication: a non-browser client can supply trusted headers. Keep this trusted-owner server behind the installation's private access boundary; configure proxy access controls separately.

Managed files use `/conversations/media`: capabilities, bounded binary upload with a stable upload ID, receipt lookup, artifact metadata and content download. Uploads belong to their installation or organization context. Only verified ready originals can enter ordered message parts; a file-only message is valid. Downloads verify bytes and use attachment disposition. Output tools write bounded UTF-8 files in the current attempt, publish immutable agent-owned snapshots, and can explicitly copy one into the active organization. An attempt may write up to 32 output files and make up to 32 publications, subject to byte limits. File associations do not change ownership. Interrupted disk/SQL publication is reconciled as a verified upload or an explicit failed operation; failed operation files are cleaned during normal recovery. Historical files with unavailable managed bytes remain explicit unavailable input parts, so later text work can continue without claiming their contents were read.

Agents can discover authorized peers and delegate bounded work through Core-bound tools. Each delegation creates a private child run with a durable parent relationship; the child uses its own agent identity for memory and files. Human questions from a child appear on the originating thread and answers return to that child. Parent continuation receives saved child results in request order after the parent provider turn ends. Stop propagates to active descendants; uncertain provider termination retains capacity until reconciliation.

Rich documents are block documents agents write for the owner to answer, edit, comment on and submit; see [decision record 7](../docs/initial-implementation-plan/07-rich-documents.md). Bootstrap capabilities include `documents: true`. The owner's routes, with shapes from `@kipster/core/protocol`:

| Route | Purpose |
| --- | --- |
| `GET /v1/documents` | Every document of the installation (`documentList`). |
| `GET /v1/documents/{id}` | Summary, current revision, draft, comments and revision list (`documentDetail`). |
| `GET /v1/documents/{id}/revisions/{number}` | One revision (`documentRevisionResult`). |
| `PUT /v1/documents/{id}/draft` | Save the draft (`documentDraftWrite` → `documentDraftResult`); `409 conflict` on the agent's turn, a stale `baseRevision` or a stale `expectedDraftVersion`. |
| `DELETE /v1/documents/{id}/draft` | Discard the draft; returns `documentDetail`. |
| `POST /v1/documents/{id}/submit` | Submit (`documentSubmit` → `documentSubmitResult`), repeatable by `operationId`: creates the user revision, opens its comments, posts `[note, document card]` to the home thread and starts the agent's run there. |
| `POST /v1/documents/{id}/take-back` | End the agent's turn and discard its unpublished edits (`documentTakeBack` → `documentDetail`). |
| `DELETE /v1/documents/{id}` | Delete; returns `{ version: 1, id }` and publishes `document-removed`. |
| `GET /v1/documents/{id}/artifacts/{artifactId}[/content]` | Metadata or bytes of a file the document references, as the media artifact routes return them. |

Every change publishes `document-changed` with the summary; a draft save publishes only when the summary changes. Agents use `documents_create` (`{ title, markdown, organizationId? }`; the admin agent may name another organization), `documents_list`, `documents_read` (`{ documentId, revision? }`), `documents_edit` (`{ documentId, operations }` with `replace`, `insert`, `delete`, `move`, `title` and `resolve`) and `documents_delete` in a Markdown dialect that Core parses and serializes. An agent sees the documents of its context; the admin agent sees all. Edits form one revision when the run ends, and are refused while the owner has an unsubmitted draft.

Each agent home holds `AGENTS.md`, `soul.md` and `identity.md`; every execution reads them fresh. Core changes them only by compare-and-swap: the caller supplies the SHA-256 it read, and a file that changed since then fails with `409 conflict` instead of being overwritten. A write syncs a temporary file, checks the live file again and renames it into place, so a crash leaves the previous or the new file, never a partial one; it may leave a hidden temporary file, which is never read. The replaced version is kept under `backups/<file>/` in the agent home, and only the latest five backups of each file remain. The owner may change any of the three files with `GET` and `PUT /v1/agents/{agentId}/identity/{file}` (`{ "version": 1, "content": string, "expectedSha256": string }`), list and read backups with `GET .../backups` and `GET .../backups/{backupId}`, and restore one with `POST .../backups/{backupId}/restore` (`{ "version": 1, "expectedSha256": string }`). A restore is itself a write and keeps a backup. Each save or restore publishes an `identity-changed` application event (`{ agentId, file, sha256 }`); an instructions save publishes `instructions-changed` (`{ organizationId }`). The admin agent has the same access to every agent's files. A non-owner write (`IdentityFiles.replaceLearned`) may change only the text between `<!-- kipster:learned:begin -->` and `<!-- kipster:learned:end -->` in `identity.md`, appending that section when it is absent; all other text is changed only by the owner. Kip memory never writes identity files. Identity files must be regular UTF-8 files of at most 64 KiB. An edit saved outside Core in the instant between the final check and the rename can still be lost.

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
| `GET`/`PUT /v1/settings/interface` | The installation's interface choices: `palette`, `theme` (`light`, `dark` or `system`) and `desktopNotifications`; null leaves the interface default. A `PUT` (`{ "version": 1, "palette"?, "theme"?, "desktopNotifications"? }`) changes the given ones and publishes `interface-changed` when one differs. Bootstrap advertises `capabilities.interfacePreferences`. |
| `GET`/`PUT /v1/settings/permissions` | The installation's permission mode and always-allowed actions, `{ "version": 1, "revision", "mode", "alwaysAllowed": [{ "id", "label", "createdAt" }] }`: what kips may do without asking. `supervised` asks before commands and file changes, `acceptEdits` approves edits and asks before other actions, `auto` (the default) lets providers that support it approve routine actions, and `fullAccess` allows commands and edits without prompts. A `PUT` (`{ "version": 1, "mode"?, "removeAlwaysAllowed"?: [id] }`) publishes `permissions-changed` when anything changes. Every text execution receives the mode as `permissionMode`; maintenance executions are unaffected. Bootstrap advertises `capabilities.permissionModes`. |

An approval card raised by an adapter for a provider's own request may carry a
`grant`: a label for the action and the `scopes` the person may choose,
`conversation` or `always`. Answering `{ "kind": "approve", "scope": … }` allows
the action beyond that card: for the rest of the conversation, or for every kip
until the person removes it from `alwaysAllowed`. Core passes the grants that
apply to each execution as `approvalGrants`, and the adapter answers matching
requests without asking. An approval without a scope allows one request.

When a run continues after waiting for the person or a delegated kip, its execution also carries `resume`: the
provider thread the previous attempt reported and a short continuation prompt. An adapter that can reopen that
session sends the continuation instead of the full prompt, so the kip carries on with its own history. A Retry after a
failure starts fresh.

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

The admin agent administers the installation from its installation chat with two
tools. `admin_operations` lists the administration catalog by area, or describes
one operation: its kind and its arguments as JSON Schema. `admin_call` runs one
operation (`{ operation, arguments?, operationId? }`). Operations call the same
services as these routes, so they produce the same records and events, and take
the route bodies without `version`, plus the target IDs the route takes in its
path, within the same size limits. The catalog covers the directory,
organizations, agents, identity files, memberships, groups and appearances,
execution settings, adapters, learning, interface choices, updates and
operation receipts; `core/tests/admin-parity.test.mjs` fails when a route has
neither an operation nor a stated reason to be left out. Core offers the tools
only for the admin agent's own work in the installation context, names the
`kipster-admin` skill file in its instructions, and checks again on every call;
organization chats and delegated work get no administration tools. A call must
come from the current attempt of a running run that is not stopping; while the
run waits on a question or approval, calls are refused. A write that commits
before a Stop stands; after it, calls are refused.

Writes with a receipt, an instructions save included, need an explicit
`operationId` and are recorded under the admin agent. Reusing that ID with the
same validated request returns its recorded result across attempts; changed
fields or targets conflict. A different ID is a separate request even when its
fields match. `operations.get` reads the receipt by ID. New attempts receive
bounded factual receipts for earlier operations in the same run, including
operations whose tool reply was lost. Identity file saves are guarded by their
`expectedSha256` instead; learning and interface choices are saved by value.
Archiving or deleting an agent, deleting an organization and installing or
restoring a Core version ask the owner with a Core approval card bound to the
exact target. An approved install starts after the answer is saved, under the
card's operation ID, so a repeated answer installs once.

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

A notification's `preview` is a single line of at most 200 characters, cut with
`…`: the run's last final reply text for `completed`, the failure for `failed`
and `recovery-needed`, the prompt for `interaction`. It is omitted when empty.
`POST /v1/notifications/read` and `POST /v1/notifications/clear` take
`{ version: 1, notificationIds }` with 1 to 200 distinct IDs and skip IDs that
are unknown, gone or another person's. Read returns `{ status: "read",
notificationIds }` (already-read ones included). Clear returns `{ status:
"cleared", cleared, kept }`: a cleared notification is read, leaves snapshots,
is never published again and reads as `410 gone`; clients receive
`notification-removed`. A notification whose interaction is still `pending` is
kept. Bootstrap advertises `capabilities.notificationActions`.

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

### Kip memory

Memory follows [decision record 10](../docs/initial-implementation-plan/10-kip-memory.md). The installation switch is off by default and each agent's switch is on by default; an agent has memory while both are on and it is live. Memory works without an embedding provider; `available` only reports whether meaning search has one.

`runtime.learning` reads and changes the memory settings for the installation owner or the admin agent, as do `GET`/`PUT /v1/settings/learning` and `PUT /v1/agents/{agentId}/learning`, and the `learning.*` administration operations. The installation body is `{ "version": 1, "enabled"?, "sleepTime"?: "HH:MM", "nightlyModel"?: { "adapterId", "modelId", "effort"? } | null, "coreCardCount"?: 0-200, "searchCardCount"?: 0-50, "searchChunkCount"?: 0-30 }`, with at least one field; an agent's body is `{ "version": 1, "enabled"?, "sleepTime"?: "HH:MM" | null }`. The counts default to 60 core cards, and 10 cards and 6 thread chunks from a turn's search. A null nightly model runs the nightly steps with Kip's model: the main kip's resolved execution settings in the installation. A nightly model is checked against the connected adapter catalog when it is set and again when the run uses it. Each change publishes one `learning-changed` application event with the new revision; an installation change also carries the nightly model and the counts. `memorySettings(db, installationId)` reads them for Core's own use.

The nightly run (`NightlyMemory`, driven by the coordinating `TextDispatcher` every minute and by `nightlyTick()`) runs each agent once per sleep day, which starts at its sleep time in the host's local time: its own, or the installation default of 01:00. After downtime a missed night runs once when Core next coordinates. An agent with nothing new has its night recorded, so a message later that day waits for the next sleep time. For each thread with final messages after its `processed_position`, oldest first, it:

1. Writes full-text thread chunks with a header (date, kip, organization). A thread segment of up to 600 words is one chunk without a model call; a longer one is split at the topic starts the model proposes, in windows of about 6,000 words, and further at message boundaries so a chunk holds at most about 600 words. A message longer than that is a chunk of its own. A grown thread's chunks are rewritten from its last chunk onward. Progress notes and internal (delegated) threads are left out, and processing stops before a message still being written.
2. Proposes card changes from the user's own new messages, compared with the nearest current cards visible in the thread's context: add, update, replace or skip, each citing its source messages. A change citing a kip's message, an unknown ref or a card outside the thread's context is dropped. A card from an organization thread carries that organization.
3. Writes the diary page of each local day covered in the thread's context (its organization, or none), built on that page's current summary.
4. Saves the chunks, card changes and sources, diary pages and the new processed position in one transaction, only while this Core still runs the agent, the agent has memory and the thread is unchanged. A failure leaves the thread for the next run.

Before its threads, the run rebuilds every diary page that owes one because a thread it covered was deleted: from scratch, from the processed messages of that day of the page's remaining threads, with the same diary prompt in windows; a page with nothing left is deleted. After its threads, the run re-picks the core cards: replaced and organization cards stop being core; while the current installation cards fit the core card count all are core, otherwise the model ranks them and Core keeps the count. Only cards still current when the ranking is saved become core; a ranked card replaced meanwhile passes its place to its replacement. Then `embedPending()` embeds every chunk, card and diary page saved without an embedding, with `embeddingDocument(text, title)`, and stores the model; without a provider the rows wait. With a provider, rows waiting for an embedding make a night due even without new messages: an agent's own chunks and diary pages, and cards, which are shared, for any agent whose sleep time arrives: another due run embeds them, otherwise one agent whose night begins (Kip first) runs for them alone. A night whose provider fails is still recorded as finished, without a retry that night; its rows wait for the next sleep time. An embedding failure never undoes saved work.

Every model call is a work intent with an issued attempt that holds an execution permit, run through the adapter registry's `maintenance` route as `{ task: 'memory', step, instructions, outputSchema, settings }` with a 15-minute deadline. One nightly call runs at a time per installation, and it takes the last free permit only while no user turn waits for one; otherwise it waits up to a minute and the run is deferred to a later tick. Shutdown cancels the call in flight. A call left by a lost process is failed by the next coordinator, which frees its permit; the call has no other effect, so it is not reconciled. A failed run is tried again after 30 and 60 minutes and given up for the night after three failures; its threads, and a core re-pick it still owes after changing cards, are caught up by the retry or the next night. Only the Core incarnation that claimed a kip's run saves its results or records its outcome, so a call or failure from a process that lost the coordinator is discarded. Core owns the versioned templates and output schemas in `modules/memory/prompts.ts` and validates every answer again; messages and cards are named by short refs Core maps back.

`CardService` creates, updates, replaces, deletes, lists, reads and finds the nearest cards. Every write records its sources: user messages of threads in the card's own context. A content change clears the embedding. Replace ends the old card with `valid_to` and `replaced_by` and keeps its row. Delete removes cards with their sources and embeddings and never touches messages. `nearest` searches current cards an installation context or one organization may see by cosine distance, then fills with unembedded cards, falling back to the same subject and the most recent cards without a provider.

Every turn of an agent with memory on (`turnMemory`) gets, in order:

1. The core cards at the end of the instructions: current installation cards marked core, oldest first, up to the core card count. Organization cards are never core. The text holds no time of the turn, so it stays byte-identical until the cards change and provider prompt caches keep working.
2. Before the history, as `memory` in the execution context and in its `prompt`: a meaning search for the user's message, embedded with `embeddingQuery` within 3 seconds. It shows the search card count of nearest current cards, then the search chunk count of nearest thread chunks and diary pages ranked together, as whole items with their thread IDs and dates; only rows embedded with the current model count. The current thread's chunks are left out, and so is a diary page that covers only the current thread. Without a provider, or when embedding fails, one line says search is unavailable this turn.
3. A line counting the agent's threads with messages the nightly run has not processed, pointing to `memory_recent_threads`, left out at zero.
4. The thread's history, which names the thread ID (`threadId` in the context).

What a turn's prompt shows follows decision record 10, section 2: installation cards plus the current organization's, and only the agent's own chunks and diary pages of installation threads plus the current organization's. A diary page belongs to one context, so it names only threads of that context. Kip's prompt is scoped the same way.

The memory tools (`memoryTool`) are offered only while the agent has memory on, and refuse calls once it is off:

- `memory_search(query, from?, to?, agent?)`: the same search, optionally within ISO dates (chunks by their time span, diary pages by day, cards by `valid_from` and `updated_at`). Without a provider it returns `{ status: 'unavailable', reason }`.
- `memory_recent_threads(agent?)`: up to 30 unprocessed threads, latest first, with ID, kip, times, processed position and first line.
- `memory_read_thread(threadId, fromPosition?, toPosition?)`: a page of final messages, at most 50 and about 60,000 characters; `nextPosition` continues.
- `memory_remember(statement, type, subject, details?)`: a confirmed card in the current context (the organization of an organization thread), sourced to the message the run answers, embedded at once when the provider answers.
- `memory_forget(cardId | query)`: deletes visible cards, current or ended, with their sources and embeddings; messages stay. A query matches statement or subject case-insensitively and deletes at most 20 cards; with more matches it deletes none and returns the candidates.

A kip's tools see installation cards plus the current organization's, and its own threads in installation and current-organization chats; a delegated thread belongs to the kip whose chat holds it. Kip, the root administration agent, sees every card and every kip's threads through its tools, and only Kip may pass `agent` to read one kip; from any other kip it is refused.

## Plugins

Core relays the person's [Kipster Plugins](https://github.com/manikanta-kops/kipster-plugins) server, its control API v1, to interfaces. Bootstrap advertises `capabilities.plugins`; a Core without the flag reads as `false` (`bootstrap` in `@kipster/core/protocol`). While plugins are off, every route below answers `503 plugins-unavailable`. Responses are the plugin server's JSON with `version: 1` added and may gain fields; errors keep the plugin server's `code`, such as `unknown-plugin` or `invalid-label`. Requests take an optional `version: 1`. Paths are in `pluginPaths`, codes in `pluginErrorCodes`.

| Route | Shapes |
| --- | --- |
| `GET /v1/plugins` | `pluginList` |
| `GET /v1/plugins/{id}` | `pluginResult`: the summary with its accounts |
| `POST /v1/plugins/{id}/sign-in` | `pluginSignInRequest` `{ address?, returnAddress? }` → `pluginSignInStart` |
| `GET /v1/plugins/sign-ins/{id}` | `pluginSignInStatus`: `pending`, `completed` with the account or `failed` with a `code` |
| `GET /v1/plugins/accounts[?plugin=]` | `pluginAccountList` |
| `PATCH /v1/plugins/accounts/{id}` | `pluginAccountRename` `{ label }` → `pluginAccountResult` |
| `PUT /v1/plugins/{id}/default-account` | `pluginDefaultAccountWrite` `{ account }` → `pluginDefaultAccount` |
| `DELETE /v1/plugins/{id}/default-account` | `pluginDefaultAccount` |
| `DELETE /v1/plugins/accounts/{id}` | `pluginAccountRemoval` |

`GET /plugins/callback` needs no Kipster session: it is the sign-in return address for a browser that reaches Core rather than the plugin server, and forwards its query unchanged to the plugin server's `/callback`, answering with its page. It keeps Core's Host and Origin checks. Core refuses a `returnAddress` whose path is not exactly that route, or whose host is neither Core's listener nor one of `listen.allowedHosts`, with `400 return-address-refused` before asking the plugin server. Without `returnAddress` the plugin server's own loopback callback is used. The plugin server's `loopback-only`, `invalid-return-address` and `needs-client-metadata-document` explain why it refused a return address or sign-in method. When the plugin server does not answer in time or answers with something Core cannot read, the route fails with `502 plugin-server-failed`.

Kip reaches the same operations through the `plugins` area of the administration catalog; its sign-in has no return address, and it gives the person the `authorizationUrl`. While the plugin server is ready, every conversation execution receives it as `mcpServers: [{ name: 'plugins', url: '<plugin server>/mcp', bearerToken }]`; maintenance executions never do. Core never writes the token to the database, events, logs or prompts.

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

## Updates

Updates are installation-wide. The owner reads or saves `{ version: 1,
channel: "stable" | "next", mode: "automatic" | "notify" }` through
`GET`/`PUT /v1/settings/updates`; a save also requires `operationId`. Defaults
are `stable` and `automatic`. Bootstrap advertises `capabilities.updates`.

The host checks `https://updates.kipster.app/v1/<channel>.json` five seconds
after startup, every 12 hours, after a channel change, and on
`POST /v1/updates/check` (`{ version: 1 }`). Semver, including prereleases,
determines whether Core is newer. Switching to stable waits for stable to pass
the running version and never initiates a downgrade. An optional
`updates: { channelUrl: "https://example.com/v1/" }` in host.json changes the
catalog base for self-hosting. Failed checks report an error without rapid retries.

`updates.managed` in host.json defaults to `false`. Every host still checks and
reports available releases, but installation requires an updater and explicit
`managed: true`. Unmanaged hosts never schedule or write update requests, and
manual installs return `update-unmanaged`.

Automatic installation runs only from 02:00 up to 05:00 in the host's local
time, while unpinned and with no active or uncertain agent execution or
preparation. Core atomically checks shared execution capacity and pauses new
conversation and memory-maintenance admissions before handing off a request.
Queued work stays saved and resumes after a terminal updater result or a pickup
timeout. Manual installation hands off immediately and can interrupt work when
Core restarts.

`GET /v1/updates` returns settings, the last check, the window and Core's
running version, `core.managed`, pin, available channel entry, state, step, error,
last result and updater-reported backups. Every status change publishes `updates-changed`
on the application stream. Response readers tolerate additive metadata and
map unknown policy, state and outcome values to `unknown`.

`POST /v1/updates/install` takes `{ version: 1, operationId, target, pin?,
backupId?, confirmDataLoss? }`. A newer target installs; an older target
requires a listed backup whose `coreVersion` exactly matches and
`confirmDataLoss: true`. Restoring loses data written since that backup.
Refusals use `update-unmanaged`, `update-backup-required`, `update-backup-mismatch`,
`update-confirmation-required`, `update-already-installed` or
`update-in-progress`. A manual target pins by default; `pin: false` leaves
an upgrade unpinned. A restore always pins its target.
`POST /v1/updates/unpin` takes `{ version: 1, operationId }`.
Mutation IDs are scoped to the owner and deduplicated across restarts; changing
the payload under an existing ID returns `conflict`.

Core atomically writes `<home>/updates/request.json` from a durable database
outbox. The separate updater verifies releases, manages backups, installs or
restores, and restarts Core. It atomically writes `status.json`; Core reads it
before dispatch starts, watches replacements and also polls once a minute.
Requests and execution pauses survive Core restarts. If no matching updater
status arrives within ten minutes of writing the request, Core releases the
pause, reports `failed` with "The updater did not start", records a failed result
and publishes `updates-changed`. A stale result cannot settle a newer request,
and a failed target is not automatically retried.
At startup, a matching restore request for the running version supersedes a
request restored from an old database snapshot. Each request carries
`settings: { channel, mode, pinned }`. Core reapplies these settings when it
reconciles the matching restore's terminal status, preserving policy and the
restore target's pin even when the database snapshot predates them.
`runtime.updates` provides the same service to embedded hosts; `openRuntime`
loads file status without network activity, and the host calls
`runtime.updates.start()` to start background checks. Tests can inject
`openRuntime`'s clock and call `runtime.updates.tick()` explicitly.

## Host commands

A host's first start creates the Playground starter from `src/starter/playground`:
the Playground organization, Admin, and four agents in two groups, each with
starter identity files. A later start never adds them again.

The package supplies `kipster-host setup|serve|start|stop|restart|status|doctor|service-template --config <file>`. Read the [macOS host setup guide](docs/host-macos.md) before configuring dependencies or registering a service. Doctor is passive unless `--probe` is explicitly requested.

### Plugin server

With `plugins: { module }` in host.json, where `module` is the absolute path of
an installed `@kipster/plugins` package's `dist/server/cli.js`, the host runs the
plugin server (`PluginServerSupervisor`) on a loopback port and restarts it with
backoff when it exits. Its home is `<home>/plugins`, always with the file key
backend. Core keeps its own files in `<home>/plugins-host`: `token`, at least 32
random bytes in a 0600 file that reaches the server only through its environment,
and `port`, reused while it is free. Server output goes to `<home>/logs/plugins.log`.
The server stops when the host does, including when the host process dies.

The server is ready once `/health` reports control API `v1` and the token opens
`/v1`. Only then does `runtime.plugins.endpoint()` return its URL and token.
Without the `plugins` entry, without the installed package, or while the server
is not ready, plugins are off and the rest of Core keeps working. `status` and
`doctor` report the plugin server's state.

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
histories; there are no down migrations. The [macOS installer](../installer/README.md)
backs up and restores the database with its matching Core release.
