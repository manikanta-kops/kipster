# Decision block 14: Memories and lessons

Status: agreed direction, 2026-10-21. It refines
[decision block 10](./10-kip-memory.md): cards are renamed memories, and each
kip also learns lessons about its own work.

Memory holds three kinds of knowledge, sorted by what it is about:

```text
About the person      memories        shared by every kip      (cards before)
What happened         chunks, diary   private to each kip      unchanged
How this kip works    lessons         private to each kip      new
```

A memory is true for every kip ("Vegetarian since October 2026"). A lesson is
about one kip's job ("For expense reports, use the 2026 template in the shared
Finance folder").

## 1. Rules

1. **Memories replace cards.** The table, protocol, tools and interface say
   memory; nothing keeps the old names. Their visibility rules stay those of
   decision block 10, section 2.
2. **Lessons belong to one kip, everywhere.** A kip keeps its lessons in every
   workspace, as a person keeps what they learned in one team when working in
   another. Each lesson names the workspace it was learned in, so the kip knows
   where it came from.
3. **Lessons come from messages.** A lesson cites the person's messages or
   another kip's messages in the kip's threads; the kip's own messages and tool
   output are context only. Tool calls are not read.
4. **Never learn what Core knows live.** Tools, permissions, plugins, settings
   and what any kip can or cannot do are never lessons or memories: Core states
   them on every turn, and they change.
5. **The conversation wins.** When a lesson or memory conflicts with the
   current conversation, the conversation is right.
6. **Keep every item valuable and current.** The nightly run does not only add.
   For each new item it compares the nearest existing ones and answers one of
   five actions, for memories and lessons alike:

   | Action | Meaning |
   |---|---|
   | add | something new |
   | update | an existing item came up again; it may be reworded to stay current |
   | merge | one new item takes the place of one or more existing ones, combined or changed |
   | retire | an existing item is no longer true; it ends without a replacement |
   | skip | nothing worth keeping |

   An ended item keeps its row with `valid_to`, and `replaced_by` when merged.
7. **Few lessons always, a few more by search.** The kip's top 10 lessons are
   always loaded, through the Learned section of its `identity.md`. Each turn
   adds the 3 lessons nearest to the person's message.

## 2. Storage

Migration 004 renames and adds:

```text
memories          (was cards)         type, subject, statement, details, confirmed,
                                      core, organization_id, valid_from, valid_to,
                                      replaced_by, embedding
memory_sources    (was card_sources)  memory_id, thread_id, message_id
lessons           new                 agent_id, organization_id, statement,
                                      confirmations, last_confirmed_night,
                                      valid_from, valid_to, replaced_by, embedding
lesson_sources    new                 lesson_id, thread_id, message_id
```

- `installations.core_card_count` and `search_card_count` become
  `core_memory_count` and `search_memory_count`.
- `lessons.organization_id` is the workspace a lesson was learned in, or null.
- `confirmations` counts the nights a lesson came up: add sets 1, update and
  merge add at most 1 per night. A merge starts from the sum of the lessons it
  combines.
- A kip keeps at most 400 current lessons (a code constant). Past that, the
  nightly run retires the ones with the fewest confirmations, oldest first.
- Deleting a thread removes its lesson sources and every lesson left with
  none, as for memories. Deleting a kip removes its lessons; deleting a
  workspace removes the lessons learned in it.

## 3. Nightly run

Decision block 10, section 4 gains a lessons step and changes the memories
step:

1. Chunks, as before.
2. **Memories**: from the person's own messages, compared with the nearest
   memories, with the five actions. The step also sees the data tables the kip
   and the thread's workspace keep (name and description), so a goal or
   routine tracked in one names its table in `details.table`.
3. **Lessons**: from the person's and other kips' messages, compared with the
   10 nearest lessons of the kip and its current top 10, with the five
   actions. The top 10 are rechecked every night the kip has new messages, so
   a stale top lesson can be updated or retired.
4. Diary, as before.
5. Core memories are re-picked, as before. New and changed memories and
   lessons are embedded right after their thread is saved, so later threads
   of the same night find them.
6. **Learned section**: Core sorts the kip's current lessons by confirmations,
   then by the night last confirmed, and writes the top 10 into the Learned
   section of `identity.md`, one line each with its workspace. The file is
   written only when those lines change, and also right after a lesson is
   edited or deleted. The rest of `identity.md` is the person's and is never
   changed.

Messages in the nightly prompts name their author as `Name (person)`,
`Name (admin kip)` or `Name (kip)`, and each prompt names the kip whose memory
it builds. The diary describes the kip's day in its own conversations, with
the person or with other kips.

## 4. Every turn and tools

- Stable instructions: the core memories, and `identity.md` with its Learned
  section.
- Before the history: memory search returns memories, the kip's 3 nearest
  lessons, and chunks or diary pages.
- `search_memory` returns lessons too: the kip's own, or for the admin kip
  every kip's, or one kip's with `agent`.
- `forget_memory` deletes memories or the kip's own lessons, by `memoryId`,
  `lessonId` or query.
- `save_memory` keeps saving one confirmed memory.

## 5. Data tables

`manage_data_tables` `create_table` requires a `description` of at most 500
characters, such as "Body weight, logged daily; goal 75 kg by December". A
new `set_description` operation changes it. `discover` lists each table with
its description. Rows are never read at night; a kip queries the table when
the conversation needs it.

Scenario: the person says "Track my weight every day, goal 75 kg by
December." The kip creates `weight_log` with that description. That night the
memories step makes the core memory `goal | user | Reach 75 kg by December
2026 | {"table":"weight_log"}`. A week later the person asks "Am I on
track?"; the kip sees the goal and its table and queries it.

## 6. Protocol and administration

A clean break, before the first beta, that raises the protocol to 4. Clients
of protocols 1 to 3 no longer see the `memoryCards` capability, so they hide
their Memory view.


- `/v1/memory/cards` becomes `/v1/memory/memories`; `/v1/memory/lessons` lists
  lessons (optionally of one kip) and `/v1/memory/lessons/{id}` reads, edits
  (statement only) and deletes one.
- The bootstrap capability `memoryCards` becomes `memories`.
- Learning settings `coreCardCount` and `searchCardCount` become
  `coreMemoryCount` and `searchMemoryCount`.
- The administration catalog's `memory` area has the same memory and lesson
  actions as the Memory view, which lists memories and each kip's lessons.
- The nightly step names sent to adapters are `chunks`, `memories`,
  `lessons`, `diary` and `core`.

## 7. Not in this version

Proposing lessons for `soul.md`, lessons from tool calls, showing each kip's
capabilities in `list_kips`, and saving a lesson live during a turn.
