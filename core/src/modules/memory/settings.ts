import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import type { Catalog } from '../settings/public.js'
import { clockTime } from '../../protocol/schema.js'

/** The model the nightly run uses instead of the admin kip's. */
export interface NightlyModel { adapterId: string; modelId: string; effort?: string }
export interface AgentLearning { agentId: string; enabled: boolean; sleepTime: string | null; revision: number; effective: boolean }
export interface LearningSettings {
  enabled: boolean; sleepTime: string; revision: number; available: boolean; agents: AgentLearning[]
  /** Null runs the nightly steps with the admin kip's model. */
  nightlyModel: NightlyModel | null
  coreCardCount: number; searchCardCount: number; searchChunkCount: number
}
export interface LearningUpdate {
  enabled?: boolean | undefined; sleepTime?: string | undefined; nightlyModel?: { adapterId: string; modelId: string; effort?: string | undefined } | null | undefined
  coreCardCount?: number | undefined; searchCardCount?: number | undefined; searchChunkCount?: number | undefined
}
export interface AgentLearningUpdate { enabled?: boolean | undefined; sleepTime?: string | null | undefined }
/** The installation's memory limits and nightly model, read by the nightly run and each turn. */
export interface MemorySettings { nightlyModel: NightlyModel | null; coreCardCount: number; searchCardCount: number; searchChunkCount: number }

/** Bounds of the count settings, inclusive. Counts are whole items: core cards on every turn, and cards and thread
 * chunks from a turn's meaning search. */
export const MEMORY_LIMITS = {
  coreCardCount: { min: 0, max: 200, default: 60 },
  searchCardCount: { min: 0, max: 50, default: 10 },
  searchChunkCount: { min: 0, max: 30, default: 6 },
} as const
type Count = keyof typeof MEMORY_LIMITS
const counts = Object.keys(MEMORY_LIMITS) as Count[]

/** SQL condition that holds while the agent in `agentColumn` has memory on: both switches are on and the agent is live. */
export function learningCondition(agentColumn: string): string {
  return `EXISTS (SELECT 1 FROM kipster.agents la JOIN kipster.installations li ON li.id = la.installation_id
    WHERE la.id = ${agentColumn} AND la.learning_enabled AND li.learning_enabled AND kipster.live_agent(la.id))`
}

/** Reads the installation's memory settings. */
export async function memorySettings(client: Postgres | SqlClient, installationId: string): Promise<MemorySettings> {
  const row = (await client.query<{ nightly_model: NightlyModel | null; core_card_count: number; search_card_count: number; search_chunk_count: number }>(
    'SELECT nightly_model, core_card_count, search_card_count, search_chunk_count FROM kipster.installations WHERE id=$1', [installationId])).rows[0]
  if (!row) throw new Error('Installation not found')
  return { nightlyModel: row.nightly_model, coreCardCount: row.core_card_count, searchCardCount: row.search_card_count, searchChunkCount: row.search_chunk_count }
}

/** Installation and per-agent memory switches and sleep times, and the installation's nightly model and memory counts.
 * An agent has memory while both switches are on; memory works without an embedding provider, and `available` only
 * reports whether one is configured for meaning search. The agent sleeps at its own sleep time, or at the installation
 * default ("HH:MM", host local time) when it has none. Changes are made by the owner or the admin agent and publish a
 * `learning-changed` application event. */
export class LearningService {
  constructor(private readonly db: Postgres, private readonly installationId: string, readonly available: boolean) {}

  async get(actor: AdminCaller): Promise<LearningSettings> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await this.requireOwner(client, actor)
      return this.read(client)
    })
  }

  /** `catalog`, when known and complete, must list a nightly model's adapter, model and effort. */
  async setInstallation(actor: AdminCaller, update: LearningUpdate, catalog: Catalog | null = null): Promise<LearningSettings> {
    const change = learningUpdate(update, false)
    if (change.nightlyModel) checkCatalog(change.nightlyModel, catalog)
    return this.db.transaction(async client => {
      await this.lockCapacity(client)
      await this.requireOwner(client, actor)
      const values = [this.installationId, change.enabled ?? null, change.sleepTime ?? null, change.nightlyModel !== undefined,
        change.nightlyModel ? JSON.stringify(change.nightlyModel) : null, ...counts.map(key => change[key] ?? null)]
      const model = 'CASE WHEN $4 THEN $5::jsonb ELSE nightly_model END'
      const next = `(COALESCE($2, learning_enabled), COALESCE($3::time, sleep_time), ${model}, COALESCE($6, core_card_count), COALESCE($7, search_card_count), COALESCE($8, search_chunk_count))`
      const changed = (await client.query<{ learning_revision: string; learning_enabled: boolean; sleep_time: string; nightly_model: NightlyModel | null; core_card_count: number; search_card_count: number; search_chunk_count: number }>(
        `UPDATE kipster.installations SET learning_enabled=COALESCE($2, learning_enabled), sleep_time=COALESCE($3::time, sleep_time), nightly_model=${model},
           core_card_count=COALESCE($6, core_card_count), search_card_count=COALESCE($7, search_card_count), search_chunk_count=COALESCE($8, search_chunk_count),
           learning_revision=learning_revision+1
         WHERE id=$1 AND (learning_enabled, sleep_time, nightly_model, core_card_count, search_card_count, search_chunk_count) IS DISTINCT FROM ${next}
         RETURNING learning_revision, learning_enabled, left(sleep_time::text, 5) AS sleep_time, nightly_model, core_card_count, search_card_count, search_chunk_count`,
        values)).rows[0]
      if (changed) {
        await publishAppEvent(client, this.installationId, 'learning-changed', this.installationId, Number(changed.learning_revision), {
          target: 'installation', enabled: changed.learning_enabled, sleepTime: changed.sleep_time, nightlyModel: changed.nightly_model,
          coreCardCount: changed.core_card_count, searchCardCount: changed.search_card_count, searchChunkCount: changed.search_chunk_count,
        })
      }
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
      if (changed) await publishAppEvent(client, this.installationId, 'learning-changed', agentId, Number(changed.learning_revision), { target: 'agent', enabled: changed.learning_enabled, sleepTime: changed.sleep_time })
      const [agent] = await this.agents(client, agentId)
      if (!agent) throw new Error('Agent not found')
      return agent
    })
  }

  /** Switch changes take the capacity lock, so they linearize with the work that reads them. */
  private async lockCapacity(client: SqlClient): Promise<void> {
    await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])
  }

  /** The owner, or the admin agent from a live attempt. */
  private async requireOwner(client: SqlClient, actor: AdminCaller): Promise<void> {
    if (actor.installationId !== this.installationId) throw new Error('Owner access denied')
    await authorizeAdministration(client, actor)
  }

  private async read(client: SqlClient): Promise<LearningSettings> {
    const row = (await client.query<{ learning_enabled: boolean; sleep_time: string; learning_revision: string }>(
      'SELECT learning_enabled, left(sleep_time::text, 5) AS sleep_time, learning_revision FROM kipster.installations WHERE id=$1', [this.installationId])).rows[0]!
    return { enabled: row.learning_enabled, sleepTime: row.sleep_time, revision: Number(row.learning_revision), available: this.available, agents: await this.agents(client), ...await memorySettings(client, this.installationId) }
  }

  private async agents(client: SqlClient, agentId?: string): Promise<AgentLearning[]> {
    const rows = await client.query<{ id: string; learning_enabled: boolean; sleep_time: string | null; learning_revision: string; learns: boolean }>(
      `SELECT a.id, a.learning_enabled, left(a.sleep_time::text, 5) AS sleep_time, a.learning_revision, ${learningCondition('a.id')} AS learns FROM kipster.agents a
       WHERE a.installation_id=$1 AND /* lifecycle visibility */ a.provisioned AND ($2::uuid IS NULL OR a.id=$2) ORDER BY a.display_name, a.id`,
      [this.installationId, agentId ?? null])
    return rows.rows.map(row => ({ agentId: row.id, enabled: row.learning_enabled, sleepTime: row.sleep_time, revision: Number(row.learning_revision), effective: row.learns }))
  }
}

type Change = { enabled?: boolean; sleepTime?: string | null; nightlyModel?: NightlyModel | null } & Partial<Record<Count, number>>
/** Validates a learning change: a switch value, a sleep time ("HH:MM"; null clears an agent's own), and for the
 * installation the nightly model (null for the admin kip's) and the counts. At least one field changes. */
function learningUpdate(update: unknown, agent: boolean): Change {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid learning update')
  const { enabled, sleepTime: time, ...rest } = update as Record<string, unknown>
  const own = agent ? [] : ['nightlyModel', ...counts]
  const extra = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
  if (Object.keys(extra).some(key => !own.includes(key)) || (enabled === undefined && time === undefined && !Object.keys(extra).length)) throw new Error('Invalid learning update')
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Invalid learning switch')
  const change: Change = {
    ...(enabled === undefined ? {} : { enabled }),
    ...(time === undefined ? {} : { sleepTime: time === null && agent ? null : sleepTime(time) }),
  }
  if (Object.hasOwn(extra, 'nightlyModel')) change.nightlyModel = extra.nightlyModel === null ? null : nightlyModel(extra.nightlyModel)
  for (const key of counts) {
    if (!Object.hasOwn(extra, key)) continue
    const value = extra[key], { min, max } = MEMORY_LIMITS[key]
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${key}: a whole number from ${min} to ${max}`)
    change[key] = value as number
  }
  return change
}

function nightlyModel(value: unknown): NightlyModel {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const text = (field: unknown) => typeof field === 'string' && field.trim() !== '' && field.length <= 200
  if (!row || Object.keys(row).some(key => !['adapterId', 'modelId', 'effort'].includes(key)) || !text(row.adapterId) || !text(row.modelId) || (row.effort !== undefined && !text(row.effort))) throw new Error('Invalid nightly model')
  return { adapterId: row.adapterId as string, modelId: row.modelId as string, ...(row.effort === undefined ? {} : { effort: row.effort as string }) }
}

/** Checks a nightly model against a complete catalog, as execution settings are resolved. */
export function checkCatalog(model: NightlyModel, catalog: Catalog | null): void {
  if (!catalog?.complete) return
  const adapter = catalog.adapters.find(item => item.id === model.adapterId)
  if (!adapter) throw new Error('Invalid nightly model: the adapter is unavailable')
  const listed = adapter.models.find(item => item.id === model.modelId)
  if (!listed) throw new Error('Invalid nightly model: the model is unavailable for the adapter')
  if (model.effort && !listed.efforts?.includes(model.effort)) throw new Error('Invalid nightly model: the effort is unsupported for the model')
}

const clock = clockTime()
function sleepTime(value: unknown): string {
  try { return clock.parse(value) } catch { throw new Error('Invalid sleep time') }
}
