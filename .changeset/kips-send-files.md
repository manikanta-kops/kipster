---
"@kipster/core": minor
---

Kips send files of any type: `conversation_publish` and `agents_delegate` take `files`, paths of files to attach, absolute or relative to the kip's working directory. Core stores a copy of each as an agent-owned artifact, typed from its extension, and returns the artifact IDs with the message or delegation. A file that cannot be attached is named with the reason, and nothing is published. The text-only `artifacts_write` and `artifacts_publish` tools are removed.
