---
'@kipster/transcription-transcribe-cpp': minor
'@kipster/core': patch
---

Add local transcribe.cpp transcription with a persistent child-process model,
cancellation and timeout recovery. 16 kHz mono PCM WAV goes straight to the
model; any other audio or video file is decoded by a configured FFmpeg. Document
local Parakeet Ultra transcription and the Core provider configuration.
