# Contributing

Thanks for helping improve Kipster.

## Before you start

For anything larger than a small fix, open an issue first so we can agree on
the approach. Read the [architecture plan](docs/initial-implementation-plan/implementation-plan.md)
and the decision records for the area you are changing.

## Setup

Use the Node.js version in `.nvmrc`, then install once from the repository root:

```sh
nvm install
npm ci
```

Each package's README lists its checks: [Core](core/README.md),
[the app](interface/kipster-ui/README.md) and [adapters](adapters/README.md).

## Pull requests

- Branch from `next` and open the pull request against `next`.
- Add a changeset for every package you change: `npx changeset`. Use `patch`
  for fixes and `minor` for features and breaking changes.
- Keep released apps working: change protocol responses by addition only
  ([decision record 5.1.7](docs/initial-implementation-plan/05-kipster-protocol.md)).
- Run the checks for the packages you touched. CI runs them again.

Releases are described in [docs/releasing.md](docs/releasing.md).

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 license](LICENSE).
