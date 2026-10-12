---
'@kipster/core': minor
---

Kip memory diary pages belong to one context: migration 026 keys a page by kip, day and organization, and a turn or a kip's `memory_search` shows only pages of contexts it may see. A deleted thread leaves nothing in the diary: its pages lose their summary and embedding and the next nightly run rebuilds them from the remaining threads. Rows waiting for an embedding make a night due, so an idle night embeds them once the provider answers.
