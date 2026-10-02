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

Every new release also includes `release.json` (schema version 1). It records
`package`, `version` and `files` with each file's `name`, byte `size` and hex
`sha256`. Core includes `protocolRange: { current, oldest }`; the app includes
the build-time `protocolRange.current` as `protocol`. Signed app releases also
include `Kipster.app.tar.gz`, `Kipster.app.tar.gz.sig` and
`updater: { platform: "darwin-aarch64", file, signature }`, where `signature` is
the content of the `.sig` file. Metadata hashes the final published bytes,
including the stapled DMG, and does not include itself in `files`.

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

### Updater signing

Updater signing is independent of Apple signing. Set these two secrets in the
`release` environment to publish signed Apple Silicon updater bundles:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the Tauri updater private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password of that key |

The owner generates the production key in their own terminal, after `npm ci`:

```sh
bash scripts/setup-updater-key.sh "$HOME/.config/kipster/updater.key"
```

The script prompts for a password, creates the key outside the repository,
uploads both secrets with `gh secret set --env release`, and writes the public
key to `plugins.updater.pubkey` in
[`tauri.conf.json`](../interface/kipster-ui/src-tauri/tauri.conf.json). Only the
public key is printed to stdout. Back up the private key file and password in
1Password, and commit the public configuration through a pull request into
`next` before publishing a signed app. The public key starts empty; a signed
release build refuses to proceed until it is configured. Keep this key for all
future releases: installed apps trust it.

`bundle.createUpdaterArtifacts` is enabled in the app configuration. The release
script disables it when the private key is absent, producing an unsigned DMG
and metadata without an updater. `npm run app` also disables updater artifacts
for development builds. Direct unsigned Tauri builds can use
`--config '{"bundle":{"createUpdaterArtifacts":false}}'`. The future updater
plugin will read `plugins.updater.pubkey`; its initial endpoint is
`https://updates.kipster.app/v1/app/stable.json`. Installing and using that plugin
is a separate change. See the [Tauri updater format](https://v2.tauri.app/plugin/updater/#static-json-file).

## Channel files

GitHub Releases is the source of truth. **Publish update channels** rebuilds and
deploys the site after the stable or next release workflow finishes publishing,
including any packages published by a partially failed matrix. It also supports
manual runs. Merging into `next` does not publish or update these files. Releases
without `release.json` are logged and skipped; invalid metadata or failed GitHub
requests fail generation and leave the deployed site intact.

All URLs are under `https://updates.kipster.app/v1/`:

| Path | Contents |
| --- | --- |
| `stable.json` | Latest stable release for each package |
| `next.json` | Highest semver for each package, stable or prerelease |
| `releases.json` | All eligible versions per package, in descending semver order |
| `app/stable.json` | Latest signed stable app in Tauri v2 static updater format |
| `app/next.json` | Highest signed app semver, stable or prerelease |
| `app/<version>.json` | One signed app version in that same format |

The three package catalogs have `{ "schemaVersion": 1, "packages": { ... } }`.
Keys are full package names, such as `@kipster/core` and `@kipster/ui`. A channel
maps each key to an entry; `releases.json` maps it to an array of entries.
Packages with no eligible release on a channel are omitted. With only legacy
releases, all three catalogs have an empty `packages` object.

Each entry has this shape (protocol fields apply to Core or the app only):

```json
{
  "package": "@kipster/core",
  "version": "0.2.0",
  "prerelease": false,
  "notes": "Release notes from GitHub.",
  "publishedAt": "2026-10-02T09:00:00Z",
  "files": [
    {
      "name": "kipster-core-0.2.0.tgz",
      "url": "https://github.com/manikanta-kops/kipster/releases/download/core-v0.2.0/kipster-core-0.2.0.tgz",
      "size": 12345,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "protocolRange": { "current": 2, "oldest": 1 }
}
```

An app entry has `protocol` instead of `protocolRange`, plus
`updater: { platform, url, signature }` or `updater: null` for an unsigned DMG.
The generator checks tag/package/version consistency, asset sizes, SHA-256
digests when supplied by GitHub, protocol values and complete updater pairs.
Consumers must tolerate additive fields. Incompatible schema changes need a
new URL namespace; released clients retain their `/v1/` URLs.

Tauri files contain exactly `version`, `notes`, `pub_date` and
`platforms: { "darwin-aarch64": { url, signature } }`; the URL points to the
`.app.tar.gz`, and the signature is the `.sig` contents, never its URL.
Unsigned app versions remain in the package catalogs but have no per-version
Tauri file. Tauri channel files are absent (404) until a signed release exists
on that channel; they then choose the latest signed version. This can differ
from the package channel's newest unsigned DMG.

Regenerate locally into an empty directory with an authenticated GitHub CLI:

```sh
node scripts/channels.mjs /tmp/kipster-update-site
```

The command uses `gh api --paginate` for the release list and the authenticated
asset API for metadata. `GITHUB_REPOSITORY` or `GH_REPO` can override the default
`manikanta-kops/kipster`. CI supplies `GH_TOKEN`. The output includes a `CNAME`
for `updates.kipster.app`. Pages deployments share one concurrency group.

### Pages setup (owner)

1. In repository **Settings → Pages**, choose **GitHub Actions** as the build
   source.
2. At the DNS provider, add CNAME `updates` → `manikanta-kops.github.io`.
3. In **Settings → Pages**, set the custom domain to `updates.kipster.app`.
   Once DNS and the certificate are ready, enable **Enforce HTTPS**.
4. In **Settings → Environments → github-pages**, select **Selected branches
   and tags** under deployment branches, and add branch rules for both `master`
   and `next`. Check any required reviewer rules allow release deployments.
5. After merging the workflow and setting up signing, run
   `gh workflow run pages.yml --ref next`, then check
   `https://updates.kipster.app/v1/next.json` loads. Existing releases without
   metadata remain excluded until new releases are published.

No repository settings or DNS are changed by the generator. To redeploy later,
run **Publish update channels** on `next` or `master` from the Actions tab, or
use the same CLI command above.

## Compatibility

Apps and Core release independently. Protocol changes follow decision record
[5.1.7](initial-implementation-plan/05-kipster-protocol.md): additions only,
and Core serves the previous protocol number for at least one release after
raising it in `core/src/protocol/version.ts`.

Database migrations are shipped when merged into `next` and are immutable; schema fixes add a new numbered migration, and rollback restores a pre-upgrade database backup with its matching Core version.

CI enforces this against the committed `core/protocol-shape.json`; see
[Core](../core/README.md). Regenerate it with `npm run protocol:shape -w core`.
