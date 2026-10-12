---
"@kipster/core": minor
---

Replace the first memory engine with the Kip memory schema. Its records, extraction, sleep, relationships, promotion and the 11 old `memory_*` tools are removed, along with the `@kipster/core/maintenance` entry. Migration 024 drops their tables and adds `memory_thread_state`, `thread_chunks`, `cards`, `card_sources` and `diary`. Deleting a thread, kip or workspace removes the memory derived from it. The `data_space` and `vectors_space` tools are renamed `data_tables` and `vector_collections`. Memory can be switched on without an embedding provider; `available` now reports whether one is configured.
