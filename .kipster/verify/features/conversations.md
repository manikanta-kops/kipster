# Conversations

## Sub-features

- Independent root threads and replies inside the selected thread.
- Saved messages, streaming/SSE projections, draft/outbox recovery and reload.
- Uncertain acceptance with stable submission identity.

## How to get to it (user point of view)

Select Kip in the sidebar, type in Start a new thread, press Send message and open the root via Open thread. Reply in this thread adds a follow-up. Close thread returns to the feed.

## Driving it

| User action                                              | Exact command                                        | Observable result                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Send a root and follow-up, then reload                   | `node .kipster/verify/drive.mjs conversations`       | Exactly one follow-up is stored and its Fixture reply remains visible after reload.          |
| Send while the HTTP acknowledgement is lost, then reload | `node .kipster/verify/drive.mjs submission-recovery` | One feed root remains; the driver intercepts exactly one submission, with no duplicate send. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

Drafts/outbox are IndexedDB journals; durable conversation state is in Core. Use new text/IDs for an intentional second send. Reload is not a Core restart. Attachment drafts, simultaneous tabs, large streaming frames, hydration retries and unavailable IndexedDB need additional focused tests; existing durable-text.spec.ts covers related cases.
