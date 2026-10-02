# Decision block 7 — Rich documents

Status: agreed direction for the first version, 2026-10-02. Embeds and HTML blocks are a later phase.

A rich document (user-facing: *rich doc*; code: `document`) is a block document an agent writes for the user. The user reads it, answers its questions, edits it, comments on highlighted text and submits it in one go. The agent revises it and hands it back. Every handoff is a revision. The wire contract is `core/src/protocol/documents.ts`.

## 1. Ownership and visibility

- Only agents create documents. Agents may create, list, read, edit and delete them without further restrictions.
- A document belongs to the context of the conversation it was created in: the installation or an organization. The admin agent may name an organization instead.
- An agent sees the documents of the context it works in; the admin agent sees every document. The owner sees every document of the installation.
- Each document has a home chat and thread, where it was created, and a responsible agent, its creator. A submission is posted to the home thread. Removing the home thread, or deleting the document's organization, removes the document.

## 2. Turns

`turn` says whose move it is.

```text
user turn: draft autosaves ──Submit──> agent turn (locked) ──run ends──> user turn
                                         │
                                         └──Take back──> user turn (run's edits discarded)
```

- On the user's turn the user saves a draft. A save names the revision it is based on and the draft version it replaces (0 when there is none); either being stale is a conflict.
- Submit turns the draft, or the unchanged content when there is none, into a user revision, opens its comments, posts a message `[note, document card]` to the home thread and starts the agent's run there exactly like a reply. The agent's turn is bound to that run.
- An agent's edits go to a working copy of its run. When the run ends (completed, failed, cancelled or recovery-needed) the working copy becomes one agent revision and the turn returns to the user. A run without edits adds no revision. Settling a run ends its turns at once; every read also ends turns whose run has ended, so a crash never leaves a document locked.
- Take back ends the agent's turn now: the working copy is discarded and that run's later edits are refused.
- An agent may edit a document on the user's turn when the user has no draft; its run then takes the turn under the same rule. With a draft, the edit is refused and the agent is told to ask the user to submit. An edit while another run holds the turn is refused.

## 3. Content

Blocks: paragraph, heading (1–3), list, checklist, quote, callout, code, divider, image, file, table, toggle, question and scale. Text fields hold a small inline Markdown subset. Clients show a neutral placeholder for an unknown block type and keep it unchanged. Block IDs are unique in a document and item IDs within their block. Images and files name an artifact readable in the document's context: owned by the document's context or its home chat's context, owned by the document's or the editing agent, or already referenced by the document. Limits are `DOCUMENT_LIMITS`.

Comments anchor to a field of a block and a range of its plain text. A submitted comment is numbered after the existing ones and stays open until an agent resolves it, optionally with a reply.

## 4. Agent interface

Agents work in a Markdown dialect rather than block JSON: headings, paragraphs, lists, checklists, quotes, `> [!NOTE]`/`[!TIP]`/`[!WARNING]` callouts, fenced code, dividers, GFM tables, `![caption](artifact:<id>)` images, `[name](artifact:<id>)` files, and fenced `question`, `scale` and `toggle` blocks whose `key: value` lines carry their settings and answers. Core parses and serializes it; serializing and parsing a block gives the same block.

Tools: `documents_create`, `documents_list`, `documents_read`, `documents_edit` (replace, insert, delete, move, title, resolve) and `documents_delete`. A replacement with one block keeps the block's ID, and its item and option IDs by position. A submission reaches the agent as text listing the note, answers, checklist changes, added, edited and removed blocks, and each new comment with its ID, quote and body.

## 5. Events

Every change publishes `document-changed` with the document summary; a draft save publishes only when the summary changes (a draft appears or its unanswered questions change). Deletion publishes `document-removed`. Bootstrap capabilities include `documents: true`.
