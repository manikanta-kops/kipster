---
"@kipster/core": minor
---

Kips message each other with `message_kip` instead of delegating. A message opens or continues a visible linked thread in the recipient's chat, the sender's turn goes on, and the recipient's final reply (or its failure, stop or removal) comes back into the sender's thread and wakes the sender. Turns started by a person or by an answer send nothing back, and an empty final reply saves no message. Thread summaries carry `startedBy`, `linkedFrom` and `links` with `waiting`; thread snapshots send an empty `delegations` list. Migration 033 drops delegations and hidden threads and records each run's trigger, chain and responsible person. `delegate_to_kip`, `check_kip_task` and `delegationResults` are gone.
