# Changesets

Every pull request that changes a package adds one file here describing the
release. Create it with `npx changeset`, or write it by hand:

```md
---
"@kipster/core": minor
"@kipster/codex-cli": patch
---

Add scheduled runs.
```

Until 1.0: `patch` for fixes, `minor` for features and breaking changes. A
change that needs no release, such as tests only, uses `npx changeset --empty`.

The stable release on `master` turns these files into version bumps and
changelog entries, then deletes them.
