---
"@kipster/core": minor
"@kipster/claude-cli": minor
"@kipster/codex-cli": minor
---

Memories and lessons (decision record 14). Protocol 4: cards are renamed memories everywhere: tables, protocol routes (`/v1/memory/memories`), the `memories` capability, the `coreMemoryCount` and `searchMemoryCount` settings, tools and the administration catalog. Each kip now learns lessons about its own work from the person's and other kips' messages: a new `lessons` table, a nightly `lessons` step, `/v1/memory/lessons` routes and `memory.lesson*` admin operations. The nightly run keeps memories and lessons current with add, update, merge, retire and skip; a lesson gains at most one confirmation per night, a kip keeps at most 400, and its 10 most confirmed are written into the Learned section of its identity.md. Each turn adds the 3 nearest lessons to memory search. Nightly prompts name authors as person, admin kip or kip, and name the kip whose memory they build. Data tables require a description, changed with `set_description` and listed by `discover`, and the memories step sees them so a goal can name its table. The CLI adapters run the `memories` and `lessons` steps.
