---
"@kipster/core": minor
---

Add routines: work a kip does on its own when a time trigger fires. Kips create, edit, list and delete them with
`create_routine`, `edit_routine`, `list_routines` and `delete_routine`. Each run starts a new thread in the kip's chat
and reports with `message_user`; its prompt lists the routine's last three runs and what each sent. Missed times run once after a restart or sleep, and each kip starts at most 50
routine runs a day (`/v1/settings/routines`). New `/v1/routines` routes create, change, run now, list runs and delete
routines, and thread summaries name the routine that started them.
