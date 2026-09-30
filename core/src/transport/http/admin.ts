import type { Runtime } from '../../runtime.js'
import type { TrustedActor } from '../../modules/identity/public.js'
import { addAppearance, addMembership, archiveAgent, changeSettings, createAgent, createGroup, createOrganization, deleteAgent, deleteOrganization, deleteGroup, readOperation, readOrganizationInstructions, removeAppearance, removeMembership, renameGroup, reorderAppearances, reorderGroups, restoreAgent, updateAgent, updateOrganization, writeOrganizationInstructions, type Changes } from '../../modules/administration/public.js'
import { adaptersRefresh, agentCreate, agentDelete, agentUpdate, appearanceAdd, appearanceOrder, groupCreate, groupOrder, groupRename, membershipAdd, operationRequest, organizationCreate, organizationInstructionsWrite, organizationUpdate, settingsWrite } from '../../protocol/admin.js'
import { effectiveSettings, readAdapters, readSettings, requireSettingsOwner } from '../../modules/settings/public.js'
import type { TextDispatcher } from '../../workflows/text-dispatch.js'
import { MAX_ORGANIZATION_INSTRUCTIONS_BYTES } from '../../platform/home/public.js'

/** The server lacks a service the route needs; mapped to 503 `unavailable`. */
export class ServiceUnavailableError extends Error {}

const changes = (input: { name?: string | undefined; description?: string | undefined; settings?: Changes['settings'] | undefined }): Changes => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.settings !== undefined ? { settings: input.settings } : {}),
})

/**
 * Owner administration routes. Returns the response body, or undefined when no route matches.
 * `read` parses the JSON request body up to the given byte limit. Adapter routes need the dispatcher;
 * without one, effective settings are not checked against a catalog.
 */
export async function administrationRoute(runtime: Runtime, actor: TrustedActor, method: string, path: string, query: URLSearchParams, read: (limit?: number) => Promise<unknown>, dispatcher?: TextDispatcher): Promise<object | undefined> {
  const { db, home } = runtime
  if (path === '/v1/settings' && method === 'GET') return readSettings(db, actor)
  const operation = /^\/v1\/operations\/([^/]{1,600})$/.exec(path)
  if (operation && method === 'GET') {
    let operationId: string
    try { operationId = decodeURIComponent(operation[1]!) } catch { throw new Error('Invalid operation ID') }
    if (!operationId || operationId.length > 200) throw new Error('Invalid operation ID')
    return { version: 1, ...await readOperation(db, actor, operationId) }
  }
  const settings = /^\/v1\/(agents|organizations)\/([0-9a-f-]{36})\/settings$/.exec(path)
  if (settings && method === 'PUT') {
    const input = settingsWrite.parse(await read())
    return { version: 1, operationId: input.operationId, ...await changeSettings(db, actor, input.operationId, settings[1] === 'agents' ? 'agent' : 'organization', settings[2]!, input.settings) }
  }
  const effective = /^\/v1\/agents\/([0-9a-f-]{36})\/effective-settings$/.exec(path)
  if (effective && method === 'GET') {
    const organizationId = query.get('organizationId')
    if (organizationId === '') throw new Error('Invalid organization ID')
    return effectiveSettings(db, home, actor, effective[1]!, organizationId, dispatcher?.catalog() ?? null)
  }
  if (path === '/v1/execution-adapters' && method === 'GET') {
    if (!dispatcher) throw new ServiceUnavailableError('Execution adapters are unavailable without a dispatcher')
    return readAdapters(db, actor)
  }
  if (path === '/v1/execution-adapters/refresh' && method === 'POST') {
    adaptersRefresh.parse(await read())
    if (!dispatcher) throw new ServiceUnavailableError('Execution adapters are unavailable without a dispatcher')
    await requireSettingsOwner(db, actor)
    await dispatcher.refreshAdapters()
    return readAdapters(db, actor)
  }
  if (path === '/v1/organizations' && method === 'POST') {
    const input = organizationCreate.parse(await read())
    return { version: 1, operationId: input.operationId, ...await createOrganization(db, home, actor, input.operationId, { name: input.name, ...changes(input) }) }
  }
  if (path === '/v1/agents' && method === 'POST') {
    const input = agentCreate.parse(await read())
    const fields = { name: input.name, ...changes(input), ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}) }
    return { version: 1, operationId: input.operationId, ...await createAgent(db, home, actor, input.operationId, fields) }
  }
  const organization = /^\/v1\/organizations\/([0-9a-f-]{36})(\/instructions)?$/.exec(path)
  if (organization && !organization[2] && method === 'DELETE') {
    const input = operationRequest.parse(await read())
    const result = await deleteOrganization(db, runtime.jobs, actor, organization[1]!, input.operationId)
    await dispatcher?.deliverCancellations().catch(() => undefined)
    return { version: 1, operationId: input.operationId, ...result }
  }
  if (organization && !organization[2] && method === 'PUT') {
    const input = organizationUpdate.parse(await read())
    return { version: 1, operationId: input.operationId, ...await updateOrganization(db, actor, organization[1]!, input.operationId, changes(input)) }
  }
  if (organization?.[2] && method === 'GET') {
    return { version: 1, organizationId: organization[1], content: await readOrganizationInstructions(db, home, actor, organization[1]!) }
  }
  if (organization?.[2] && method === 'PUT') {
    const input = organizationInstructionsWrite.parse(await read(8 * MAX_ORGANIZATION_INSTRUCTIONS_BYTES))
    await writeOrganizationInstructions(db, home, actor, organization[1]!, input.content)
    return { version: 1, organizationId: organization[1], content: input.content }
  }
  const agent = /^\/v1\/agents\/([0-9a-f-]{36})$/.exec(path)
  if (agent && method === 'PUT') {
    const input = agentUpdate.parse(await read())
    return { version: 1, operationId: input.operationId, ...await updateAgent(db, actor, agent[1]!, input.operationId, changes(input)) }
  }
  if (agent && method === 'DELETE') {
    const input = agentDelete.parse(await read())
    return { version: 1, operationId: input.operationId, ...await deleteAgent(db, runtime.jobs, actor, agent[1]!, input.operationId, { copyFilesToOrganizations: input.copyFilesToOrganizations ?? false }) }
  }
  const lifecycle = /^\/v1\/agents\/([0-9a-f-]{36})\/(archive|restore)$/.exec(path)
  if (lifecycle && method === 'POST') {
    const input = operationRequest.parse(await read())
    const archive = lifecycle[2] === 'archive'
    const result = await (archive ? archiveAgent : restoreAgent)(db, runtime.jobs, actor, lifecycle[1]!, input.operationId)
    // The adapter of stopped work is asked to cancel now; a dispatcher in another process does it on its next tick.
    if (archive) await dispatcher?.deliverCancellations().catch(() => undefined)
    return { version: 1, operationId: input.operationId, ...result }
  }
  const children = /^\/v1\/organizations\/([0-9a-f-]{36})\/(memberships|groups|groups\/order)$/.exec(path)
  if (children?.[2] === 'memberships' && method === 'POST') {
    const input = membershipAdd.parse(await read())
    return { version: 1, operationId: input.operationId, ...await addMembership(db, actor, input.operationId, children[1]!, input.agentId) }
  }
  if (children?.[2] === 'groups' && method === 'POST') {
    const input = groupCreate.parse(await read())
    return { version: 1, operationId: input.operationId, ...await createGroup(db, actor, input.operationId, children[1]!, input.name) }
  }
  if (children?.[2] === 'groups/order' && method === 'PUT') {
    const input = groupOrder.parse(await read())
    return { version: 1, operationId: input.operationId, ...await reorderGroups(db, actor, input.operationId, children[1]!, input.groupIds) }
  }
  const membership = /^\/v1\/memberships\/([0-9a-f-]{36})$/.exec(path)
  if (membership && method === 'DELETE') {
    const input = operationRequest.parse(await read())
    return { version: 1, operationId: input.operationId, ...await removeMembership(db, actor, input.operationId, membership[1]!) }
  }
  const group = /^\/v1\/groups\/([0-9a-f-]{36})$/.exec(path)
  if (group && method === 'PUT') {
    const input = groupRename.parse(await read())
    return { version: 1, operationId: input.operationId, ...await renameGroup(db, actor, input.operationId, group[1]!, input.name) }
  }
  if (group && method === 'DELETE') {
    const input = operationRequest.parse(await read())
    return { version: 1, operationId: input.operationId, ...await deleteGroup(db, actor, input.operationId, group[1]!) }
  }
  const appearances = /^\/v1\/groups\/([0-9a-f-]{36})\/appearances(?:\/(order|[0-9a-f-]{36}))?$/.exec(path)
  if (appearances && !appearances[2] && method === 'POST') {
    const input = appearanceAdd.parse(await read())
    return { version: 1, operationId: input.operationId, ...await addAppearance(db, actor, input.operationId, appearances[1]!, input.membershipId) }
  }
  if (appearances?.[2] === 'order' && method === 'PUT') {
    const input = appearanceOrder.parse(await read())
    return { version: 1, operationId: input.operationId, ...await reorderAppearances(db, actor, input.operationId, appearances[1]!, input.membershipIds) }
  }
  if (appearances?.[2] && appearances[2] !== 'order' && method === 'DELETE') {
    const input = operationRequest.parse(await read())
    return { version: 1, operationId: input.operationId, ...await removeAppearance(db, actor, input.operationId, appearances[1]!, appearances[2]) }
  }
  return undefined
}
