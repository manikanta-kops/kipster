import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { HomeInstructionError, type Home, type HomeInstructions, type IdentityBackup, type IdentityFile, type IdentityFileName } from '../../platform/home/public.js'
import { authorizeAdministration, requireOrganizationMember, type AdminCaller, type TrustedActor } from '../identity/public.js'
import { applicationCursor, publishAppEvent } from '../synchronization/public.js'
import type { EffectiveSettings, ExecutionAdapter, ExecutionAdapters, SettingsRecord, SettingsSnapshot } from '../../protocol/admin.js'
export { readInterfacePreferences, writeInterfacePreferences } from './interface.js'
export { DEFAULT_PERMISSION_MODE, approvalGrantKeys, permissionModeFor, readPermissions, saveApprovalGrant, savePermissions, writePermissions } from './permissions.js'

export type Field = 'adapterId' | 'modelId' | 'effort' | 'options'
export type SettingsTarget = 'agent' | 'organization'
export type Settings = Partial<{ adapterId: string; modelId: string; effort: string; options: Record<string, unknown> }>
/** An omitted or undefined field is unchanged. */
export type Patch = { [K in Field]?: { set: unknown } | { clear: true } | undefined }
export interface Catalog {
  adapters: readonly { id: string; models: readonly { id: string; efforts?: readonly string[] }[]; defaultModel?: { id: string; effort?: string } }[]
  /** The adapter used when neither the agent nor its organization chooses one. */
  defaultAdapterId?: string | null
  complete: boolean
}
/** Where a setting comes from: the agent, its organization, or the default adapter and its default model. */
export type Source = 'organization' | 'agent' | 'default'
export type Resolution =
  | { status: 'ready' | 'unknown-catalog'; settings: Settings; source: Partial<Record<Field, Source>>; instructions: HomeInstructions }
  | { status: 'missing' | 'incompatible'; reason: string; settings: Settings; source: Partial<Record<Field, Source>> }

const fields: readonly Field[] = ['adapterId', 'modelId', 'effort', 'options']
/** Validates a settings patch into the fields to set and to clear. */
export function settingsChange(patch: Patch): { set: Record<string, unknown>; clear: string[] } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('Invalid settings patch')
  const set: Record<string, unknown> = {}, clear: string[] = []
  for (const [key, operation] of Object.entries(patch)) {
    if (operation === undefined) continue
    if (!fields.includes(key as Field)) throw new Error(`Unknown settings field: ${key}`)
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error(`Invalid setting operation: ${key}`)
    const keys = Object.keys(operation)
    if (keys.length !== 1 || (keys[0] !== 'set' && keys[0] !== 'clear')) throw new Error(`Invalid setting operation: ${key}`)
    if ('clear' in operation) {
      if (operation.clear !== true) throw new Error(`Invalid clear of setting: ${key}`)
      clear.push(key)
    } else if ('set' in operation) {
      const value = operation.set
      if (key === 'options') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid options')
      } else if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid setting: ${key}`)
      set[key] = value
    }
  }
  return { set, clear }
}
async function ownerExists(db: Postgres | SqlClient, actor: TrustedActor): Promise<void> {
  const found = await db.query('SELECT 1 FROM kipster.bootstrap WHERE owner_id=$1 AND installation_id=$2', [actor.personId, actor.installationId])
  if (!found.rows.length) throw new Error('Owner access denied')
}

// Saved settings are listed for agents that are not deleted and for active organizations.
const listed = { agent: "/* lifecycle visibility */ provisioned AND lifecycle IN ('active','archived')", organization: 'kipster.live_organization(id)' } as const
const tables = { agent: 'agents', organization: 'organizations' } as const

async function settingsRecords(client: Postgres | SqlClient, installationId: string, target: SettingsTarget, id: string | null = null): Promise<SettingsRecord[]> {
  const rows = await client.query<{ id: string; settings: Settings; settings_revision: string }>(
    `SELECT id, settings, settings_revision FROM kipster.${tables[target]} WHERE installation_id=$1 AND ${listed[target]} AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at, id`, [installationId, id])
  return rows.rows.map(row => ({ target, id: row.id, revision: Number(row.settings_revision), settings: row.settings }))
}

/** The saved settings of a listed agent or active organization. */
export async function settingsRecord(client: SqlClient, installationId: string, target: SettingsTarget, id: string): Promise<SettingsRecord | undefined> {
  return (await settingsRecords(client, installationId, target, id))[0]
}

/**
 * Publishes the saved settings of an agent or organization in the writer's transaction. Lock the
 * row and write first, then publish: publishing locks the installation's application stream until commit.
 */
export async function publishSettingsChange(client: SqlClient, installationId: string, target: SettingsTarget, id: string): Promise<void> {
  const record = await settingsRecord(client, installationId, target, id)
  if (record) await publishAppEvent(client, installationId, 'settings-changed', id, record.revision, record)
}

/** The saved settings and the application cursor to follow their changes from, read from one snapshot. */
export async function readSettings(db: Postgres, actor: AdminCaller): Promise<SettingsSnapshot> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    return {
      version: 1,
      cursor: await applicationCursor(client, actor.installationId),
      agents: await settingsRecords(client, actor.installationId, 'agent'),
      organizations: await settingsRecords(client, actor.installationId, 'organization'),
    }
  })
}

/**
 * The settings the agent's next execution would use in the organization, or in the installation when
 * `organizationId` is null, checked against the catalog. The agent need not be a member: a former
 * member's accepted work still runs with these settings.
 */
export async function effectiveSettings(db: Postgres, home: Home, actor: AdminCaller, agentId: string, organizationId: string | null, catalog: Catalog | null): Promise<EffectiveSettings> {
  await authorizeAdministration(db, actor)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const agent = uuid.test(agentId) && (await db.query(`SELECT 1 FROM kipster.agents WHERE id=$1 AND installation_id=$2 AND ${listed.agent}`, [agentId, actor.installationId])).rows.length > 0
  if (!agent) throw new Error('Agent not found')
  if (organizationId !== null) {
    const organization = uuid.test(organizationId) && (await db.query(`SELECT 1 FROM kipster.organizations WHERE id=$1 AND installation_id=$2 AND ${listed.organization}`, [organizationId, actor.installationId])).rows.length > 0
    if (!organization) throw new Error('Organization not found')
  }
  const resolved = await resolveAgentSettings(db, home, actor.installationId, agentId, organizationId, catalog)
  return { version: 1, agentId, organizationId, status: resolved.status, reason: 'reason' in resolved ? resolved.reason : null, settings: resolved.settings, sources: resolved.source }
}

/**
 * Replaces the installation's execution adapter list when it differs from the recorded one, and
 * publishes `adapters-changed` with the new revision in the same transaction.
 */
export async function recordAdapters(db: Postgres, installationId: string, adapters: readonly ExecutionAdapter[]): Promise<void> {
  await db.transaction(async client => {
    await client.query(`INSERT INTO kipster.execution_adapters(installation_id, revision, adapters) VALUES ($1, 0, '[]'::jsonb) ON CONFLICT DO NOTHING`, [installationId])
    const changed = (await client.query<{ revision: string }>(
      'UPDATE kipster.execution_adapters SET revision=revision+1, adapters=$2::jsonb WHERE installation_id=$1 AND (revision=0 OR adapters <> $2::jsonb) RETURNING revision',
      [installationId, JSON.stringify(adapters)])).rows[0]
    if (changed) await publishAppEvent(client, installationId, 'adapters-changed', installationId, Number(changed.revision), { adapters })
  })
}

/** The recorded execution adapters and the application cursor to follow their changes from. */
export async function readAdapters(db: Postgres, actor: AdminCaller): Promise<ExecutionAdapters> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    const row = (await client.query<{ revision: string; adapters: ExecutionAdapter[] }>('SELECT revision, adapters FROM kipster.execution_adapters WHERE installation_id=$1', [actor.installationId])).rows[0]
    return { version: 1, cursor: await applicationCursor(client, actor.installationId), revision: row ? Number(row.revision) : 0, adapters: row?.adapters ?? [] }
  })
}

/** Administration check for callers outside a transaction, such as an adapter refresh before it probes. */
export async function requireSettingsOwner(db: Postgres, actor: AdminCaller): Promise<void> {
  await authorizeAdministration(db, actor)
}

/** Identity files of a listed agent can be read; only a live agent's files change. */
async function ownedAgent(db: Postgres, actor: AdminCaller, agentId: string, write = false): Promise<void> {
  await authorizeAdministration(db, actor)
  const found = await db.query(`SELECT 1 FROM kipster.agents WHERE id=$1 AND installation_id=$2 AND ${write ? 'kipster.live_agent(id)' : listed.agent}`, [agentId, actor.installationId])
  if (!found.rows.length) throw new Error('Agent not found')
}
/** Tells clients the file changed. The file is content-addressed, so the event carries its hash and no revision. */
async function identityChanged(db: Postgres, installationId: string, agentId: string, saved: IdentityFile): Promise<IdentityFile> {
  await db.transaction(client => publishAppEvent(client, installationId, 'identity-changed', agentId, 0, { agentId, file: saved.file, sha256: saved.sha256 }))
  return saved
}
/** Administration access to an agent's identity files. Writes and restores are compare-and-swap and keep a backup. */
export async function readIdentityFile(db: Postgres, home: Home, actor: AdminCaller, agentId: string, file: IdentityFileName): Promise<IdentityFile> {
  await ownedAgent(db, actor, agentId)
  return home.identity.read(agentId, file)
}
export async function writeIdentityFile(db: Postgres, home: Home, actor: AdminCaller, agentId: string, file: IdentityFileName, content: string, expectedSha256: string): Promise<IdentityFile> {
  await ownedAgent(db, actor, agentId, true)
  return identityChanged(db, actor.installationId, agentId, await home.identity.write(agentId, file, content, expectedSha256, 'owner'))
}
export async function listIdentityBackups(db: Postgres, home: Home, actor: AdminCaller, agentId: string, file: IdentityFileName): Promise<IdentityBackup[]> {
  await ownedAgent(db, actor, agentId)
  return home.identity.listBackups(agentId, file)
}
export async function readIdentityBackup(db: Postgres, home: Home, actor: AdminCaller, agentId: string, file: IdentityFileName, backupId: string): Promise<IdentityFile> {
  await ownedAgent(db, actor, agentId)
  return home.identity.readBackup(agentId, file, backupId)
}
export async function restoreIdentityBackup(db: Postgres, home: Home, actor: AdminCaller, agentId: string, file: IdentityFileName, backupId: string, expectedSha256: string): Promise<IdentityFile> {
  await ownedAgent(db, actor, agentId, true)
  return identityChanged(db, actor.installationId, agentId, await home.identity.restore(agentId, file, backupId, expectedSha256))
}

export async function resolveSettings(db: Postgres, home: Home, actor: TrustedActor, agentId: string, organizationId: string | null, catalog: Catalog | null): Promise<Resolution> {
  await ownerExists(db, actor)
  if (organizationId) await requireOrganizationMember(db, actor, organizationId)
  return resolveAgentSettings(db, home, actor.installationId, agentId, organizationId, catalog)
}

/**
 * Current settings without caller auth. Text callers must use resolveSettings. `organizationId` is
 * the chat's organization: membership is checked when work is accepted, so accepted work keeps its
 * organization defaults after the agent leaves the organization.
 */
export async function resolveAgentSettings(db: Postgres, home: Home, installationId: string, agentId: string, organizationId: string | null, catalog: Catalog | null): Promise<Resolution> {
  const agent = (await db.query<{ settings: Settings; root: boolean }>(
    'SELECT a.settings, EXISTS(SELECT 1 FROM kipster.agent_roles r WHERE r.agent_id=a.id AND r.role=$3) AS root FROM kipster.agents a WHERE a.id=$1 AND a.installation_id=$2 AND /* lifecycle visibility */ a.provisioned',
    [agentId, installationId, 'root-admin'])).rows[0]
  if (!agent) throw new Error('Agent not available')
  let defaults: Settings = {}
  if (organizationId) {
    const org = (await db.query<{ settings: Settings }>('SELECT o.settings FROM kipster.organizations o WHERE o.id=$1 AND o.installation_id=$2 AND /* lifecycle visibility */ o.provisioned', [organizationId, installationId])).rows[0]
    if (!org) throw new Error('Organization not available')
    defaults = org.settings
  } else if (!agent.root) throw new Error('Organization required for ordinary agent')
  const settings: Settings = { ...defaults, ...agent.settings }
  const source: Partial<Record<Field, Source>> = {}
  for (const field of fields) {
    if (Object.hasOwn(defaults, field)) source[field] = 'organization'
    if (Object.hasOwn(agent.settings, field)) source[field] = 'agent'
  }
  if (!settings.adapterId && catalog?.defaultAdapterId) {
    settings.adapterId = catalog.defaultAdapterId
    source.adapterId = 'default'
  }
  const fallback = catalog?.adapters.find(x => x.id === settings.adapterId)?.defaultModel
  if (!settings.modelId && fallback) {
    settings.modelId = fallback.id
    source.modelId = 'default'
    if (!settings.effort && fallback.effort) {
      settings.effort = fallback.effort
      source.effort = 'default'
    }
  }
  if (!settings.adapterId || !settings.modelId) return { status: 'missing', reason: 'Adapter and model must be configured', settings, source }
  if (catalog?.complete) {
    const adapter = catalog.adapters.find(x => x.id === settings.adapterId)
    if (!adapter) return { status: 'incompatible', reason: 'Adapter is unavailable', settings, source }
    const model = adapter.models.find(x => x.id === settings.modelId)
    if (!model) return { status: 'incompatible', reason: 'Model is unavailable for adapter', settings, source }
    if (settings.effort && (!model.efforts || !model.efforts.includes(settings.effort))) return { status: 'incompatible', reason: 'Effort is unsupported for model', settings, source }
  }
  try {
    const instructions = await home.instructions(agentId, organizationId ?? undefined)
    return { status: catalog?.complete ? 'ready' : 'unknown-catalog', settings, source, instructions }
  } catch (error) {
    if (error instanceof HomeInstructionError) return { status: 'missing', reason: error.message, settings, source }
    throw error
  }
}
