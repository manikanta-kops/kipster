import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { MAINTENANCE_SWEEP_JOB_ID, learningCondition } from './maintenance.js'
import { clockTime } from '../../protocol/schema.js'

export interface AgentLearning { agentId: string; enabled: boolean; sleepTime: string | null; revision: number; effective: boolean }
export interface LearningSettings { enabled: boolean; sleepTime: string; revision: number; available: boolean; agents: AgentLearning[] }
export interface LearningUpdate { enabled?: boolean | undefined; sleepTime?: string | undefined }
export interface AgentLearningUpdate { enabled?: boolean | undefined; sleepTime?: string | null | undefined }

/** Installation and per-agent learning switches and sleep times. An agent learns only while both switches are on
 * and the runtime has an embedding profile (`available`). It sleeps at its own sleep time, or at the installation
 * default ("HH:MM", host local time) when it has none. Changes are made by the owner or the admin agent, publish a `learning-changed`
 * application event and wake the maintenance sweep that applies them. */
export class LearningService {
  constructor(private readonly db: Postgres, private readonly jobs: Jobs, private readonly installationId: string, readonly available: boolean) {}

  async get(actor: AdminCaller): Promise<LearningSettings> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.requireOwner(client, actor)
      return this.read(client)
    })
  }

  async setInstallation(actor: AdminCaller, update: LearningUpdate): Promise<LearningSettings> {
    const { enabled, sleepTime: time } = learningUpdate(update, false)
    return this.db.transaction(async client => {
      await this.lockCapacity(client)
      await this.requireOwner(client, actor)
      if (enabled && !this.available) throw new Error('An embedding profile is required for learning')
      const changed = (await client.query<{ learning_revision: string; learning_enabled: boolean; sleep_time: string }>(
        `UPDATE kipster.installations SET learning_enabled=COALESCE($2, learning_enabled), sleep_time=COALESCE($3::time, sleep_time),
           learning_revision=learning_revision+1
         WHERE id=$1 AND (learning_enabled, sleep_time) IS DISTINCT FROM (COALESCE($2, learning_enabled), COALESCE($3::time, sleep_time))
         RETURNING learning_revision, learning_enabled, left(sleep_time::text, 5) AS sleep_time`,
        [this.installationId, enabled ?? null, time ?? null])).rows[0]
      if (changed) await this.changed(client, 'installation', this.installationId, Number(changed.learning_revision), changed.learning_enabled, changed.sleep_time)
      return this.read(client)
    })
  }

  async setAgent(actor: AdminCaller, agentId: string, update: AgentLearningUpdate): Promise<AgentLearning> {
    const { enabled, sleepTime: time } = learningUpdate(update, true)
    return this.db.transaction(async client => {
      await this.lockCapacity(client)
      await this.requireOwner(client, actor)
      const sleep = 'CASE WHEN $4 THEN $5::time ELSE sleep_time END'
      const changed = (await client.query<{ learning_revision: string; learning_enabled: boolean; sleep_time: string | null }>(
        `UPDATE kipster.agents SET learning_enabled=COALESCE($3, learning_enabled), sleep_time=${sleep}, learning_revision=learning_revision+1
         WHERE id=$1 AND installation_id=$2 AND kipster.live_agent(id)
           AND (learning_enabled, sleep_time) IS DISTINCT FROM (COALESCE($3, learning_enabled), ${sleep})
         RETURNING learning_revision, learning_enabled, left(sleep_time::text, 5) AS sleep_time`,
        [agentId, this.installationId, enabled ?? null, time !== undefined, time ?? null])).rows[0]
      if (changed) await this.changed(client, 'agent', agentId, Number(changed.learning_revision), changed.learning_enabled, changed.sleep_time)
      const [agent] = await this.agents(client, agentId)
      if (!agent) throw new Error('Agent not found')
      return agent
    })
  }

  /** Every learning gate reads the switches under the capacity lock, so a change linearizes with enqueue, claim, issue and commit. */
  private async lockCapacity(client: SqlClient): Promise<void> {
    await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])
  }

  /** The owner, or the admin agent from a live attempt. */
  private async requireOwner(client: SqlClient, actor: AdminCaller): Promise<void> {
    if (actor.installationId !== this.installationId) throw new Error('Owner access denied')
    await authorizeAdministration(client, actor)
  }

  private async changed(client: SqlClient, target: 'installation' | 'agent', resourceId: string, revision: number, enabled: boolean, sleepTime: string | null): Promise<void> {
    await publishAppEvent(client, this.installationId, 'learning-changed', resourceId, revision, { target, enabled, sleepTime })
    await this.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
  }

  private async read(client: SqlClient): Promise<LearningSettings> {
    const row = (await client.query<{ learning_enabled: boolean; sleep_time: string; learning_revision: string }>(
      'SELECT learning_enabled, left(sleep_time::text, 5) AS sleep_time, learning_revision FROM kipster.installations WHERE id=$1', [this.installationId])).rows[0]!
    return { enabled: row.learning_enabled, sleepTime: row.sleep_time, revision: Number(row.learning_revision), available: this.available, agents: await this.agents(client) }
  }

  private async agents(client: SqlClient, agentId?: string): Promise<AgentLearning[]> {
    const rows = await client.query<{ id: string; learning_enabled: boolean; sleep_time: string | null; learning_revision: string; learns: boolean }>(
      `SELECT a.id, a.learning_enabled, left(a.sleep_time::text, 5) AS sleep_time, a.learning_revision, ${learningCondition('a.id')} AS learns FROM kipster.agents a
       WHERE a.installation_id=$1 AND /* lifecycle visibility */ a.provisioned AND ($2::uuid IS NULL OR a.id=$2) ORDER BY a.display_name, a.id`,
      [this.installationId, agentId ?? null])
    return rows.rows.map(row => ({ agentId: row.id, enabled: row.learning_enabled, sleepTime: row.sleep_time, revision: Number(row.learning_revision), effective: this.available && row.learns }))
  }
}

/** Validates a learning change: a switch value, a sleep time ("HH:MM"; null clears an agent's own), or both. */
function learningUpdate(update: unknown, agent: boolean): { enabled?: boolean; sleepTime?: string | null } {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid learning update')
  const { enabled, sleepTime: time, ...rest } = update as Record<string, unknown>
  if (Object.keys(rest).length || (enabled === undefined && time === undefined)) throw new Error('Invalid learning update')
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid learning switch')
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(time === undefined ? {} : { sleepTime: time === null && agent ? null : sleepTime(time) }),
  }
}

const clock = clockTime()
function sleepTime(value: unknown): string {
  try { return clock.parse(value) } catch { throw new Error('Invalid sleep time') }
}
