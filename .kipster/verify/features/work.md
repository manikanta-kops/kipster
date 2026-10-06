# Work and interactions

## Sub-features

- Durable questions and approvals with attempt/proposal-bound answers.
- Stop holds follow-ups; Resume releases the queue without resurrecting cancelled work.
- Explicit Retry of failed work; queued cancellation, progress notes and delegated activity.

## How to get to it (user point of view)

Open a thread. Its work block below the kip reply shows state, pending questions/approvals and controls. Special fixture messages described in the verification guide expose stable states.

## Driving it

| User action                                         | Exact command                                | Observable result                                                                                         |
| --------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Choose Blue after reloading a waiting question      | `node .kipster/verify/drive.mjs question`    | The card survives reload; Send answer resumes the fixture and the saved interaction is no longer pending. |
| Approve the inert fixture proposal after reload     | `node .kipster/verify/drive.mjs approval`    | Approve resumes the fixture; the interaction settles in Core.                                             |
| Queue a reply, Stop held work and Resume follow-ups | `node .kipster/verify/drive.mjs stop-resume` | The first run is cancelled with queueHold true; the queued reply appears only after Resume.               |
| Retry deliberately failed work                      | `node .kipster/verify/drive.mjs retry`       | Core first reports failed; Retry work produces the fixture reply.                                         |

## Gotchas

Use APP_URL and EVIDENCE_DIR from [the verification guide](../README.md). Each command saves a screenshot, trace and JSON verdict.

The deterministic adapter has no steering/native resume or real external effects. Approvals do not grant provider permissions. This map does not prove queued cancellation, provider termination, durable crash recovery, progress notes or delegation; Core deterministic tests cover these domains separately. Failed commands can leave pending state; report it without restarting the instance.
