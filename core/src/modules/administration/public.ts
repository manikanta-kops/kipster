import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { HomeInstructionError, type Home, type IdentityFileName } from '../../platform/home/public.js'
import { authorizeAdministration, isAgentCaller, isLive, type AdminAuthority, type AdminCaller, type Bootstrap } from '../identity/public.js'
import { publishSettingsChange, settingsChange, settingsRecord, type Patch, type SettingsTarget } from '../settings/public.js'
import { notifyThread, applicationCursor, publishAppEvent } from '../synchronization/public.js'
import { fenceAffectedWork, lockInstallation } from '../work/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import type { DirectoryAgent, DirectoryGroup, DirectoryMembership, DirectoryOrganization, DirectorySnapshot, SettingsRecord } from '../../protocol/admin.js'
import { claimOperation, completeOperation, lockOperation, operationStatus, pendingOperations, OperationConflictError, type OperationKey, type OperationStatus } from './operations.js'

export { OperationConflictError, claimOperation, lockOperation, openOperations, recordStep, recordStepError, type Operation, type OperationKey, type OperationStatus, type StepOutcome } from './operations.js'
export type DirectoryResource = 'organization' | 'agent' | 'membership' | 'group'

// The directory lists provisioned agents in every lifecycle, including deleted ones, and
// provisioned organizations that are not deleted. Memberships and groups are listed only for
// active organizations; clients drop an organization's children when it leaves `active`.
const listedOrganization = '/* lifecycle visibility */ o.provisioned AND o.lifecycle <> \'deleted\''
const activeOrganization = 'kipster.live_organization(o.id)'

async function organizations(client: SqlClient, installationId: string, id: string | null = null): Promise<DirectoryOrganization[]> {
  const rows = await client.query<{ id: string; display_name: string; description: string; lifecycle: DirectoryOrganization['lifecycle']; revision: string; created_at: Date }>(
    `SELECT o.id, o.display_name, o.description, o.lifecycle, o.revision, o.created_at FROM kipster.organizations o
     WHERE o.installation_id=$1 AND ${listedOrganization} AND ($2::uuid IS NULL OR o.id=$2) ORDER BY o.created_at, o.id`, [installationId, id])
  return rows.rows.map(row => ({ id: row.id, name: row.display_name, description: row.description, lifecycle: row.lifecycle, revision: Number(row.revision), createdAt: row.created_at.toISOString() }))
}

async function agents(client: SqlClient, installationId: string, id: string | null = null): Promise<DirectoryAgent[]> {
  const rows = await client.query<{ id: string; display_name: string; description: string; lifecycle: DirectoryAgent['lifecycle']; admin: boolean; revision: string; created_at: Date; deleted_at: Date | null }>(
    `SELECT a.id, a.display_name, a.description, a.lifecycle, a.revision, a.created_at, a.deleted_at,
       EXISTS (SELECT 1 FROM kipster.agent_roles r WHERE r.agent_id=a.id AND r.role='root-admin') AS admin
     FROM kipster.agents a WHERE a.installation_id=$1 AND /* lifecycle visibility */ a.provisioned AND ($2::uuid IS NULL OR a.id=$2) ORDER BY a.display_name, a.id`, [installationId, id])
  return rows.rows.map(row => ({ id: row.id, name: row.display_name, description: row.description, lifecycle: row.lifecycle, admin: row.admin, revision: Number(row.revision), createdAt: row.created_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null }))
}

async function memberships(client: SqlClient, installationId: string, id: string | null = null): Promise<DirectoryMembership[]> {
  const rows = await client.query<{ id: string; organization_id: string; agent_id: string; revision: string; created_at: Date }>(
    `SELECT m.id, m.organization_id, m.agent_id, m.revision, m.created_at FROM kipster.agent_memberships m
     JOIN kipster.organizations o ON o.id=m.organization_id JOIN kipster.agents a ON a.id=m.agent_id
     WHERE o.installation_id=$1 AND ${activeOrganization} AND /* lifecycle visibility */ a.provisioned AND ($2::uuid IS NULL OR m.id=$2)
     ORDER BY o.created_at, m.organization_id, m.created_at, m.id`, [installationId, id])
  return rows.rows.map(row => ({ id: row.id, organizationId: row.organization_id, agentId: row.agent_id, revision: Number(row.revision), createdAt: row.created_at.toISOString() }))
}

async function groups(client: SqlClient, installationId: string, id: string | null = null): Promise<DirectoryGroup[]> {
  const rows = await client.query<{ id: string; organization_id: string; name: string; position: number; revision: string; appearances: DirectoryGroup['appearances'] }>(
    `SELECT g.id, g.organization_id, g.name, g.position, g.revision,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('membershipId', m.id, 'agentId', m.agent_id) ORDER BY x.position, m.id)
         FROM kipster.group_appearances x JOIN kipster.agent_memberships m ON m.id=x.membership_id JOIN kipster.agents a ON a.id=m.agent_id
         WHERE x.group_id=g.id AND /* lifecycle visibility */ a.provisioned), '[]'::jsonb) AS appearances
     FROM kipster.groups g JOIN kipster.organizations o ON o.id=g.organization_id
     WHERE o.installation_id=$1 AND ${activeOrganization} AND ($2::uuid IS NULL OR g.id=$2)
     ORDER BY o.created_at, g.organization_id, g.position, g.id`, [installationId, id])
  return rows.rows.map(row => ({ id: row.id, organizationId: row.organization_id, name: row.name, position: row.position, revision: Number(row.revision), appearances: row.appearances }))
}

/** The directory and the application cursor to follow its changes from, read from one snapshot. */
export async function readDirectory(db: Postgres, actor: AdminCaller): Promise<DirectorySnapshot> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    return {
      version: 1,
      cursor: await applicationCursor(client, actor.installationId),
      organizations: await organizations(client, actor.installationId),
      agents: await agents(client, actor.installationId),
      memberships: await memberships(client, actor.installationId),
      groups: await groups(client, actor.installationId),
    }
  })
}

const readers = { organization: organizations, agent: agents, membership: memberships, group: groups }

/**
 * Publishes the resource's current directory record in the writer's transaction. A resource the
 * directory does not list publishes nothing. Take every row lock the change needs first and
 * publish last: publishing locks the installation's application stream until commit.
 */
export async function publishDirectoryChange(client: SqlClient, installationId: string, kind: DirectoryResource, id: string): Promise<void> {
  const [record] = await readers[kind](client, installationId, id)
  if (record) await publishAppEvent(client, installationId, `${kind}-changed`, id, record.revision, record)
  if (record && 'lifecycle' in record && ['deleting','deleted'].includes(record.lifecycle) && (kind === 'organization' || kind === 'agent')) {
    const threads = await client.query<{ id: string }>(`SELECT t.id FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id
      WHERE c.installation_id=$1 AND ${kind === 'agent' ? 'c.agent_id=$2' : "c.context_kind='organization' AND c.context_id=$2"}`, [installationId, id])
    for (const thread of threads.rows) await notifyThread(client, thread.id)
  }
}

/**
 * Publishes that a listed organization, membership or group leaves the directory, with the revision
 * after its last one. Call it while the record is still listed and after locking every row the
 * removal touches; then remove the rows. Agents are never removed; they are tombstoned.
 */
export async function publishDirectoryRemoval(client: SqlClient, installationId: string, kind: Exclude<DirectoryResource, 'agent'>, id: string): Promise<void> {
  const [record] = await readers[kind](client, installationId, id)
  if (!record) return
  const data = 'agentId' in record ? { id, organizationId: record.organizationId, agentId: record.agentId }
    : 'organizationId' in record ? { id, organizationId: record.organizationId } : { id }
  await publishAppEvent(client, installationId, `${kind}-removed`, id, record.revision + 1, data)
}

export type Lifecycle = 'active' | 'archived' | 'deleting' | 'deleted'

/**
 * Changes an agent's or organization's lifecycle in the caller's transaction and publishes the record.
 * The capacity lock comes first, then the row is locked FOR UPDATE: a writer holds its owner FOR KEY
 * SHARE, so it committed before the change or sees it. A row leaving `active` has its work fenced in
 * the same transaction. Returns the previous lifecycle and the attempts whose adapter should cancel,
 * or null for an unknown row.
 */
export async function changeLifecycle(client: SqlClient, jobs: Jobs, installationId: string, kind: 'agent' | 'organization', id: string, lifecycle: Lifecycle, failure: string): Promise<{ previous: Lifecycle; cancelAttempts: string[] } | null> {
  if (!uuid.test(id)) return null
  await lockInstallation(client, installationId)
  const row = (await client.query<{ lifecycle: Lifecycle }>(`SELECT lifecycle FROM kipster.${tables[kind]} WHERE id=$1 AND installation_id=$2 FOR UPDATE`, [id, installationId])).rows[0]
  if (!row) return null
  if (row.lifecycle !== lifecycle) {
    await client.query(`UPDATE kipster.${tables[kind]} SET lifecycle=$2, revision=revision+1, deleted_at=CASE WHEN $2='deleted' THEN now() END WHERE id=$1`, [id, lifecycle])
  }
  const fenced = lifecycle === 'active' ? { cancelAttempts: [] } : await fenceAffectedWork(client, jobs, installationId, kind === 'agent' ? { agentId: id } : { organizationId: id }, failure)
  if (row.lifecycle !== lifecycle) await publishDirectoryChange(client, installationId, kind, id)
  return { previous: row.lifecycle, cancelAttempts: fenced.cancelAttempts }
}

// Administration writes. Every request carries an operation ID, and a repeat returns the result
// recorded the first time. A creation records the IDs it plans and inserts its rows unprovisioned
// in one transaction, then seeds the home and marks the rows provisioned. A retry or the startup
// sweep finishes an interrupted creation with the recorded IDs.

export interface OrganizationFields { name: string; description?: string; settings?: Patch }
export interface AgentFields { name: string; description?: string; settings?: Patch; organizationId?: string }
export interface Changes { name?: string; description?: string; settings?: Patch }
export type Applied<T> = T & { alreadyApplied: boolean }
export interface OrganizationResult { organization: DirectoryOrganization }
export interface AgentCreateResult { agent: DirectoryAgent; membership: DirectoryMembership | null }
export interface AgentResult { agent: DirectoryAgent }

const creations = ['organization.create', 'agent.create'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const names = { organization: 'Organization', agent: 'Agent', membership: 'Membership', group: 'Group' } as const
const tables = { organization: 'organizations', agent: 'agents' } as const
export const operationKey = (actor: AdminCaller, authority: AdminAuthority, operationId: string): OperationKey => ({ installationId: actor.installationId, actorKind: authority.actorKind, actorId: authority.actorId, operationId, ...(isAgentCaller(actor) ? { attemptId: actor.attemptId } : {}) })

/** Requires a live agent or organization of the installation, optionally locking its row first. */
async function requireLive(client: SqlClient, kind: 'organization' | 'agent', installationId: string, id: string, lock: '' | 'FOR SHARE' | 'FOR NO KEY UPDATE' | 'FOR UPDATE'): Promise<void> {
  if (uuid.test(id) && lock) await client.query(`SELECT 1 FROM kipster.${tables[kind]} WHERE id=$1 AND installation_id=$2 ${lock}`, [id, installationId])
  if (!await isLive(client, installationId, kind, id, false)) throw new Error(`${names[kind]} not found`)
}

/** Initial content of an agent's identity files; a file left out starts with only a heading. */
export type AgentFiles = Partial<Record<IdentityFileName, string>>

/** What a new installation starts with besides its owner, first organization and admin agent. */
export interface Starter {
  organization: { description: string; instructions: string }
  rootAgent: { description: string; files: AgentFiles }
  /** Agents of the first organization. `key` names the agent in `groups` and in its creation's operation ID. */
  agents: readonly { key: string; name: string; description: string; files: AgentFiles }[]
  /** Groups of the first organization, in order, each listing its agents' keys in order. */
  groups: readonly { name: string; agents: readonly string[] }[]
}

type BootstrapRow = { installation_id: string; owner_id: string; initial_organization_id: string; root_agent_id: string }
const bootstrapIds = (row: BootstrapRow): Bootstrap => ({ installationId: row.installation_id, ownerId: row.owner_id, organizationId: row.initial_organization_id, rootAgentId: row.root_agent_id })

/**
 * Creates the installation on its first start: the owner, the first organization and the admin agent,
 * and with `starter`, its agents and groups. Later starts return the recorded IDs and only seed files
 * that are missing. Starter agents are recorded as pending creations in the same transaction, so
 * finishPendingCreations provisions them, also after an interrupted first start.
 */
export async function bootstrap(db: Postgres, home: Home, names: { owner: string; organization: string; rootAgent: string }, starter?: Starter): Promise<Bootstrap> {
  const ids = await db.transaction(async client => {
    const existing = (await client.query<BootstrapRow>('SELECT * FROM kipster.bootstrap')).rows[0]
    if (existing) return bootstrapIds(existing)
    // Serialize concurrent first starts without creating a synthetic owner/agent singleton.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [78315, 5])
    const afterLock = (await client.query<BootstrapRow>('SELECT * FROM kipster.bootstrap')).rows[0]
    if (afterLock) return bootstrapIds(afterLock)
    const installationId = randomUUID(), ownerId = randomUUID(), organizationId = randomUUID(), rootAgentId = randomUUID()
    await client.query('INSERT INTO kipster.installations(id) VALUES ($1)', [installationId])
    await client.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [ownerId, installationId, names.owner])
    await client.query('INSERT INTO kipster.agents(id, installation_id, display_name, description) VALUES ($1,$2,$3,$4)', [rootAgentId, installationId, names.rootAgent, starter?.rootAgent.description ?? ''])
    await client.query('INSERT INTO kipster.agent_roles VALUES ($1,$2)', [rootAgentId, 'root-admin'])
    await client.query('INSERT INTO kipster.organizations(id, installation_id, display_name, description) VALUES ($1,$2,$3,$4)', [organizationId, installationId, names.organization, starter?.organization.description ?? ''])
    await client.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [organizationId, ownerId])
    await client.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [organizationId, rootAgentId])
    await client.query('INSERT INTO kipster.bootstrap VALUES ($1,$2,$3,$4)', [installationId, ownerId, organizationId, rootAgentId])
    if (starter) await recordStarter(client, installationId, ownerId, organizationId, starter)
    return { installationId, ownerId, organizationId, rootAgentId }
  })
  await home.initialize(ids.installationId)
  await provisionLive(db, 'agents', ids.rootAgentId, () => home.provisionAgent(ids.rootAgentId, starter?.rootAgent.files))
  await provisionLive(db, 'organizations', ids.organizationId, () => home.provisionOrganization(ids.organizationId, starter?.organization.instructions))
  return ids
}

/** Records the starter agents as the owner's pending creations, with their memberships, groups and appearances. */
async function recordStarter(client: SqlClient, installationId: string, ownerId: string, organizationId: string, starter: Starter): Promise<void> {
  const memberships = new Map<string, string>()
  for (const agent of starter.agents) {
    const fields = { name: agent.name, description: agent.description, organizationId }
    const membershipId = randomUUID()
    const key: OperationKey = { installationId, actorKind: 'person', actorId: ownerId, operationId: `starter:${agent.key}` }
    const { operation } = await claimOperation(client, key, 'agent.create', { kind: 'agent', id: randomUUID() }, { ...fields, membershipId, files: agent.files }, { kind: 'agent.create', fields })
    await client.query('INSERT INTO kipster.agents(id, installation_id, display_name, description) VALUES ($1,$2,$3,$4)', [operation.targetId, installationId, agent.name, agent.description])
    await client.query('INSERT INTO kipster.agent_memberships(id, organization_id, agent_id) VALUES ($1,$2,$3)', [membershipId, organizationId, operation.targetId])
    memberships.set(agent.key, membershipId)
  }
  for (const [position, group] of starter.groups.entries()) {
    const groupId = randomUUID()
    await client.query('INSERT INTO kipster.groups(id, organization_id, name, position) VALUES ($1,$2,$3,$4)', [groupId, organizationId, group.name, position])
    for (const [index, agentKey] of group.agents.entries()) {
      const membershipId = memberships.get(agentKey)
      if (!membershipId) throw new Error(`Unknown starter agent: ${agentKey}`)
      await client.query('INSERT INTO kipster.group_appearances(group_id, membership_id, organization_id, position) VALUES ($1,$2,$3,$4)', [groupId, membershipId, organizationId, index])
    }
  }
}

/** Seeds the home of an active row and marks it provisioned. Other rows, such as a deleted organization, get no home. */
async function provisionLive(db: Postgres, table: 'agents' | 'organizations', id: string, seed: () => Promise<void>): Promise<void> {
  await db.transaction(async client => {
    const live = await client.query(`SELECT 1 FROM kipster.${table} WHERE id=$1 AND lifecycle='active' FOR NO KEY UPDATE`, [id])
    if (!live.rows.length) return
    await seed()
    await client.query(`UPDATE kipster.${table} SET provisioned=true WHERE id=$1 AND NOT provisioned`, [id])
  })
}

/** Seeds the home of a recorded creation, marks its rows provisioned, publishes them and records the result. */
async function finishCreation(db: Postgres, home: Home, operationId: string): Promise<unknown> {
  return db.transaction(async client => {
    const operation = await lockOperation(client, operationId)
    if (operation.state === 'succeeded') return operation.result
    const { installationId, targetId } = operation
    let result: OrganizationResult | AgentCreateResult
    if (operation.kind === 'organization.create') {
      await home.provisionOrganization(targetId)
      await client.query('UPDATE kipster.organizations SET provisioned=true WHERE id=$1', [targetId])
      await publishDirectoryChange(client, installationId, 'organization', targetId)
      await publishSettingsChange(client, installationId, 'organization', targetId)
      result = { organization: (await organizations(client, installationId, targetId))[0]! }
    } else if (operation.kind === 'agent.create') {
      await home.provisionAgent(targetId, operation.options.files as AgentFiles | undefined)
      await client.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1', [targetId])
      await publishDirectoryChange(client, installationId, 'agent', targetId)
      await publishSettingsChange(client, installationId, 'agent', targetId)
      // Memberships of an unprovisioned agent are not listed, so they appear now.
      const joined = await client.query<{ id: string }>('SELECT id FROM kipster.agent_memberships WHERE agent_id=$1 ORDER BY created_at, id', [targetId])
      for (const row of joined.rows) await publishDirectoryChange(client, installationId, 'membership', row.id)
      const membershipId = operation.options.membershipId
      result = { agent: (await agents(client, installationId, targetId))[0]!, membership: typeof membershipId === 'string' ? (await memberships(client, installationId, membershipId))[0] ?? null : null }
    } else throw new Error(`Unknown operation kind: ${operation.kind}`)
    await completeOperation(client, operationId, result)
    return result
  })
}

/** Creates an organization with the owner as a member, its default settings and a seeded home. */
export async function createOrganization(db: Postgres, home: Home, actor: AdminCaller, operationId: string, fields: OrganizationFields): Promise<Applied<OrganizationResult>> {
  const settings = settingsChange(fields.settings ?? {}).set
  const { operation, claimed } = await db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const claim = await claimOperation(client, operationKey(actor, authority, operationId), 'organization.create', { kind: 'organization', id: randomUUID() }, { ...fields }, { kind: 'organization.create', fields })
    if (claim.claimed) {
      const id = claim.operation.targetId
      await client.query('INSERT INTO kipster.organizations(id, installation_id, display_name, description, settings) VALUES ($1,$2,$3,$4,$5::jsonb)', [id, actor.installationId, fields.name, fields.description ?? '', JSON.stringify(settings)])
      await client.query('INSERT INTO kipster.human_memberships(organization_id, person_id) VALUES ($1,$2)', [id, authority.ownerId])
    }
    return claim
  })
  return { ...await finishCreation(db, home, operation.id) as OrganizationResult, alreadyApplied: !claimed }
}

/** Creates a global agent with its settings and a seeded home; `organizationId` also adds it to that organization. */
export async function createAgent(db: Postgres, home: Home, actor: AdminCaller, operationId: string, fields: AgentFields): Promise<Applied<AgentCreateResult>> {
  const settings = settingsChange(fields.settings ?? {}).set
  const { operation, claimed } = await db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const membershipId = fields.organizationId === undefined ? undefined : randomUUID()
    const claim = await claimOperation(client, operationKey(actor, authority, operationId), 'agent.create', { kind: 'agent', id: randomUUID() }, { ...fields, ...(membershipId ? { membershipId } : {}) }, { kind: 'agent.create', fields })
    if (claim.claimed) {
      const id = claim.operation.targetId
      await client.query('INSERT INTO kipster.agents(id, installation_id, display_name, description, settings) VALUES ($1,$2,$3,$4,$5::jsonb)', [id, actor.installationId, fields.name, fields.description ?? '', JSON.stringify(settings)])
      if (fields.organizationId !== undefined) {
        await requireLive(client, 'organization', actor.installationId, fields.organizationId, 'FOR SHARE')
        await client.query('INSERT INTO kipster.agent_memberships(id, organization_id, agent_id) VALUES ($1,$2,$3)', [membershipId, fields.organizationId, id])
      }
    }
    return claim
  })
  return { ...await finishCreation(db, home, operation.id) as AgentCreateResult, alreadyApplied: !claimed }
}

/** Applies a validated change to a locked live row. Name and description bump the directory revision, settings the settings revision. */
async function applyChanges(client: SqlClient, installationId: string, kind: 'organization' | 'agent', id: string, changes: Changes, settings: { set: Record<string, unknown>; clear: string[] }): Promise<void> {
  const metadata = changes.name !== undefined || changes.description !== undefined
  const settingsChanged = settings.clear.length > 0 || Object.keys(settings.set).length > 0
  await client.query(`UPDATE kipster.${tables[kind]} SET display_name=COALESCE($2, display_name), description=COALESCE($3, description),
    settings=(settings - $4::text[]) || $5::jsonb, revision=revision + $6, settings_revision=settings_revision + $7 WHERE id=$1`,
    [id, changes.name ?? null, changes.description ?? null, settings.clear, JSON.stringify(settings.set), metadata ? 1 : 0, settingsChanged ? 1 : 0])
  if (metadata) await publishDirectoryChange(client, installationId, kind, id)
  if (settingsChanged) await publishSettingsChange(client, installationId, kind, id)
}

function validChanges(changes: Changes): { set: Record<string, unknown>; clear: string[] } {
  const settings = settingsChange(changes.settings ?? {})
  if (changes.name === undefined && changes.description === undefined && !settings.clear.length && !Object.keys(settings.set).length) throw new Error('Invalid empty update')
  return settings
}

async function update<T>(db: Postgres, actor: AdminCaller, operationId: string, kind: 'organization' | 'agent', id: string, changes: Changes): Promise<Applied<T>> {
  const settings = validChanges(changes)
  return operate(db, actor, operationId, `${kind}.update`, { kind, id }, { ...changes }, async client => {
    await requireLive(client, kind, actor.installationId, id, 'FOR NO KEY UPDATE')
    await applyChanges(client, actor.installationId, kind, id, changes, settings)
    return { [kind]: (await readers[kind](client, actor.installationId, id))[0]! } as T
  })
}

export interface SettingsResult { settings: SettingsRecord }

/**
 * Sets or clears saved execution settings of an agent, including the admin agent, or of an
 * organization. An omitted field is unchanged; clearing an agent's field restores the inherited value.
 */
export async function changeSettings(db: Postgres, actor: AdminCaller, operationId: string, target: SettingsTarget, id: string, patch: Patch): Promise<Applied<SettingsResult>> {
  const settings = validChanges({ settings: patch })
  return operate(db, actor, operationId, `${target}.settings`, { kind: target, id }, { settings: patch }, async client => {
    await requireLive(client, target, actor.installationId, id, 'FOR NO KEY UPDATE')
    await applyChanges(client, actor.installationId, target, id, {}, settings)
    return { settings: (await settingsRecord(client, actor.installationId, target, id))! }
  })
}

/** Changes an organization's name, description or default settings. An omitted field is unchanged. */
export async function updateOrganization(db: Postgres, actor: AdminCaller, organizationId: string, operationId: string, changes: Changes): Promise<Applied<OrganizationResult>> {
  return update<OrganizationResult>(db, actor, operationId, 'organization', organizationId, changes)
}

/** Changes an agent's name, description or explicit settings. An omitted field is unchanged. */
export async function updateAgent(db: Postgres, actor: AdminCaller, agentId: string, operationId: string, changes: Changes): Promise<Applied<AgentResult>> {
  return update<AgentResult>(db, actor, operationId, 'agent', agentId, changes)
}

/**
 * Archives or restores an agent. Archiving fences the agent's work in the same transaction: queued and
 * waiting work is cancelled, running work is asked to stop, and a waiting parent gets the child's
 * failure. Memberships, settings, memory, files and the home are untouched, and its chats stay
 * readable. Restoring makes the agent live again; stopped work stays stopped. The admin agent cannot
 * be archived, and a deleted agent cannot be restored.
 */
async function changeAgentLifecycle(db: Pick<Postgres, 'transaction'>, jobs: Jobs, actor: AdminCaller, operationId: string, agentId: string, lifecycle: 'archived' | 'active'): Promise<Applied<AgentResult>> {
  return operate(db, actor, operationId, lifecycle === 'archived' ? 'agent.archive' : 'agent.restore', { kind: 'agent', id: agentId }, {}, async client => {
    await lockInstallation(client, actor.installationId)
    const row = (await client.query<{ lifecycle: Lifecycle; provisioned: boolean; admin: boolean }>(
      `SELECT a.lifecycle, a.provisioned, EXISTS (SELECT 1 FROM kipster.agent_roles r WHERE r.agent_id=a.id AND r.role='root-admin') AS admin
       FROM kipster.agents a WHERE a.id=$1 AND a.installation_id=$2 FOR UPDATE`, [agentId, actor.installationId])).rows[0]
    if (!row?.provisioned || (row.lifecycle !== 'active' && row.lifecycle !== 'archived')) throw new Error('Agent not found')
    if (lifecycle === 'archived' && row.admin) throw new Error('Archive of the admin agent denied')
    await changeLifecycle(client, jobs, actor.installationId, 'agent', agentId, lifecycle, 'Agent was archived')
    return { agent: (await agents(client, actor.installationId, agentId))[0]! }
  })
}

/** Moves an agent to the archive. Afterwards the dispatcher delivers the adapter cancellations of its stopped work. */
export async function archiveAgent(db: Pick<Postgres, 'transaction'>, jobs: Jobs, actor: AdminCaller, agentId: string, operationId: string): Promise<Applied<AgentResult>> {
  if (isAgentCaller(actor)) throw new Error('Human approval required')
  return changeAgentLifecycle(db, jobs, actor, operationId, agentId, 'archived')
}

/** Brings an archived agent back; it takes new work again. */
export async function restoreAgent(db: Pick<Postgres, 'transaction'>, jobs: Jobs, actor: AdminCaller, agentId: string, operationId: string): Promise<Applied<AgentResult>> {
  return changeAgentLifecycle(db, jobs, actor, operationId, agentId, 'active')
}

/** Only an archived agent can be permanently deleted. */
export class AgentNotArchivedError extends Error {
  constructor() { super('Agent must be archived before it is deleted') }
}

/**
 * Starts the permanent deletion of an archived agent: it becomes `deleting` and the operation's
 * cleanup steps run in the background. A repeated operation ID returns the agent as it is now.
 */
export async function deleteAgent(db: Pick<Postgres, 'transaction'>, jobs: Jobs, actor: AdminCaller, agentId: string, operationId: string, options: { copyFilesToOrganizations: boolean }): Promise<Applied<AgentResult>> {
  if (isAgentCaller(actor)) throw new Error('Human approval required')
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    if (!uuid.test(agentId)) throw new Error('Agent not found')
    const { operation, claimed } = await claimOperation(client, operationKey(actor, authority, operationId), 'agent.delete', { kind: 'agent', id: agentId }, { ...options })
    if (!claimed) {
      if (operation.targetId !== agentId) throw new OperationConflictError()
      return { agent: (await agents(client, actor.installationId, agentId))[0]!, alreadyApplied: true }
    }
    await lockInstallation(client, actor.installationId)
    const row = (await client.query<{ lifecycle: Lifecycle; provisioned: boolean }>('SELECT lifecycle, provisioned FROM kipster.agents WHERE id=$1 AND installation_id=$2 FOR UPDATE', [agentId, actor.installationId])).rows[0]
    if (!row?.provisioned) throw new Error('Agent not found')
    if (row.lifecycle !== 'archived' || (await client.query("SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role='root-admin'", [agentId])).rows.length) throw new AgentNotArchivedError()
    await changeLifecycle(client, jobs, actor.installationId, 'agent', agentId, 'deleting', 'Agent was deleted')
    await jobs.send(client, operation.id, 0, 'administration')
    return { agent: (await agents(client, actor.installationId, agentId))[0]!, alreadyApplied: false }
  })
}

/** Starts permanent organization deletion. Global agents and their independent resources survive. */
export async function deleteOrganization(db: Pick<Postgres, 'transaction'>, jobs: Jobs, actor: AdminCaller, organizationId: string, operationId: string): Promise<Applied<OrganizationResult>> {
  if (isAgentCaller(actor)) throw new Error('Human approval required')
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    if (!uuid.test(organizationId)) throw new Error('Organization not found')
    const { operation, claimed } = await claimOperation(client, operationKey(actor, authority, operationId), 'organization.delete', { kind: 'organization', id: organizationId }, {})
    if (!claimed) {
      if (operation.targetId !== organizationId) throw new OperationConflictError()
      return { organization: operation.result as DirectoryOrganization, alreadyApplied: true }
    }
    await lockInstallation(client, actor.installationId)
    await requireLive(client, 'organization', actor.installationId, organizationId, 'FOR UPDATE')
    await changeLifecycle(client, jobs, actor.installationId, 'organization', organizationId, 'deleting', 'Organization was deleted')
    const organization = (await organizations(client, actor.installationId, organizationId))[0]!
    await client.query('UPDATE kipster.admin_operations SET result=$2::jsonb WHERE id=$1', [operation.id, JSON.stringify(organization)])
    await jobs.send(client, operation.id, 0, 'administration')
    return { organization, alreadyApplied: false }
  })
}

/** Removes affiliations and tombstones the organization without touching global agents. */
export async function tombstoneOrganization(client: SqlClient, jobs: Jobs, installationId: string, organizationId: string): Promise<void> {
  await lockInstallation(client, installationId)
  await client.query('DELETE FROM kipster.groups WHERE organization_id=$1', [organizationId])
  await client.query('DELETE FROM kipster.agent_memberships WHERE organization_id=$1', [organizationId])
  await client.query('DELETE FROM kipster.human_memberships WHERE organization_id=$1', [organizationId])
  await publishDirectoryRemoval(client, installationId, 'organization', organizationId)
  await client.query("UPDATE kipster.organizations SET settings='{}'::jsonb, description='', settings_revision=settings_revision+1 WHERE id=$1", [organizationId])
  await changeLifecycle(client, jobs, installationId, 'organization', organizationId, 'deleted', 'Organization was deleted')
}

/**
 * The last step of an agent's deletion: its memberships and their group appearances are removed,
 * its settings and description are cleared, and the row stays as a `deleted` tombstone that keeps
 * the last name, so history can show it. Caller runs it in the operation's transaction.
 */
export async function tombstoneAgent(client: SqlClient, jobs: Jobs, installationId: string, agentId: string): Promise<void> {
  await lockInstallation(client, installationId)
  const joined = (await client.query<{ id: string }>('SELECT id FROM kipster.agent_memberships WHERE agent_id=$1 ORDER BY id FOR UPDATE', [agentId])).rows
  for (const { id } of joined) {
    const affected = (await client.query<{ id: string }>('SELECT g.id FROM kipster.groups g JOIN kipster.group_appearances x ON x.group_id=g.id WHERE x.membership_id=$1 ORDER BY g.id FOR UPDATE OF g', [id])).rows
    await publishDirectoryRemoval(client, installationId, 'membership', id)
    await client.query('DELETE FROM kipster.agent_memberships WHERE id=$1', [id])
    for (const group of affected) await touchGroup(client, installationId, group.id)
  }
  await client.query('DELETE FROM kipster.agent_roles WHERE agent_id=$1', [agentId])
  await client.query(`UPDATE kipster.agents SET settings='{}'::jsonb, description='', sleep_time=NULL, settings_revision=settings_revision+1 WHERE id=$1`, [agentId])
  await changeLifecycle(client, jobs, installationId, 'agent', agentId, 'deleted', 'Agent was deleted')
}

/** An operation the caller recorded under its own operation ID: its state and, once finished, its result. */
export async function readOperation(db: Postgres, actor: AdminCaller, operationId: string): Promise<OperationStatus> {
  const authority = await authorizeAdministration(db, actor)
  let found = await operationStatus(db, operationKey(actor, authority, operationId))
  // The owner also reads the operations the admin agent started, under their stable operation IDs.
  if (!found && authority.actorKind === 'person') {
    const admin = (await db.query<{ id: string }>(`SELECT a.id FROM kipster.agents a JOIN kipster.agent_roles r ON r.agent_id=a.id AND r.role='root-admin' WHERE a.installation_id=$1`, [actor.installationId])).rows[0]
    if (admin) found = await operationStatus(db, { installationId: actor.installationId, actorKind: 'agent', actorId: admin.id, operationId })
  }
  // An approved destructive request is executed under the human's authority. The admin can
  // inspect that specific bound operation after its continuation resumes.
  if (!found && authority.actorKind === 'agent') {
    const approval = (await db.query<{ owner_id: string }>(`SELECT b.owner_id FROM kipster.admin_approvals p
      JOIN kipster.bootstrap b ON b.installation_id=p.installation_id
      WHERE p.installation_id=$1 AND p.operation_id=$2 AND p.result IS NOT NULL`, [actor.installationId, operationId])).rows[0]
    if (approval) found = await operationStatus(db, { installationId: actor.installationId, actorKind: 'person', actorId: approval.owner_id, operationId })
  }
  if (!found) throw new Error('Operation not found')
  return found
}

/** Finishes creations that stopped before their home was seeded. Failed ones stay pending and are returned. */
export async function finishPendingCreations(db: Postgres, home: Home, installationId: string): Promise<Error[]> {
  const failures: Error[] = []
  for (const id of await pendingOperations(db, installationId, creations)) {
    try { await finishCreation(db, home, id) } catch (error) { failures.push(error instanceof Error ? error : new Error('Administration operation failed')) }
  }
  return failures
}

/** The organization's instructions file, which is their only copy. */
export async function readOrganizationInstructions(db: Postgres, home: Home, actor: AdminCaller, organizationId: string): Promise<string> {
  await authorizeAdministration(db, actor)
  await requireLive(db, 'organization', actor.installationId, organizationId, '')
  try { return await home.organizationInstructions(organizationId) } catch (error) {
    if (error instanceof HomeInstructionError) throw new Error('Organization instructions not found')
    throw error
  }
}

export interface InstructionsResult { instructions: { organizationId: string; bytes: number } }

/**
 * Replaces the organization's instructions. Saves are serialized per organization; the latest wins and
 * the next execution reads it. With an operation ID the save is recorded, and a repeat returns the
 * recorded result without saving again; the admin agent always supplies one.
 */
export async function writeOrganizationInstructions(db: Postgres, home: Home, actor: AdminCaller, organizationId: string, content: string, operationId: string | null = null): Promise<Applied<InstructionsResult>> {
  const authority = await authorizeAdministration(db, actor)
  if (operationId !== null && await operationStatus(db, operationKey(actor, authority, operationId))) {
    return operate(db, actor, operationId, 'organization.instructions', { kind: 'organization', id: organizationId }, { content }, async () => { throw new Error('Recorded operation disappeared') })
  }
  await requireLive(db, 'organization', actor.installationId, organizationId, '')
  const staged = await home.prepareOrganizationInstructions(organizationId, content)
  try {
    const save = async (client: SqlClient): Promise<InstructionsResult> => {
      await requireLive(client, 'organization', actor.installationId, organizationId, 'FOR SHARE')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kipster.organization-instructions:${organizationId}`])
      await staged.commit()
      await publishAppEvent(client, actor.installationId, 'instructions-changed', organizationId, 0, { organizationId })
      return { instructions: { organizationId, bytes: Buffer.byteLength(content) } }
    }
    if (operationId !== null) return await operate(db, actor, operationId, 'organization.instructions', { kind: 'organization', id: organizationId }, { content }, save)
    if (isAgentCaller(actor)) throw new Error('Invalid missing operation ID')
    return await db.transaction(async client => {
      await authorizeAdministration(client, actor, true)
      return { ...await save(client), alreadyApplied: false }
    })
  } finally { await staged.discard() }
}

// Memberships, groups and appearances. Each write runs in one transaction that claims its operation,
// changes the rows and records the result. Row locks are taken in one order, organization, then
// membership, then groups, and every event is published after the rows it describes are locked.

export interface MembershipResult { membership: DirectoryMembership }
export interface MembershipRemovalResult { removed: { id: string; organizationId: string; agentId: string } }
export interface GroupResult { group: DirectoryGroup }
export interface GroupRemovalResult { removed: { id: string; organizationId: string } }
export interface GroupOrderResult { groups: DirectoryGroup[] }

/** An ordered list that does not name exactly the current items; the client should reload them. */
export class OrderConflictError extends Error {
  constructor(items: string) { super(`The order must list exactly the current ${items}`) }
}

/** Claims the operation and applies it in one transaction; a repeated operation ID returns the recorded result. */
async function operate<T>(db: Pick<Postgres, 'transaction'>, actor: AdminCaller, operationId: string, kind: string, target: { kind: 'organization' | 'agent' | 'membership' | 'group'; id: string }, options: Record<string, unknown>, apply: (client: SqlClient) => Promise<T>): Promise<Applied<T>> {
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    if (!uuid.test(target.id)) throw new Error(`${names[target.kind]} not found`)
    const { operation, claimed } = await claimOperation(client, operationKey(actor, authority, operationId), kind, target, options)
    if (!claimed) {
      if (operation.targetId !== target.id) throw new OperationConflictError()
      return { ...operation.result as T, alreadyApplied: true }
    }
    const result = await apply(client)
    await completeOperation(client, operation.id, result)
    return { ...result, alreadyApplied: false }
  })
}

const group = async (client: SqlClient, installationId: string, id: string): Promise<DirectoryGroup> => (await groups(client, installationId, id))[0]!

/** Share-locks the active organization of a group and returns its ID. */
async function lockOrganizationOf(client: SqlClient, installationId: string, groupId: string): Promise<string> {
  const found = (await client.query<{ organization_id: string }>('SELECT organization_id FROM kipster.groups WHERE id=$1', [groupId])).rows[0]
  if (!found) throw new Error('Group not found')
  await requireLive(client, 'organization', installationId, found.organization_id, 'FOR SHARE')
  return found.organization_id
}

/** Locks a group of an active organization for a change; the organization is share-locked first. */
async function lockGroup(client: SqlClient, installationId: string, groupId: string): Promise<string> {
  const organizationId = await lockOrganizationOf(client, installationId, groupId)
  if (!(await client.query('SELECT 1 FROM kipster.groups WHERE id=$1 FOR UPDATE', [groupId])).rows.length) throw new Error('Group not found')
  return organizationId
}

/** Checks that `ids` names each current item exactly once. */
function sameItems(ids: readonly string[], current: readonly string[], items: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Invalid duplicate ${items}`)
  if (ids.length !== current.length || ids.some(id => !current.includes(id))) throw new OrderConflictError(items)
}

async function touchGroup(client: SqlClient, installationId: string, groupId: string): Promise<void> {
  await client.query('UPDATE kipster.groups SET revision=revision+1 WHERE id=$1', [groupId])
  await publishDirectoryChange(client, installationId, 'group', groupId)
}

/** Adds an active agent to an active organization. Adding a current member returns its membership unchanged. */
export async function addMembership(db: Postgres, actor: AdminCaller, operationId: string, organizationId: string, agentId: string): Promise<Applied<MembershipResult>> {
  return operate(db, actor, operationId, 'membership.add', { kind: 'organization', id: organizationId }, { agentId }, async client => {
    // The agent is locked before the organization, as the task-data guard does.
    await requireLive(client, 'agent', actor.installationId, agentId, 'FOR SHARE')
    await requireLive(client, 'organization', actor.installationId, organizationId, 'FOR SHARE')
    const added = await client.query<{ id: string }>('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [organizationId, agentId])
    const id = added.rows[0]?.id ?? (await client.query<{ id: string }>('SELECT id FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2', [organizationId, agentId])).rows[0]!.id
    if (added.rows[0]) await publishDirectoryChange(client, actor.installationId, 'membership', id)
    return { membership: (await memberships(client, actor.installationId, id))[0]! }
  })
}

/**
 * Removes an agent from an organization. Its group appearances go with the membership; its chat stays
 * readable, and work accepted before the removal still runs. Adding the agent again creates a new
 * membership and opens the same chat.
 */
export async function removeMembership(db: Postgres, actor: AdminCaller, operationId: string, membershipId: string): Promise<Applied<MembershipRemovalResult>> {
  return operate(db, actor, operationId, 'membership.remove', { kind: 'membership', id: membershipId }, {}, async client => {
    const found = (await client.query<{ organization_id: string }>('SELECT organization_id FROM kipster.agent_memberships WHERE id=$1', [membershipId])).rows[0]
    if (!found) throw new Error('Membership not found')
    await requireLive(client, 'organization', actor.installationId, found.organization_id, 'FOR SHARE')
    // Waits for acceptances and delegations that hold the membership with FOR KEY SHARE.
    const row = (await client.query<{ agent_id: string }>('SELECT agent_id FROM kipster.agent_memberships WHERE id=$1 FOR UPDATE', [membershipId])).rows[0]
    if (!row) throw new Error('Membership not found')
    const affected = (await client.query<{ id: string }>('SELECT g.id FROM kipster.groups g JOIN kipster.group_appearances x ON x.group_id=g.id WHERE x.membership_id=$1 ORDER BY g.id FOR UPDATE OF g', [membershipId])).rows
    await publishDirectoryRemoval(client, actor.installationId, 'membership', membershipId)
    await client.query('DELETE FROM kipster.agent_memberships WHERE id=$1', [membershipId])
    for (const { id } of affected) await touchGroup(client, actor.installationId, id)
    return { removed: { id: membershipId, organizationId: found.organization_id, agentId: row.agent_id } }
  })
}

/** Creates an empty group after the organization's other groups. */
export async function createGroup(db: Postgres, actor: AdminCaller, operationId: string, organizationId: string, name: string): Promise<Applied<GroupResult>> {
  return operate(db, actor, operationId, 'group.create', { kind: 'organization', id: organizationId }, { name }, async client => {
    // Serializes positions with other creations and reorders in the organization.
    await requireLive(client, 'organization', actor.installationId, organizationId, 'FOR NO KEY UPDATE')
    const id = randomUUID()
    await client.query('INSERT INTO kipster.groups(id, organization_id, name, position) SELECT $1, $2, $3, COALESCE(max(position) + 1, 0) FROM kipster.groups WHERE organization_id=$2', [id, organizationId, name])
    await publishDirectoryChange(client, actor.installationId, 'group', id)
    return { group: await group(client, actor.installationId, id) }
  })
}

export async function renameGroup(db: Postgres, actor: AdminCaller, operationId: string, groupId: string, name: string): Promise<Applied<GroupResult>> {
  return operate(db, actor, operationId, 'group.rename', { kind: 'group', id: groupId }, { name }, async client => {
    await lockGroup(client, actor.installationId, groupId)
    await client.query('UPDATE kipster.groups SET name=$2 WHERE id=$1', [groupId, name])
    await touchGroup(client, actor.installationId, groupId)
    return { group: await group(client, actor.installationId, groupId) }
  })
}

/** Deletes a group and its appearances. Agents, memberships and appearances in other groups are unchanged. */
export async function deleteGroup(db: Postgres, actor: AdminCaller, operationId: string, groupId: string): Promise<Applied<GroupRemovalResult>> {
  return operate(db, actor, operationId, 'group.delete', { kind: 'group', id: groupId }, {}, async client => {
    const organizationId = await lockGroup(client, actor.installationId, groupId)
    await publishDirectoryRemoval(client, actor.installationId, 'group', groupId)
    await client.query('DELETE FROM kipster.groups WHERE id=$1', [groupId])
    return { removed: { id: groupId, organizationId } }
  })
}

/** Orders the organization's groups. The list names every current group; the latest save wins. */
export async function reorderGroups(db: Postgres, actor: AdminCaller, operationId: string, organizationId: string, groupIds: readonly string[]): Promise<Applied<GroupOrderResult>> {
  return operate(db, actor, operationId, 'group.reorder', { kind: 'organization', id: organizationId }, { groupIds }, async client => {
    await requireLive(client, 'organization', actor.installationId, organizationId, 'FOR NO KEY UPDATE')
    const current = (await client.query<{ id: string; position: number }>('SELECT id, position FROM kipster.groups WHERE organization_id=$1 ORDER BY id FOR UPDATE', [organizationId])).rows
    sameItems(groupIds, current.map(row => row.id), 'groups')
    for (const [position, id] of groupIds.entries()) {
      if (current.find(row => row.id === id)!.position === position) continue
      await client.query('UPDATE kipster.groups SET position=$2 WHERE id=$1', [id, position])
      await touchGroup(client, actor.installationId, id)
    }
    return { groups: (await groups(client, actor.installationId)).filter(item => item.organizationId === organizationId) }
  })
}

/** Places a membership of the group's organization at the end of the group. A placed membership stays where it is. */
export async function addAppearance(db: Postgres, actor: AdminCaller, operationId: string, groupId: string, membershipId: string): Promise<Applied<GroupResult>> {
  return operate(db, actor, operationId, 'appearance.add', { kind: 'group', id: groupId }, { membershipId }, async client => {
    // The membership is locked before the group, the order a removal uses.
    const organizationId = await lockOrganizationOf(client, actor.installationId, groupId)
    const member = uuid.test(membershipId) && (await client.query('SELECT 1 FROM kipster.agent_memberships WHERE id=$1 AND organization_id=$2 FOR KEY SHARE', [membershipId, organizationId])).rows.length > 0
    if (!member) throw new Error('Membership not found')
    await client.query('SELECT 1 FROM kipster.groups WHERE id=$1 FOR UPDATE', [groupId])
    const added = await client.query(`INSERT INTO kipster.group_appearances(group_id, membership_id, organization_id, position)
      SELECT $1, $2, $3, COALESCE(max(position) + 1, 0) FROM kipster.group_appearances WHERE group_id=$1
      ON CONFLICT DO NOTHING`, [groupId, membershipId, organizationId])
    if (added.rowCount) await touchGroup(client, actor.installationId, groupId)
    return { group: await group(client, actor.installationId, groupId) }
  })
}

/** Takes a membership out of the group. Its other appearances and the membership itself stay. */
export async function removeAppearance(db: Postgres, actor: AdminCaller, operationId: string, groupId: string, membershipId: string): Promise<Applied<GroupResult>> {
  return operate(db, actor, operationId, 'appearance.remove', { kind: 'group', id: groupId }, { membershipId }, async client => {
    if (!uuid.test(membershipId)) throw new Error('Membership not found')
    await lockGroup(client, actor.installationId, groupId)
    const removed = await client.query('DELETE FROM kipster.group_appearances WHERE group_id=$1 AND membership_id=$2', [groupId, membershipId])
    if (removed.rowCount) await touchGroup(client, actor.installationId, groupId)
    return { group: await group(client, actor.installationId, groupId) }
  })
}

/** Orders a group's appearances. The list names every membership in the group; the latest save wins. */
export async function reorderAppearances(db: Postgres, actor: AdminCaller, operationId: string, groupId: string, membershipIds: readonly string[]): Promise<Applied<GroupResult>> {
  return operate(db, actor, operationId, 'appearance.reorder', { kind: 'group', id: groupId }, { membershipIds }, async client => {
    await lockGroup(client, actor.installationId, groupId)
    const current = (await client.query<{ membership_id: string; position: number }>('SELECT membership_id, position FROM kipster.group_appearances WHERE group_id=$1', [groupId])).rows
    sameItems(membershipIds, current.map(row => row.membership_id), 'memberships')
    let changed = false
    for (const [position, id] of membershipIds.entries()) {
      if (current.find(row => row.membership_id === id)!.position === position) continue
      await client.query('UPDATE kipster.group_appearances SET position=$3 WHERE group_id=$1 AND membership_id=$2', [groupId, id, position])
      changed = true
    }
    if (changed) await touchGroup(client, actor.installationId, groupId)
    return { group: await group(client, actor.installationId, groupId) }
  })
}

/** Bounded receipts for this admin agent's earlier work in the same logical run. */
export async function administrationReceipts(db: Postgres, installationId: string, agentId: string, runId: string): Promise<{ receipts: unknown[]; hasMore: boolean }> {
  const rows = (await db.query(`SELECT operation_id AS "operationId", kind, target_id AS "targetId", state, result
    FROM kipster.admin_operations WHERE installation_id=$1 AND actor_kind='agent' AND actor_id=$2 AND origin_run_id=$3
    ORDER BY created_at DESC, id DESC LIMIT 21`, [installationId, agentId, runId])).rows
  const receipts: unknown[] = []
  let bytes = 0
  for (const row of rows.slice(0, 20)) {
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (bytes > 32768) break
    receipts.push(row)
  }
  return { receipts, hasMore: rows.length > receipts.length }
}
