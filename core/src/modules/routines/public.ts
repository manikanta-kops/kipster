import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { authorizeAdministration, isLive, refuseAgent, type AdminCaller, type TrustedActor } from '../identity/public.js'
import { authorizedChat, messageRecord, workRecord } from '../conversations/public.js'
import { chatPresent, publishThreadChange } from '../synchronization/public.js'
import { boundScope, insertMessage, listAgents, messageTarget, queueRun, type KipScope } from '../work/public.js'
import { routineSettingsWrite, type Routine, type RoutineCreate, type RoutineRun, type RoutineSettings, type RoutineUpdate } from '../../protocol/routines.js'
import { hostTimeZone, localLabel, nextRunAfter, parseTriggers, startOfDay, validTimeZone, type Trigger } from './schedule.js'

export { hostTimeZone, localLabel, nextRunAfter, parseTriggers, type Trigger } from './schedule.js'

/** A run that starts this long after its scheduled time is marked late. */
const LATE_MS = 2 * 60000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const listeners = new Set<() => void>()
/** Calls `listener` after any routine is created, changed or deleted in this process. */
export function onRoutinesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function changed(): void {
  for (const listener of listeners) { try { listener() } catch { /* a listener's failure is its own */ } }
}

interface Row {
  id: string; installation_id: string; chat_id: string; agent_id: string; person_id: string; created_by: string; name: string; instructions: string
  triggers: Trigger[]; time_zone: string; enabled: boolean; next_run_at: Date | null; created_at: Date; updated_at: Date; revision: string
  context_kind: 'installation' | 'organization'; context_id: string
}
interface RunRow { id: string; routine_id: string | null; scheduled_for: Date; started_at: Date; state: 'started' | 'skipped'; late: boolean; thread_id: string | null }
const selectRoutine = 'SELECT r.*,c.context_kind,c.context_id FROM kipster.routines r JOIN kipster.direct_chats c ON c.id=r.chat_id'

const runRecord = (row: RunRow): RoutineRun => ({ id: row.id, scheduledFor: row.scheduled_for.toISOString(), startedAt: row.started_at.toISOString(), state: row.state, late: row.late, threadId: row.thread_id })
/** Routines as the protocol shows them, each with its last run. */
async function records(client: SqlClient, rows: readonly Row[]): Promise<Routine[]> {
  const last = new Map((await client.query<RunRow>('SELECT DISTINCT ON (routine_id) * FROM kipster.routine_runs WHERE routine_id=ANY($1::uuid[]) ORDER BY routine_id,scheduled_for DESC', [rows.map(row => row.id)])).rows.map(run => [run.routine_id!, run]))
  return rows.map(row => {
    const run = last.get(row.id)
    return {
      id: row.id, agentId: row.agent_id, chatId: row.chat_id, contextKind: row.context_kind, contextId: row.context_id, name: row.name, instructions: row.instructions,
      triggers: row.triggers, timeZone: row.time_zone, enabled: row.enabled, nextRunAt: row.next_run_at?.toISOString() ?? null, lastRun: run ? runRecord(run) : null,
      createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revision: Number(row.revision),
    }
  })
}
async function record(client: SqlClient, id: string): Promise<Routine> {
  const row = (await client.query<Row>(`${selectRoutine} WHERE r.id=$1`, [id])).rows[0]
  if (!row) throw new Error('Routine not found')
  return (await records(client, [row]))[0]!
}
/** A routine of the installation whose chat still exists, locked for a change. */
async function lockedRoutine(client: SqlClient, installationId: string, routineId: unknown): Promise<Row> {
  const row = typeof routineId === 'string' && uuid.test(routineId) ? (await client.query<Row>(`${selectRoutine} WHERE r.id=$1 AND r.installation_id=$2 AND kipster.chat_present(r.chat_id) FOR UPDATE OF r`, [routineId, installationId])).rows[0] : undefined
  if (!row) throw new Error('No routine has that ID; find routines with list_routines')
  return row
}

interface Fields { name: string; instructions: string; triggers: Trigger[]; timeZone: string }
const text = (value: unknown, field: string, max: number): string => typeof value === 'string' && value.trim() && value.length <= max ? value : (() => { throw new TypeError(`${field} must be 1 to ${max} characters`) })()
function timeZone(value: unknown): string {
  if (value === undefined) return hostTimeZone()
  if (!validTimeZone(value)) throw new TypeError('timeZone must be an IANA time zone such as "America/New_York"')
  return value
}
const nextRun = (enabled: boolean, triggers: readonly Trigger[], zone: string, now: Date): Date | null => enabled ? nextRunAfter(triggers, zone, now) : null

async function insertRoutine(client: SqlClient, routine: { installationId: string; chatId: string; agentId: string; personId: string; createdBy: string; requestKey: string } & Fields, now: Date): Promise<string> {
  const existing = (await client.query<{ id: string }>('SELECT id FROM kipster.routines WHERE request_key=$1', [routine.requestKey])).rows[0]
  if (existing) return existing.id
  const id = randomUUID()
  await client.query(`INSERT INTO kipster.routines(id,installation_id,chat_id,agent_id,person_id,created_by,name,instructions,triggers,time_zone,next_run_at,request_key,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$13)`,
    [id, routine.installationId, routine.chatId, routine.agentId, routine.personId, routine.createdBy, routine.name, routine.instructions, JSON.stringify(routine.triggers), routine.timeZone, nextRun(true, routine.triggers, routine.timeZone, now), routine.requestKey, now])
  return id
}

interface Patch { name?: unknown; instructions?: unknown; triggers?: unknown; timeZone?: unknown; enabled?: unknown }
/** Applies the fields a change names; triggers replace the whole list. The next run is computed again from now. */
async function updateRoutine(client: SqlClient, row: Row, patch: Patch, now: Date): Promise<void> {
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be true or false')
  const zone = patch.timeZone === undefined ? row.time_zone : timeZone(patch.timeZone)
  const triggers = patch.triggers === undefined ? row.triggers : parseTriggers(patch.triggers, zone, now)
  const enabled = (patch.enabled as boolean | undefined) ?? row.enabled
  await client.query(`UPDATE kipster.routines SET name=$2,instructions=$3,triggers=$4::jsonb,time_zone=$5,enabled=$6,next_run_at=$7,updated_at=$8,revision=revision+1 WHERE id=$1`,
    [row.id, patch.name === undefined ? row.name : text(patch.name, 'name', 200), patch.instructions === undefined ? row.instructions : text(patch.instructions, 'instructions', 16000),
      JSON.stringify(triggers), zone, enabled, nextRun(enabled, triggers, zone, now), now])
}

/** The most routine runs one kip starts a day. */
async function dailyLimit(client: SqlClient, installationId: string): Promise<number> {
  return (await client.query<{ routine_daily_limit: number }>('SELECT routine_daily_limit FROM kipster.installations WHERE id=$1', [installationId])).rows[0]?.routine_daily_limit ?? 50
}

/**
 * Starts one run of a locked routine for `scheduledFor`: a new thread in the routine's chat with its instructions as
 * a message of the routine's author, and the kip's turn queued there. Past the kip's daily limit the time is recorded as skipped.
 */
async function startRun(client: SqlClient, jobs: Jobs, row: Row, scheduledFor: Date, now: Date, requestKey: string | null = null): Promise<RunRow> {
  const used = Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM kipster.routine_runs WHERE agent_id=$1 AND state='started' AND started_at>=$2", [row.agent_id, startOfDay(now, hostTimeZone())])).rows[0]!.n)
  const late = now.getTime() - scheduledFor.getTime() > LATE_MS
  const insertRun = async (state: 'started' | 'skipped', threadId: string | null) => (await client.query<RunRow>(`INSERT INTO kipster.routine_runs(id,routine_id,routine_name,agent_id,scheduled_for,started_at,state,late,thread_id,request_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), row.id, row.name, row.agent_id, scheduledFor, now, state, late, threadId, requestKey])).rows[0]!
  if (used >= await dailyLimit(client, row.installation_id)) return insertRun('skipped', null)
  const threadId = randomUUID()
  await client.query('INSERT INTO kipster.threads(id,chat_id) VALUES ($1,$2)', [threadId, row.chat_id])
  // The instructions are the message of whoever wrote the routine, so memory never takes a kip's words for the person's.
  const messageId = await insertMessage(client, threadId, row.created_by, [{ kind: 'text', text: row.instructions }], [])
  const runId = await queueRun(client, jobs, threadId, messageId, row.installation_id, { trigger: 'routine', chainDepth: 0, personId: row.person_id })
  // Recorded before publishing, so the thread summary names the routine.
  const run = await insertRun('started', threadId)
  await publishThreadChange(client, row.installation_id, row.person_id, threadId, row.chat_id, 'message-final', messageId, 1, await messageRecord(client, messageId), 'queued', messageId)
  await publishThreadChange(client, row.installation_id, row.person_id, threadId, row.chat_id, 'work-changed', runId, 1, await workRecord(client, runId), 'queued', null)
  return run
}
/** Whether the routine's kip, and its workspace for a workspace chat, can take new work. */
async function runnable(client: SqlClient, row: Row): Promise<boolean> {
  return await chatPresent(client, row.chat_id) && await isLive(client, row.installation_id, 'agent', row.agent_id)
    && (row.context_kind !== 'organization' || await isLive(client, row.installation_id, 'organization', row.context_id))
}

// Scheduling ------------------------------------------------------------------

/** The earliest next run of the installation's routines that are on. */
export async function earliestRunAt(db: Postgres, installationId: string): Promise<Date | null> {
  return (await db.query<{ at: Date | null }>('SELECT min(next_run_at) AS at FROM kipster.routines WHERE installation_id=$1 AND enabled', [installationId])).rows[0]?.at ?? null
}

/**
 * Runs every routine whose next run is due at `now`, each in its own transaction. A routine due several times since
 * its next run, because Core was stopped or the computer slept, runs once and goes on at its next time after `now`.
 * A routine whose kip or workspace cannot take work skips the time.
 */
export async function runDueRoutines(db: Postgres, jobs: Jobs, installationId: string, now: Date): Promise<number> {
  const due = (await db.query<{ id: string }>('SELECT id FROM kipster.routines WHERE installation_id=$1 AND enabled AND next_run_at<=$2 ORDER BY next_run_at,id LIMIT 100', [installationId, now])).rows
  let started = 0
  for (const { id } of due) {
    started += await db.transaction(async client => {
      const row = (await client.query<Row>(`${selectRoutine} WHERE r.id=$1 AND r.enabled AND r.next_run_at<=$2 FOR UPDATE OF r SKIP LOCKED`, [id, now])).rows[0]
      if (!row) return 0
      const run = await runnable(client, row) && !(await client.query('SELECT 1 FROM kipster.routine_runs WHERE routine_id=$1 AND scheduled_for=$2', [row.id, row.next_run_at])).rows.length
        ? await startRun(client, jobs, row, row.next_run_at!, now) : null
      await client.query('UPDATE kipster.routines SET next_run_at=$2 WHERE id=$1', [row.id, nextRunAfter(row.triggers, row.time_zone, now)])
      return run?.state === 'started' ? 1 : 0
    })
  }
  return started
}

/** For a run a routine started: the routine's name, its scheduled time as the person reads it, and whether it is late. */
/** How much of what an earlier run sent its header shows. */
export const EARLIER_RUN_TEXT = 300
/** One earlier run of a routine as its next run sees it: `sent` is null when the run sent the person nothing. */
export interface EarlierRun { scheduledFor: string; state: 'started' | 'skipped'; threadId: string | null; sent: string | null }

/** The routine of a run, with its three previous runs newest first and what each sent the person. */
export async function routineRunFacts(db: Postgres, runId: string): Promise<{ name: string; scheduledFor: string; late: boolean; earlier: EarlierRun[] } | null> {
  const row = (await db.query<{ routine_id: string | null; routine_name: string; scheduled_for: Date; late: boolean; time_zone: string | null }>(`SELECT rr.routine_id,rr.routine_name,rr.scheduled_for,rr.late,r.time_zone
    FROM kipster.text_runs t JOIN kipster.routine_runs rr ON rr.thread_id=t.thread_id LEFT JOIN kipster.routines r ON r.id=rr.routine_id
    WHERE t.id=$1 AND t.trigger_kind='routine'`, [runId])).rows[0]
  if (!row) return null
  const zone = row.time_zone ?? hostTimeZone()
  const earlier = row.routine_id ? (await db.query<{ scheduled_for: Date; state: 'started' | 'skipped'; thread_id: string | null; sent: string | null; messages: string }>(`SELECT e.scheduled_for,e.state,e.thread_id,
      (SELECT string_agg(p.part->>'text', ' ' ORDER BY m.position, p.n) FROM kipster.messages m CROSS JOIN LATERAL jsonb_array_elements(m.parts) WITH ORDINALITY p(part, n)
        WHERE m.thread_id=e.thread_id AND m.author_id=e.agent_id AND m.publication_source='tool' AND NOT m.progress AND p.part->>'kind'='text') AS sent,
      (SELECT count(*) FROM kipster.messages m WHERE m.thread_id=e.thread_id AND m.author_id=e.agent_id AND m.publication_source='tool' AND NOT m.progress) AS messages
    FROM kipster.routine_runs e WHERE e.routine_id=$1 AND e.scheduled_for<$2 ORDER BY e.scheduled_for DESC LIMIT 3`, [row.routine_id, row.scheduled_for])).rows : []
  return {
    name: row.routine_name, scheduledFor: localLabel(row.scheduled_for, zone), late: row.late,
    earlier: earlier.map(run => {
      const text = run.sent?.replace(/\s+/g, ' ').trim() || (Number(run.messages) ? 'a message without text' : '')
      return { scheduledFor: localLabel(run.scheduled_for, zone), state: run.state, threadId: run.thread_id, sent: text ? (text.length > EARLIER_RUN_TEXT ? `${text.slice(0, EARLIER_RUN_TEXT)}…` : text) : null }
    }),
  }
}

// Kip tools -------------------------------------------------------------------

/** The kips whose routines a kip manages: its own and those of the kips it can message. */
async function manageable(db: Postgres, scope: KipScope, attemptId: string, incarnation: string): Promise<Set<string>> {
  return new Set([scope.agentId, ...(await listAgents(db, attemptId, incarnation)).map(agent => agent.id)])
}
const only = (args: Record<string, unknown>, keys: string[], tool: string) => { for (const key of Object.keys(args)) if (!keys.includes(key)) throw new TypeError(`${key} is not an argument of ${tool}`) }
/** A routine as a kip reads it: the protocol record, with the next run in the routine's time zone. */
const forKip = (routine: Routine) => ({ ...routine, ...(routine.nextRunAt ? { nextRun: localLabel(new Date(routine.nextRunAt), routine.timeZone) } : {}) })

/**
 * The routine tools of a kip: `create_routine`, `edit_routine`, `list_routines` and `delete_routine`. A kip manages
 * its own routines and those of the kips it can message; a routine for another kip runs in that kip's chat with the
 * person, in the workspace a message to it would go to. A repeated create call returns the first routine.
 */
export async function routineTool(db: Postgres, attemptId: string, incarnation: string, callId: string, name: string, args: Record<string, unknown>, now: Date): Promise<unknown> {
  if (!callId || callId.length > 200) throw new Error('Invalid call ID')
  const scope = await boundScope(db, attemptId, incarnation)
  const allowed = await manageable(db, scope, attemptId, incarnation)
  const target = (agentId: unknown): string => {
    if (agentId === undefined) return scope.agentId
    if (typeof agentId !== 'string' || !allowed.has(agentId)) throw new Error('You can manage only your own routines and those of the kips list_kips shows')
    return agentId
  }
  if (name === 'list_routines') {
    only(args, ['agentId'], name)
    const rows = (await db.query<Row>(`${selectRoutine} WHERE r.installation_id=$1 AND r.agent_id=$2 AND kipster.chat_present(r.chat_id) ORDER BY r.created_at,r.id`, [scope.installationId, target(args.agentId)])).rows
    return { routines: (await records(db, rows)).map(forKip) }
  }
  if (name === 'create_routine') {
    only(args, ['name', 'instructions', 'triggers', 'timeZone', 'agentId', 'workspaceId'], name)
    const agentId = target(args.agentId)
    const zone = timeZone(args.timeZone)
    const fields: Fields = { name: text(args.name, 'name', 200), instructions: text(args.instructions, 'instructions', 16000), triggers: parseTriggers(args.triggers, zone, now), timeZone: zone }
    if (args.workspaceId !== undefined && (typeof args.workspaceId !== 'string' || agentId === scope.agentId)) throw new TypeError('workspaceId names the workspace of another kip')
    const id = await db.transaction(async client => {
      let chatId = scope.chatId
      if (agentId !== scope.agentId) {
        const kip = (await client.query<{ display_name: string }>('SELECT display_name FROM kipster.agents WHERE id=$1', [agentId])).rows[0]!.display_name
        const where = await messageTarget(client, scope, agentId, kip, args.workspaceId as string | undefined)
        if (!await isLive(client, scope.installationId, 'agent', agentId)) await refuseAgent(client, scope.installationId, agentId, `${kip} is not available`)
        chatId = (await client.query<{ id: string }>(`INSERT INTO kipster.direct_chats(id,installation_id,caller_id,context_kind,context_id,agent_id) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (installation_id,caller_id,context_kind,context_id,agent_id) DO UPDATE SET id=kipster.direct_chats.id RETURNING id`, [randomUUID(), scope.installationId, scope.personId, where.kind, where.id, agentId])).rows[0]!.id
      }
      return insertRoutine(client, { installationId: scope.installationId, chatId, agentId, personId: scope.personId, createdBy: scope.agentId, requestKey: `kip:${attemptId}:${callId}`, ...fields }, now)
    })
    changed()
    return { routine: forKip(await record(db, id)) }
  }
  if (name === 'edit_routine') {
    only(args, ['routineId', 'name', 'instructions', 'triggers', 'timeZone', 'enabled'], name)
    const { routineId, ...patch } = args
    await db.transaction(async client => {
      const row = await lockedRoutine(client, scope.installationId, routineId)
      target(row.agent_id)
      await updateRoutine(client, row, patch, now)
    })
    changed()
    return { routine: forKip(await record(db, routineId as string)) }
  }
  if (name === 'delete_routine') {
    only(args, ['routineId'], name)
    await db.transaction(async client => {
      const row = await lockedRoutine(client, scope.installationId, args.routineId)
      target(row.agent_id)
      await client.query('DELETE FROM kipster.routines WHERE id=$1', [row.id])
    })
    changed()
    return { routineId: args.routineId, deleted: true }
  }
  throw new Error('Unsupported routine tool')
}

// The person's routes -----------------------------------------------------------

/** The routines of the installation, or of one kip, for its owner. */
export async function listRoutines(db: Postgres, actor: TrustedActor, agentId?: string): Promise<Routine[]> {
  await authorizeAdministration(db, actor)
  if (agentId !== undefined && !uuid.test(agentId)) return []
  const rows = (await db.query<Row>(`${selectRoutine} WHERE r.installation_id=$1 AND ($2::uuid IS NULL OR r.agent_id=$2) AND kipster.chat_present(r.chat_id) ORDER BY r.created_at,r.id`, [actor.installationId, agentId ?? null])).rows
  return records(db, rows)
}
export async function readRoutine(db: Postgres, actor: TrustedActor, routineId: string): Promise<Routine> {
  await authorizeAdministration(db, actor)
  return db.transaction(async client => records(client, [await lockedRoutine(client, actor.installationId, routineId)]).then(list => list[0]!))
}
/** Creates a routine for the kip of one of the person's chats. A repeat with the same operation ID returns the first routine. */
export async function createRoutine(db: Postgres, actor: TrustedActor, input: RoutineCreate, now: Date): Promise<Routine> {
  const zone = timeZone(input.timeZone)
  const fields: Fields = { name: text(input.name, 'name', 200), instructions: text(input.instructions, 'instructions', 16000), triggers: parseTriggers(input.triggers, zone, now), timeZone: zone }
  const id = await db.transaction(async client => {
    await authorizeAdministration(client, actor)
    const chat = await authorizedChat(client, actor, input.context, input.chatId, true)
    if (!await isLive(client, actor.installationId, 'agent', chat.agent_id)) await refuseAgent(client, actor.installationId, chat.agent_id, 'Agent is not available')
    return insertRoutine(client, { installationId: actor.installationId, chatId: chat.id, agentId: chat.agent_id, personId: actor.personId, createdBy: actor.personId, requestKey: `person:${actor.personId}:${input.operationId}`, ...fields }, now)
  })
  changed()
  return record(db, id)
}
export async function changeRoutine(db: Postgres, actor: TrustedActor, routineId: string, input: RoutineUpdate, now: Date): Promise<Routine> {
  const { version: _, ...patch } = input
  await db.transaction(async client => {
    await authorizeAdministration(client, actor)
    await updateRoutine(client, await lockedRoutine(client, actor.installationId, routineId), patch, now)
  })
  changed()
  return record(db, routineId)
}
/** `deleted` is false when the routine was already gone. A run in progress finishes. */
export async function deleteRoutine(db: Postgres, actor: TrustedActor, routineId: string): Promise<boolean> {
  await authorizeAdministration(db, actor)
  const deleted = uuid.test(routineId) && !!(await db.query('DELETE FROM kipster.routines WHERE id=$1 AND installation_id=$2', [routineId, actor.installationId])).rowCount
  if (deleted) changed()
  return deleted
}
/** A routine's runs, newest first. */
export async function routineRuns(db: Postgres, actor: TrustedActor, routineId: string, limit = 50): Promise<RoutineRun[]> {
  await readRoutine(db, actor, routineId)
  return (await db.query<RunRow>('SELECT * FROM kipster.routine_runs WHERE routine_id=$1 ORDER BY scheduled_for DESC,id LIMIT $2', [routineId, Math.min(Math.max(limit, 1), 100)])).rows.map(runRecord)
}
/** Starts a run now, counted toward the kip's daily limit. A repeat with the same operation ID returns the first run. */
export async function runRoutineNow(db: Postgres, jobs: Jobs, actor: TrustedActor, routineId: string, operationId: string, now: Date): Promise<RoutineRun> {
  return db.transaction(async client => {
    await authorizeAdministration(client, actor)
    const key = `person:${actor.personId}:${operationId}`
    const prior = (await client.query<RunRow>('SELECT * FROM kipster.routine_runs WHERE request_key=$1', [key])).rows[0]
    if (prior) return runRecord(prior)
    const row = await lockedRoutine(client, actor.installationId, routineId)
    if (!await runnable(client, row)) await refuseAgent(client, row.installation_id, row.agent_id, 'The routine\'s kip is not available')
    return runRecord(await startRun(client, jobs, row, now, now, key))
  })
}

// Settings ---------------------------------------------------------------------

export async function readRoutineSettings(db: Postgres, caller: AdminCaller): Promise<RoutineSettings> {
  await authorizeAdministration(db, caller)
  return { version: 1, dailyRunLimit: await dailyLimit(db, caller.installationId) }
}
export async function writeRoutineSettings(db: Postgres, caller: AdminCaller, value: unknown): Promise<RoutineSettings> {
  const input = routineSettingsWrite.parse(value)
  return db.transaction(async client => {
    await authorizeAdministration(client, caller, true)
    await client.query('UPDATE kipster.installations SET routine_daily_limit=$2 WHERE id=$1', [caller.installationId, input.dailyRunLimit])
    return { version: 1, dailyRunLimit: input.dailyRunLimit }
  })
}
