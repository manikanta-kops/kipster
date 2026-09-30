# Decision block 4 — Storage and recovery

Status: agreed storage direction, 2026-09-18. Core-owned embedding service placement is the recommended interpretation of the requested SDK methods; exact method signatures and physical table definitions remain design work.

This record builds on blocks [1](./01-identity-and-ownership.md), [2](./02-conversations-and-work-lifecycle.md), and [3](./03-execution-adapters-and-agent-capabilities.md). It supersedes earlier tentative engine choices, per-collection embedding overrides, and immediate backup/move tooling. This is a fresh implementation: Hidden Leaf Village and the predecessor LeafOS 2.0 are references only, with no schema/code copying or data import implied.

[Decision block 5](./05-kipster-protocol.md) refines file ownership/publication, current-memory correction without a full correction archive, separate application/thread replay streams, and durable notification state. Its membership-removal behavior lets accepted work finish; actual agent/organization deletion still fences affected work as specified below.

## 1. One engine, two data capabilities

Choose PostgreSQL with pgvector. One Kipster installation uses one managed PostgreSQL instance and one application database for relational records and vectors. Chroma and a separate graph database are not part of the selected architecture.

Every agent and organization has both structured-data and vector-data capabilities. A logical data space is a namespace/ownership context inside this database, not another database server, another process, or a copied brain.

```text
Kipster installation
  |
  `-- PostgreSQL database + pgvector
        +-- Core records: identities, memberships, chats, work, events
        +-- Memory records: content, evidence, synapses, embeddings
        +-- Agent A's custom tables and vector collections
        +-- Agent B's custom tables and vector collections
        `-- Organization X's shared tables and vector collections
```

Use shared Core-managed tables for standard domain/memory records, with explicit ownership. Named PostgreSQL schemas are the proposed organization for arbitrary agent/organization task tables. Exact SQL names and ownership relationships remain to be specified; creating a namespace does not require duplicating all fixed tables for every owner.

A collection is a named set of searchable records, backed by PostgreSQL/pgvector. Agents can create collections and task tables as their work requires. The framework does not impose a predetermined list of task-specific tables or collections. A vector collection need not correspond to a separate physical database or PostgreSQL server.

## 2. Ownership, discovery, and avoiding accidental duplication

Agents have one continuous personal brain across organizations. Organization resources are independently owned shared data. Joining an organization does not copy agent data into it or copy the organization store into the agent's personal space.

Default memory retrieval uses the current agent's memories plus the active organization's shared knowledge. Data/vector service calls derive acting identity and default ownership context from the execution. Discovery operations list available tables/collections and their owners; the model does not need to guess a connection string, host directory, or database name.

Operations identify a target owner or collection when needed. This is routing, not a new prohibition on access to another agent's data. Preserve acting identity separately from owning identity, following block 1.

Two intentional distinctions are not accidental duplication:

- An embedding is a derived numeric representation of source content, not a second authoritative memory.
- Publishing personal knowledge or a file into an organization creates or transfers independently owned organizational content. That publication must survive deletion of its authoring agent.

The UI may present a simple personal/shared data view without exposing internal schema names. Sources, collection identifiers, and ownership remain inspectable through services.

## 3. Extensible task data and Core consistency

Agents may create, alter, query, and remove custom task tables and indexes, and create/read/write/search their vector collections. Data structures are driven by the task, not limited to built-in Kipster examples.

Standard memory and conversation operations go through their Core services so evidence, events, interactions, and work records remain consistent. Flexible task-data creation does not change the agreed rule that adapters report to Core rather than directly manipulating conversation tables.

Structured and vector methods are part of the Core service/API surface, exposed to agents through the mechanisms supported by execution adapters. Physical schema/role design must preserve Core invariants without introducing an unrequested personal-store access ban. Broad host access remains part of the trusted deployment model.

## 4. Embedding configuration and SDK boundary

Use one installation-wide default embedding service/profile, configured during setup. Ollama is a possible provider; the specific model, endpoint, and provider implementation remain to be selected. Do not introduce per-agent or per-collection model override features now.

Recommended placement: the embedding service belongs to Kipster Core and is callable through its SDK/tool services. It does not belong to the Codex or another execution adapter. Core already exports shared contracts/helpers; this does not introduce a separate adapter SDK package, contrary to block 3's agreed simplicity.

```text
Agent / application calls Kipster vector methods
                  |
                  v
       Core vector + embedding service
            |                 |
            v                 v
     Configured provider   PostgreSQL + pgvector
     turns text into       saves/searches content,
     vectors               metadata, and vectors
```

Execution adapters expose these operations to their harness; they do not own a different embedding configuration for each harness. Changing a conversation's execution adapter/model must not silently change how its memory is embedded.

Illustrative responsibilities, not final API signatures:

- Register/configure an embedding provider through Core setup/SDK facilities.
- `vectors.createCollection`: create a named collection in the selected ownership context.
- `vectors.upsert`: save source content/metadata and obtain embeddings through the configured service.
- `vectors.search`: embed a text query using the compatible profile and return matching records.
- Collection/record discovery, get, and deletion operations.

Memory services can use these lower-level facilities. Saving a memory also preserves evidence and memory-specific meaning; a generic vector upsert is not the entire memory algorithm.

Keep the configured embedding model stable. Store the profile identity, model identity/version information available from the provider, dimension, and content/indexing status needed to establish compatibility. This metadata is not a frozen execution-instruction/configuration subsystem.

Different embedding models can produce incompatible vector spaces even with equal dimensions. A model change must never silently search old vectors with an incompatible new query embedding. Preserve original records and identify incompatible/pending indexing explicitly. An intentional model change requires a rebuild/migration path; convenient change UI and warning flows can be designed later. Do not erase canonical memory simply because indexing is unavailable.

Embedding generation/updates are recoverable background work where appropriate. Save source content and durable indexing intent; a provider failure must not permanently strand unsearchable records without a recorded repair path. Full model-change tooling is not required in the current implementation scope.

### Retained source content and future embedding rebuilds

Every Kipster-managed embedding must reference retained source content, not just a vector or a temporary/external URL. For text, retain the actual text/chunk used for embedding, its source record, content revision/hash, and relevant preparation metadata. If non-text embedding is supported, retain the corresponding managed source artifact and preprocessing information. A vector is a derived search representation; it cannot reliably reconstruct the original content.

Keep canonical content independent of embedding rows. The schema must allow multiple embedding generations for the same content revision, each identifying its model/profile, dimension, generation, and indexing status. Do not make replacing a model overwrite the only previous embedding. This is content/index compatibility tracking, not frozen execution instructions or settings.

The future rebuild flow is:

```text
Retained source text/content
          |
          +-- Existing embedding generation -> remains active during rebuild
          |
          `-- New model -> new embedding generation
                                |
                         Validate completeness
                                |
                         Switch active generation
                                |
                         Retain old generation for rollback
```

Re-embed from the source content, not from the old vectors. Source updates/deletions during a rebuild must be reconciled before activation so new search results correspond to current records. An old generation retained as a rollback backup does not automatically include later content changes; a future rollback operation must catch up or explicitly handle those differences. Preserve profile information needed to generate compatible query vectors, and never search one generation with another model's query embeddings. Old generations still follow explicit deletion/retention rules; they must not resurrect deleted content.

Retaining source content and permitting parallel generations are storage requirements now. Rebuild orchestration, activation/rollback controls, progress UI, and old-generation cleanup policies remain future features.

## 5. Memory is a core architecture responsibility

Memory is not deferred as a temporary or reduced design. The storage contract must support:

- Facts, observations, and episodes.
- Agent-global ownership and explicit organization publication.
- Multiple provenance/evidence records, including source organization, conversation, author, and subject where applicable.
- Typed, weighted synapses with supporting evidence and change history.
- Reconciliation of conflicting or changed knowledge.
- Durable extraction, consolidation, indexing, and maintenance work.
- Identity evolution with recorded evidence/history and recoverable file updates.
- Relevant retrieval before execution and additional agent-invoked search.

Synapses are explicit graph relationships stored as relational records. A separate graph database is not required to represent them. Vector search finds relevant content; synapses express supported relationships between records. These are different functions.

The phrase "future work" in the earlier explanatory diagram meant later tasks using remembered information. It did not mean postponing memory implementation.

Exact extraction, ranking, decay, consolidation, and reflection algorithms still need design and validation. Selecting pgvector alone does not establish memory quality. Coordinate maintenance per global agent while preserving the parallel conversation behavior in block 2. This is database/memory integrity, not the workspace locking excluded in block 3.

Current memory wording can be corrected in place under its stable ID, as agreed in decision block 5. Do not require an archive of every previous wording. Retain current source content/evidence and a revision or hash to keep embeddings consistent. This does not remove the separate provenance, synapse-change, or identity-evolution requirements above. A later correction-history feature records subsequent changes; it cannot reconstruct already-overwritten wording.

## 6. One persistent home per agent

Create one stable home directory for every agent, keyed by its ID and independent of organizations and adapters. Use it as the default working directory for that agent's executions. No per-thread worktrees or automatic workspace locking are introduced.

Seed an `AGENTS.md` file with default operating instructions and provide soul, identity, journal, and file/output locations. Agents may create task files in their home. Exact optional filenames/layout can be finalized with implementation.

```text
<kipster-home>/
  +-- installation.json
  +-- system/
  |     `-- instructions.md
  +-- agents/<agent-id>/
  |     +-- AGENTS.md
  |     +-- soul.md
  |     +-- identity.md
  |     +-- journal.md
  |     +-- files/
  |     `-- outputs/
  +-- organizations/<organization-id>/
  |     +-- instructions.md
  |     `-- files/
  +-- artifacts/<artifact-id>/...
  `-- database/postgres/...
```

The tree illustrates ownership and locality, not another database per agent directory. Agent SQL/vector data lives in the shared managed database. Deleting an agent therefore requires a Core lifecycle operation, not merely deleting its directory.

Read current instructions/settings for each new execution, including retries and new continuations. Already-running work continues with its supplied inputs. A future file-view/edit UI changes those authoritative files; the next execution picks up the changes. Do not build that editor or a frozen instruction-copy system now. Adapters must convey instructions through supported provider mechanisms rather than assuming all harnesses discover `AGENTS.md` automatically.

## 7. Managed files and ownership-based deletion

Generated outputs can be staged in agent output directories. Publication produces a stable registered artifact with a logical storage key, metadata, ownership, and message associations. Uploaded originals and derived transcripts retain their relationship. Filesystem bytes and database records require a recoverable staged publication process; ordinary SQL transactions alone do not atomically commit both.

Deletion rules:

| Operation | Remove | Preserve |
| --- | --- | --- |
| Delete agent | Agent-owned memory, vectors, custom data, home, and personal files; memberships/appearances | Organization-owned contributions and messages in surviving organization conversations |
| Delete organization | Organization-owned shared data, vectors, files, conversations, memberships, and groups | Global agents, their homes, and what they personally learned |
| Remove membership | Membership and associated visual assignments | Global agent and its brain; organization-owned contributions |

Deleting an agent retains authorship attribution on surviving organizational messages as a deleted-agent reference/tombstone. Such a minimal reference is not retention of the deleted agent's brain or configuration.

Organization-owned publications must not depend solely on deleted personal files. Retained memories can preserve evidence metadata indicating that a source was deleted; they must not secretly retain a complete deleted organization's store as a backup. Personal learning already retained by a surviving agent remains, as explicitly agreed.

Stop/fence affected work during deletion so late outputs cannot recreate deleted state. Actual database/filesystem cleanup needs durable progress because it spans multiple stores. Exact treatment of personal or installation-level chats on agent deletion and retention periods for transient events/diagnostics remain to be specified. Do not infer those policies solely from organization-chat retention.

## 8. One Kipster home and future portability

All Kipster-managed persistent state should be rooted in one configurable home: managed database data, settings, identity files, managed agent/organization files, and artifacts. Installed packages/runtime binaries are dependencies that can be installed again; they are not the canonical user data.

Use home-relative storage keys for managed paths. Avoid mandatory external database volumes or hardcoded developer paths that would scatter application-owned state. Configure the database runtime to keep its data in the chosen home.

The desired future move is stop, copy the home, install compatible dependencies, and start using the copied home. Stopping includes the database; copying live database files is not the assumed procedure. Raw PostgreSQL directories require compatible runtime/platform details. An eventual logical export/restore can handle incompatible environments while keeping the transferred data in one folder.

Portability is a design constraint now, not a request to implement move commands, automated exports, scheduled backups, or ZIP generation now. Those features remain deferred. Provider-owned authentication/sessions may require reconnection; preserve Kipster context for supported reconstruction.

External files intentionally created outside Kipster home are accepted exceptions. Do not introduce host-wide scanning, extra isolation, or backup machinery to prevent them. Default managed paths keep ordinary work inside the home; arbitrary external dependencies are outside the one-folder guarantee.

## 9. Recovery remains part of the Core

Preserve the accepted durability behavior from blocks 2 and 3:

- Acknowledge submitted work after durable persistence.
- Persist work and state changes with corresponding observable events in transactions.
- Maintain ordered per-thread replay events and consistent snapshots; SSE does not own work.
- Store questions, approvals, answers, delegation results, and continuation intent across restarts.
- Reconcile provider execution before replacing an expired/crashed attempt; do not blindly replay uncertain effects.
- Fence cancelled/obsolete attempts and retain useful published output after later failure.
- Persist memory/indexing work and file-publication progress so interrupted processing can be recovered.

Physical table definitions, indexes, transaction boundaries, event retention, and migration mechanics are the remaining storage implementation design. The selected direction is not a claim that these mechanisms are already implemented.

## 10. Remaining design details

- Exact shared tables, namespace provisioning, constraints, and deletion/reference relationships.
- Final directory/file names and authority for each configuration field, without two independently writable masters.
- The default embedding provider/model and precise SDK/tool arguments.
- Memory processing/retrieval algorithms and quality checks.
- Transient event, diagnostic, and intermediate-file retention.
- Database packaging/startup and compatibility validation.
- Detailed personal/installation-chat deletion behavior and file ownership transfer semantics.

There is no migration/import from either older repository. No service operation or code implementation is authorized merely by recording these decisions.
