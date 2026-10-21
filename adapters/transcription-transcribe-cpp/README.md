# Local transcribe.cpp transcription

Runs speech recognition locally with `transcribe-cpp` 0.4.0 and Parakeet Ultra
Q8_0. Implements `TranscriptionProvider` from `@kipster/core/transcription`;
Core selects it through `transcription: { module, options }` in `host.json`.
No service account or network request is needed for transcription.

The package includes the runtime's native dependencies, but no model. The
installer downloads [Parakeet Ultra by Moondream](https://huggingface.co/handy-computer/parakeet-ultra-gguf),
a post-trained NVIDIA parakeet-tdt-0.6b-v3 licensed CC-BY-4.0. The pinned Q8_0
file at revision `a1539be1b849ea7463b88343e5277b373d0c4ea9` is 740,363,168 bytes,
SHA-256 `007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59`.

`createTranscriptionProvider(options)` accepts:

- `model`: absolute path to the downloaded GGUF model.
- `modelSha256`: its 64-character hexadecimal SHA-256.
- `ffmpeg`: optional absolute path to an FFmpeg executable. With it the provider
  accepts any `audio/*` or `video/*` file; without it only `audio/wav`.
- `timeoutMs`: optional positive integer up to 600,000; defaults to 120,000 ms,
  including time waiting for another request, reading audio and loading the model.
- `modelSize`: positive integer byte count, required only for an unlisted model
  SHA-256. The pinned Ultra and small 110m Q8_0 model sizes are built in.

One owned Node child process loads the model on the first nonempty transcription
and keeps it for subsequent calls. Requests run one at a time in arrival order.
A crash returns `provider-error`; the next call starts a fresh worker. Abort and
timeout kill the worker before another call runs. `close()` cancels pending calls,
ends the child and releases its memory; a closed provider cannot be reused.

Readiness checks the model's presence, readability and pinned size, and that a
configured FFmpeg is executable, without loading the model or transcribing. SHA-256 is verified once before each child loads the model.
The binding exposes model metadata only after loading, so readiness does not query
it. Readiness alone does not prove native inference works.

Inputs are up to 100 MiB. A 16 kHz mono signed 16-bit PCM `audio/wav` goes
straight to the model, including metadata chunks and empty recordings. Any other
file is decoded by FFmpeg: its first audio stream, local files only, resampled to
16 kHz mono, up to two hours. A file FFmpeg cannot read, or one without audio,
returns `invalid-input`; longer audio returns `output-limit`. Without FFmpeg,
other formats return `invalid-input`. Empty or whitespace output is `no-speech`. Text and failures
carry provider `transcribe-cpp`; Core retains original audio and durable status.

Build and test after `npm ci` at the repository root and building Core:

```sh
npm run build -w core
npm run check -w adapters/transcription-transcribe-cpp
```

Mechanics tests generate WAV bytes and use an injectable internal worker. The
real-model smoke test requires macOS `say` and the
[110m Q8_0 model](https://huggingface.co/handy-computer/parakeet-tdt_ctc-110m-gguf)
at revision `1c3f0d5378fdd358905cc410a93ed9e64f52d170`, 135,373,280 bytes,
SHA-256 `7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296`.
Set `KIPSTER_TRANSCRIPTION_TEST_MODEL` to its absolute path, or place it at
`$XDG_CACHE_HOME/kipster/transcription-models/parakeet-tdt_ctc-110m-Q8_0.gguf`
(default cache root `~/.cache`). The test skips when the model or `say` is absent. A second test transcribes M4A
and MP4 files through FFmpeg from Homebrew, `/usr/bin` or
`KIPSTER_TRANSCRIPTION_TEST_FFMPEG`, and skips without one.
It checks nonempty output and reports cold/warm elapsed time, without asserting
exact words or model quality.
