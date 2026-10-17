# Kip messaging

## Sub-features

- A kip messages another kip with `message_kip`; the message opens a visible linked thread in the recipient's chat.
- The answer lands in the sender's thread under the recipient's name and wakes the sender, behind any running turn.
- The sender's thread waits for the answer; a question asked in a linked thread reaches the person there.
- A woken kip with nothing to add ends without a message.

## How to get to it (user point of view)

Write to the admin kip, or to Planner in Factory Garden, with a `__message_kip__ <kip name>: <text>` message. The sent card's Open button leads to the recipient's linked thread; its Sent from link leads back.

## Driving it

| User action                                                                          | Exact command                                  | Observable result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create Planner, then ask the admin kip for something only Planner knows (scenario 1) | `node .kipster/verify/drive.mjs kip-messaging` | The admin kip's thread shows the sent card and Waiting for Planner; Planner's chat gets a thread started by the admin kip; Planner's answer lands under its name and the admin kip replies. Saves s1-sender and s1-recipient. |
| Ask Planner to get the admin kip's feedback and keep chatting (scenario 2)           | `node .kipster/verify/drive.mjs kip-messaging` | The admin kip's answer lands in Planner's thread after your follow-up and wakes Planner, which replies; the answer's turn is queued after your follow-up's. Saves s2-sender and s2-recipient.                                 |
| Answer Planner's question in its thread for the admin kip (scenario 7)               | `node .kipster/verify/drive.mjs kip-messaging` | The question shows in the linked thread with Needs your answer and Planner's sidebar mark; after Send answer, Planner's answer reaches the admin kip, which replies. Saves s7-recipient-question, s7-recipient and s7-sender. |
| Send a `__silent__` message through the admin kip                                    | `node .kipster/verify/drive.mjs kip-messaging` | Planner's answer wakes the admin kip, whose turn completes without a message in Core. Saves silent-sender.                                                                                                                    |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). The command also saves `kip-messaging-details.json` with the thread IDs and whether scenario 2's answer arrived while Planner still worked on your follow-up.

Each run creates a new Planner kip and new threads. `__slow__` turns take eight seconds, so the command runs for about a minute; scenario 2 relies on the driver sending the follow-up within those eight seconds. The fixture cannot steer a running turn or read threads, so scenarios 3 to 6 and 8 are proved only by Core's PostgreSQL tests (`core/tests/kip-messaging.test.mjs`). Real provider runs are not part of this kit.
