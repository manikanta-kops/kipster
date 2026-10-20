# Files and voice

## Sub-features

- Managed upload/download bytes, attachment captions and previews.
- Files a kip sends by path: inline image, audio, video, PDF and text previews, the generic file card and Download.
- Locally journaled bytes, drag/drop/paste and attachment recovery.
- Voice recording, preparation status and preserved original when transcription fails.

## How to get to it (user point of view)

In Start a new thread or Reply in this thread, Attach files opens the file picker. Sent file cards offer Download. Files a kip sends appear in the thread pane, each with a preview or the generic card. Record voice note opens recording controls; Stop recording returns to the draft before Send message.

## Driving it

| User action                                       | Exact command                               | Observable result                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Attach a generated text file and send its caption | `node .kipster/verify/drive.mjs attachment` | The file card appears and scoped artifact content equals the generated original bytes.                                                  |
| Send `__files__` in a new thread and in a reply   | `node .kipster/verify/drive.mjs kip-files`  | Each kip file previews (or shows the generic card), Download returns the original bytes, and Core reports its name, MIME type and size. |
| Record synthetic audio and send the voice note    | `node .kipster/verify/drive.mjs voice`      | The thread shows Transcription unavailable; the fixture receives available original audio with unavailable transcription.               |

| Record speech or silence through the real local model | `node .kipster/verify/drive.mjs voice-real` | With VOICE_WAV and the staged model, the thread and fixture reply show nonempty transcript text, or no-speech when VOICE_EXPECT=no-speech. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

The default voice scenario synthesizes audio and uses fixture transcription (it skips on a real-model instance). The voice-real scenario uses VOICE_WAV through Chromium fake audio capture and the real local model; see the verification guide. This does not prove hardware permissions, actual speech recognition, HEIC, upload failures, paste/drop or draft recovery. Original file bytes must remain authoritative. Keep generated media and captures under the evidence directory.

`kip-files` uses the fixture kip, not a real provider, and the committed files in `.kipster/verify/fixtures`. It proves previews in headless Chrome only; PDF painting in WebKit or the packaged macOS app is unproven. When Chrome reports no PDF viewer, the PDF must show the generic card instead, recorded as `pdfViewerEnabled` in `kip-files-details.json` with each file's preview, artifact ID, MIME type and size. It also saves `kip-files-main-chat.png`, `kip-files-thread-pane.png` and `kip-files-thread-pane-files.png`. Light and dark screenshots are taken only while Appearance is System. Kip files appear in the thread pane; the main chat shows the thread's root and reply count.
