# Decision block 2 — Conversations and work lifecycle

Status: agreed architectural direction, 2026-09-17. Exact schemas, API/tool signatures, and harness-specific continuation mechanics are subsequent design work.

This record builds on [Identity and ownership](./01-identity-and-ownership.md). It supersedes the earlier suggestions of frontend-only submitted queues, blocking voice-only work on transcription failure, and a single execution lock that would prevent delegated work from running within a thread.

[Decision block 5](./05-kipster-protocol.md) adds the agreed protocol behavior: queued cancellation retains messages, Stop holds ordinary follow-ups until Resume, questions allow optional text/dismissal, first accepted answers win, child questions route through the original thread to the correct child, and application/thread streams support durable notifications. Use those refinements when implementing the lifecycle below.

## 1. Chats, threads, participants, and runs

| Concept | Meaning |
| --- | --- |
| Chat | A conversation space with identified participants and an organization or installation context. |
| Thread | One root message and its subsequent conversation; an independent work context within a chat. |
| Message | Authored content from a human, agent, or system, with ordered content parts. |
| Run | Durable work triggered by a message or a correlated continuation. |
| Execution attempt | A particular harness invocation/session operation for that work. |
| Delegation | A correlated request from one agent to another and its delivery, work, and result history. |

Initially, implement a direct chat between the current human and an agent in the active organization. The domain must also admit future human/agent group chats and agent-to-agent chats; those dedicated UI experiences are deferred. A chat is not globally unique to an agent or an organization alone.

Examples of distinct future chat spaces:

- Human A and Agent X in Organization One.
- Human B and Agent X in Organization One.
- Human A, Human B, Agent X, and Agent Y in an explicit group chat.
- Agent X and Agent Y in a dedicated agent chat, if that feature is added.

Chat participants are recorded explicitly. Messages retain their author, intended recipient/routing context, and source thread/run where applicable. Choosing a future group-chat routing policy does not follow automatically from having participant records.

Displaying Agent X in two visual groups does not create two copies of the current human's direct chat with X. It also does not merge every human's conversation with X. Visual groups are navigation assignments; group chats are participant-based conversation spaces.

Root-admin chats use installation context. Selecting another organization must not silently retarget an existing admin conversation or pending operation.

A new top-level message starts a new independent thread in the current chat. It does not require creating a new chat container. Replies use an explicit existing thread ID. Thread isolation means its conversational execution context is independent; it does not create another agent identity or memory store.

## 2. Parallel work, queues, and steering

### Parallel threads

- Fresh threads may execute concurrently, including multiple threads involving the same agent.
- Initial installation-wide active AI execution limit: **20**, configurable from the beginning.
- Count delegated AI executions toward the same limit. The value is a ceiling, not a promise that a provider or host will sustain 20 executions.
- Persist excess work as queued. There is no maximum of 20 stored threads or logical pending workflows.
- Each thread/agent execution context must be distinct; never feed two unrelated concurrent threads into the same active provider session.
- Shared agent identity and memory remain continuous across organizations, as decided in block 1. Concurrency does not create separate brains. Coordinate mutable shared state and memory maintenance; detailed workspace conflict handling belongs to subsequent blocks.

### Queue ownership

When the human submits a message, Kipster persists it immediately, whether it can execute now or must wait. Acknowledgement means it is durably accepted. The UI renders the backend queue and does not retain the sole copy of submitted work.

Within a thread, ordinary human follow-ups queue behind the current primary workflow. New root messages remain independent. Local unsent drafts and temporary upload state are distinct from accepted queue entries.

### Steering

A user may select a queued message and request steering of the current execution. The Core targets a specific active run/attempt and delegates only if that adapter supports steering.

- Accepted steering consumes that queue entry so it cannot later run again as an ordinary follow-up.
- If the target finished or the adapter does not support steering, the message remains queued and the UI shows the actual result.
- If acceptance is uncertain, reconcile before either replaying steering or releasing the message for ordinary execution.
- Do not silently substitute cancel-and-restart for unsupported steering.

Interaction answers and delegated results are continuation/control inputs. They must not sit in the ordinary human queue behind the workflow waiting for them.

### Waiting and capacity

Waiting for a human or another agent leaves a logical workflow open without requiring continuous model execution. The scheduler must not deadlock when all execution capacity belongs to parents waiting for children.

Adapters should suspend/release execution capacity when supported or yield to a persisted continuation. If a provider cannot suspend, admission and capacity accounting must still permit dependencies to progress within the configured limit; define the concrete strategy in the execution block. Do not mark an actively executing provider as suspended merely to evade the limit.

## 3. Message content and file preparation

Messages carry ordered content parts, initially:

- Markdown-compatible text and ordinary links.
- Images, including camera captures.
- Documents and arbitrary file attachments, such as PDF, text, Markdown, and archives.
- Video attachments, without requiring automatic video interpretation.
- Voice notes used as spoken instructions.
- Ordinary audio attachments used as material for the task.

One message can combine text, a voice note, and other attachments. The UI communicates file purpose explicitly; do not infer voice-note intent from MIME type or extension alone. Exact field names belong to the protocol block, but it must distinguish `voice_note` from an ordinary audio/file attachment.

Store uploaded bytes and stable artifact references before declaring the message ready for execution. Preserve part order, file metadata, original bytes, and any derived information. The Core makes references/files available to the execution adapter, which translates them to provider-supported inputs or readable host paths. Filesystem layout belongs to the storage block.

Retaining a file does not mean the selected model can understand its contents. Preserve unsupported inputs and make their availability/limitations explicit; do not silently drop a video or imply it was analyzed. Opening the camera, recording gestures, and composing captions are UI features over these same message parts.

## 4. Voice notes and transcription

### Automatic preparation

Every input explicitly designated a voice note receives automatic transcription through the installation-configured transcription service. Initial implementation: Spokenly CLI. Reserve an interchangeable CLI/API service contract without implementing additional providers now.

Normal flow:

```text
Save message and original recording
→ acknowledge receipt
→ automatically transcribe
→ save transcript/status alongside the voice note
→ dispatch the prepared message to the agent
```

No human confirmation is required for the normal transcription step. Display preparation state while it runs. Transcription preserves the spoken language unless translation is requested separately.

Typed text remains typed text. A transcript is machine-generated derived content associated with its source voice note, not a replacement for the original recording or caption. Make it available to the UI and agent with that provenance. Instruct the agent to interpret likely transcription errors using context and ask when uncertainty materially affects the task.

### Failure policy

Make a bounded best-effort attempt, then continue to the agent even if transcription is unavailable, including for voice-only submissions. Do not indefinitely hold the message in a mandatory Retry/Add text screen.

Pass the original recording, any independently typed text and other attachments, and an explicit marker such as: “This message includes a voice note; automatic transcription failed.” Preserve the failure status separately from successful empty/no-speech output.

The agent can invoke the transcription tool, use supported audio processing, work from available context, or ask the user for clarification. Do not claim the audio was understood when no available tool/provider can interpret it, and do not invent missing instructions. A later successful transcription must be recorded as a new derived result and delivered through a correlated tool result or continuation, without silently launching a duplicate user run.

“Added text” means an optional typed caption or message the user already supplied, not a new required action. If nothing was typed, send the recording and failure marker.

### Model-facing transcription capability

Expose the same configured transcription service to agents through a Kipster tool. That lets an agent transcribe an ordinary attached audio file when the task calls for it, or retry a failed voice note. The tool operates on a registered artifact or an allowed file reference and returns transcript/status/error information. Exact arguments, retry policy, caching, and supported formats belong to the execution and storage blocks.

The tool is part of the standard Kipster capability catalog. An unavailable dependency should report unavailable, rather than disappear silently. Health checks must validate that the configured transcription dependency works. A CLI running on the host does not by itself imply that its underlying recognition model runs locally; inspect the chosen dependency configuration during implementation.

## 5. State, reactions, progress, and user-facing output

Keep these concepts separate even when they appear together in the UI:

| Concept | Purpose |
| --- | --- |
| Message acknowledgement | The submitted message reached Kipster and was saved. |
| Run state | Queued, preparing, running, waiting, completed, failed, cancelled, or recovery needed. Exact enums remain to be specified. |
| Reaction | A displayable reaction attached to a specific message. |
| Activity timeline | Public updates about meaningful work and agent collaboration. |
| Published message | Intermediate or final content sent to the user. |
| Interaction | A question or approval awaiting an explicit response. |

Core-owned status can be rendered as reactions such as received/looking, completed/checkmark, or failed/warning. Receipt is not evidence the model has started. Ordinary requested reactions do not override the authoritative run lifecycle.

The agreed name is **activity timeline**. Initially, its entries are short text updates. Models receive an operation for publishing meaningful progress; Kipster can supplement it with factual lifecycle and delegation updates. Do not depend on private chain of thought or require a model update to determine whether execution is active.

Agents may publish multiple intermediate messages and a final message, with attachments. Distinct messages retain identity and order. Deltas belong to a particular message; persisted finalized content remains authoritative after reconnect.

The model can indicate that it has completed the requested work, but Kipster finalizes run state after the execution outcome and durable outputs are reconciled. An intermediate message, a checkmark, or text containing “done” is not sufficient by itself. Provider failure after a message was published must not be hidden by that message.

Native provider final output and explicit publishing tools must not duplicate or suppress the actual answer. In particular, publishing an intermediate update must not suppress all later final output. The precise authoritative publication mode and no-additional-message completion contract are execution-adapter decisions.

## 6. Questions, approvals, and interactive blocks

Initially support one choice-card layout with prompt text and up to five labeled options. Stable option IDs carry meaning independent of display labels. The renderer decides buttons versus other suitable presentation. Keep a versioned block/type extension point for future card layouts; optional free-text answers can be expressed when supported.

A question and an approval may share this layout but retain distinct semantics. A question captures a preference or information; an approval authorizes a particular proposed action and context. Normalize native harness requests and explicit model-created requests into durable Core interactions.

The response contains the interaction identity and selected option/answer. Kipster derives the responding human from its trusted request context, resolves the interaction atomically, and records a visible response in the same Kipster thread. User-authored answer text must remain distinguishable from system narration of that answer.

## 7. Returning after days and continuing work

An SSE connection is only a subscription to updates. It does not own the interaction, thread, provider session, or continuation. Closing the stream cannot discard a question or cancel pending work.

Required scenario:

1. An agent asks a question or requests approval.
2. Kipster saves the interaction, pending work, and continuation context before presenting it.
3. The user leaves for three or four days and the SSE connection closes.
4. The user returns from any device; history/snapshot recovery shows the pending interaction.
5. The user responds through an ordinary command, independently of whether SSE is currently connected.
6. Kipster saves that answer once, adds the interaction response to the original thread, and schedules the correlated continuation.
7. The adapter resolves/resumes the original provider operation when supported. Otherwise, it reconstructs a continuation using saved conversation context, the original request, the explicit answer, completed work, and artifacts.

Continuation stays in the same **Kipster thread**, even if it needs a new provider invocation or session. “CLI” does not inherently mean stateless: use actual integration capabilities. Context assembly may need a faithful summary and selected history when the full transcript exceeds a provider's limits; preserve the complete canonical history in Kipster.

Do not impose a short blanket expiry on Kipster questions just because an SSE stream or RPC cannot remain open indefinitely. Provider waiting lifetimes and action validity are separate from interaction retention. Exact restoration of hidden provider state is not guaranteed.

A saved approval authorizes the exact recorded proposal. If the action or relevant conditions materially changed, request fresh approval instead of applying a stale answer to another operation. Never restore an unknown external side effect by blindly replaying it. If safe continuation cannot be reconstructed, preserve the answer and show recovery needed.

Duplicate responses from devices return the recorded outcome. Cancelled or superseded requests cannot affect newer work. A normal queued message is not an implicit approval.

## 8. Agent-to-agent work

An agent may ask another agent for help during an active workflow. Kipster is the intermediary: it durably routes the request, dispatches recipient work, tracks status, and returns correlated results and continuation signals.

Persist the asking and receiving agents, originating chat/thread/run, explicit organization or installation context, request content/files, delivery identity, status, result, and continuation relationship. Preserve this provenance even though the UI initially shows only concise summaries. No implicit organization switch or global single “current organization” may retarget a request.

Example:

```text
Human → Agent A: Prepare a launch plan.
Agent A → Agent B: Review technical risks.
Kipster activity: Agent A is consulting Agent B.
Agent B performs its work in a separate execution context.
Kipster activity: Agent B finished its review.
Kipster delivers the result to Agent A's originating workflow.
Agent A continues and publishes the combined result.
```

The asking agent may continue independent work, inspect delivery status, or wait for the dependency. Kipster schedules continuation when a requested result becomes available; automatic continuation does not depend on repeated model queries. Keep status lookup available and use neutral model guidance: neither encourage nor discourage polling. Deliver results through a supported tool-return, steering, or subsequent continuation path, never concurrently mutate an incompatible active provider session.

Recipient follow-up questions and replies remain correlated to the delegation. If a child needs a human decision, route it to the responsible human with its source agent and interaction identity rather than answering it as that human. Exact tool contracts are block 3 work.

A delegated child is not an ordinary human follow-up queued behind its parent. One primary workflow per thread can own multiple independent child executions, with shared installation capacity accounting. Replies, questions, and dependency resolution must not create A-waits-for-B/B-waits-for-A deadlocks. Detect blocked dependency cycles and report them; bound unattended chains without choosing arbitrary numeric limits in this block.

If the parent is stopped, cancel its outstanding child work where supported and suppress automatic revival by late results. Retain late results and delivery history. A parent explicitly waiting for a result can resume; a finished parent should only be reactivated by a previously recorded follow-up/monitoring intent or an explicit new request.

Initial user-facing presentation: concise activity entries about who is consulting whom and whether work is running, finished, or failed. A detailed expandable exchange, dedicated agent chat, or public group discussion is deferred. Agent B's internal result does not automatically become an ordinary user-facing message; Agent A can incorporate or publish it deliberately.

## 9. Disconnection, failure, and persistence

Preserve the implementation plan's durable event log, per-thread cursors, consistent snapshots, request deduplication, and recovery behavior. Reconnection reloads state; it does not re-execute the user's message.

Distinguish device connectivity from transcription availability, execution state, interaction state, and delivery state. Already-published messages and artifacts remain available after a later failure.

Cancellation is an explicit Core command, not the loss of a stream. Fence obsolete attempts so late events cannot complete newer work or consume a newer interaction. Retries reconcile already-completed outputs and uncertain side effects before repeating execution.

## 10. Acceptance scenarios for later implementation

- The same human opens an agent from two visual groups and sees the same direct chat; another human's future direct chat is not silently merged with it.
- Two root messages to the same agent execute in separate threads concurrently; replies to a busy thread queue in Kipster.
- At a configured ceiling of 20 active executions, additional work remains durably queued and dependencies can still make progress without exceeding the ceiling.
- Closing the originating UI preserves queued messages; another device sees their current state.
- Steering consumes a queued message exactly once when acceptance is established; unsupported or uncertain delivery is represented honestly.
- A message contains typed text, a voice note, image, and PDF in order; camera capture needs no special execution path.
- Voice-note transcription runs without asking the user. Ordinary attached audio is not automatically treated as an instruction; the agent can explicitly call the same transcription service.
- Failed transcription still dispatches original audio, any typed text, and an unavailable marker. The agent can retry or ask for clarification without inventing the instruction.
- Progress, several intermediate messages, and final output render without a duplicate or accidentally suppressed answer.
- An interaction created four days earlier survives disconnection/restart, records the response once, and continues in the original Kipster thread through native resume or supported reconstruction.
- A stale/cancelled approval cannot authorize changed work.
- Agent A delegates to B; B can run independently of A's ordinary thread queue; its result resumes the appropriate workflow and produces concise activity updates.

## 11. Remaining design work

[Decision block 3](./03-execution-adapters-and-agent-capabilities.md) records the execution context, adapter package lifecycle, capability catalog, publication, and continuation direction. Concrete signatures and first-harness support still require implementation verification.

Storage and protocol blocks will define physical schemas, durable scheduling mechanics, artifact paths, retention, dependency health configuration, and request/event schemas. Future group-chat routing, dedicated agent-chat UI, edits/deletion/archival behavior, and detailed collaboration displays remain explicit follow-up product decisions rather than implied features of this block.
