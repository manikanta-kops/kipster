---
"@kipster/core": minor
"@kipster/installer": minor
"@kipster/embedding-llama-cpp": minor
---

Memory search runs on Kipster's own llama.cpp `llama-server` with EmbeddingGemma 2. The installer downloads the pinned server build for the platform and the Q8 model into the Kipster home, verifies their SHA-256 and adds the `embedding.server` entry to host.json once `@kipster/embedding-llama-cpp` is released on the channel. Core verifies and supervises the server: it reuses a Kipster server already running on the recorded port, picks another port when something else holds it, restarts a crashed server with backoff and shows its status in `doctor`. The new `@kipster/embedding-llama-cpp` package replaces the previous embedding package, and `embeddingQuery` and `embeddingDocument` in `@kipster/core/embedding` format text as the model card asks.
