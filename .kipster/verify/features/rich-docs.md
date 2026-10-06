# Rich docs

## Sub-features

- Agent-created block documents, questions/scales/checklists and user draft autosave.
- User submission, responsible-kip revision and revision history.
- Inline edits/comments, resolved comments, Take back and unknown-block fallback.

## How to get to it (user point of view)

Ask Kip to write a rich doc in a new thread. Open rich doc: Trip plan opens its pane. Answer questions, edit/check items, add a note and Submit; the resulting revision returns the turn to the user.

## Driving it

| User action                                                   | Exact command                             | Observable result                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Answer Oslo and the date scale, check Book flights and submit | `node .kipster/verify/drive.mjs rich-doc` | Draft saved and 2 of 2 answered appear; the fixture publishes Trip plan, revised at revision 3 and retains the checked item. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

Only kips create documents. Draft version and base revision govern conflicts; user submission creates revision 2 and fixture editing creates revision 3. The fixture revises immediately, so transient locked state is not asserted. Comments, inline editing, Take back, conflicts, other block types and revision browsing need independent additional proof; real-documents.spec.ts records the existing selectors and richer flow.
