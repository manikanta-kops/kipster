# Decision block 5 — Kipster Protocol

Status: agreed protocol direction, consolidated 2026-09-18 from discussions 5.1–5.7 and the completeness review in 5.8. No application implementation or deployment is implied.

This is the behavioral contract and decision record for future implementation agents. It is not yet a generated OpenAPI specification, final JSON Schema, or exact TypeScript interface set. Operation names, route examples, and state labels express responsibilities unless explicitly identified as fixed conventions. Do not mistake illustrative names for additional product decisions.

## Reading order and precedence

Read these records before implementing this protocol:

1. [Identity and ownership](./01-identity-and-ownership.md).
2. [Conversations and work lifecycle](./02-conversations-and-work-lifecycle.md).
3. [Execution adapters and agent capabilities](./03-execution-adapters-and-agent-capabilities.md).
4. [Storage and recovery](./04-storage-and-recovery.md).
5. This document.

This document refines those records in the areas explicitly listed below; it does not replace their other decisions. All numbered decision records take precedence over earlier tentative suggestions in the [implementation plan](./implementation-plan.md). The project is a fresh implementation: older Kipster systems remain references, not code/schema copying or data-import requirements.

### Important refinements and rejected alternatives

| Topic | Current decision |
| --- | --- |
| Settings edits | Latest backend save wins. No stale-edit revision checking or optimistic-concurrency UI initially. Partial updates change only supplied fields. |
| Submission retries | One submission ID identifies one accepted action. Repeated delivery returns the existing receipt; it does not overwrite work or start it again. No initial payload-mismatch conflict mechanism. |
| Interaction responses | First accepted response wins. Repeated or competing submissions return the recorded outcome. |
| Membership removal | Removes membership/visual appearances, not the agent or its brain. Already-accepted work may finish; removal itself is not cancellation or a new data-access restriction system. |
| Stop and queues | Explicit Stop cancels the current workflow where supported and holds ordinary queued follow-ups. Resume releases those follow-ups, not the cancelled workflow. |
| Generated files | Agent-owned by default; organizational ownership is an explicit publication choice. |
| Memory corrections | Update current memory without archiving every prior wording. Retain source content, current evidence, and embedding-consistency metadata. |
| Production adapter minimum | Execution, standard events, Kipster tool access, and cancellation are required. Steering and native session resumption may be unsupported. |
| Subscriptions | One application subscription and one detailed subscription for the currently open thread. Closing the latter must not lose background notifications. |
| Notifications | Durable notification identity and read/unread state, independent of temporary SSE replay history. Fully closed/suspended app delivery needs a later platform decision. |

## 5.1 — Shared contract conventions and caller context

### 5.1.1 Keep Core simple, but preserve correctness

The initial deployment trusts its operators and agents. Do not build an elaborate permission matrix, granular agent-behavior restrictions, or a cross-agent data-access ban. Agents should be able to use the capabilities already agreed in blocks 1–4.

Core still owns necessary correctness rules: authentic acting-context binding, accurate targeting, durable acceptance, database consistency, avoiding duplicate execution from retries, and preventing obsolete attempts or stale approvals from affecting replacement work. These are infrastructure guarantees, not a new policy engine deciding how agents should reason or collaborate.

### 5.1.2 Actor, requester, context, target, and owner

Keep these concepts distinct:

| Concept | Meaning |
| --- | --- |
| Actor | Human, agent, or system process performing an operation. |
| Requester | Human or agent whose request caused the work, when applicable. |
| Working context | Explicit organization or installation context of the conversation/work. |
| Target | Resource on which an operation acts. |
| Owner | Identity or organization to which stored content belongs. |

```text
Kipster UI -> HTTP -> caller resolver -> configured human initially

Harness agent -> Kipster tool connection -> bound agent/run/attempt
                                           + recorded requester
                                           + working context
```

Initial Tailscale-only trusted-owner mode resolves permitted interface calls to the configured human. This is an access mode, not a one-human domain model. Multiple humans already fit the identity, membership, direct-chat, interaction, and notification models. Future authentication resolves actual callers to those existing identities. No login/password/device-token feature is required now.

Core binds agent-tool connections to their execution context. Models do not repeatedly choose their own acting identity or source thread in tool arguments. They supply explicit targets when required, such as a collaborator, organization destination, artifact, or data owner. Retain acting identity separately from owning identity; targeting another owner's data does not imply a newly invented prohibition.

### 5.1.3 Resource context versus UI navigation

The selected organization is local UI navigation state. It is never a globally mutable backend "current organization."

```text
Laptop viewing Organization A -> request targets A
Phone viewing Organization B  -> request targets B
```

For existing resources, derive relationships from the resource. A reply identifies its thread; Core resolves the chat, organization/installation context, and applicable participants. Avoid requiring the client to repeat the whole relationship chain. If redundant context is supplied, detect an actual mismatch rather than silently retargeting work.

New organization-owned resources name their destination explicitly. Global agent creation need not name an organization unless also adding membership. Root-admin chats retain installation context, and administration specifies the affected organization/resource. Switching the UI organization must not retarget a pending administrative request, question, or run.

### 5.1.4 Stable IDs and names

Use stable, opaque string IDs for durable resources. Display names can change and need not be unique. Discovery/selection must distinguish same-named resources by identity and context rather than selecting an arbitrary first match.

Distinguish resource IDs, request/diagnostic IDs, submission IDs, provider IDs, and event cursors. A prefix or encoding can be selected in implementation; clients must not parse ownership or meaning from it. A request ID identifies one transport request. A submission ID identifies one intended submission across transport retries.

### 5.1.5 Durable acceptance and deduplication

The UI generates a submission ID for each intentional send and preserves it with the outgoing content through acknowledgement uncertainty. A network retry repeats that same submission. An intentional second send gets a new ID even if the text is identical.

```text
Send once with ID S1
    -> Core saves message/work
    -> Acknowledgement is lost
Retry S1
    -> Return original accepted receipt and resource IDs
    -> Do not create a second thread/message/run
```

If the first request never reached Core, retrying S1 accepts it normally. Deduplication and creation must be atomic. Validate/resolve the caller and operation scope before looking up its receipt. Exact key scope and retention belong to the concrete schema; receipts must not leak across unrelated callers/operations, and deleting an old receipt must not silently make supported retries unsafe.

The initial policy does not compare changed payloads and return an idempotency-conflict screen. If an accepted ID is reused, return its existing receipt with an already-accepted indication; never imply that changed content was accepted. Clients must use a new ID for new content. This rule applies to retrying the submission, not user-approved edits of settings.

Distinguish:

- Retry sending: establish the outcome of the original submission.
- Retry work: explicitly attempt failed work again, with existing context/results reconciled and current instructions/settings read for the new execution.

State-changing operations that can be repeated by transport retries need comparable stable operation identity or naturally repeatable behavior. Exact coverage is part of the endpoint schemas, not an exactly-once claim about arbitrary external harness effects.

### 5.1.6 Responses, updates, and errors

Quick operations return their saved result. Long-running operations return durable identifiers/current state after acceptance, with query and event paths to subsequent outcomes. Do not keep the original request open for the entire AI task, transcription, indexing, or cleanup operation.

Settings updates use latest backend save wins, without requiring revisions. An omitted field stays unchanged. Clearing an explicit agent execution override restores organization inheritance. Read latest settings/instructions at each new execution, including retries and new continuations; do not freeze a settings snapshot for future retries. Already-running execution retains the inputs it received.

This editing policy does not override interaction settlement, queue ownership, or submission deduplication. Those operations have their own specific semantics.

Errors include a stable code, useful explanation, relevant details such as an invalid field, and a request ID. Distinguish rejection before acceptance from failure of accepted work. A transport timeout is an uncertain response, not proof that an operation never happened. Unsupported controls return an explicit outcome; never disguise a substitute action as success.

Adopt a major API namespace such as `/v1`, JSON payloads with consistent field naming, UTC timestamps, bounded paginated lists with explicit ordering, and opaque pagination cursors. Pagination cursors and SSE replay cursors are separate contracts. Reject unexpected mutation fields to catch mistakes; tolerate additive response fields. Define fallbacks for unknown event/content kinds. Exact field casing, error codes, HTTP status mappings, page limits, and compatibility matrices remain specification work.

### 5.1.7 Compatibility between releases

Core and each client release independently. A backend-only change must never force a client update.

- Core reports its release version and the protocol range it serves, such as `protocol: { current: 3, oldest: 2 }`. A client states the protocol number it speaks.
- A client blocks only when its protocol number is outside Core's range. Otherwise it keeps working and may show a non-blocking update notice.
- Change responses and events by addition only. Renaming, removing or changing the meaning of a field, or making a new request field mandatory, raises the protocol number.
- Core keeps serving the previous protocol number for at least one release after raising it.
- Clients tolerate unknown fields, and unknown values in enumerations, event kinds and content kinds. They render a neutral fallback instead of failing.
- New features are advertised through bootstrap capabilities. A client hides a feature the connected Core does not advertise.

## 5.2 — Administration, configuration, and discovery

### 5.2.1 One service implementation for UI and agent callers

```text
Kipster UI -> HTTP --------+
                       v
                 Core services
                       ^
Root admin -> tools ---+
```

UI endpoints and agent tools share business behavior. Do not duplicate organization/agent creation logic in each transport or let the adapter directly manipulate Core tables.

### 5.2.2 Administration operation families

| Family | Required responsibilities |
| --- | --- |
| Installation | Identity, setup/readiness, settings, and applicable administration status. |
| Organizations | Create, list, get, update metadata/instructions/defaults, delete. |
| Global agents | Create, list, get, update metadata/explicit settings, delete. |
| Memberships | Add an existing human/agent, list, remove. No initial human invitation/login system. |
| Visual groups | Create, list, rename, order, delete; add/remove/order membership appearances. |
| Effective execution settings | Resolve explicit agent settings against a specified organization's defaults, with source information. |
| Execution adapters | Discover, register/refresh, replace/drain/remove, report readiness/models/capabilities. |
| Administrative operations | Read progress/outcome for work such as staged creation or deletion cleanup. |

Illustrative route families are `/v1/organizations`, `/v1/agents`, `/v1/organizations/{id}/memberships`, `/v1/organizations/{id}/groups`, `/v1/execution-adapters`, and `/v1/operations/{id}`. Exact verbs and nested routes remain to be defined.

Support both create-new-agent and add-existing-agent flows. A convenience create-and-add operation can create a global agent and its initial membership while retaining their distinct identities. It must recover partial provisioning without creating another agent. A name is sufficient to begin setup; seed required files/storage and accept optional description/instructions/settings. Agents and organizations may exist before execution configuration/dependencies are ready. Report what is missing rather than silently selecting another provider.

### 5.2.3 Membership removal versus deletion

```text
Remove visual appearance -> only that assignment disappears
Remove membership       -> organization membership/appearances disappear
Delete global agent     -> agent-owned resources are deleted
Delete organization     -> organization-owned resources are deleted
```

Membership removal preserves the global agent's personal memory, home, settings, other memberships, and organizational contributions. It does not trigger cancellation; already-accepted work may finish. It is not a new fine-grained access revocation policy. Ordinary new dispatch through a removed membership is unavailable; exact historical-chat affordances can be specified without adding an agent-data access ban. Preserve routing context required for accepted continuations instead of relying on an extant membership row for every step.

Deleting an agent removes its personal resources, but explicitly organization-owned publications survive. Preserve deleted-agent attribution on surviving organization messages. Deleting an organization preserves global agents and their already-retained personal learning. "Organization contributions survive" means independent of the contributing agent, not immunity to explicit organization/content deletion.

Actual agent/organization deletion fences affected work and performs durable database/filesystem cleanup, per block 4. This is intentionally different from membership removal. Return inspectable operation progress when cleanup is asynchronous. Personal/installation-chat deletion details remain open; do not infer them from organizational-message retention.

### 5.2.4 Settings, instructions, and availability

For each setting, use an explicit agent value when defined; otherwise inherit the active organization's value. Clear an override to inherit again. Report missing required configuration and incompatible adapter/model combinations without silent fallback. Root-admin installation execution uses explicit agent configuration rather than an arbitrary organization's defaults.

Return global agent configuration separately from effective settings for a particular organization. The latter explains the selected values and their sources. Agent overrides apply across organizations; organization-specific membership overrides and per-message overrides remain extension points, not initial features.

Expose simple organization-instruction text editing now. Core updates the authoritative instruction file, and the next execution reads it. A broad agent file editor for `AGENTS.md`, soul, identity, journal, and arbitrary files is deferred. Do not create a separately editable database copy of those authoritative files.

### 5.2.5 Adapter/model discovery and lifecycle

Each registered adapter supplies its stable ID, display name, model IDs/names, supported effort/settings, capabilities, and availability/dependency information. Core exposes this to the frontend for selection controls. Model catalog fetching/refresh details remain adapter implementation work; do not hardcode one provider's model list in Kipster UI.

```text
Install package on host
    -> Explicit registration/refresh
    -> Validate/load/initialize
    -> Catalog visible to Core/UI
    -> Select for organization or agent
```

No initial package marketplace or UI dependency installer is needed. Packages can be registered without restarting Core. Replacements initialize before taking new work; existing executions retain the old loaded implementation until settled. Removal stops new admissions and drains before unloading. Failed replacement preserves the working implementation.

Keep saved selections if an adapter/model later becomes unavailable. Show the reason and prevent false claims of execution; do not choose another provider automatically. Already-accepted affected work must remain visible with an explicit outcome. Concrete blocked/retry state names can be finalized later.

## 5.3 — Chats, threads, messages, and work controls

### 5.3.1 Direct chats and submissions

Resolve a direct chat from human + agent + organization/installation context. Provide a find-or-create operation that cannot create duplicates when devices open it simultaneously. Visual-group appearances resolve to the same direct chat for the same human/context. Different humans do not share a direct chat implicitly. Root-admin chats use installation context.

```text
Chat: Human + Agent + context
  +-- Root message -> Thread A -> independent workflow
  `-- Root message -> Thread B -> independent workflow
```

Starting a thread accepts its root message and creates work together; empty-thread creation is not an initial feature. Replying identifies an existing thread and accepts an ordinary follow-up there. Every intentional submission has a fresh submission ID. Return accepted resource IDs/current state without waiting for AI execution or voice-note transcription.

### 5.3.2 Message content and preparation

Messages contain ordered parts: text/links, images, documents/arbitrary files, video, explicit voice notes, and ordinary audio attachments. Reference registered uploaded originals by artifact ID. Do not infer voice-note purpose solely from MIME type. Camera capture and recording controls use the same parts contract.

Voice-note preparation automatically invokes configured Spokenly transcription, retaining original audio, transcript provenance, and preparation status. Ordinary audio transcription is agent-invoked when useful. After bounded transcription failure, dispatch original recording, available typed text/attachments, and an explicit unavailable marker, including voice-only messages. A later successful transcription must not silently duplicate the user run. Preserve no-speech success separately from failure.

Save bytes/artifact references before claiming readiness to execute. A durable acknowledgement can precede transcription. Expose accepted/preparing/queued/running distinctions; exact enums remain to be formalized. Preserve inputs without a guessed model-understanding gate.

### 5.3.3 Queue and steering controls

- Ordinary follow-ups execute in backend acceptance order within their thread; no manual reordering initially.
- Parallel root threads, including those for the same agent, use distinct execution contexts and share the configurable installation limit, initially 20 active AI executions including delegated work.
- Cancelling a queued item prevents its execution but keeps its message visible as cancelled. A simple remove/delete-looking UI control may invoke this; it does not hard-delete the authored message or cancel other entries.
- Target steering to a specific queued message and current run/attempt. A delayed request must not steer whichever new run happens to exist later.
- On confirmed steering acceptance, consume the queue entry and retain the message with its delivery treatment.
- Unsupported steering or an already-finished target leaves the message queued. Do not replace steering with cancel-and-restart.
- Uncertain acceptance requires reconciliation before replay or ordinary dispatch of that message.
- Questions, approval responses, and delegated results are continuation inputs, not ordinary follow-ups trapped behind their waiting parent.

### 5.3.4 Stop, Resume, and Retry

```text
Running A -> Queued B -> Queued C
       |
      Stop
       v
A stops; B and C remain saved, dispatch paused
       |
     Resume
       v
B executes next, then C
```

Stop requests cancellation of the targeted current workflow and its outstanding delegated work where supported, cancels its pending interactions, suppresses automatic revival, and holds ordinary queued follow-ups. Persist this queue hold so another device or restart sees it. Cancellation requested is not cancellation confirmed; do not dispatch conflicting work until the old execution is safely settled. A Resume received early cannot bypass that requirement.

Resume releases ordinary queued follow-ups. It does not resurrect cancelled work, approval cards, or children. New follow-ups on a held thread remain subject to that hold. Stop is thread/workflow-scoped, not a pause of the entire installation or agent. Normal successful completion dispatches the next item automatically. Stop does not undo already-written files, sent messages, or other completed effects.

Explicit Retry remains correlated with the original message/work, preserves prior outputs, reconciles uncertain effects, and reads current settings/instructions for the new execution. Exact run-versus-attempt allocation is a schema detail. Do not blindly repeat an unknown external action.

Initial scope excludes editing/hard-deleting sent messages, thread branching, and manual queue reordering. Auto-advance policy after terminal failure/recovery-needed and the interaction of explicit Retry with a held queue still need precise transition rules; do not silently equate them with successful completion or explicit Resume.

### 5.3.5 Thread reads

Provide a coherent snapshot with a bounded page of messages, current workflow/queue state, pending interactions, relevant activity, available controls, and matching replay cursor. Paginate older history separately. Distinguish authored messages, reactions, activity-timeline updates, run state, and interactions. A model saying "done" does not independently settle execution or conceal a later provider failure.

## 5.4 — Questions, approvals, delegation, and continuation

### 5.4.1 Durable interactions and responses

Initially use one versioned choice-card layout with prompt text, up to five labeled options with stable option IDs, and optional free-text answers for questions. Approvals require explicit Approve/Decline; an optional comment or ordinary queued message does not substitute for a decision. The renderer chooses buttons/layout.

Save the interaction and continuation relationship before presenting it. Responses carry interaction identity plus the answer; derive the responding human from trusted caller context. Save the outcome and a visible response in the original thread without disguising system narration as user-authored text.

First accepted response settles an interaction atomically. Later duplicates or competing answers return the recorded outcome, even if the UI had not yet disabled the card. Never apply a second answer after continuation has begun. Stale, cancelled, or superseded requests cannot authorize new work.

Question dismissal returns "no answer provided" to the agent; it does not itself stop the entire workflow. Declining approval means do not perform that proposal; the agent may explain or find another approach. The UI needs an explicit way to distinguish dismissing a question from declining an approval.

### 5.4.2 Long waits

Questions have no short blanket expiry. A human may return days later on another device, load the pending request, and respond through an ordinary command without a connected thread stream.

Retaining the request does not keep a provider RPC/process alive indefinitely. Respond to a resumable original operation when supported; otherwise reconstruct a supported continuation in the same Kipster thread. Preserve the decision and show recovery needed if safe continuation cannot be established. A saved approval applies only to the exact proposal and valid context; materially changed actions require fresh approval.

### 5.4.3 Delegation and default continuation

```text
Human -> Agent A -> delegation D1 -> Agent B
              |                       |
              |                 result saved
              |                       |
              `------- continue A <---+
```

Persist sender/recipient, originating chat/thread/run, explicit context, task/files, delegation ID, work/result state, and continuation intent. Default ordinary delegation to result-triggered parent continuation. The caller may do independent work while the child runs. Correlated results bypass the ordinary human queue, delivered through a supported active tool/control path or at a safe subsequent boundary.

Record continuation intent so a stopped parent cannot be revived by a late result and a completed parent is not arbitrarily restarted. Save late results/history. A child failure becomes a useful result to its parent rather than a hidden failure. Status lookup remains available with neutral model guidance: neither prescribe nor discourage agent polling. Automatic continuation does not depend on polling.

Child work is independently schedulable within the shared limit. Waiting parents must not consume all actual execution permits and prevent dependencies from running. Release permits only after confirmed yield/pause/end. Verify the first harness's actual mechanism; do not invent universal suspension support. Preserve block 2's dependency-cycle and unattended-chain handling requirements without choosing arbitrary limits here.

### 5.4.4 Child questions appear in the original human thread

```text
Human -> Agent A: Prepare a launch plan
              |
              `-> Agent B: Estimate engineering work
                         |
                         `-> Question Q1 for the human

Original thread displays: "Agent B asks: Include Android?"
Human responds to Q1
    -> Resume B's specific waiting work
    -> B returns result
    -> Continue A
```

This is attribution and routing, not a new group-chat UI or publication of all internal exchanges. Questions for the parent agent can route to that agent; questions requiring a human route to the responsible human in the original thread. Agent responses retain agent attribution and are never supplied as if authored by the human.

For human-required child questions, persist enough routing and context to identify:

- Original chat/thread and organization/installation context.
- Delegation and parent workflow.
- Asking child agent, run, and execution attempt.
- Responsible human and exact question/options/proposed action.
- Accepted response, provider interaction reference, and continuation state.

The UI sends only the interaction ID and answer; Core resolves this saved relationship. Do not infer the destination from the thread's primary agent or require the UI/model to rebuild the chain.

For reconstructed child execution, include the delegated task, relevant original-thread context, child's work history, completed results/artifacts, exact request/answer, relationship to the parent, result destination, current instructions/settings, and relevant memory. Current input must remain distinct from historical content. Maintain full canonical history even if context assembly must select/summarize for provider limits. Hidden provider state is not guaranteed recoverable.

## 5.5 — Files, structured data, vectors, and memory

### 5.5.1 Files and ownership

```text
UI upload -> save original -> artifact ID -> ordered message part

Agent creates output -> publish file -> stable artifact ID
                                       -> publish message referencing it
                                       -> UI downloads through Core
```

Core supplies an output directory under the agent home; agents may also publish applicable files elsewhere. Register a stable copy/snapshot rather than relying on a mutable workspace path forever. Filesystem staging and database publication need durable recovery; do not claim one SQL transaction commits both stores. Core fallback imports explicit output references as agreed earlier, without treating every source citation as a generated attachment.

Operations cover upload, publish/finalize, metadata retrieval, and content download. UI references artifact IDs and resolves them against the configured base URL. Host paths belong inside execution/file services, not frontend download links. Preserve metadata, source/derived relationships, message associations, and logical ownership separately.

Generated files are agent-owned unless explicitly published to a selected organization. Simply attaching a personal artifact to an organization thread does not silently transfer ownership. Organization-owned publications must remain readable after authoring-agent deletion, without depending solely on deleted personal bytes. Organization deletion still deletes its owned resources. Exact uploaded-file default ownership and copy-versus-transfer API details remain to be specified.

Voice-note preparation and `audio.transcribe` share the configured service. Keep original bytes, transcripts, status/error, and derivation provenance. File previews/downloads are initial UI scope; broad data/memory browsing screens are deferred.

### 5.5.2 Structured task data

Expose discover/describe, query, and execute operations over logical agent/organization data spaces. Agents can create/alter/remove custom task tables/indexes and read/write their contents. Preserve acting identity separately from target ownership. Discovery avoids making models guess database names, host paths, or connection strings.

Use the selected managed PostgreSQL instance/application database. Proposed task-data namespaces remain compatible with block 4; exact SQL schemas/roles and statement contracts are engineering work. Core conversation, identity, interaction, run, and memory-integrity mutations still use their dedicated services. This is consistency, not a personal-store access ban.

### 5.5.3 Vector collections and source preservation

Expose collection discovery/creation, record save/update/get/search/delete, and processing status. Core's installation-wide embedding service handles vectors; execution adapters do not each own separate embedding configuration.

```text
Save source text + metadata
    -> durable indexing intent
    -> configured embedding service
    -> searchable compatible representation
```

Content saved but indexing pending/failed is an explicit valid outcome. Retain source content and a recoverable indexing path. Do not lose the only canonical text when embedding is unavailable or show stale vectors as current after correction.

Keep block 4's profile/model/dimension metadata, retained source revision/hash and preparation information, and ability to store parallel embedding generations. Rebuild/activation/rollback UI remains deferred. Never mix incompatible query/index vector spaces, even if dimensions match. Retaining source content is a present requirement because vectors cannot reconstruct it for future model migration.

### 5.5.4 Memory operations and corrections

Provide search/get, save facts/observations/episodes, link memories with evidence, correct current learning, and explicit publication to organization knowledge. Default retrieval uses the agent's continuous personal memory plus active organization knowledge. Organization publication is a deliberate separately owned contribution, not an automatic transfer of the whole brain.

Current memory correction is deliberately simple: update the record's current content under its stable ID; do not retain every previous wording in a superseded-memory archive. Keep current supporting provenance, updated timestamp, and content revision/hash needed to invalidate and rebuild derived embeddings. A late indexing result for an older revision cannot make stale content appear current. Relationships retain stable identity, while memory services maintain their semantic/evidence consistency.

This is not a settings-conflict revision system or a full memory-version archive. Future correction history can be added for subsequent changes; overwritten historical wording cannot be reconstructed retrospectively. That tradeoff is accepted. It does not remove the separately agreed evidence/provenance, synapse-change, or identity-evolution records from block 4. Memory algorithms remain real architecture work; deferring correction history or a UI browser is not deferring memory itself.

Initially expose data/vector/memory services through Core and agent tools. Defer dedicated table/collection/memory browsing and editing screens; users may converse with agents about their data. Exact HTTP exposure of each lower-level service can be chosen without forcing all internal methods into public endpoints.

## 5.6 — Execution adapter and agent-tool contracts

### 5.6.1 Two contracts

```text
Core -> execution request/control -> Adapter -> Harness
Core <- normalized execution events <- Adapter <- Harness

Agent -> bound Kipster tools -> Core services -> tool result
```

Adapters neither select UI connections nor directly update conversation tables. Core preserves and projects outcomes. Contracts/helpers remain in Core; adapters are separately installable packages, without a separate initial SDK package.

### 5.6.2 Execution input and handle

Each new execution receives structured actor/requester and context IDs, task/current input, conversation history, latest operating/agent/organization instructions, relevant memory, ordered files/transcripts, working/output locations, skills/tools, resolved settings, and prior provider-session/continuation metadata where applicable.

Include why execution is starting: new message, accepted human response, delegated result, or recovery/retry. Keep the trigger distinct from historical messages so it is not sent twice. The adapter maps this package to supported provider inputs rather than requiring one concatenated prompt. There are no frozen instruction/settings copies for later retries.

`execute(context)` returns an execution handle promptly with a normalized event stream. Controls target this handle/execution. Save provider IDs and serializable continuation metadata separately: an in-memory handle alone cannot survive restart.

| Operation family | Responsibility |
| --- | --- |
| Describe | Adapter identity/version, capabilities, models/settings. |
| Initialize | Prepare integration/dependencies. |
| Execute | Start/continue and expose handle/events. |
| Steer | Deliver targeted active input if supported. |
| Respond | Resolve a native pending interaction if supported. |
| Cancel | Request cancellation and expose actual outcome. |
| Reconcile | Inspect saved execution after interruption; report running, ended, or uncertainty. |
| Shutdown | Release resources after appropriate draining. |

These are responsibility names, not final method signatures. Every production adapter must support execution, normalized output/outcome events, Kipster tools, and cancellation. Steering and native resume remain optional and advertised. Required cancellation does not guarantee instantaneous process termination or rollback of completed effects.

Common settings are adapter/model/effort, plus an adapter-defined options object. The adapter validates its options. No initial custom UI editor for every provider-specific field is required. Catalog/readiness comes from 5.2.

### 5.6.3 Events, publications, and tool results

Execution events include provider-session references, activity, message start/deltas/finalization, interactions, output files, and terminal outcomes. Correlate each to its attempt and each message delta to its message. These are not the public SSE stream, though Core translates them into observable state/events.

Native and explicit tool publications share Core publication logic. Reconcile only representations with established common identity/correlation; similar text is not enough. Intermediate publication cannot suppress later answers. Distinct later content stays visible even after a final-purpose message. A provider can finish without a new message if its output has already been published; do not fabricate filler. Core settles run state after outcomes and outputs are reconciled, retaining later failure visibly.

Tool calls inherit acting context and accept explicit targets as necessary. Results distinguish completed, pending with a stable request/operation reference, and failed with a useful explanation. Persist interactions/delegations before returning pending or awaiting a result. A harness may hold a supported tool call open or yield and later continue; do not require a days-long live RPC.

Use the agreed tool families from block 3: activity, publication/reaction/history, questions/approvals, memory/data/vectors, artifacts/transcription, agent discovery/delegation, administration, and future scheduling. Detailed scheduling behavior remains deferred.

### 5.6.4 Diagnostics

Keep raw provider logs out of conversation content. Show meaningful activity and useful errors, with bounded separate diagnostic logging. Start with simple local logging behind a small interface; an external logging provider can be added later. Do not save every raw provider payload by default or introduce a logging-plugin platform now. Exact limits/sinks/redaction are implementation choices consistent with useful correlation and avoiding secret disclosure.

## 5.7 — Live events, SSE, synchronization, and notifications

### 5.7.1 Commands and subscriptions are independent

```text
UI -- HTTP: send/stop/answer/steer --> Core
UI <-- SSE: committed updates ------- Core
```

A UI opens outbound subscriptions; it needs no inbound callback server. Commands work without a connected SSE stream. Disconnecting or closing a thread view does not stop work, discard questions, or prevent background notification tracking.

### 5.7.2 Two subscription scopes

```text
Application subscription (while app is connected)
  +-- Background thread summaries/unread attention
  +-- Pending questions/approvals
  +-- Organization/agent/group/settings changes
  +-- Adapter availability
  `-- Notifications

Open-thread subscription
  +-- Detailed messages/deltas
  +-- Activity, reactions, attachments
  +-- Work/queue/hold state
  `-- Interactions and responses
```

Use one application stream plus one detailed stream for the open thread. Switching threads replaces the detailed subscription; do not subscribe to every historical thread. Application events may carry compact state or identify summaries that need refetching rather than copying all background answer text.

Both scopes use caller context and resource relevance. Do not assume future humans all see the same events. UI organization selection must not accidentally suppress a relevant notification from another context or an installation-level root-admin thread; exact notification scope/filter controls remain UI design work.

### 5.7.3 Envelopes, ordering, snapshots, and reconnects

Public events have stable identity, type, relevant resource references, timestamp, and data. A replay cursor tracks stream position. Final field names and event-type enums are schema work. Order by the stream's durable position, not timestamps. Keep application and per-thread cursor domains separate; provider IDs are not replay cursors.

```text
Fetch view snapshot, complete through cursor 100
    -> Subscribe after 100
    -> Apply 101, 102, 103...

Disconnect after 103
    -> Core continues 104, 105, 106
    -> Reconnect after 103
    -> Apply missed updates, then continue live
```

The snapshot and cursor must describe a consistent view. State changes and their observable events are committed durably; event production for both scopes must not introduce a failure window where state commits but no recoverable notification/summary update can be produced. The concrete transaction/outbox/projection design remains implementation work, with durable replay as the source of truth rather than transient notifications alone.

No gap is allowed between replay and live delivery. Deduplicate events on the client and advance its cursor after applying the state. Persist a cursor only with matching local state; an empty or rebuilt client loads a snapshot. Old/invalid cursors produce explicit snapshot resynchronization, not silent loss or task re-execution. Use automatic reconnection with a modest retry delay and a visible reconnecting indication. Connection loss is distinct from execution failure.

Keep the same message ID through answer drafting, batched fragments, and finalization. Canonical finalized content remains authoritative. Do not require a durable event per individual token. Recoverable draft state/events must still let an active answer reappear coherently after reconnect. Overlap between application and thread streams must not duplicate resources or regress newer client state; exact cursor/revision reconciliation is a synchronization detail, not the rejected settings-edit conflict UI.

### 5.7.4 Bounded replay versus canonical records

Replay history is bounded and configurable. Old cursors recover from snapshots. Canonical chronological messages, artifacts, pending interactions, work/continuation state, and notifications have independent lifecycles. Event expiry must not erase them. No fixed retention duration has been agreed; choose limits during implementation and make clients handle resynchronization correctly.

### 5.7.5 Notifications

Closing a detailed thread stream leaves the application stream available for attention elsewhere. Persist important notifications with stable IDs, recipient identity/context, target thread/resource, and saved read/unread state. Delivery and reading are different facts; repeated event delivery must not create a second notification.

Notify on meaningful completion, a question/approval requiring attention, or failure/recovery needed. Do not create notifications for each answer fragment or routine activity update. Exact aggregation and user preferences can be refined later.

| UI condition | Behavior |
| --- | --- |
| Viewing affected thread | Update it directly; avoid a redundant popup. |
| Viewing another thread/screen | In-app notification and unread/attention indicator. |
| App backgrounded but able to receive | Use system notifications when the platform permits. |
| Offline | Retain notification for reconnect/snapshot recovery. |
| Fully closed or suspended app | SSE alone does not guarantee live delivery; platform push/background integration remains a UI-technology decision. |

```text
Important state change
    -> saved notification
         +-- connected -> application stream
         `-- disconnected -> recover on return
```

Snapshots restore outstanding notifications even after replay events expire. An old approval notification cannot restore cancelled controls; current interaction state wins. Notification receipt/read synchronization must not resolve a question or approval. Exact mark-read endpoints, multi-device popup suppression, OS permission handling, and fully closed delivery require implementation/platform decisions. Do not claim these are already implemented or guaranteed by SSE.

## 5.8 — Completeness review and implementation handoff

### 5.8.1 Contract surface map

| Surface | What must be specified next |
| --- | --- |
| Common conventions | IDs, context, errors, lists, update/clear syntax, operation receipts and replay-safe submission scope. |
| Administration | Organization/agent/membership/group operations, effective settings, instruction text, asynchronous cleanup. |
| Discovery | Installation readiness, registered adapters, model/effort/options metadata, unavailable selections. |
| Conversations | Direct-chat resolution, thread start/read/list, ordered messages, history, reactions/activity. |
| Work controls | Queue inspection/cancel, targeted steering, Stop/Resume, Retry and actual cancellation outcomes. |
| Interactions | Ask/approve/dismiss/respond, choice/free-text content, exact-action validity and first-response receipt. |
| Delegation | Task/result/status, continuation intent, child-to-human routing and parent/child correlation. |
| Files/audio | Upload/publication/ownership/metadata/download, preparation/transcription and derived records. |
| Data/vector/memory | Discovery and scoped targets, custom data, indexing status, current corrections and provenance. |
| Execution integration | Context/trigger, handle/serializable state, controls, capabilities/options, events/tools/reconciliation. |
| Synchronization | Two snapshot/subscription scopes, envelopes, cursors, replay/reset, draft/final reconciliation. |
| Notifications | Durable identity, audience/target, list/read state, application delivery and platform limitations. |

Not all internal service operations need public HTTP endpoints. UI/API, adapter callbacks, and harness tools share semantics while retaining suitable transports. Exact route/field names must be finalized coherently rather than independently invented by implementing agents.

### 5.8.2 Scenario matrix

These are acceptance obligations to implement and test, not claims of passing tests today.

| Scenario | Required observable result |
| --- | --- |
| Two devices select different organizations | Requests retain explicit targets; no global active-organization mutation. |
| Future two humans use the same agent | Separate direct chats/actor context; agent identity and personal brain remain global. |
| Same agent appears in multiple visual groups | Same direct chat for the same human/context, no duplicate agent or memory. |
| Concurrent direct-chat resolution | One intended direct chat, not duplicates. |
| Create agent without a working provider | Agent exists with clear readiness reason; no fabricated fallback. |
| Add existing agent to another organization | Membership added without copying identity/home/brain. |
| Concurrent settings saves | Latest backend save wins for supplied fields; no stale-edit conflict mechanism. |
| Clear an agent override | Organization value becomes effective; incompatible inherited combinations are explained. |
| Settings change before Retry/continuation | New execution reads current settings/instructions, not frozen historical inputs. |
| Submission saved but acknowledgement lost | Retry same ID returns original receipt; no duplicate root thread or work. |
| Same text intentionally submitted twice | Two different submission IDs represent two intentional actions. |
| Accepted ID accidentally reused with changed content | Existing receipt returned; no overwrite or false claim of new acceptance. |
| Two root messages and a follow-up | Roots run independently; follow-up queues in its target thread. |
| Cancel queued item | Message remains cancelled in history; other queue entries unchanged. |
| Supported steering | Exact target consumes selected entry once. |
| Unsupported/late/uncertain steering | Honest outcome; no silent restart or duplicate ordinary execution. |
| Stop with queued replies and restart | Work cancellation/hold survives; Resume releases saved replies only after safe settlement. |
| Mixed text, voice note, video, and files | Ordered originals retained; voice-note transcription status is explicit. |
| Transcription fails on a voice-only message | Recording and failure marker reach the agent; no invented instruction or indefinitely blocked input. |
| Native answer plus explicit publications | Distinct content remains; known same-publication representations reconcile by identity. |
| Question answered four days later | Saved response continues same Kipster thread via native resume or supported reconstruction. |
| Two devices submit answers | First accepted outcome returned consistently; only one continuation decision. |
| Dismiss question / decline approval | Different explicit outcomes; neither is silently treated as Stop or approval. |
| B asks a human while delegated by A | Card in A's original thread, answer routed to B's exact pending work, then result returns to A. |
| Parent stopped before child finishes | Late result retained; stopped parent not revived. |
| Execution limit reached during delegation | Dependencies can progress without pretending running providers are suspended or exceeding the limit. |
| Remove organization membership | Accepted work may finish; global memory and organization contributions stay. |
| Delete contributing agent | Personal resources removed; organization-owned publications/messages survive with suitable attribution. |
| Generated personal file appears in organization thread | Reference does not silently change ownership; organizational publication must be explicit. |
| File publication interrupted between disk and DB | Recoverable staging produces a correct artifact or explicit failure, not a permanently false ready state. |
| Correct current memory while indexing is pending | Current text remains; stale indexing result cannot replace the current representation. |
| Embedding provider unavailable | Source text and indexing intent survive; search status is honest. |
| Future embedding model replacement | Retained source can be re-embedded into a separate compatible generation. |
| Adapter replacement while executing | Running implementation retained; new implementation only receives new work when initialized. |
| Adapter disappears after selection | Saved selection retained with unavailability reason; no provider substitution. |
| Core restarts with unknown provider outcome | Reconcile before replacement; uncertain effects are not blindly repeated. |
| Snapshot followed by subscription during concurrent writes | No event gap; duplicates harmless; no task replay. |
| Thread view closes before completion | Application subscription delivers notification/summary; original work continues. |
| Replay cursor expires | Snapshot restores canonical state and outstanding notifications. |
| App fully closed | Saved notification remains; no promise of immediate OS delivery without platform integration. |

### 5.8.3 Open engineering details and narrowly scoped product gaps

There are no unanswered questions blocking this decision record. It deliberately does not claim every wire schema or edge transition has already been chosen. Remaining work:

- Produce exact HTTP/tool/adapter signatures, JSON validation schemas, response/status/error catalogs, and public event enums from this record.
- Define physical tables, indexes, transaction boundaries, staged file cleanup, two-scope event production, and migrations.
- Choose submission-key namespace/lifetime, cursor encoding/reset responses, page/size limits, replay/log retention, and backpressure behavior. Preserve the accepted semantics.
- Formalize queue/run/attempt/interaction transitions, including failure auto-advance and Retry on a held queue; only successful auto-advance and explicit Stop/Resume are settled here.
- Specify upload ownership defaults, personal-file references after owner deletion, copy-versus-transfer publication semantics, and personal/installation-chat deletion treatment.
- Select exact choice-card/free-text schemas and adapter support for interaction round trips and recoverable waiting.
- Select model catalog refresh, adapter loader/replacement/reconciliation implementation, provider-specific yield/cancel behavior, and option merge/clear semantics.
- Design memory algorithms and quality evaluation, without reintroducing mandatory correction archives; preserve retained source/evidence and indexing compatibility.
- Choose UI technology and notification delivery for background/closed states; specify notification read/attention rules and aggregation without losing durable pending requests.
- Finalize authoritative configuration field locations and instruction precedence, maintaining no independently writable duplicate masters.

Do not silently convert these open details into broad new features. Defaults may be chosen for routine implementation; materially different user-visible behavior should be discussed. Block 6 can address application assembly and platform choices. No new authentication system, fine-grained agent ACLs, workspace locks/worktrees, migration/import, full data/file editors, logging platform, or correction-history subsystem is authorized by this record.

### 5.8.4 Review outcome

The decisions are consistent when their boundaries remain explicit: latest-save settings are different from deduplicated submissions and first-response interactions; membership removal is different from deletion; organizational file ownership is different from message association; a queued follow-up is different from a continuation input; adapter events are different from public subscription events; event replay is different from durable messages/notifications; retaining source content is different from archiving every correction.

Implementation agents should use the scenario matrix to verify these distinctions, preserve the open-detail list, and consult blocks 1–4 for unchanged identity, memory, storage, and execution requirements.
