# Kipster developer additions

Keep Core, interfaces and adapters independent. Every changed package needs a changeset; shipped next migrations are immutable and new numbers exceed the base maximum with runtime list updates. Keep protocol responses additive and settings/actions in Core with admin-tools, kipster-admin skill and parity checks. Format touched files explicitly, including hidden kit files, and run the declared gate before committing.

Read context/index.md and its factory-verification guide. Never touch a provider account or Codex/Claude home. Only factory system actions push, manage PRs or merge; kit changes always go to human approval.

This machine may run the owner's production Kipster. Never touch it unless the owner's ticket explicitly asks: don't run `npm run backend`, `npm run app`, `scripts/local*`, the installer or `launchctl`; don't use `~/.kipster`, `~/Applications/Kipster.app` or port 43120; don't kill processes by name, only ones you started. To see your change running, use `node .kipster/check.mjs` and the factory's test instance.
