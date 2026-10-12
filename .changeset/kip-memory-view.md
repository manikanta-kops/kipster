---
'@kipster/core': minor
'@kipster/ui': minor
---

Read, correct and delete memory cards. Core adds `GET /v1/memory/cards` (paged, replaced cards with `ended=true`), `GET`, `PUT` and `DELETE /v1/memory/cards/{id}` for the owner, and the matching `memory` operations in the administration catalog for Kip. An edit confirms the card; deleting removes the card with its sources and embedding while messages stay. Card list paging no longer skips cards saved in the same transaction. Settings → Memory (formerly Learning) adds the nightly model, the counts of core cards, cards and conversation pieces each turn gets, and a Cards view to read, edit and delete cards.
