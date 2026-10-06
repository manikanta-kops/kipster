# Organizations, kips and lifecycle

## Sub-features

- Create/edit organizations and globally owned kips.
- Organization memberships, former-member history, visual groups and ordering.
- Archive/restore, typed-name permanent deletion and cleanup receipts; protected root admin.

## How to get to it (user point of view)

Settings → Organization → Manage kips and groups… opens Management sections: Organization, Kips and Groups. The sidebar Organization selector changes active context. Settings → Archive & deletion holds lifecycle actions.

## Driving it

| User action                             | Exact command                                        | Observable result                                                                 |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Create a kip and reload                 | `node .kipster/verify/drive.mjs create-kip`          | Exactly one uniquely named global kip remains in the real directory.              |
| Create and select an organization       | `node .kipster/verify/drive.mjs create-organization` | Directory contains it and sidebar profile-context displays its name.              |
| Create a visual group                   | `node .kipster/verify/drive.mjs groups`              | The uniquely named group exists in the directory.                                 |
| Archive and restore a newly created kip | `node .kipster/verify/drive.mjs lifecycle`           | Restore becomes available after archive; Archive becomes available after restore. |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

Names are not unique identifiers; commands use fresh names and Core IDs. New organizations have no fixture execution defaults unless configured, so use Kip for conversation driving. Group appearances share the same membership/chat, not separate kips. These commands do not prove membership changes, reorder, deletion, long cleanup or recovery of lost administration acknowledgements. Permanent deletion must target only disposable test resources; the root admin is protected.
