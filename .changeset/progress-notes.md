---
"@kipster/core": minor
"@kipster/ui": minor
"@kipster/codex-cli": minor
"@kipster/claude-cli": minor
---

Show a kip's progress notes in its work instead of the conversation. Text events can carry a `phase`: `progress` for notes written while working, `answer` for the reply. The Codex adapter maps Codex's `commentary` and `final_answer` message phases. The Claude adapter marks text that comes right before a tool call as progress and the text that ends the turn as the answer. Core stores the mark (migration 023) and sends `progress: true` on those thread messages. The thread lists them as steps in the run's work block and leaves them out of reply counts.
