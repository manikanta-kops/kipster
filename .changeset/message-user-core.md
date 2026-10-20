---
"@kipster/core": minor
---

Kips reach the person only with `message_user`: text, a `silent` or `normal` priority, ordered attachments (`{ path }`, `{ artifactId }` or `{ documentId }`) and an optional choice or approval element that waits for the answer. A provider's own text is no longer shown, `post_chat_message`, `ask_user_question` and `request_user_approval` leave the kip's tools, and `create_rich_doc` creates the doc without posting it. A normal message notifies once with a new `message` notification that carries `messageId`; finished turns no longer notify. A kip answers another kip with `message_kip` from the linked thread, which goes back into the sender's thread and wakes it on every call; a turn that ends without answering posts "<Name> finished without a reply.". A kip's message or answer, and a linked thread's instructions, name the sender's `recipientId`. `message_kip` takes `attachments` too. Migration 002 adds `notifications.message_id`.
