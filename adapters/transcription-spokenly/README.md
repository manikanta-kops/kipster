# Spokenly transcription adapter

Implements the Core transcription contract using the installed Spokenly CLI. It exports `createTranscriptionProvider(options)` and declares `audio/*` and `video/*` input types. Configure `executable` and optional `ffmpegExecutable` as absolute paths; `timeoutMs` defaults to 60000 and `maxOutputBytes` to 1048576. Given limits must be positive integers. Spokenly selects its recognition model and processing route from its own configuration; the CLI exposes no model option. This adapter does not request a model download or choose a fallback provider. Core remains responsible for verified managed input, authorization, durable results, and run scheduling.

## Development

The package resolves `@kipster/core` from the repository's npm workspace. Install from the repository root and build Core first:

```sh
npm ci --prefix ../..
npm --prefix ../../core run build
npm run check
```

`npm pack` runs the prepack build, so the tarball includes its exported JavaScript
and declarations even when `dist/` is absent. Install development dependencies
and build the linked Core package as above before packing from this checkout.

## Audio preparation

The adapter copies compatible inputs into a private temporary directory with the
correct extension, including originals stored under extensionless artifact IDs.
For other formats such as WebM, configure `ffmpegExecutable` with an absolute
path to an installed FFmpeg binary. The adapter converts the first audio stream
to mono 48 kHz PCM WAV before invoking Spokenly. It does not install FFmpeg.

Conversion and transcription share `timeoutMs`. Converted output is limited to
100 MiB; reaching the limit fails instead of transcribing truncated audio.
Cancellation terminates the owned process, and temporary files are removed after
success or failure. Original artifacts remain unchanged. Missing conversion
support reports unavailable. Readiness checks CLI availability, not successful
recognition by the model selected in Spokenly's Transcribe File settings.
