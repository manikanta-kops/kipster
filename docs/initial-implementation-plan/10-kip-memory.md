# Decision block 10: Kip memory

Status: agreed direction, 2026-10-12. It replaces the memory engine in
`core/src/modules/memory/` and its tools. The old engine is deleted without
compatibility code: no installation depends on it yet.
[Decision block 13](./13-memories-and-lessons.md) renames cards to memories,
adds per-kip lessons and changes the nightly actions.

Memory lets every kip (code: agent) recall what the user said in other threads
and on other days. The raw conversation stays the source of truth. Once a night,
new conversation becomes searchable thread chunks and shared cards. Each turn
gets the core cards and a meaning search over that memory, and tools let the kip
dig deeper.

## 1. Raw conversation

- `kipster.threads` and `kipster.messages` stay as they are and are the raw log.
  A thread is a root message and its replies.
- Memory never edits messages. They are removed only when their thread is
  deleted, and memory derived from a deleted thread is removed with it.
- Search finds threads, not single messages. A hit names its thread, and the kip
  reads the thread when it needs detail.

## 2. Visibility

- **Cards** are shared by every kip of the installation. A card learned in an
  organization thread carries that organization and appears only to kips working
  in it.
- **Threads** are private to the kip they belong to.
- **The admin kip** can search and read every kip's threads and every card,
  organization ones included, but only through tools. Nothing from other kips or
  organizations is placed in its prompt, and organization cards never become
  its core cards.
- Only the user's own messages become cards. Kip replies, tool output, web pages,
  files and other kips' messages give context but never become facts about the
  user.

## 3. Storage

One table per kind, with an agent column. No per-kip tables.

```text
memory_thread_state  thread_id, processed_position
thread_chunks        id, thread_id, agent_id, organization_id, from_position,
                     to_position, title, text, embedding vector(768), embedding_model
cards                id, type, subject, statement, details, confirmed, core,
                     organization_id, valid_from, valid_to, replaced_by,
                     created_at, updated_at, embedding vector(768), embedding_model
card_sources         card_id, thread_id, message_id
diary                agent_id, day, organization_id, summary, thread_ids,
                     embedding vector(768), embedding_model
```

- `type` is free text. Suggested types: fact, preference, person, goal,
  commitment, event, routine. The model may add new types without a schema change.
- `subject` names who or what the card is about: `user`, `Priya`, `Berlin trip`.
- `details` is free JSON, such as `{"due":"2026-12-01"}` or `{"every":"week","day":"Sun"}`.
- `confirmed` means the user said it directly; otherwise it was inferred.
- `core` marks the cards loaded on every turn.
- `valid_to` empty means still true. A replaced card keeps its row, gets
  `valid_to` and points to its replacement through `replaced_by`.
- Columns beyond the sketch: every table carries `installation_id`;
  `thread_chunks` has `started_at` and `ended_at` (the times of its first and
  last messages, for date-range search); chunks, diary pages and thread state
  have `updated_at`, and chunks and diary pages `created_at`. `embedding` and
  `embedding_model` are nullable: rows are saved first and embedded later.
- A diary page belongs to one context, like the thread chunks of its threads:
  one page per agent, day and organization, with no organization for
  installation threads.
- Deleting a thread removes its chunks, its thread state and its card sources,
  and deletes every card left with no source. Every diary page it contributed
  to loses the thread, its summary and its embedding in the same transaction:
  a page left with no thread is deleted, and a page with other threads owes a
  rebuild. Until the next nightly run writes it again from the remaining
  threads' messages of that day, never from the old summary, it is not
  searched. Deleting an agent removes its chunks and diary, and deleting an
  organization removes its cards, chunks and diary pages. Cards of other
  threads stay; a card replaced by a deleted card keeps its `valid_to`.
- Vector collections keep the installation's embedding profile in
  `embedding_profiles` and `embedding_generations`.

Example, after a day with three threads:

```text
thread_chunks  A   "Mon 12 Oct 2026, with Kip" + the two messages in full
               B1  Berlin flights (messages in full)
               B2  Berlin hotel and Priya (messages in full)
cards          event       user    "Dentist 13 Oct 2026, 3 pm"         {date, time}
               person      Priya   "User's sister"                      {relation: sister}
               preference  user    "Vegetarian since Oct 2026"          core, replaces "loves steak"
card_sources   each card -> its thread and message
diary          12 Oct  "Moved the dentist to 13 Oct. Planned Berlin with Priya. Went vegetarian."
```

Size: at 200 messages a day for five years there are about 365,000 messages and
about 100,000 vectors, under 1 GB with the vector index. Search stays in
milliseconds on a laptop.

## 4. Nightly run

The run starts at the agent's existing sleep time. For each kip with new
messages, using Kip's model unless the nightly-model setting names another:

1. Pick threads whose last message is after their `processed_position`. A failed
   or missed night is caught up by the next run.
2. Write the thread chunks. A short thread becomes one chunk: a header (date,
   kip, organization) and its messages in full. A long thread is split at topic
   changes into full-text pieces of at most about 600 words. Chunks are never
   summaries. A thread that grows later has its chunks rewritten.
3. Propose card changes from the user's own messages, each compared with the
   nearest existing cards: add, update, replace or skip. Every card change
   records its source messages.
4. Write one diary page for each day covered, in the thread's context: a short
   summary and its thread IDs. Pages owing a rebuild are written first.
5. End replaced cards, and re-pick the core cards up to the core card count.
6. Embed the new and changed chunks, cards and diary pages. Rows still waiting
   for an embedding make the night due, so an idle night repairs them; a
   night whose only work is embedding finishes even when the provider fails,
   and the rows wait for the next night.
7. Advance a thread's `processed_position` only after its results are saved.

A thread's chunks, card changes, sources, diary contribution and processed
position are saved in one transaction. Linked threads between kips are ordinary
threads and are processed like any other; progress notes are not conversation
and are left out. Each model call is ordinary work
with an execution permit, one at a time per installation, and never takes the
last free permit while a user turn waits for one.

## 5. Every turn

In order:

1. The stable part: instructions and the core cards. It changes only at night,
   so the provider's prompt cache keeps working.
2. Memory search results. The user's message is embedded and matched against the
   chunks, cards and diary pages the kip may see. The top results by similarity
   are included as whole items with their thread ID and date. There is no
   keyword search and no reranker: the kip judges relevance and reads threads.
3. One line about unprocessed threads: "N threads since last night are not
   searchable yet. If search does not answer, read them with
   `memory_recent_threads`." Kip's line adds that other kips' recent threads are
   available through the same tool.
4. The current thread's history and its thread ID.

Limits are counts, never cut mid-item: 60 core cards, and 10 cards plus 6 thread
chunks from search. Each is a setting. Diary pages are ranked with the thread
chunks and share their count, and are visible where their context's chunks are.
The current thread's chunks are left out: its history is already there. So is a
diary page that covers only the current thread; a page that also covers other
threads stays.

Without the embedding runtime, core cards, the unprocessed-threads line and
reading threads still work, and search reports that it is unavailable.

## 6. Tools

- `memory_search(query, from, to, agent)`: meaning search with an optional date
  range.
- `memory_recent_threads(agent)`: threads not yet processed, each with ID, time
  and first line.
- `memory_read_thread(threadId, fromPosition, toPosition)`: a thread's messages.
- `memory_remember(statement, type, subject, details)`: writes a confirmed card
  now, sourced to the current message.
- `memory_forget(cardId or query)`: deletes matching cards with their sources and
  embeddings. Raw messages stay.

`agent` is accepted only from Kip; without it Kip's tools cover every kip. A
`memory_forget` query deletes at most 20 cards: with more matches it deletes none
and returns the candidates. The tools are offered only while the kip has memory
on. The old tools `memory_save`, `memory_get`,
`memory_correct`, `memory_publish`, `memory_link`, `memory_unlink` and the
`memory_relationship_*` tools are removed. `data_space` is renamed
`data_tables` and `vectors_space` is renamed `vector_collections`; kips keep
creating their own tables and vector collections with them, for example to track
a habit.

## 7. Embedding runtime

- Kipster runs its own pinned build of llama.cpp's `llama-server` with
  EmbeddingGemma 2 (270M text model, 768 dimensions, Q8 GGUF), in embedding
  mode with an 8,192-token context. It never runs in float16.
- The installer downloads the server build for the platform (macOS arm64 and
  x64, Linux x64 and arm64) and the model, and verifies their SHA-256.
- Core supervises the server. Before starting it, Core checks for a Kipster
  server already running on its recorded port and reuses it when it serves the
  expected model. A port held by anything else makes Core pick another free
  port. A crashed server restarts with backoff. Status appears in diagnostics.
- Core never uses or changes a user's own llama.cpp or Ollama.
- Core adds the model's query and document prompt formats from its model card.
- The `embedding-ollama` package and its references leave the repository. An
  existing Ollama install on a user's machine is untouched.
- Every vector row names its `embedding_model`, so a later model change can
  re-embed from text. Changing models is not offered yet.

## 8. Settings

In Core, in the administration catalog and in the `kipster-admin` skill:
memory on or off, sleep time, nightly model (default: Kip's model), core card
count (0-200, default 60), search card count (0-50, default 10) and search chunk
count (0-30, default 6). The nightly model and the counts belong to the
installation. The interface has a Memory view
to read, edit and delete cards.

- The view lists current cards of the installation and every organization,
  each with its organization and sources, and replaced cards on demand. It
  reloads when opened and after its own actions; cards publish no live event.
- An edit changes a current card's type, subject, statement or details and
  marks it confirmed. A replaced card cannot be edited.
- Deleting a card removes it with its sources and embedding. Messages stay, and
  a card it replaced keeps its `valid_to`.
- The owner and Kip, through the administration catalog's `memory` area, have
  the same card actions. The view does not create cards or change `core`.
- Kip's card edits and deletes take an `operationId` like other catalog
  writes: a repeat changes nothing again. Their receipts keep the card ID and a
  digest of the request, never the card's text.

## 9. Not in this version

A reranker, keyword search, per-message embeddings, a separate memory agent,
goal and habit statistics beyond cards and kip-made tables, changing the
embedding model, and image or audio memory.
