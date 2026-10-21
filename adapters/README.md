# Execution adapters

Adapters connect Kipster Core to AI providers. Each adapter is an independently
installable package with its own dependencies and lockfile.

Use `@kipster/core/adapter` for the public contract and receive Core host services
through a factory. Keep provider-specific code inside the adapter. Core passes each
execution adapter a private `host.dataDirectory` (`<Kipster home>/providers/<adapter id>`)
for its own state.

The Codex CLI and Claude CLI packages implement text execution and memory maintenance with durable recovery. Core renders each turn's user input as `context.prompt` and supplies each maintenance task's result schema as `outputSchema`; adapters send them as they are. The separate [transcribe.cpp package](./transcription-transcribe-cpp/README.md) implements Core's transcription contract locally with the Parakeet Ultra model downloaded by the installer and is selected explicitly during runtime assembly.

A transcription package exports `createTranscriptionProvider(options)` and declares its accepted MIME types in `inputTypes`. It receives `options` from `host.json`. The local transcribe.cpp provider sends 16 kHz mono 16-bit PCM WAV straight to the model and decodes any other audio or video file with the FFmpeg the installer downloads.

Text events contain full accumulated text under a stable `messageId`. Emit drafts
as they arrive; Core may merge them, keeping only the latest pending draft. Final
content replaces the draft. After `final: true`, emit nothing more for that ID.
Separate provider messages must use separate IDs.

Embedding packages export `createEmbeddingProvider(options)` returning the `EmbeddingProvider` contract from `@kipster/core/embedding`. Configure one package with `embedding: { module, options }` in host.json; see [embedding-llama-cpp](./embedding-llama-cpp/README.md), the client of the llama.cpp server Core runs.
