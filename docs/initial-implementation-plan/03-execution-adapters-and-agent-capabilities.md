# Decision block 3 — Execution adapters and agent capabilities

Status: agreed architectural direction. Exact TypeScript signatures, event schemas, package-loading implementation, and provider-specific recovery behavior remain implementation design work.

This record builds on [Identity and ownership](./01-identity-and-ownership.md) and [Conversations and work lifecycle](./02-conversations-and-work-lifecycle.md). It establishes four connected parts: execution context, adapter execution, agent capabilities, and continuation. It supersedes earlier suggestions of frozen instruction/configuration copies, restart-required adapter installation, and final-answer suppression based merely on an earlier publication.

[Decision block 5](./05-kipster-protocol.md) refines the shared conventions, tool outcomes, continuation routing, adapter options, and diagnostic logging. Its production-adapter minimum requires execution, normalized events, Kipster tools, and cancellation; steering and native resumption remain optional.

## 1. Overall boundary

Kipster coordinates and preserves work. The harness and model perform the task. Two contracts connect them:

- **Execution contract:** Core starts, controls, and observes work through an adapter.
- **Agent capability contract:** the agent calls Kipster services to communicate, access data, publish files, and collaborate.

```text
Kipster Core
    |
    | Prepared context + execution request
    v
Execution adapter package
    |
    | Provider-specific commands
    v
Harness / AI system
    |
    | Provider-specific responses
    v
Execution adapter
    |
    | Standard Kipster execution events
    v
Core -> saves updates -> streams them to Kipster UI
```

The adapter does not directly update the UI or write conversation tables. It reports to Core. Provider-specific protocols remain inside adapter packages. A future Kipster-managed model API loop implements the same boundary while owning its model/tool loop internally.

The initial implementation should stay liberal: avoid unnecessary model-behavior restrictions, file-understanding gates, or workspace coordination. Accurate routing, durable state, explicit outcomes, and duplicate-operation handling remain necessary system responsibilities.

## 2. Part one — Prepare execution context

Before each new execution, Core reads the current information, retrieves relevant memory, and supplies a structured context package to the selected adapter.

| Part | Supplied information |
| --- | --- |
| Identity and routing | Agent, requester when applicable, organization or installation context, chat, thread, run, and attempt identifiers. |
| Instructions | Current Kipster operating instructions, agent soul/identity/operational instructions, and active organization instructions. |
| Conversation | Thread history, separately identified current input, interaction answers, and delegated results. |
| Memory | Relevant agent learning and active organization knowledge; further search remains available through tools. |
| Attachments | Ordered artifact references or accessible paths, metadata, transcripts, and preparation status. |
| Environment | Working directory, available input locations, and generated-output directory. |
| Tools and skills | Applicable Kipster tool definitions/connections and skill references. |
| Execution settings | Current organization defaults with agent overrides: adapter, model, effort, and supported options. |
| Provider metadata | Saved provider-session references and adapter-owned continuation information. |

This is not necessarily one large prompt. The adapter translates instructions, content, files, tools, and metadata into the forms its provider accepts.

### Latest information at execution time

Use the latest applicable settings and instructions when execution begins, including queued work and newly started continuations or retries. Do not introduce frozen instruction copies, configuration snapshots, or a version-management subsystem for this purpose. An execution already running continues with the inputs it received; a response delivered to that still-running operation is not automatically a fresh invocation.

Organization defaults are overridden by explicit agent settings, as established in block 1. Root-admin installation work can use explicit agent settings. If changed settings make an existing provider session incompatible, use a suitable new session and the supplied history. This is not live transfer of provider internals.

Refreshing current inputs does not require clearing old provider history. Adapters convey current instructions through their supported mechanism. Instruction precedence and exact provider mapping must be made explicit during implementation; no new conflict hierarchy is established by this document.

### History and identifiers

Always supply conversation history to the adapter along with metadata. The adapter decides how much must actually be sent to the provider: a compatible continuing session may already contain the history, while a fresh invocation needs context supplied explicitly. CLI does not inherently mean stateless; use actual integration capabilities.

Keep the current input distinguishable from historical messages so it is not submitted twice. Preserve full canonical history in Kipster; configurable context budgets and provider limits govern what is supplied to the model. Do not impose unnecessarily small fixed budgets or silently discard source history.

```text
Kipster chat: Human <-> Agent A
  `-- Kipster thread: Build the landing page
        `-- Agent A's execution context
              `-- Provider session: abc123
```

Kipster IDs and provider IDs are separate. Core persists their mapping; adapter metadata does not all need to appear in the prompt.

### Memory, files, and environment

Retrieve relevant memory before every execution and let the agent search further through tools. Default retrieval uses the agent's continuous memory plus the active organization's shared context. Do not merge every agent's memories into the prompt or partition one agent's identity by organization.

Store and pass attachments through native input support or accessible file references. The model decides how to inspect the material and explains its limitations to the user. Do not build a guessed file/model compatibility gate or block execution merely because Kipster cannot determine whether a model understands a format. Preserve actual preparation errors and the voice-note transcription behavior agreed in block 2.

Environment means practical paths and execution setup, for example:

```text
Working directory: /work/projects/my-website/
Input file:        /kipster/files/file_123/design.png
Output directory: /kipster/outputs/thread_42/run_7/
```

Use one Kipster home with stable IDs for directory identity. Agent resources sit independently of organizations and adapters, so membership or adapter changes do not move or duplicate the agent's files. The root admin uses an ordinary agent directory; installation-level shared resources have their own location. Exact folders, default workspace selection, and artifact layout belong to the storage block.

Do not implement workspace file locking, automatic worktrees, or conflict coordination initially. Agents may handle shared-file conflicts, but detection is not guaranteed. This choice does not remove database transaction integrity or durable queue ownership.

## 3. Part two — Adapter packages execute and report back

### Packages and concurrent registration

Kipster and execution adapters are separately installable packages. The public adapter contract and integration helpers initially live in Core; a separate adapter SDK package is unnecessary.

Illustrative package names:

```text
@kipster/core
@kipster/adapter-codex
@kipster/adapter-other-provider
```

Package names are not claims about published packages. Multiple adapters can be registered and used simultaneously:

```text
Kipster Core
  +-- Codex app-server adapter <--- Agent A
  +-- Codex CLI adapter        <--- Agent B
  `-- Other harness adapter   <--- Agent C
```

Adapter IDs identify integration routes, not just provider brands. Each execution resolves one adapter and compatible model/settings. The installation does not have a single globally selected adapter. Only the first integration is implemented initially; examples do not promise that every possible integration exists.

### Loading and replacement

Support adding a package without restarting the backend. An explicit registration/refresh command is sufficient; constant filesystem watching is not required.

```text
Install package
      |
Register / refresh adapters
      |
Discover -> check contract -> load -> initialize
      |
Available to new executions
```

- Adding an adapter makes it available after successful initialization.
- Updating prepares a replacement for new executions; existing executions keep their current loaded implementation until settled.
- Removing stops new admissions and unloads after active work drains.
- A failed replacement must not invalidate an already-running implementation.

The loader must deliberately handle module caching and version identity. Simply importing the same path again is not a sufficient replacement design. Retaining a loaded implementation for active work is lifecycle management, not the instruction/configuration snapshot system excluded above. Exact process/module loading mechanics remain open.

### Starting and controlling work

Use one `execute(context)` entry point. The adapter handles provider-specific create/resume/send sequences internally and returns an execution handle promptly with a stream of normalized events.

| Proposed operation | Responsibility |
| --- | --- |
| `describe()` | Adapter ID, contract version, capabilities, supported settings, and model information. |
| `initialize()` | Prepare connections/processes and check required dependencies. |
| `execute(context)` | Start or continue execution and return its handle/event stream. |
| `steer(handle, input)` | Deliver input to a targeted active execution when supported. |
| `cancel(handle)` | Request cancellation and expose its actual outcome. |
| `respond(handle, interaction, answer)` | Resolve a native pending interaction when supported. |
| `shutdown()` | Close connections and release resources once execution is settled. |

These names express responsibilities, not finalized TypeScript signatures. Recovery after backend restart also needs inspection/reconciliation support; a concrete method signature is not yet chosen.

Basic execution, event reporting, and explicit outcomes form the common contract. As finalized in decision block 5, production adapters must also expose Kipster tools and support cancellation. Native session continuation and steering may be unsupported. Do not disguise unsupported controls as success or substitute cancel-and-restart for steering.

Cancellation requested and cancellation confirmed are distinct. Core must not start conflicting replacement work solely because it sent a cancel request.

### Events and SSE are separate streams

```text
Core ---- steer / cancel / interaction response ----> Adapter
Core <--- normalized execution events --------------- Adapter

Harness -> Adapter -> Core -> persisted events -> SSE subscribers
```

The adapter never chooses a browser connection. It correlates provider events to the execution, and Core owns persistence, subscription routing, and replay.

Example:

```text
Kipster:   thread T42 / run R7 / attempt A1
Provider: session P99 / turn P100

P99 + P100 -> A1 -> R7 -> T42
```

When the provider lacks explicit IDs, the adapter can correlate through the request or process producing the events. Core sends saved updates to all applicable subscribers, or retains them when none are connected. An SSE cursor is a position in Kipster's event log, not a provider-session identifier.

Event categories include session references, activity, message drafts/deltas/finalization, interaction requests, output files, outcomes, and optional usage/diagnostics. Each event identifies its execution; message deltas identify the message. Exact envelopes and replay schemas belong to the protocol/storage work.

Messages, run states, reactions, activities, and interactions remain distinct. A reaction does not independently complete a run, and an activity entry need not become a chat message.

## 4. Part three — Agent capabilities and publication

Harness-native operations such as terminal, browser, and file access coexist with Kipster tools. The adapter exposes Kipster tools through whatever supported integration mechanism the harness provides. MCP is a candidate for the first integration, not the universal Core service contract.

```text
Agent inside harness
  +-- Harness tools -> files / commands / browser
  `-- Kipster tools -> Core
                       +-- Conversations and activities
                       +-- Memory and structured data
                       +-- Questions and approvals
                       +-- Files and transcription
                       `-- Delegation and administration
```

### Tool catalog

The following is the agreed catalog direction; names and exact arguments remain proposed until schema design.

| Operation/family | Purpose |
| --- | --- |
| `activity.report` | Short public activity-timeline update. |
| `conversation.publish` | Intermediate or final user-facing message with ordered content and optional artifacts. |
| `conversation.react` | Reaction attached to a specific message. |
| `conversation.read` | Retrieve source messages or additional history. |
| `interactions.ask` | Durable question, initially using the choice-card behavior in block 2. |
| `interactions.request_approval` | Approval for a specific proposed action and context. |
| `memory.search/get/save/link` | Retrieve learning, record it, and relate memories. |
| `data.describe/query/execute` | Structured agent or organization data access. |
| `artifacts.publish` | Register a completed generated file and return an artifact ID. |
| `audio.transcribe` | Invoke the same configured service used for voice-note preparation. |
| `agents.list/get` | Discover agents and their roles. |
| `agents.delegate` | Durable task request to another agent, optionally with files. |
| `agents.delegation_status` | Inspect a delegation and its result/status. |
| Administration families | Applicable organization, agent, membership, group, and configuration operations. |
| Scheduling families | Interface to future scheduling capabilities; detailed scheduling design is separate. |

Memory/vector operations use the relevant backing services. The model need not manage embeddings merely to remember something. Structured and vector storage do not imply separate database servers. Keep acting identity distinct from ownership; do not introduce an unrequested cross-agent access ban. Ordinary data operations still cannot bypass Core conversation, run, or interaction invariants.

[Decision block 4](./04-storage-and-recovery.md) selects PostgreSQL with pgvector and one installation-wide default embedding service. The recommended service placement is Core, exposed through its SDK/tool methods; execution adapters bridge those tools into harnesses rather than each owning a separate embedding model. Exact registration and vector method signatures remain to be defined. No additional standalone SDK package is introduced.

Core binds the tool connection to actor and execution context. The model supplies a target when needed, such as a collaborator or artifact, but does not repeatedly choose its own acting identity or the current thread. Tool results distinguish success, useful failure, and pending work with stable IDs. Preserve the distinction between a question and an approval even when their UI layout is shared.

Skills are instructions/workflows and references; tools are callable operations. Supply both without treating them as identical.

### Multiple messages without hidden output

`conversation.publish` distinguishes intermediate and final purpose. An intermediate message does not complete the run. A final designation does not suppress every later message or override an execution failure.

Native harness output and explicit publishing calls enter the same Core publication machinery:

- Reliably identified public commentary can become activity updates.
- Native answer content can stream into a draft message and then finalize.
- Explicit intermediate publications remain independent durable messages.
- Explicit final publications remain durable final messages.
- Reconcile native and tool output only when explicit identity/correlation establishes that they are the same publication.
- Preserve a distinct later answer even if a final message was already published. Never suppress all native output because any publishing tool was called.
- Do not guess that similar text must be the same message. When identity cannot establish duplication, preserve distinct content rather than silently hide it.

Replacing/finalizing a draft is valid only for a correlated version of that same message, not an unrelated earlier draft. Keep the canonical conversation and execution record. This does not require access to private model reasoning or making an internal delegated result public; audience follows the conversation/delegation context agreed in block 2.

Core settles run state after execution and output reconciliation. A provider that has already published its answer may finish without another user-facing message; do not invent a duplicate or a filler answer. Likewise, a later provider failure stays visible even when useful messages were already published.

```text
Agent publishes intermediate message -> Core saves and delivers it
Agent continues working
Agent returns native answer OR publishes explicit final
      |
Core correlates any representations of the same message
      |
Distinct messages remain visible; same publication is not duplicated
      |
Provider outcome arrives -> Core settles execution state
```

### Generated files

```text
Create report.pdf in supplied output directory
      |
artifacts.publish(path) -> artifact ID
      |
conversation.publish(text + artifact ID)
      |
Core saves message -> UI downloads file through Kipster
```

The output directory is a convenience for the agent. Final file-storage paths, publication copies, fallback imports, and retention are storage-block decisions. Do not expose an arbitrary host filesystem path as if it were a client download URL.

## 5. Part four — Waiting, interruption, and continuation

A Kipster workflow may remain open when no AI execution is running. UI connectivity does not own execution or pending interactions.

```text
Agent works
  +-- Finished -> preserve output -> complete
  `-- Needs human answer / delegated result
         |
         Save request and continuation context
         |
         Continue independent work, or yield when safe
         |
         Answer/result arrives
         |
         Resume in the same Kipster thread
```

### Main mechanism and optional status lookup

Core saves an interaction or delegation before presenting or dispatching it. Completion/response triggers correlated continuation. An agent can continue independent work or yield until the dependency is ready. Status lookup remains available through tools when the agent wants it.

Describe automatic result delivery and continuation as the main mechanism in model instructions. Do not add instructions or comments that prohibit, discourage, encourage, or prescribe the frequency of agent status polling. The system does not require repeated agent queries in order to notice a completed dependency. This does not prescribe whether the backend scheduler internally uses database polling or notifications.

```text
Agent A delegates to B
      |
Core saves request and schedules B
      |
A continues independent work or yields
      |
B's result is saved
      |
Core delivers/schedules the correlated continuation for A
```

If A is still active, deliver through a supported tool return/control path or hold the result until a safe execution boundary. Do not mutate an incompatible active provider session concurrently. Child questions for a human retain their source and route to the responsible human. Internal child results do not automatically become public conversation messages.

### Capacity and safe yield

Count actual active AI execution toward the configurable installation limit, initially 20, including delegated work. Release a permit only when execution is confirmed paused or ended. Do not label an active provider as suspended merely to make capacity appear available.

Waiting parents must not occupy every permit and prevent children from progressing. Use supported suspension or end/yield at a supported boundary with a saved continuation. Not every harness can pause an arbitrary operation. The first adapter's concrete yielding and admission strategy must be verified during implementation, including behavior at the configured ceiling; this document does not invent universal pause support.

### Resume or reconstruct

```text
Answer or result arrives and is saved once
      |
Original provider operation still resumable?
  +-- Yes -> respond/resume through adapter
  `-- No  -> reconstruct execution from Kipster records
      |
Continue in the same Kipster thread
```

Reconstruction includes original work, history, the pending request and explicit answer, completed outputs, artifacts, and any saved continuation note. It also reads latest instructions/settings and retrieves relevant memory for the newly starting execution. Provider sessions may change without changing the Kipster thread. Hidden provider state is not assumed recoverable.

Questions have no short blanket default expiry. Approvals remain recorded, but authorize only the exact valid proposal. A materially changed action needs a new approval. Duplicate responses return the recorded result; stale or cancelled interactions cannot authorize replacement work.

### Stops and failures

| Situation | Behavior |
| --- | --- |
| UI disconnects | Execution continues; reconnect restores saved state. |
| User stops work | Cancel targeted execution and outstanding children where supported; preserve existing output and prevent automatic revival. |
| Harness crashes | Preserve output, reconcile provider state, and attempt supported recovery. |
| Core restarts | Reload unfinished work and reconcile before starting replacement execution. |
| Earlier side-effect outcome is uncertain | Preserve context, show recovery needed, and request input when necessary rather than blindly replaying. |

Automatically continue when a safe supported recovery can be established. Involve the user when uncertainty prevents safe continuation. Stop does not undo written files, sent messages, or other completed effects. Save late child results but do not let them revive a cancelled parent. A finished parent resumes only for previously recorded continuation intent or explicit new work.

## 6. Full example

```text
Human sends message + attachment
      |
Core saves input and queues work
      |
Read latest settings/instructions + retrieve memory + include history
      |
Selected adapter executes with file references and Kipster tools
      |
      +-- Native activity/message events -> adapter -> Core -> UI
      +-- Publish tool calls ------------> Core -> UI
      +-- Generated file ----------------> Core artifact service
      `-- Delegate / ask human ----------> Core saves pending request
                                               |
                                      Continue work or safely yield
                                               |
                                      Answer / result is saved
                                               |
                                      Resume or reconstruct
                                               |
                                      More messages / final output
                                               |
                                      Core settles run state
```

All user-facing delivery passes through Core. Multiple devices observe the same saved conversation, activities, interactions, reactions, and run states through their subscriptions.

## 7. Acceptance scenarios and remaining implementation work

- Multiple registered adapters execute work for different agents concurrently.
- Adding an adapter through registration/refresh needs no backend restart; replacement does not alter running executions.
- Current instructions/settings and relevant memory are read for new execution; no frozen configuration subsystem is required.
- History and provider metadata reach the adapter; compatible sessions avoid unnecessary history resubmission, and fresh sessions receive needed context.
- Attachments are made available without a guessed model-understanding gate.
- Native and tool-published intermediate/final messages retain distinct content and reconcile known duplicates only.
- Provider events route to the correct execution and all relevant UI subscribers; disconnected clients do not lose saved outcomes.
- Status lookup works independently of automatic continuation, with neutral model guidance about polling.
- A pending question survives days and restart, and its answer continues the same Kipster thread.
- Delegated children can progress at the execution ceiling; obsolete or cancelled attempts cannot revive work.
- Safe recoveries proceed automatically; uncertain external effects are not blindly repeated.

Storage and protocol work will define exact schemas, event envelopes, tool arguments, folder layout, and transaction/replay details. Implementation must select the package-loading mechanism and verify the first harness's steering, cancellation, instruction refresh, yielding, and recovery capabilities. These are remaining engineering details, not additional product clarification required before recording this block.
