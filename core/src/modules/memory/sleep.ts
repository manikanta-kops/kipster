import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { freezeConsolidation, type ConsolidationInput } from './consolidation.js'
import { freezePromotion, type IdentityWriter } from './promotion.js'
import { MAINTENANCE_LIMITS, agentLearns, agentWorking, learningCondition } from './maintenance.js'
import { MEMORY_STRENGTH, deleteMemories, strengthSql } from './strength.js'

export const SLEEP = {
  agentsPerRun: 10,
  historyPerAgent: 7,
  /** Read-only vector snapshot budget, without holding the execution lock. */
  snapshotMs: 30000,
} as const

/** Sleep steps in order. Each step is idempotent and may take several runs; a sleep finishes after the last one. */
export const SLEEP_STEPS = ['consolidate', 'forget', 'promote'] as const
export type SleepStep = typeof SLEEP_STEPS[number]
export type SleepState = 'running' | 'finished' | 'skipped'

export interface SleepRun { started: number; finished: number; skipped: number; forgotten: number }

/** The wall-clock time of `now` in the host's local time zone, as a PostgreSQL timestamp without time zone. */
function localTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock time')
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0')
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** Sleep day of agents aliased `g` (installation `i`) at local time `local`: a sleep day starts at the sleep time. */
const sleepDaySql = (local: string): string => `(${local}::timestamp - COALESCE(g.sleep_time, i.sleep_time)::interval)::date`

/** Nightly memory sleep. An agent that learns sleeps once per sleep day, which starts at its sleep time; when
 * Core was not running at that time, the agent sleeps once when it next runs. A sleep begins only while none of
 * the agent's executions is in flight, and each step batch waits for that too. Every transaction holds the
 * capacity lock, so sleep never interleaves with admission, extraction commits or a learning switch change.
 * When learning stops for the agent, its sleep is recorded as skipped and nothing further runs.
 * Consolidation and promotion hand their model calls to the maintenance coordinator and wait for that run to end. */
export class SleepService {
  constructor(private readonly db: Postgres, private readonly installationId: string, private readonly identity: IdentityWriter) {}

  /** Starts due sleeps and advances unfinished ones by one bounded batch each, for at most a few agents. A failing
   * agent does not stop the others: its sleep counts the failure and sorts after healthy ones, and the first error
   * is rethrown once every selected agent had its turn. */
  async run(now: Date): Promise<SleepRun> {
    const local = localTimestamp(now)
    const result: SleepRun = { started: 0, finished: 0, skipped: 0, forgotten: 0 }
    const agents = (await this.db.query<{ agent_id: string }>(
      `SELECT due.agent_id FROM (
         SELECT s.agent_id, s.sleep_on, s.failures FROM kipster.memory_sleeps s JOIN kipster.agents g ON g.id=s.agent_id
         WHERE g.installation_id=$1 AND s.state='running'
         UNION ALL
         SELECT g.id, ${sleepDaySql('$2')}, 0 FROM kipster.agents g JOIN kipster.installations i ON i.id=g.installation_id
         WHERE g.installation_id=$1 AND ${learningCondition('g.id')}
           AND NOT EXISTS (SELECT 1 FROM kipster.memory_sleeps s WHERE s.agent_id=g.id AND (s.state='running' OR s.sleep_on=${sleepDaySql('$2')}))
       ) due
       WHERE NOT ${learningCondition('due.agent_id')} OR NOT ${agentWorking('due.agent_id')}
       ORDER BY due.failures, due.sleep_on, due.agent_id LIMIT $3`, [this.installationId, local, SLEEP.agentsPerRun])).rows
    let failure: unknown
    for (const { agent_id: agentId } of agents) {
      try {
        if (!await this.locked(client => this.begin(client, agentId, local, result))) continue
        const frozen = await this.prepareConsolidation(agentId)
        // A completed step commits before the next one starts, so each step's work is its own transaction.
        for (let steps = 0; steps < SLEEP_STEPS.length && await this.locked(client => this.step(client, agentId, result, frozen)); steps++);
      } catch (error) {
        // Capacity contention defers this agent to the next run and is not a failure.
        if ((error as { code?: string }).code === '55P03') continue
        failure ??= error
        await this.db.query(`UPDATE kipster.memory_sleeps SET failures=failures+1 WHERE agent_id=$1 AND state='running'`, [agentId]).catch(() => undefined)
      }
    }
    if (failure !== undefined) throw failure
    return result
  }

  /** Pure reads use a coherent snapshot outside the installation lock. Queueing rechecks the sleep
   * and lifecycle under the lock; prompt assembly and commit also validate memory revisions. */
  private prepareConsolidation(agentId: string): Promise<{ sleepId: string; input: ConsolidationInput | null } | null> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query(`SET LOCAL statement_timeout='${SLEEP.snapshotMs}ms'`)
      await client.query(`SET LOCAL transaction_timeout='${SLEEP.snapshotMs}ms'`)
      const sleep = (await client.query<{ id: string }>(`SELECT s.id FROM kipster.memory_sleeps s
        WHERE s.agent_id=$1 AND s.state='running' AND s.step='consolidate'
          AND NOT EXISTS (SELECT 1 FROM kipster.maintenance_runs r WHERE r.sleep_id=s.id AND r.task_kind='consolidate')`, [agentId])).rows[0]
      if (!sleep) return null
      return { sleepId: sleep.id, input: await freezeConsolidation(client, this.installationId, agentId) }
    })
  }

  private locked<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction(async client => {
      await client.query(`SET LOCAL statement_timeout='${MAINTENANCE_LIMITS.statementMs}ms'`)
      await client.query(`SET LOCAL lock_timeout='${MAINTENANCE_LIMITS.lockMs}ms'`)
      await client.query(`SET LOCAL transaction_timeout='${MAINTENANCE_LIMITS.pageTxMs}ms'`)
      await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])
      return work(client)
    })
  }

  /** Records the start of a due sleep, or skips an unfinished one. Returns whether a sleep is in progress. */
  private async begin(client: SqlClient, agentId: string, local: string, result: SleepRun): Promise<boolean> {
    const running = await this.running(client, agentId)
    if (running) return !await this.skipUnlessLearning(client, running.id, agentId, result)
    if (!await agentLearns(client, agentId) || await this.working(client, agentId)) return false
    const started = await client.query(
      `INSERT INTO kipster.memory_sleeps(id, agent_id, sleep_on, step)
       SELECT gen_random_uuid(), g.id, ${sleepDaySql('$2')}, $3 FROM kipster.agents g JOIN kipster.installations i ON i.id=g.installation_id
       WHERE g.id=$1 AND kipster.live_agent(g.id)
       ON CONFLICT DO NOTHING`, [agentId, local, SLEEP_STEPS[0]])
    if (!started.rowCount) return false
    result.started++
    await client.query(`DELETE FROM kipster.memory_sleeps WHERE agent_id=$1 AND state<>'running'
      AND id NOT IN (SELECT id FROM kipster.memory_sleeps WHERE agent_id=$1 ORDER BY sleep_on DESC LIMIT $2)`, [agentId, SLEEP.historyPerAgent])
    return true
  }

  /** Runs one batch of the current step and moves to the next step, or finishes, once the step is complete.
   * Returns whether the sleep moved on to another step. */
  private async step(client: SqlClient, agentId: string, result: SleepRun, frozen: { sleepId: string; input: ConsolidationInput | null } | null): Promise<boolean> {
    const sleep = await this.running(client, agentId)
    if (!sleep || await this.skipUnlessLearning(client, sleep.id, agentId, result) || await this.working(client, agentId)) return false
    const step = sleep.step as SleepStep
    let done: boolean
    if (step === 'consolidate') done = await this.consolidate(client, sleep.id, agentId, frozen)
    else if (step === 'forget') done = await this.forget(client, sleep.id, agentId, result)
    else if (step === 'promote') done = await this.promote(client, sleep.id, agentId)
    else throw new Error(`Unknown sleep step ${String(step)}`)
    if (!done) return false
    const next = SLEEP_STEPS[SLEEP_STEPS.indexOf(step) + 1]
    if (next) {
      await client.query('UPDATE kipster.memory_sleeps SET step=$2 WHERE id=$1', [sleep.id, next])
      return true
    }
    await client.query(`UPDATE kipster.memory_sleeps SET state='finished', finished_at=now() WHERE id=$1`, [sleep.id])
    result.finished++
    return false
  }

  /** Freezes the agent's new material and queues one consolidation run for it, then waits until that run ends. With
   * no new material there is no run and no model call. The run applies its result; a failed run is only reported. */
  private async consolidate(client: SqlClient, sleepId: string, agentId: string, frozen: { sleepId: string; input: ConsolidationInput | null } | null): Promise<boolean> {
    const run = (await client.query<{ state: string; failure: string | null }>(
      `SELECT state, failure FROM kipster.maintenance_runs WHERE sleep_id=$1 AND task_kind='consolidate' ORDER BY created_at DESC LIMIT 1`, [sleepId])).rows[0]
    if (!run) {
      if (!frozen || frozen.sleepId !== sleepId) return false
      const input = frozen.input
      if (!input) return true
      const runId = randomUUID()
      await client.query(`INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,'queued')`, [runId, this.installationId])
      await client.query(`INSERT INTO kipster.maintenance_runs(id, installation_id, agent_id, state, task_kind, sleep_id, input)
        VALUES ($1,$2,$3,'queued','consolidate',$4,$5::jsonb)`, [runId, this.installationId, agentId, sleepId, JSON.stringify(input)])
      return false
    }
    if (run.state === 'failed') {
      await client.query(`UPDATE kipster.memory_sleeps SET report=report || jsonb_build_object('consolidation', jsonb_build_object('failure', $2::text)) WHERE id=$1`,
        [sleepId, run.failure ?? 'failed'])
      return true
    }
    return run.state === 'completed'
  }

  /** Rebuilds the Learned section of identity.md when the promotable set changed since it was last built, through one
   * identity run that writes the section when it settles. An unchanged set needs no run and no model call. A run
   * that failed, for example because identity.md was edited meanwhile, is only reported: the set stays unrecorded,
   * so the next sleep tries again. */
  private async promote(client: SqlClient, sleepId: string, agentId: string): Promise<boolean> {
    const report = (promotion: unknown) => client.query(`UPDATE kipster.memory_sleeps SET report=report || jsonb_build_object('promotion', $2::jsonb) WHERE id=$1`,
      [sleepId, JSON.stringify(promotion)])
    const run = (await client.query<{ state: string; failure: string | null }>(
      `SELECT state, failure FROM kipster.maintenance_runs WHERE sleep_id=$1 AND task_kind='identity' ORDER BY created_at DESC LIMIT 1`, [sleepId])).rows[0]
    if (!run) {
      const frozen = await freezePromotion(client, this.identity, this.installationId, agentId)
      if (!frozen) return true
      if ('recorded' in frozen) { await report(frozen.recorded); return true }
      if ('failure' in frozen) { await report(frozen); return true }
      const runId = randomUUID()
      await client.query(`INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,'queued')`, [runId, this.installationId])
      await client.query(`INSERT INTO kipster.maintenance_runs(id, installation_id, agent_id, state, task_kind, sleep_id, input)
        VALUES ($1,$2,$3,'queued','identity',$4,$5::jsonb)`, [runId, this.installationId, agentId, sleepId, JSON.stringify(frozen)])
      return false
    }
    if (run.state === 'failed') {
      await report({ failure: run.failure ?? 'failed' })
      return true
    }
    return run.state === 'completed'
  }

  /** Deletes up to one batch of the agent's memories whose strength fell below the forget threshold. */
  private async forget(client: SqlClient, sleepId: string, agentId: string, result: SleepRun): Promise<boolean> {
    const days = 'COALESCE((SELECT a.active_days FROM kipster.memory_activity a WHERE a.agent_id=$2), 0)'
    const weak = `FROM kipster.memory_records m WHERE m.installation_id=$1 AND m.scope='agent' AND m.owner_id=$2 AND ${strengthSql(days)} < $3`
    const params = [this.installationId, agentId, MEMORY_STRENGTH.forgetBelow]
    const ids = (await client.query<{ id: string }>(`SELECT m.id ${weak} ORDER BY m.id LIMIT $4 FOR UPDATE OF m SKIP LOCKED`,
      [...params, MEMORY_STRENGTH.forgetBatch])).rows.map(row => row.id)
    await deleteMemories(client, ids)
    if (ids.length) {
      await client.query(`UPDATE kipster.memory_sleeps SET report=report || jsonb_build_object('forgotten', COALESCE((report->>'forgotten')::bigint, 0) + $2)
        WHERE id=$1`, [sleepId, ids.length])
      result.forgotten += ids.length
    }
    return !(await client.query(`SELECT 1 ${weak} LIMIT 1`, params)).rows.length
  }

  private async running(client: SqlClient, agentId: string): Promise<{ id: string; step: string } | undefined> {
    return (await client.query<{ id: string; step: string }>(
      `SELECT id, step FROM kipster.memory_sleeps WHERE agent_id=$1 AND state='running' FOR UPDATE`, [agentId])).rows[0]
  }

  /** Stops a sleep whose agent no longer learns, with a model run that has not started. A run already started is
   * left to its commit fence. Returns whether the sleep was skipped. */
  private async skipUnlessLearning(client: SqlClient, sleepId: string, agentId: string, result: SleepRun): Promise<boolean> {
    if (await agentLearns(client, agentId)) return false
    await client.query(`UPDATE kipster.memory_sleeps SET state='skipped', finished_at=now(), report=report || '{"reason":"learning_disabled"}'
      WHERE id=$1`, [sleepId])
    const queued = (await client.query<{ id: string }>(`UPDATE kipster.maintenance_runs SET state='failed', failure='learning_disabled', updated_at=now()
      WHERE sleep_id=$1 AND state='queued' RETURNING id`, [sleepId])).rows.map(row => row.id)
    if (queued.length) await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=ANY($1::uuid[])`, [queued])
    result.skipped++
    return true
  }

  private async working(client: SqlClient, agentId: string): Promise<boolean> {
    return (await client.query(`SELECT 1 WHERE ${agentWorking('$1::uuid')}`, [agentId])).rows.length > 0
  }
}
