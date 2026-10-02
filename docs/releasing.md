# Releasing

Core, the app and each adapter have their own version and their own GitHub
release. Versions stay below 1.0 while Kipster is in beta.

## Branches

| Branch | Purpose |
| --- | --- |
| `next` | Default and integration branch. Every pull request targets it. |
| `master` | Stable releases. Updated only by merging `next`. |

Both branches accept changes only through pull requests with passing checks.
Pull requests into `next` are squashed; `next` merges into `master` with a
merge commit. Only the repository owner merges into `master`.

## Changesets

Every pull request that changes a package adds a file to `.changeset/` naming
the packages and the bump:

- `patch` for fixes.
- `minor` for features and breaking changes.

CI rejects a pull request that changes a package without one. Use
`npx changeset --empty` for a change that needs no release. See
[`.changeset/README.md`](../.changeset/README.md).

## Next builds

Run **Release next** from the Actions tab on the `next` branch, or:

```sh
gh workflow run release-next.yml --ref next
gh workflow run release-next.yml --ref next -f packages=core,ui
```

It builds every package with unreleased changesets, or only the named ones, as
`<version>-next.<UTC timestamp>` pre-releases. Nothing is committed.

## Stable releases

1. Run `npm run release:prepare` on a clean checkout. It applies the pending
   changesets on a `release/` branch (versions, `CHANGELOG.md` files, deleted
   changeset files) and opens a release pull request into `next`.
2. Review the versions and changelogs, then merge it.
3. Open a pull request from `next` to `master` and merge it with a merge commit.

The **Release** workflow then builds and publishes a GitHub release for every
package version that has no tag yet. It never pushes to a branch, and published
releases cannot be changed.

## Release files

| Package | Tag | File |
| --- | --- | --- |
| Core | `core-v<version>` | `kipster-core-<version>.tgz` |
| Adapter | `<adapter>-v<version>` | `kipster-<adapter>-<version>.tgz` |
| App | `ui-v<version>` | `Kipster_<version>_aarch64.dmg` |

## App signing

The app is signed and notarized when these secrets exist in the `release`
environment, which only `master` and `next` can use. Without them it builds
unsigned.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | For example `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_PRIVATE_KEY` | Contents of that key's `.p8` file |

## Compatibility

Apps and Core release independently. Protocol changes follow decision record
[5.1.7](initial-implementation-plan/05-kipster-protocol.md): additions only,
and Core serves the previous protocol number for at least one release after
raising it in `core/src/protocol/version.ts`.

Database migrations are shipped when merged into `next` and are immutable; schema fixes add a new numbered migration, and rollback restores a pre-upgrade database backup with its matching Core version.

CI enforces this against the committed `core/protocol-shape.json`; see
[Core](../core/README.md). Regenerate it with `npm run protocol:shape -w core`.
