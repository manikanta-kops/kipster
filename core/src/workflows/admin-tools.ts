import { requestAdminApproval } from './admin-approvals.js'
import type { Postgres } from '../platform/postgres/public.js'
import type { Jobs } from '../platform/jobs/public.js'
import { MAX_ORGANIZATION_INSTRUCTIONS_BYTES, type Home } from '../platform/home/public.js'
import { authorizeAdministration, type AgentCaller } from '../modules/identity/public.js'
import { addAppearance, addMembership, changeSettings, createAgent, createGroup, createOrganization, deleteGroup, readDirectory, readOperation, readOrganizationInstructions, removeAppearance, removeMembership, renameGroup, reorderAppearances, reorderGroups, restoreAgent, updateAgent, updateOrganization, writeOrganizationInstructions, type Changes } from '../modules/administration/public.js'
import { effectiveSettings, readAdapters, readSettings, requireSettingsOwner, type Catalog, type Patch } from '../modules/settings/public.js'
import { agentCreate, agentUpdate, appearanceAdd, appearanceOrder, groupCreate, groupOrder, groupRename, membershipAdd, operationRequest, organizationCreate, organizationInstructionsWrite, organizationUpdate, settingsWrite } from '../protocol/admin.js'
import type { Schema } from '../protocol/schema.js'

/** What the administration tools need from the dispatcher that runs the calling attempt. */
export interface AdministrationToolHost {
  readonly db: Postgres
  readonly home: Home
  readonly jobs: Jobs
  catalog(): Catalog | null
  refreshAdapters(): Promise<void>
}

const settingFields = ['adapterId', 'modelId', 'effort', 'options'] as const

function invalid(name: string): never { throw new Error(`Invalid ${name} arguments`) }

/** Reads the named string arguments and returns the rest. */
function split(name: string, args: Record<string, unknown>, keys: readonly string[]): { ids: string[]; rest: Record<string, unknown> } {
  const rest = { ...args }
  const ids = keys.map(key => {
    const value = rest[key]
    if (typeof value !== 'string') invalid(name)
    delete rest[key]
    return value
  })
  return { ids, rest }
}

function none(name: string, args: Record<string, unknown>): void {
  if (Object.keys(args).length) invalid(name)
}

const changes = (input: { name?: string | undefined; description?: string | undefined; settings?: Changes['settings'] | undefined }): Changes => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.settings !== undefined ? { settings: input.settings } : {}),
})

const settingsTarget = (name: string, value: unknown): 'agent' | 'organization' => value === 'agent' || value === 'organization' ? value : invalid(name)

/**
 * Runs one `admin.*` tool call of the admin agent. Every call names its targets by ID. Reads and
 * writes call the same administration services as the HTTP routes, authorized for the calling
 * attempt. Direct writes use an explicit operation ID, stable across execution retries.
 * Reusing the ID returns its receipt; different IDs remain distinct requests.
 */
export async function administrationTool(host: AdministrationToolHost, caller: AgentCaller, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (typeof callId !== 'string' || !callId || callId.length > 160) throw new Error('Invalid administration call ID')
  const { db, home } = host
  await authorizeAdministration(db, caller)
  const direct = /\.(create|update|restore|add|remove|rename|reorder|instructions_set|set|clear)$/.test(name) || name === 'admin.groups.delete'
  const operationId = direct ? operationRequest.parse({ version: 1, operationId: args.operationId }).operationId : `${caller.attemptId}:${callId}`
  if (direct) { const { operationId: ignored, ...fields } = args; void ignored; args = fields }
  // Write arguments are checked by the HTTP request schema, with this call's operation ID.
  const request = <T>(schema: Schema<T>, fields: Record<string, unknown>): T => {
    if ('version' in fields || 'operationId' in fields) invalid(name)
    return schema.parse({ ...fields, version: 1, operationId })
  }
  const recorded = <T extends object>(result: T): T & { operationId: string } => ({ operationId, ...result })
  // The HTTP routes bound their bodies; instructions allow room for JSON escaping, as their route does.
  if (Buffer.byteLength(JSON.stringify(args)) > (name === 'admin.organizations.instructions_set' ? 8 * MAX_ORGANIZATION_INSTRUCTIONS_BYTES : 64 * 1024)) invalid(name)
  switch (name) {
    case 'admin.directory.get':
      none(name, args)
      return readDirectory(db, caller)
    case 'admin.organizations.get': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      none(name, rest)
      const directory = await readDirectory(db, caller)
      const organization = directory.organizations.find(item => item.id === organizationId)
      if (!organization) throw new Error('Organization not found')
      return { cursor: directory.cursor, organization, memberships: directory.memberships.filter(item => item.organizationId === organizationId), groups: directory.groups.filter(item => item.organizationId === organizationId) }
    }
    case 'admin.agents.get': {
      const { ids: [agentId], rest } = split(name, args, ['agentId'])
      none(name, rest)
      const directory = await readDirectory(db, caller)
      const agent = directory.agents.find(item => item.id === agentId)
      if (!agent) throw new Error('Agent not found')
      return { cursor: directory.cursor, agent, memberships: directory.memberships.filter(item => item.agentId === agentId) }
    }
    case 'admin.organizations.instructions_get': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      none(name, rest)
      return { organizationId, content: await readOrganizationInstructions(db, home, caller, organizationId!) }
    }
    case 'admin.settings.list':
      none(name, args)
      return readSettings(db, caller)
    case 'admin.settings.effective': {
      const { ids: [agentId], rest } = split(name, args, ['agentId'])
      const { organizationId, ...extra } = rest
      none(name, extra)
      if (organizationId !== undefined && organizationId !== null && typeof organizationId !== 'string') invalid(name)
      return effectiveSettings(db, home, caller, agentId!, organizationId ?? null, host.catalog())
    }
    case 'admin.adapters.list':
      none(name, args)
      return readAdapters(db, caller)
    case 'admin.adapters.refresh':
      none(name, args)
      await requireSettingsOwner(db, caller)
      await host.refreshAdapters()
      return readAdapters(db, caller)
    case 'admin.operations.get': {
      const { ids: [id], rest } = split(name, args, ['operationId'])
      none(name, rest)
      return readOperation(db, caller, id!)
    }
    case 'admin.organizations.create': {
      const input = request(organizationCreate, args)
      return recorded(await createOrganization(db, home, caller, operationId, { name: input.name, ...changes(input) }))
    }
    case 'admin.organizations.update': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      return recorded(await updateOrganization(db, caller, organizationId!, operationId, changes(request(organizationUpdate, rest))))
    }
    case 'admin.organizations.instructions_set': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      if ('version' in rest) invalid(name)
      const input = organizationInstructionsWrite.parse({ ...rest, version: 1 })
      return recorded(await writeOrganizationInstructions(db, home, caller, organizationId!, input.content, operationId))
    }
    case 'admin.agents.create': {
      const input = request(agentCreate, args)
      return recorded(await createAgent(db, home, caller, operationId, { name: input.name, ...changes(input), ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}) }))
    }
    case 'admin.agents.update': {
      const { ids: [agentId], rest } = split(name, args, ['agentId'])
      return recorded(await updateAgent(db, caller, agentId!, operationId, changes(request(agentUpdate, rest))))
    }
    case 'admin.agents.archive':
    case 'admin.agents.delete':
    case 'admin.organizations.delete': {
      const organization = name === 'admin.organizations.delete'
      const { ids: [targetId], rest } = split(name, args, [organization ? 'organizationId' : 'agentId'])
      const copy = rest.copyFilesToOrganizations
      if (name === 'admin.agents.delete') delete rest.copyFilesToOrganizations
      none(name, rest)
      if (copy !== undefined && typeof copy !== 'boolean') invalid(name)
      return requestAdminApproval(db, caller, callId, organization ? 'organization.delete' : name === 'admin.agents.archive' ? 'agent.archive' : 'agent.delete', targetId!, copy === true)
    }
    case 'admin.agents.restore': {
      const { ids: [agentId], rest } = split(name, args, ['agentId'])
      request(operationRequest, rest)
      return recorded(await restoreAgent(db, host.jobs, caller, agentId!, operationId))
    }
    case 'admin.memberships.add': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      return recorded(await addMembership(db, caller, operationId, organizationId!, request(membershipAdd, rest).agentId))
    }
    case 'admin.memberships.remove': {
      const { ids: [membershipId], rest } = split(name, args, ['membershipId'])
      request(operationRequest, rest)
      return recorded(await removeMembership(db, caller, operationId, membershipId!))
    }
    case 'admin.groups.create': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      return recorded(await createGroup(db, caller, operationId, organizationId!, request(groupCreate, rest).name))
    }
    case 'admin.groups.rename': {
      const { ids: [groupId], rest } = split(name, args, ['groupId'])
      return recorded(await renameGroup(db, caller, operationId, groupId!, request(groupRename, rest).name))
    }
    case 'admin.groups.delete': {
      const { ids: [groupId], rest } = split(name, args, ['groupId'])
      request(operationRequest, rest)
      return recorded(await deleteGroup(db, caller, operationId, groupId!))
    }
    case 'admin.groups.reorder': {
      const { ids: [organizationId], rest } = split(name, args, ['organizationId'])
      return recorded(await reorderGroups(db, caller, operationId, organizationId!, request(groupOrder, rest).groupIds))
    }
    case 'admin.appearances.add': {
      const { ids: [groupId], rest } = split(name, args, ['groupId'])
      return recorded(await addAppearance(db, caller, operationId, groupId!, request(appearanceAdd, rest).membershipId))
    }
    case 'admin.appearances.remove': {
      const { ids: [groupId, membershipId], rest } = split(name, args, ['groupId', 'membershipId'])
      request(operationRequest, rest)
      return recorded(await removeAppearance(db, caller, operationId, groupId!, membershipId!))
    }
    case 'admin.appearances.reorder': {
      const { ids: [groupId], rest } = split(name, args, ['groupId'])
      return recorded(await reorderAppearances(db, caller, operationId, groupId!, request(appearanceOrder, rest).membershipIds))
    }
    case 'admin.settings.set': {
      const { ids: [id], rest } = split(name, args, ['id'])
      const { target, ...values } = rest
      const patch: Record<string, { set: unknown }> = {}
      for (const [field, value] of Object.entries(values)) patch[field] = { set: value }
      const input = request(settingsWrite, { settings: patch })
      return recorded(await changeSettings(db, caller, operationId, settingsTarget(name, target), id!, input.settings as Patch))
    }
    case 'admin.settings.clear': {
      const { ids: [id], rest } = split(name, args, ['id'])
      const { target, fields, ...extra } = rest
      none(name, extra)
      if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length || fields.some(field => !settingFields.includes(field))) invalid(name)
      const input = request(settingsWrite, { settings: Object.fromEntries(fields.map(field => [field, { clear: true }])) })
      return recorded(await changeSettings(db, caller, operationId, settingsTarget(name, target), id!, input.settings as Patch))
    }
    default:
      throw new Error('Unsupported administration tool')
  }
}
