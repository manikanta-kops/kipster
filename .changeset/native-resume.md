---
"@kipster/core": minor
"@kipster/codex-cli": minor
"@kipster/claude-cli": minor
---

Continue a kip's work where it paused. When a run continues after an approval, a question or a delegated kip, Core gives the execution `resume`: the provider thread of the previous attempt and a short continuation prompt. The Codex adapter reopens that thread with `thread/resume` and the Claude adapter reopens the session with `--resume`, so the kip keeps its history instead of starting the task over; the continuation tells it that the action it waited on did not run and to run it again once approved. A session that cannot be reopened starts fresh, and a Retry after a failure always does. Claude conversations now keep their transcripts, which are removed when the conversation is permanently deleted. Both adapters advertise `nativeResume`.
