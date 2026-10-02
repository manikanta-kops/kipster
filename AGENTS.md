# Kipster

Kipster coordinates persistent conversations and AI work. Core owns shared state
and execution; interfaces connect through its protocol, and execution adapters
connect it to AI providers. Core, interfaces and adapters are independent
packages. Protocol and adapter contracts ship inside Core.

User-facing text calls agents *kips*. Code, protocol, storage and documentation
keep the term agent. The default main kip is named Kip.

Read the [product and architecture plan](docs/initial-implementation-plan/implementation-plan.md)
and the relevant [decision records](docs/initial-implementation-plan/) before
changing behavior. The numbered records refine the initial plan; current user
instructions take precedence over older decisions.

## Working rules

- Understand the requested outcome and existing code before making changes.
  Make deliberate implementation decisions and keep the scope focused.
- Before implementing a feature, challenge its assumptions and look for blind
  spots, failure cases and integration impacts. Raise material gaps and tradeoffs
  up front, with a proposed way forward.
- Challenge your own design and review your work before presenting it.
- Never claim a feature works without testing the relevant behavior. Report
  what you tested, the results and anything still unverified.
- Preserve unrelated work and respect each package's boundaries.
- Database migrations merged into `next` are shipped and immutable; every schema change or fix adds a new number above the base branch's highest and updates the ordered list in `core/src/runtime.ts`.
- Keep released clients working: change protocol responses by addition only,
  and follow the compatibility rules in decision record 5.1.7.
- Start each task on a new branch from the latest `origin/next`, in its own git
  worktree when other work may share this checkout. Install dependencies with
  `npm ci` at the repository root.
- Open pull requests against `next`. Add a changeset for every package you
  change (`patch` for fixes, `minor` for features and breaking changes); see
  [releasing](docs/releasing.md). The owner merges pull requests unless they ask
  you to, and only the owner merges into `master`.
- Keep public documentation concise and useful. Leave task history, conversation
  notes and personal environment details out of public READMEs and API comments.
