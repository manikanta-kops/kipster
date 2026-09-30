# Ollama embeddings

Build with `npm run build` after `npm ci` at the repository root. Configure host.json with an absolute
`embedding.module` pointing to `dist/index.js` and `embedding.options` containing
`endpoint` (HTTP(S), with an optional proxy path), `model` (an installed model),
and optional `apiKeyEnv` (the name of a bearer-token environment variable).

Exports `createEmbeddingProvider(options)` using `@kipster/core/embedding`.
Changing provider ID or model re-embeds retained text on the next host start.
