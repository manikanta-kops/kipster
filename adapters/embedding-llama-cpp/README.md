# llama.cpp embeddings

An HTTP client of a local llama.cpp `llama-server` that runs EmbeddingGemma 2 in
embedding mode. It implements the `EmbeddingProvider` contract from
`@kipster/core/embedding` and returns 768-dimensional vectors.

Core starts and supervises the server; see the `embedding.server` entry in the
[host guide](../../core/docs/host-macos.md). The Kipster installer downloads the
pinned server build and model into the Kipster home and writes that entry. Core
passes this package the server's actual address, so `embedding.options` in
host.json may stay empty.

`createEmbeddingProvider(options)` accepts:

- `endpoint`: the server's loopback `http://` address.
- `model`: the model name the server serves; it is also the stored `embedding_model`.
- `apiKey`: optional bearer key the server requires.
- `timeoutMs`: optional request timeout, 60,000 ms by default.

Requests honour the caller's abort signal. Wrong dimensions, HTTP errors, a
rejected key and an unreachable server fail with a clear message. Format text
with Core's `embeddingQuery` and `embeddingDocument` before embedding it.

Build with `npm run build` after `npm ci` at the repository root.
