import { array, boolean, boundedInteger, boundedString, clockTime, fallback, integer, literal, nonempty, nullable, object, optional, union, unknown, utcTimestamp, type Infer } from './schema.js'
import { context } from './text.js'

const id = nonempty()
const weekday = union(literal('sun'), literal('mon'), literal('tue'), literal('wed'), literal('thu'), literal('fri'), literal('sat'))
/** Weekdays a trigger fires on; every day when missing. */
const days = optional(array(weekday))
/**
 * When a routine runs, in wall-clock time of its time zone: `once` at a local date and time ("2026-10-22T15:00"),
 * `every` so many minutes inside a daily window counted from `from` (all day when missing), or `times` at fixed
 * times of day.
 */
export const routineTrigger = union(
  object({ type: literal('once'), at: boundedString(16, 16) }),
  object({ type: literal('every'), minutes: boundedInteger(1, 1440), from: optional(clockTime()), until: optional(clockTime()), days }),
  object({ type: literal('times'), times: array(clockTime()), days }),
)
export type RoutineTrigger = Infer<typeof routineTrigger>
/** One scheduled time: `started` with its thread, or `skipped` past the kip's daily limit. `late` runs caught up a missed time. */
export const routineRun = object({ id, scheduledFor: utcTimestamp(), startedAt: utcTimestamp(), state: fallback('started', 'skipped'), late: boolean(), threadId: nullable(id) }, false)
export type RoutineRun = Infer<typeof routineRun>
/**
 * Work a kip does on its own when a trigger fires; each run starts a new thread in `chatId`. `nextRunAt` is null when
 * the routine is off or no trigger fires again. `triggers` are read as sent, so later trigger kinds pass through.
 */
export const routine = object({
  id, agentId: id, chatId: id, contextKind: union(literal('installation'), literal('organization')), contextId: id, name: nonempty(), instructions: nonempty(),
  triggers: array(unknown()), timeZone: nonempty(), enabled: boolean(), nextRunAt: nullable(utcTimestamp()), lastRun: nullable(routineRun),
  createdBy: id, createdAt: utcTimestamp(), updatedAt: utcTimestamp(), revision: integer(),
}, false)
export type Routine = Infer<typeof routine>
export const routineList = object({ version: literal(1), routines: array(routine) }, false)
export type RoutineList = Infer<typeof routineList>
export const routineResult = object({ version: literal(1), routine }, false)
export type RoutineResult = Infer<typeof routineResult>
/** Runs newest first, at most 100. */
export const routineRunList = object({ version: literal(1), routineId: id, runs: array(routineRun) }, false)
export type RoutineRunList = Infer<typeof routineRunList>
export const routineRemoval = object({ version: literal(1), routineId: id, deleted: boolean() }, false)
export type RoutineRemoval = Infer<typeof routineRemoval>
export const routineRunResult = object({ version: literal(1), routineId: id, run: routineRun }, false)
export type RoutineRunResult = Infer<typeof routineRunResult>

/** A routine for the kip of a chat of the person. The time zone defaults to the computer's. */
export const routineCreate = object({
  version: literal(1), operationId: boundedString(1, 200), context, chatId: id, name: boundedString(1, 200), instructions: boundedString(1, 16000),
  triggers: array(routineTrigger), timeZone: optional(boundedString(1, 100)),
})
export type RoutineCreate = Infer<typeof routineCreate>
/** Omitted fields are unchanged; `triggers` replaces the whole list. `enabled` false pauses the routine. */
export const routineUpdate = object({
  version: literal(1), name: optional(boundedString(1, 200)), instructions: optional(boundedString(1, 16000)), triggers: optional(array(routineTrigger)),
  timeZone: optional(boundedString(1, 100)), enabled: optional(boolean()),
})
export type RoutineUpdate = Infer<typeof routineUpdate>
/** Starts a run now; a repeat with the same `operationId` returns the first run. */
export const routineRunStart = object({ version: literal(1), operationId: boundedString(1, 200) })
export type RoutineRunStart = Infer<typeof routineRunStart>

/** The most routine runs one kip starts a day, across its routines. */
export const routineSettings = object({ version: literal(1), dailyRunLimit: integer() }, false)
export type RoutineSettings = Infer<typeof routineSettings>
export const routineSettingsWrite = object({ version: literal(1), dailyRunLimit: boundedInteger(1, 1000) })
export type RoutineSettingsWrite = Infer<typeof routineSettingsWrite>
