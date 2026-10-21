# Decision block 13: Routines

Status: agreed direction, 2026-10-21. It gives the scheduling design that
[decision block 3](./03-execution-adapters-and-agent-capabilities.md) and
[block 6](./06-application-assembly-and-operations.md) left to a separate
record.

A routine is work a kip does on its own when a trigger fires. Each run starts a
new thread, and the kip tells the person only what is worth telling.

## 1. Rules

1. **A routine is a kip, instructions and triggers.** It has a name, Markdown
   instructions, one or more triggers, a time zone and an on/off switch.
   Instructions must make sense without any earlier conversation.
2. **Kips and people create them.** A kip creates, changes, pauses and deletes
   its own routines and those of the kips it can message, without approval;
   the admin kip manages every kip's. The person manages all of them in the
   interface.
3. **Time triggers.** Triggers are a list; this block defines three kinds:
   - `{ type: 'once', at }` runs once at a local date and time.
   - `{ type: 'every', minutes, from?, until?, days? }` repeats inside a daily
     window, counted from `from`. Without a window it runs all day from
     midnight.
   - `{ type: 'times', times, days? }` runs at fixed times, such as
     `['07:15']`.

   `days` lists weekdays and defaults to every day. Times are wall-clock times
   in the routine's time zone, so a daylight-saving change does not shift
   them; a time the change skips runs an hour later that day. The time zone
   defaults to the Mac's.

   | The person says | Triggers |
   | --- | --- |
   | Every day at 9 AM | `[{ type: 'times', times: ['09:00'] }]` |
   | Mon and Tue at 2:30 PM, Wed and Fri at 6 AM | `[{ type: 'times', times: ['14:30'], days: ['mon','tue'] }, { type: 'times', times: ['06:00'], days: ['wed','fri'] }]` |
   | Every 2 hours, 9 AM to 7 PM | `[{ type: 'every', minutes: 120, from: '09:00', until: '19:00' }]` |
   | Tomorrow at 3 PM, once | `[{ type: 'once', at: '2026-10-22T15:00' }]` |
4. **Every run is a new thread.** The thread is in the kip's chat with the
   person and is marked with its routine, so the interface can list routine
   runs on their own. It starts with the routine's instructions as a message
   of whoever wrote the routine, the person or a kip. A routine for another kip runs in the workspace a
   message to that kip would go to. Runs of the same or different routines
   run in parallel.
5. **Runs are unattended.** The kip works without the person watching and
   should not ask them anything. It reports with `message_user`: `normal` when
   the person should see it now, `silent` when it can wait, or nothing when
   there is nothing to report. A failed or interrupted run notifies the person,
   as in [decision block 12](./12-messaging-the-person.md).
6. **Each scheduled time runs once.** A run is identified by its routine and
   scheduled time. Retries, restarts and repeated wake-ups never start it
   twice.
7. **Missed times run once.** When Core was stopped or the Mac slept through
   one or more scheduled times, the routine runs once, marked late, and then
   continues at its next future time. A missed `once` routine also runs once.
   A run that starts more than two minutes after its time is late. A routine
   whose kip is archived or unavailable skips its times.
8. **Daily limit.** A kip starts at most 50 routine runs a day, across all its
   routines, counted from local midnight. A scheduled time past the limit is
   recorded as skipped and starts no thread. The limit is an installation
   setting.

## 2. Mechanics

- Core stores each routine's next run time. Recording a run and moving the next
  run time forward happen in one transaction.
- Core keeps the earliest next run time in memory and sets one timer for it,
  never longer than 60 seconds. A wake-up with nothing due does not touch the
  database; the 60-second limit only lets Core notice a Mac that woke from
  sleep.
- At startup Core runs the same check, so routines need no re-registration.
  Interrupted runs are recovered by the existing run recovery.
- A run's turn has trigger kind `routine`. It acts for the person who created
  the routine, or, for a routine a kip created, the person responsible for the
  run that created it.
- Pausing or deleting a routine stops future runs; a run in progress finishes.
  Resuming continues from now without catching up. Changing triggers or the
  time zone recomputes the next run time. Deleting a kip or its workspace
  deletes the routines of its chats; a deleted routine's threads keep its
  name.
- "Run now" starts a run at once and counts toward the daily limit.
- Kips use four Core tools: `create_routine`, `edit_routine` (pause with
  `enabled: false`), `list_routines` and `delete_routine`. A repeated create
  call returns the first routine. Routine runs get a header naming the routine
  and its time, telling the kip that the person is not watching. The header
  lists the routine's three previous runs, newest first, with their threads and
  the first 300 characters of what each sent with `message_user`, "sent
  nothing" or "skipped", so a run builds on them instead of repeating them.
- The administration catalog's `routines` area reads and sets the daily limit.
- Migration 003 adds `routines`, `routine_runs`, the installation's
  `routine_daily_limit` and the `routine` trigger kind.

## 3. Protocol

Additions, following [decision block 5, section 5.1.7](./05-kipster-protocol.md):

- `/v1/routines`: list (optionally for one `agentId`) and create for the kip
  of one of the person's chats. `/v1/routines/{id}`: read, change (`PATCH`)
  and delete. `/v1/routines/{id}/runs` lists runs newest first;
  `/v1/routines/{id}/run` starts one now. Create and run now take an
  `operationId`; a repeat returns the first result.
- A routine returns its triggers, time zone, on/off state, next run time and
  last run. A run returns its scheduled time, start time, state (`started` or
  `skipped`), whether it was late, and its thread.
- `/v1/settings/routines` reads and sets `dailyRunLimit`.
- A thread a routine started carries `routine: { id, name }`; `id` is null
  once the routine is deleted.
- Clients that do not know routines show those threads as ordinary threads.
