---
"@kipster/core": minor
"@kipster/codex-cli": minor
---

Core now renders each turn's user input as `context.prompt` and supplies the JSON Schema of every maintenance result as `outputSchema`, so execution adapters no longer rebuild either. Extraction accepts a null `importance` as the default. The Codex adapter uses both and requires a Core that provides them.
