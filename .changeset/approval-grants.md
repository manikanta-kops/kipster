---
"@kipster/core": minor
"@kipster/codex-cli": minor
"@kipster/claude-cli": minor
"@kipster/ui": minor
---

Approve a kip's action for the conversation or always. Provider approval cards now read as one plain question with detail, keep the exact request under Details, and offer "Allow in this conversation" and "Always allow" next to Decline. Core keeps the grants, lists always-allowed actions in permission settings where the person or Kip can remove them, and gives each execution the grants that apply as `approvalGrants`; the Codex and Claude adapters answer matching requests without a card. Computer Use approvals no longer repeat forever: they match across attempts and are granted per app. Full access allows Computer Use instead of Codex declining it.
