---
"@kipster/core": minor
---

First-run onboarding support. A new installation now has only the owner, Playground and the admin kip; the person picks starter kips (Planner, Researcher, Writer, Coach) with `GET`/`POST /v1/starters`. Add `GET`/`PUT /v1/settings/person` for the person's name and `GET /v1/settings/onboarding` with `POST /v1/settings/onboarding/complete`, and the matching `person.*`, `onboarding.*` and `agents.create_starters` admin operations.
