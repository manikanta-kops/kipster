# Decision block 11: Kip messaging

Status: agreed direction, 2026-10-16. It supersedes
[decision block 2, section 8](./02-conversations-and-work-lifecycle.md#8-agent-to-agent-work)
and the delegation tools, statuses and continuation described in blocks 3 and 5.
Hidden, paused delegation (`delegate_to_kip`, `check_kip_task`,
`kipster.delegations`, `kipster.delegation_calls` and internal threads) is
replaced; only the protocol keeps its deprecated delegation fields (section 4).

Kips (code: agents) message each other with one tool. Every message opens or
continues a visible _linked thread_ in the recipient's chat, and every answer
comes back into the sender's thread and wakes the sender.

## 1. Rules

1. **One action.** A kip sends a message to another kip with `message_kip`:
   `recipientId`, `text`, and optional `files` paths and `artifactIds`, with the
   same attachment behaviour and limits as the old delegation. The admin kip
   alone also gets an optional `workspaceId`, needed only when the recipient
   works in several workspaces. The recipient gets a turn in a linked thread in
   its own chat. The tool returns at once with the linked thread ID; the
   sender's turn is not paused.
2. **The answer always comes back.** The recipient's final user-visible output
   from that turn (its final messages' text and files) is posted into the
   sender's source thread under the recipient's name. It wakes the sender for a
   new turn, queued behind any running turn in that thread. There is no wake
   flag.
3. **No bouncing.** A turn woken by an answer replies in its own thread to the
   person and never sends anything back on its own; talking back takes a new
   `message_kip` call. A woken kip with nothing to add ends its turn without
   posting a message.
4. **Same thread every time.** There is one linked thread per installation,
   source thread and recipient agent, whatever the topic. Core picks the
   thread; kips never pass a thread ID.
5. **A kip answers whoever started its turn.** A turn started by a kip's message
   answers that kip. A turn started by the person answers the person, even
   inside a linked thread. Turns triggered by an answer or by the person never
   copy anything back.
6. **Who can message whom.** Kips sharing a workspace can message each other.
   The admin kip can message any kip in any workspace, and any kip can message
   the admin kip. Kips in different workspaces go through the admin kip.
7. **Context on demand.** A recipient may `read_thread` the thread a message
   came from, and only that one; the admin kip can read any thread. Thread
   history is not copied into the recipient's turn.
8. **Limits stay.** The existing `execution_permits` columns and defaults apply:
   depth 4 (`delegation_depth_limit`), 32 messages per chain
   (`delegation_root_budget`) and 4 `message_kip` calls per turn
   (`delegation_fanout_limit`). A person's turn begins a new chain at depth 0,
   the recipient of a message runs at depth + 1, and a woken sender stays at
   its own depth. Every kip message and every answer counts toward the 32. Over
   a limit only `message_kip` is refused, with a clear error to the calling
   kip; answers are never refused.

## 2. Mechanics

- Each run records its trigger: `person`, `kip` (started by an incoming kip
  message) or `answer` (woken by an answer). It also records its chain root and
  depth, and the responsible person, whose message started the chain.
- The linked thread lives in the recipient's direct chat with the responsible
  person: in the target workspace for a workspace kip, in the installation chat
  for the admin kip. Linked threads are normal visible threads; there are no
  hidden threads.
- Failure, stop and removal are answers too. Each is posted into the source
  thread and wakes the sender: "<Name> couldn't finish: <reason>",
  "<Name> stopped before answering." and "<Name> was removed before answering."
- Silent end: Core saves no message for an empty final reply. The tool guidance
  tells a woken kip with nothing to add to end with an empty reply.
- Replaying the same attempt and call ID returns the first result and creates
  nothing new.
- Questions and approvals during a kip-started turn show in that linked thread
  and notify the person as usual. Kip messages and answers create no
  notifications.
- `list_kips` and `get_kip`: a workspace kip sees its workspace's kips and the
  admin kip; the admin kip sees every kip with its workspaces.
- Every run input message carries its author, and the turn prompt labels every
  message, for example `You (the person):`, `John (admin kip):` and
  `Planner (kip in Playground):`. A message from a kip says that its answer
  returns automatically.
- The admin kip may use any live workspace's data tables and vector
  collections, and other kips' own ones.
- Real provider runs are not part of automated proof; tests drive the
  deterministic execution fixture on real Core.

## 3. Scenarios

Planner and Researcher are workspace kips; John is the admin kip.

1. **The admin kip asks while you wait.** You ask John for something only
   Planner knows. John messages Planner and his turn ends; your thread shows it
   waiting for Planner. Planner works in a new linked thread in its chat, and
   its answer lands in your thread with John and wakes him to finish your
   request.
2. **You keep talking meanwhile.** You ask Planner to get John's feedback, then
   keep chatting with Planner. John's answer lands in Planner's thread in order,
   queued behind Planner's running turn, and Planner combines everything when
   it wakes.
3. **An FYI, and a question back.** Planner tells John about an approved budget.
   John's answer is a question, which wakes Planner; Planner answers with a new
   `message_kip` call that goes to the same John thread. John's "Got it" wakes
   Planner, who has nothing to add and ends silently.
4. **Kips in one workspace.** Planner asks Researcher. Researcher needs a detail
   that is not in the message, reads Planner's source thread, and answers.
5. **Same thread or a new one.** A later message from the same source thread
   goes to the same linked thread, whatever its topic. A message from a
   different source thread opens a new one.
6. **You step into a kip thread.** While Planner works for John, you write in
   that linked thread. Your message steers the running turn where the provider
   supports it, and the answer still goes to John. A later message from you
   starts a turn that answers you only.
7. **A kip asks you while working for another kip.** Planner needs your approval
   while booking for John. It asks in the linked thread, you get the usual
   notification and answer there, and Planner's final answer goes to John.
8. **Morning brief.** When started by hand for your morning brief, John reads
   the kips' threads first and messages only the kip whose fact is missing,
   then writes the brief once it answers.

## 4. Protocol

Additions only, following [decision block 5, section 5.1.7](./05-kipster-protocol.md).
Core always sends the new fields once kip messaging runs; they are optional in
the schemas so the change stays additive.

- A thread summary (`appThreadSummary`) gains:
  - `startedBy`: the author of the thread's first message, the person or a kip.
  - `linkedFrom: { threadId, chatId, agentId, title }` on a linked thread.
    `agentId` is the sending kip. `title` is the source thread's title: the
    first text part of its first message, cut to 55 characters, or
    `File attachment`.
  - `links: [{ agentId, threadId, chatId, waiting }]` on a source thread, one
    entry per linked kip. `waiting` is true while a message sent from this
    thread to that kip has no answer yet.
- Read-only message parts, never accepted in submissions:
  - `{ kind: 'kip-message', recipientId, threadId, chatId }` on the message the
    sender sent, which also carries the text and file parts it sent.
  - `{ kind: 'kip-answer', agentId, threadId, chatId }` on the answer in the
    source thread, authored by the recipient with its final text and files.
    Failure, stop and removal answers use the same part.
  - The incoming message in a linked thread is an ordinary message authored by
    the sender. Clients recognise it because its `authorId` equals the thread's
    `linkedFrom.agentId`.
- The thread snapshot's `delegations` list and the `delegation-changed` event
  are deprecated, and clients ignore them. Released clients require the list,
  so Core keeps sending it, empty once delegation is gone, until a protocol
  raise under section 5.1.7 removes it.

## 5. Not in this version

Scheduling, unread-dot rules for kip threads, configurable chain limits,
learning lessons from kip exchanges, the iPhone app and direct messages between
kips in different workspaces.
