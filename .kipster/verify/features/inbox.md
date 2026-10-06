# Inbox and attention

## Sub-features

- Durable unread/completed/failed/interaction notices with original context.
- Mark all read, Clear and Clear all; sidebar attention marks and pending interaction counts.
- Reading a notice is separate from answering its interaction.

## How to get to it (user point of view)

Click the sidebar Notifications button. Needs you lists pending requests; Updates lists other notices. Opening a notice returns to its thread. Notification delivery choices are in Settings.

## Driving it

| User action                                                           | Exact command                          | Observable result                                                                        |
| --------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Open Notifications, mark the question read, then answer in its thread | `node .kipster/verify/drive.mjs inbox` | Its saved notice is read while the interaction stays pending; sending Blue resumes work. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

The driver generates its own question and settles it at the end. Read state is shared through Core, not a browser-only preference. Clear actions, routed delegation notices, cross-device delivery, OS alerts/badges and background attention require separate proof. Fully closed-app notification delivery is not implemented.
