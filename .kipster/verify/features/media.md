# Files and voice

## Sub-features

- Managed upload/download bytes, attachment captions and previews.
- Locally journaled bytes, drag/drop/paste and attachment recovery.
- Voice recording, preparation status and preserved original when transcription fails.

## How to get to it (user point of view)

In Start a new thread or Reply in this thread, Attach files opens the file picker. Sent file cards offer Download. Record voice note opens recording controls; Stop recording returns to the draft before Send message.

## Driving it

| User action                                       | Exact command                               | Observable result                                                                                                         |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Attach a generated text file and send its caption | `node .kipster/verify/drive.mjs attachment` | The file card appears and scoped artifact content equals the generated original bytes.                                    |
| Record synthetic audio and send the voice note    | `node .kipster/verify/drive.mjs voice`      | The thread shows Transcription unavailable; the fixture receives available original audio with unavailable transcription. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

The driver synthesizes audio instead of requesting a physical microphone and calls no transcription service. This does not prove hardware permissions, actual speech recognition, images/HEIC, PDFs/video, download UI, upload failures, paste/drop or draft recovery. Original file bytes must remain authoritative. Keep generated media and captures under the evidence directory.
