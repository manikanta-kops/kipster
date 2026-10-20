# Decision block 12: Messaging the person

Status: agreed direction, 2026-10-20. It replaces the publication rules of
[decision block 3, section 4](./03-execution-adapters-and-agent-capabilities.md#4-part-three--agent-capabilities-and-publication)
and refines rules 2, 3 and 5 of [decision block 11](./11-kip-messaging.md).

A kip reaches the person with one tool, `message_user`, and another kip with
`message_kip`. Nothing else a kip writes is shown.

## 1. Rules

1. **One way to the person.** `message_user` posts a message in the run's
   thread. A provider's own text, final or not, is never shown or stored as a
   message.
2. **The kip chooses the notification.** `priority` is `silent` or `normal`;
   Core uses `normal` when it is missing. A normal message notifies the person
   once. A finished turn notifies nobody; a failed or interrupted turn still
   notifies.
3. **Attachments in order.** `attachments` is an ordered list of objects, each
   naming one source: `{ path }` for a file the kip made or downloaded,
   `{ artifactId }` for a file already in Kipster, `{ documentId }` for a rich
   doc. At most 10, with the file size limits of decision block 3. New sources
   or fields can be added later.
4. **Elements wait for the person.** `element` adds one card that waits for an
   answer: `{ type: 'choice', prompt, options, freeText }` or
   `{ type: 'approval', prompt, proposalId, proposal }`. The kip ends its turn;
   the answer comes back in its next turn as the saved interaction, as before.
   New element types define only their answer. Several questions at once belong
   in a rich doc.
5. **Text is optional.** A message needs text, an attachment or an element.
   Text is Markdown of at most 512 KiB, as a rich doc's.
6. **Rich docs are shown, not posted.** `create_rich_doc` only creates the doc.
   The kip shows it by attaching its `documentId` to a message.
7. **Kips answer kips with `message_kip`.** In a linked thread, a message to
   the kip whose messages the thread holds is an answer: it goes back into that
   kip's thread with a `kip-answer` part and wakes it. Every call is delivered
   at once. Messaging any other kip follows decision block 11.
8. **The asking kip is never stranded.** A turn a kip's message started that
   ends without answering posts "<Name> finished without a reply."; a failed,
   stopped or removed turn posts its note even after an answer.

## 2. Mechanics

- `message_user` returns `{ status: 'sent', messageId, files? }`, or
  `{ status: 'pending', interactionId, messageId?, files? }` with an element.
  The call ID identifies the message and the element; a repeat returns the
  first result.
- The element is an interaction; a silent element notifies nobody. A message
  with an element notifies of the element only.
- A `pending` result with an `interactionId` leaves the run waiting once the
  provider turn ends, whichever tool returned it.
- `ask_user_question` and `request_user_approval` remain only for adapters
  translating a provider's own question or approval (call IDs starting
  `native:`).
- A kip's answer posts two messages: its copy in the linked thread with a
  `kip-message` part pointing at the source thread, and the answer in the
  source thread. The first answer marks the run answered for the thread
  summary's `waiting`.
- Answers count toward the 4 messages per turn, not toward the depth limit. A
  chain's budget of 32 counts the runs its kip messages and answers start.
- Migration 002 adds `notifications.message_id` and the `message` kind.

## 3. Protocol

Additions, following [decision block 5, section 5.1.7](./05-kipster-protocol.md):

- A notification may have `kind: 'message'` with `messageId`. Its `preview` is
  the message's text. Core no longer sends `completed`.
- Clients that do not know `message` show their neutral fallback.
