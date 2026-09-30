# Releasing

Core, the app and each adapter have their own version and their own GitHub
release. Versions stay below 1.0 while Kipster is in beta.

## Branches

| Branch | Purpose |
| --- | --- |
| `next` | Integration branch. Every pull request targets it. |
| `master` | Stable releases. Updated only by merging `next`. |

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

Merge `next` into `master` with a merge commit (not squash). The **Release**
workflow then:

1. Applies the changesets: bumps versions, writes each `CHANGELOG.md` and
   deletes the changeset files, then commits to `master`.
2. Builds and publishes a GitHub release for each package with a new version.
3. Merges `master` back into `next`.

## Release files

| Package | Tag | File |
| --- | --- | --- |
| Core | `core-v<version>` | `kipster-core-<version>.tgz` |
| Adapter | `<adapter>-v<version>` | `kipster-<adapter>-<version>.tgz` |
| App | `ui-v<version>` | `Kipster_<version>_aarch64.dmg` |

## App signing

The app is signed and notarized when these repository secrets exist. Without
them it builds unsigned.

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
