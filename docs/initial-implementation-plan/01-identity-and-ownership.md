# Decision block 1 — Identity, ownership, and organizations

Status: agreed architectural direction, 2026-09-17. Physical schemas, detailed APIs, and memory algorithms are not finalized here.

This record supersedes earlier suggestions of organization-specific agent memory and strict separation between agents' personal stores. It complements the implementation plan.

Protocol refinements are recorded in [decision block 5](./05-kipster-protocol.md): latest-save settings, stable IDs with duplicate display names, administration/discovery, and membership removal that preserves already-accepted work. Global identity and ownership rules below remain in effect.

## 1. Installation and initial setup

- One installation is one running Kipster backend with a stable installation identity.
- AI-guided setup provisions the UI and backend connections and creates one initial organization, one human owner, and one root admin agent. Later organizations are created inside the same installation.
- Humans and agents have stable identities independent of any organization. Both can belong to multiple organizations through memberships.
- There is one initial human and one initial root admin agent, but neither is a hardcoded singleton in the domain model.
- Authentication is deferred. Initial trusted-owner mode maps permitted requests to the configured human. Future authentication resolves to these existing human identities and memberships.
- Bootstrap should resume safely after interruption and preserve existing identities and configuration rather than creating duplicates.

## 2. Root admin is an agent

The root admin has the ordinary agent facilities: identity, soul, instructions, memory, synapses, files, execution settings, conversations, and messaging.

Its specialization is installation-level administration. It receives instructions/context and applicable operations for organization and agent creation, reading, updating, deletion, and future system configuration. It is not a separate species of entity or a substitute for the human owner.

The UI displays it above the organization switcher. Its identity and administrative conversations do not change with the selected organization. Administration requests must identify their target explicitly in the Core rather than silently retargeting existing work when the UI switches organizations.

Model root administrative designation as an extensible role/capability association, initially assigned to one agent. The precise tool catalog and any future restrictions are subsequent decisions; this record does not introduce exclusive permissions for all ordinary agent operations.

Proposed bootstrap detail: configure the root agent's execution settings explicitly so it can operate before or outside an organization without borrowing an arbitrary organization's defaults.

## 3. Organizations and memberships

An organization supplies shared context and organization-owned resources:

- Name and descriptive metadata.
- Human and agent memberships.
- Organization instructions editable as text.
- Default execution adapter, model, and reasoning effort where supported.
- Shared structured data, vector-backed knowledge, and files.
- Organization-wide visual groups of agents.
- Organization-associated conversations/work; their detailed participant model belongs to decision block 2.

A membership connects an existing identity to an organization. It does not copy that identity, create another brain, or automatically grant another organization ownership of its data.

Keep memberships as meaningful records so future organization-specific settings or roles can be added. Do not implement those optional overrides now or make them necessary for the initial model.

Ownership describes where records belong; it is not equivalent to a restrictive access policy in the initial trusted deployment. Organization-shared resources are available to its participants without fine-grained restrictions initially.

## 4. One persistent agent across organizations

Each agent owns one continuous set of personal resources across the installation:

- Stable ID, name, description, and agent configuration.
- `soul.md`, `identity.md`, and operational instructions.
- Learned facts, observations, episodes, synapses, and vector representations.
- Journal and memory-maintenance history.
- Identity-file versions and evidence for evolution.
- Agent-associated structured data and files.
- Explicit adapter/model/effort overrides.

Memory is not partitioned into one agent brain per organization. Working in another organization changes the active organization context, not the agent identity or its accumulated learning.

Conceptual context assembly:

```text
Agent identity and instructions
+ Relevant retrieval from the agent's continuous memory
+ Active organization's instructions and relevant shared context
+ Current conversation and task inputs
```

Carrying the memory store does not mean loading every memory into every prompt. Retrieval selects relevant portions. Organization-specific facts retain their context so a fact about A is not mistaken for a rule in B.

Organization A's shared store is not automatically copied into or mounted as Organization B's shared context. However, the agent can retain learning from its work in A and use that learning elsewhere. Separate organization stores do not promise that an agent forgets what it learned in another organization.

Sleep/consolidation and identity evolution must coordinate per agent across its work in all organizations. Do not let two organization-specific maintenance jobs overwrite the same soul or maintain divergent copies of it. Exact scheduling and concurrency mechanics belong to later blocks.

## 5. Memory origin and evolution

Record where learning came from without using origin to divide the agent's brain. Preserve, when applicable:

- Owning/learning agent identity.
- Source organization or system-level context.
- Source conversation and message IDs.
- Source human or agent, separately from the subject of the memory.
- When the underlying event occurred and when the memory was captured.
- Evidence and source references for derived or consolidated knowledge.

A memory can accumulate evidence from multiple organizations or conversations. Preserve multiple provenance records instead of overwriting one origin field. For knowledge learned from another agent, retain the message and source-agent reference and any supplied original evidence; do not claim the receiving agent witnessed an event it only heard about.

The intended memory behavior takes inspiration from Hidden Leaf Village and the more durable mechanics in 2.0:

1. Extract facts, observations, and experiences.
2. Reconcile them with existing knowledge and track contradictions or changes.
3. Form and refine weighted synapses.
4. Consolidate and maintain memory during sleep.
5. Evolve soul/identity from supported patterns with history and evidence.
6. Publish useful knowledge into the intended organization's shared store as a distinct action.

Distinguish experience-to-knowledge consolidation, knowledge-to-identity reflection, and agent-to-organization publication. These are not one automatic ladder through which every fact must pass. Publishing shared knowledge must carry an explicit organization destination; a global agent must not rely on a single permanently bound village.

This block establishes ownership and provenance. It does not freeze thresholds, extraction triggers, table-per-agent versus shared-table layout, vector engine, or promotion algorithms.

## 6. Collaboration and access to other agents' memory

Do not introduce a rule that agents are forbidden to read or write another agent's personal store in the initial model. At the same time, direct memory access is not the collaboration pattern to encourage.

The documented agent workflow is messaging: ask another agent, receive replies, exchange results, and learn from those conversations, following the 2.0 pattern. Provide correlated messaging operations through Kipster; exact request/response and asynchronous behavior belongs to the conversation and execution blocks.

Default retrieval uses the current agent's memory and the active organization's shared context. It should not automatically merge every agent's brain into every prompt. Any direct cross-agent data operation retains both the acting identity and the owning identity, preserving provenance and ordinary data-integrity checks.

No new dedicated brain-browsing feature is required merely because such access is not prohibited. Core mutation services still maintain consistency for conversations, runs, interactions, and memory maintenance. Broad access does not require bypassing their invariants.

## 7. Execution settings and instructions

Initial resolution is active organization defaults, overridden by explicitly configured agent settings. An agent's explicit settings apply across its organizations; unset fields inherit from the active organization. Validate the resulting adapter/model/effort combination, rather than silently using an incompatible inherited model after an adapter change.

Retain an extension point for organization-specific agent overrides and future message-level overrides without creating those product features now. The memberships and configuration resolver must not assume these can never exist.

As refined in [decision block 3](./03-execution-adapters-and-agent-capabilities.md), read current settings and instructions when each new execution begins, including retries and newly started continuations. Do not introduce frozen instruction/configuration copies. Already-running execution continues with its supplied inputs.

Organization instructions contribute context alongside agent identity and instructions. They do not replace the global soul or overwrite the agent's learned identity on organization switches. Detailed instruction ordering and conflict handling belong to the execution contract.

## 8. Visual groups

- Groups belong to an organization and are shared organization-wide initially.
- An agent can appear in multiple groups, such as VIP and Marketing.
- Each appearance points to the same agent membership. For the same human in the same organization, opening that agent through different visual groups resolves to the same direct chat/history. It does not create a new agent, separate memory, execution configuration, or duplicate conversation. This does not merge different humans' direct chats or future explicit group chats; see [decision block 2](./02-conversations-and-work-lifecycle.md).
- Groups have no automatic permission, workspace, or memory semantics.
- Persist creation, renaming, ordering, membership changes, and deletion through the backend/API.
- Removing an agent from one group leaves it in its other groups.
- Deleting a group removes only that grouping. Agents with no remaining group appear ungrouped; any other group memberships remain intact.
- Group deletion never deletes agents, organization memberships, conversations, files, or memories.

## 9. Lifecycle distinctions

Keep the following operations distinct in the model:

| Operation | Meaning |
| --- | --- |
| Remove group appearance | Remove only a visual assignment. |
| Delete group | Remove the group and its visual assignments. |
| Remove agent from organization | Remove that membership; preserve the global agent and its brain. |
| Delete agent | Installation-level agent lifecycle operation, with an explicitly designed retention/deletion policy. |
| Delete organization | Organization lifecycle operation, with an explicitly designed policy for its records. |

Do not implement global agent deletion as a side effect of membership or group deletion. Actual hard deletion, archival, restore, handling active work, and retention policies remain open for the lifecycle and storage blocks.

## 10. Remaining decisions belong to subsequent blocks

- Exact schemas and future group-chat routing, building on the chat, thread, and participant distinctions in decision block 2.
- Concrete queue, cancellation, steering, and asynchronous continuation mechanics, building on decision block 2.
- Physical database schema, artifact layout, and memory processing algorithms.
- API schemas for memberships, groups, settings, and lifecycle operations.
- Authentication/authorization beyond trusted-owner mode and future execution isolation.
- Detailed workspace allocation, skills packaging, instruction authority, and bootstrap implementation.

The conversation and work-lifecycle direction is recorded in [decision block 2](./02-conversations-and-work-lifecycle.md). No further clarification is needed to establish the identity and ownership direction recorded here.
