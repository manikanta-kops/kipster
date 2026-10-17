---
"@kipster/core": minor
"@kipster/ui": minor
---

Kip messaging contract (decision record 11): thread summaries may carry `startedBy`, `linkedFrom` and `links`, and messages may carry read-only `kip-message` and `kip-answer` parts. Protocol 3: the thread snapshot's deprecated `delegations` list is optional; Core still sends it and keeps serving protocols 1 and 2. The app no longer shows delegations; it ignores Core's deprecated delegation list and events, and shows the text and files of kip messages and answers.
