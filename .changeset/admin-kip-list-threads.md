---
'@kipster/core': minor
---

The admin kip sees what every kip is doing. `list_recent_threads` becomes `list_threads`, with `agentId`, `from`, `to` and `notSearchable`, and each thread's work: running, queued, waiting for the person, or idle. The admin kip keeps `list_threads` and `read_thread` with memory off, and the admin skill tells it how to report on other kips. New installations start with memory on.
