# Plugins

## Sub-features

- Plugin catalogue by category with search and availability.
- Connect an account through the service's sign-in page in a new tab, returning through Core's `/plugins/callback`.
- Add another account, rename an account, choose the default account and disconnect an account.

## How to get to it (user point of view)

Choose Plugins in the sidebar (shown when Core reports plugins), search for a plugin and open it. Connect or Add another account… opens the service's sign-in page in a new tab; the plugin page updates by itself when the sign-in finishes. Each account row offers Set default, Rename and Disconnect.

## Driving it

| User action                                                                                               | Exact command                            | Observable result                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search for Fixture, connect alice, add bob, rename bob, make alice the default and disconnect the renamed | `node .kipster/verify/drive.mjs plugins` | After each step the account rows, labels, Default tag and status match `/v1/plugins/accounts`; `plugins-connect`, `-second-account`, `-rename`, `-default` and `-disconnect` screenshots are saved. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

The instance runs the `@kipster/plugins` server in test-only mode with the package's test catalogue (one plugin, Fixture) and its local fixture service; no real service is contacted. The fixture's sign-in page lists alice and bob. For this scenario only, the driver also allows the one loopback fixture origin that the instance publishes at `/__fixture/plugins`. Accounts left by an earlier run are disconnected first; the run leaves alice connected as the default. Plugin tools in executions, address-based plugins, reconnects, denied or expired sign-ins and plugin server restarts remain unverified here.
