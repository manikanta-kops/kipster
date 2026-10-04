import test from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// The admin agent administers the installation through `admin_call` with catalog operations, which the
// deterministic fixture adapter makes through the Core tool host against real PostgreSQL. Steps name an
// operation as `admin.<operation>`; `adminCall` turns them into tool calls.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const directoryTypes = new Set(['organization-changed', 'agent-changed', 'membership-changed', 'group-changed', 'settings-changed', 'organization-removed', 'membership-removed', 'group-removed'])
const toolNames = [
  'admin.directory.get', 'admin.organizations.get', 'admin.agents.get', 'admin.organizations.instructions_get', 'admin.organizations.instructions_set',
  'admin.settings.list', 'admin.settings.effective', 'admin.settings.set', 'admin.settings.clear', 'admin.adapters.list', 'admin.adapters.refresh',
  'admin.operations.get', 'admin.organizations.create', 'admin.organizations.update', 'admin.agents.create', 'admin.agents.update', 'admin.agents.restore', 'admin.agents.archive', 'admin.agents.delete', 'admin.organizations.delete',
  'admin.memberships.add', 'admin.memberships.remove', 'admin.groups.create', 'admin.groups.rename', 'admin.groups.delete', 'admin.groups.reorder',
  'admin.appearances.add', 'admin.appearances.remove', 'admin.appearances.reorder',
]

/** An `admin.<operation>` step as its admin_call. A receipt operation gets an attempt-scoped operation ID unless the step names one. */
function adminCall(context, callId, name, args = {}) {
  if (!name.startsWith('admin.')) return [name, args]
  const operation = name.slice('admin.'.length)
  const receipt = /\.(create|update|restore|add|remove|rename|reorder|instructions_set|set|clear)$/.test(operation) || ['groups.delete', 'updates.settings_set', 'updates.unpin'].includes(operation)
  const { operationId, ...rest } = receipt ? args : { ...args, operationId: undefined }
  if (!receipt && args.operationId !== undefined) rest.operationId = args.operationId
  return ['admin_call', { operation, arguments: rest, ...(operationId !== undefined ? { operationId } : receipt ? { operationId: `${context.attemptId}:${callId}` } : {}) }]
}
const toolCall = (execution, callId, name, args) => execution.handle.callTool(callId, ...adminCall(execution.context, callId, name, args))

async function until(read, match, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (match(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}
const count = async (db, sql, values) => Number((await db.query(sql, values)).rows[0].n)

/** A runtime with an HTTP server for the owner and a dispatcher that runs the fixture adapter. */
async function setup(t, updates) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_admin_tools_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-admin-tools-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names, executionLimit: 4, ...(updates ? { updates } : {}) })
  closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  closers.push(() => server.close())
  await dispatcher.start()
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  await ok('PUT', `/v1/organizations/${organizationId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  const installation = { kind: 'installation', installationId }
  const ctx = {
    url: url.href, server, closers, runtime, db: runtime.db, dispatcher, installationId, ownerId, organizationId, rootAgentId, call, ok,
    /** Starts a run of the agent in its chat and returns the execution with its fixture handle. */
    async start(agentId = rootAgentId, context = installation, text = 'Administer') {
      const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context, agentId })
      const accepted = await ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
      const execution = await until(() => executions.find(e => e.context.runId === accepted.runId), Boolean, `execution of ${accepted.runId}`)
      return { ...execution, chat: context, chatId, runId: accepted.runId, threadId: accepted.threadId, tool: (callId, toolName, args = {}) => toolCall(execution, callId, toolName, args) }
    },
    control: (run, action, attemptId = run.context.attemptId) => call('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: run.chat, chatId: run.chatId, threadId: run.threadId, runId: run.runId, attemptId, action }),
    executions,
    operations: () => count(runtime.db, 'SELECT count(*) AS n FROM kipster.admin_operations'),
    events: async cursor => (await readEvents(runtime.db, { kind: 'application', installationId, callerId: ownerId }, cursor)).events.map(event => textEvent.parse(event)),
  }
  return ctx
}

/** The same administration steps through HTTP or through tool calls of one admin run. */
function httpApi(ctx) {
  const op = () => ({ version: 1, operationId: randomUUID() })
  const set = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { set: value }]))
  return {
    createOrganization: fields => ctx.ok('POST', '/v1/organizations', { ...op(), ...fields }),
    updateOrganization: (id, fields) => ctx.ok('PUT', `/v1/organizations/${id}`, { ...op(), ...fields }),
    createAgent: fields => ctx.ok('POST', '/v1/agents', { ...op(), ...fields }),
    updateAgent: (id, fields) => ctx.ok('PUT', `/v1/agents/${id}`, { ...op(), ...fields }),
    addMembership: (organizationId, agentId) => ctx.ok('POST', `/v1/organizations/${organizationId}/memberships`, { ...op(), agentId }),
    removeMembership: id => ctx.ok('DELETE', `/v1/memberships/${id}`, op()),
    setInstructions: (organizationId, content) => ctx.ok('PUT', `/v1/organizations/${organizationId}/instructions`, { version: 1, content }),
    createGroup: (organizationId, name) => ctx.ok('POST', `/v1/organizations/${organizationId}/groups`, { ...op(), name }),
    renameGroup: (id, name) => ctx.ok('PUT', `/v1/groups/${id}`, { ...op(), name }),
    reorderGroups: (organizationId, groupIds) => ctx.ok('PUT', `/v1/organizations/${organizationId}/groups/order`, { ...op(), groupIds }),
    deleteGroup: id => ctx.ok('DELETE', `/v1/groups/${id}`, op()),
    addAppearance: (groupId, membershipId) => ctx.ok('POST', `/v1/groups/${groupId}/appearances`, { ...op(), membershipId }),
    removeAppearance: (groupId, membershipId) => ctx.ok('DELETE', `/v1/groups/${groupId}/appearances/${membershipId}`, op()),
    reorderAppearances: (groupId, membershipIds) => ctx.ok('PUT', `/v1/groups/${groupId}/appearances/order`, { ...op(), membershipIds }),
    setSettings: (target, id, values) => ctx.ok('PUT', `/v1/${target}s/${id}/settings`, { ...op(), settings: set(values) }),
    clearSettings: (target, id, fields) => ctx.ok('PUT', `/v1/${target}s/${id}/settings`, { ...op(), settings: Object.fromEntries(fields.map(field => [field, { clear: true }])) }),
  }
}
function toolApi(run, results) {
  let n = 0
  const tool = async (name, args) => {
    const callId = `step-${++n}`
    const result = await run.tool(callId, name, args)
    results.push({ callId, name, result })
    return result
  }
  return {
    createOrganization: fields => tool('admin.organizations.create', fields),
    updateOrganization: (organizationId, fields) => tool('admin.organizations.update', { organizationId, ...fields }),
    createAgent: fields => tool('admin.agents.create', fields),
    updateAgent: (agentId, fields) => tool('admin.agents.update', { agentId, ...fields }),
    addMembership: (organizationId, agentId) => tool('admin.memberships.add', { organizationId, agentId }),
    removeMembership: membershipId => tool('admin.memberships.remove', { membershipId }),
    setInstructions: (organizationId, content) => tool('admin.organizations.instructions_set', { organizationId, content }),
    createGroup: (organizationId, name) => tool('admin.groups.create', { organizationId, name }),
    renameGroup: (groupId, name) => tool('admin.groups.rename', { groupId, name }),
    reorderGroups: (organizationId, groupIds) => tool('admin.groups.reorder', { organizationId, groupIds }),
    deleteGroup: groupId => tool('admin.groups.delete', { groupId }),
    addAppearance: (groupId, membershipId) => tool('admin.appearances.add', { groupId, membershipId }),
    removeAppearance: (groupId, membershipId) => tool('admin.appearances.remove', { groupId, membershipId }),
    reorderAppearances: (groupId, membershipIds) => tool('admin.appearances.reorder', { groupId, membershipIds }),
    setSettings: (target, id, values) => tool('admin.settings.set', { target, id, ...values }),
    clearSettings: (target, id, fields) => tool('admin.settings.clear', { target, id, fields }),
  }
}

/** Every write the tools offer, in one sequence. Returns the organization whose instructions it saved. */
async function script(api, bootstrapOrganizationId) {
  const org = (await api.createOrganization({ name: 'Northwind', description: 'Trading', settings: { ...fixture, effort: { set: 'low' } } })).organization
  const scout = await api.createAgent({ name: 'Scout', description: 'Research', organizationId: org.id, settings: { modelId: { set: 'fixture-model' } } })
  const writer = (await api.createAgent({ name: 'Writer' })).agent
  await api.updateOrganization(org.id, { name: 'Northwind Traders', settings: { effort: { clear: true } } })
  await api.updateAgent(writer.id, { description: 'Drafts', settings: { adapterId: { set: 'deterministic-fixture' } } })
  const joined = (await api.addMembership(org.id, writer.id)).membership
  const elsewhere = (await api.addMembership(bootstrapOrganizationId, writer.id)).membership
  await api.setInstructions(org.id, 'Answer in British English.')
  const research = (await api.createGroup(org.id, 'Research')).group
  const writing = (await api.createGroup(org.id, 'Writing')).group
  await api.renameGroup(writing.id, 'Editorial')
  await api.reorderGroups(org.id, [writing.id, research.id])
  await api.addAppearance(research.id, scout.membership.id)
  await api.addAppearance(research.id, joined.id)
  await api.addAppearance(writing.id, joined.id)
  await api.reorderAppearances(research.id, [joined.id, scout.membership.id])
  await api.removeAppearance(research.id, scout.membership.id)
  await api.deleteGroup(writing.id)
  await api.removeMembership(elsewhere.id)
  await api.setSettings('agent', scout.agent.id, { effort: 'high', options: { temperature: 1 } })
  await api.clearSettings('agent', scout.agent.id, ['options'])
  await api.setSettings('organization', org.id, { effort: 'low' })
  await api.clearSettings('organization', org.id, ['effort'])
  return org
}

/** Replaces IDs by their order of first appearance and drops timestamps and cursors, so two installations compare. */
function normalizer(bootstrap) {
  const ids = new Map([[bootstrap.installationId, 'installation'], [bootstrap.ownerId, 'owner'], [bootstrap.organizationId, 'bootstrap-organization'], [bootstrap.rootAgentId, 'admin-agent']])
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const walk = value => {
    if (typeof value === 'string' && uuid.test(value)) {
      if (!ids.has(value)) ids.set(value, `id-${ids.size}`)
      return ids.get(value)
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['createdAt', 'updatedAt', 'cursor'].includes(key)).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return walk
}

async function recordsAndEvents(ctx, cursor, organizationId) {
  const events = (await ctx.events(cursor)).filter(event => directoryTypes.has(event.type)).map(event => ({ type: event.type, resourceId: event.resourceId, revision: event.revision, data: event.data }))
  const operations = (await ctx.db.query(`SELECT kind, target_kind, target_id, state, options, result FROM kipster.admin_operations
    WHERE kind <> 'organization.instructions' AND created_at >= (SELECT min(created_at) FROM kipster.admin_operations WHERE kind='organization.create') ORDER BY created_at, id`)).rows
  return {
    directory: await ctx.ok('GET', '/v1/directory'),
    settings: await ctx.ok('GET', '/v1/settings'),
    instructions: await ctx.ok('GET', `/v1/organizations/${organizationId}/instructions`),
    homes: (await ctx.db.query('SELECT id FROM kipster.agents WHERE provisioned ORDER BY created_at, id')).rows.length,
    events,
    operations,
  }
}

test('the admin agent gets the tools, and each read matches its HTTP route', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  assert.deepEqual(run.context.tools.filter(tool => tool.name.startsWith('admin_')).map(tool => tool.name), ['admin_operations', 'admin_call'])
  assert.match(run.context.instructions, /kipster-admin: .* File: \/.*\/skills\/kipster-admin\/SKILL\.md/)
  const { organizationId: org, rootAgentId: root } = ctx
  await ctx.ok('PUT', `/v1/organizations/${org}/instructions`, { version: 1, content: 'Be brief.' })

  assert.deepEqual(await run.tool('r1', 'admin.directory.get'), await ctx.ok('GET', '/v1/directory'))
  const directory = await ctx.ok('GET', '/v1/directory')
  const organization = await run.tool('r2', 'admin.organizations.get', { organizationId: org })
  assert.deepEqual(organization.organization, directory.organizations.find(item => item.id === org))
  assert.deepEqual(organization.memberships, directory.memberships.filter(item => item.organizationId === org))
  const agent = await run.tool('r3', 'admin.agents.get', { agentId: root })
  assert.deepEqual(agent.agent, directory.agents.find(item => item.id === root))
  assert.equal(agent.agent.admin, true)
  assert.deepEqual(agent.memberships.map(item => item.organizationId), [org])
  assert.deepEqual(await run.tool('r4', 'admin.organizations.instructions_get', { organizationId: org }), { organizationId: org, content: 'Be brief.' })
  assert.deepEqual(await run.tool('r5', 'admin.settings.list'), await ctx.ok('GET', '/v1/settings'))
  const { version: _v1, ...effective } = await ctx.ok('GET', `/v1/agents/${root}/effective-settings`)
  assert.deepEqual(await run.tool('r6', 'admin.settings.effective', { agentId: root }), { version: 1, ...effective })
  assert.equal(effective.status, 'ready')
  assert.deepEqual(await run.tool('r7', 'admin.settings.effective', { agentId: root, organizationId: org }), await ctx.ok('GET', `/v1/agents/${root}/effective-settings?organizationId=${org}`))
  assert.deepEqual(await run.tool('r8', 'admin.adapters.list'), await ctx.ok('GET', '/v1/execution-adapters'))
  const refreshed = await run.tool('r9', 'admin.adapters.refresh')
  assert.deepEqual(refreshed.adapters.map(item => [item.id, item.available]), [['deterministic-fixture', true]])
  assert.equal(await ctx.operations(), 2, 'reads record no operation')

  // A write returns its operation ID, which reads its state and result.
  const created = await run.tool('w1', 'admin.agents.create', { name: 'Scout', organizationId: org })
  assert.equal(created.operationId, `${run.context.attemptId}:w1`)
  assert.equal(created.alreadyApplied, false)
  assert.equal(created.membership.organizationId, org)
  const status = await run.tool('r10', 'admin.operations.get', { operationId: created.operationId })
  assert.deepEqual({ ...status, createdAt: undefined, updatedAt: undefined }, { operationId: created.operationId, kind: 'agent.create', target: { kind: 'agent', id: created.agent.id }, state: 'succeeded', step: null, waitingFor: null, result: { agent: created.agent, membership: created.membership }, error: null, createdAt: undefined, updatedAt: undefined })
  await assert.rejects(run.tool('r11', 'admin.operations.get', { operationId: 'unknown' }), /Operation not found/)
  const receipt = (await ctx.db.query("SELECT actor_kind, actor_id, operation_id, state FROM kipster.admin_operations WHERE kind='agent.create'")).rows
  assert.deepEqual(receipt, [{ actor_kind: 'agent', actor_id: root, operation_id: `${run.context.attemptId}:w1`, state: 'succeeded' }])
  assert.equal((await readFile(join(ctx.runtime.home.agent(created.agent.id), 'soul.md'), 'utf8')).length > 0, true, 'the new agent has a seeded home')

  // Targets are explicit and arguments are exact.
  await assert.rejects(run.tool('x1', 'admin.agents.get', { agentId: randomUUID() }), /Agent not found/)
  await assert.rejects(run.tool('x2', 'admin.organizations.update', { name: 'No target' }), /Invalid wire value at \$\.arguments\.organizationId/)
  await assert.rejects(run.tool('x3', 'admin.agents.create', { name: 'Scout', operationId: '' }), /Invalid/)
  await assert.rejects(run.tool('x4', 'admin.agents.create', { name: 'Scout', admin: true }), /Invalid wire value/)
  await assert.rejects(run.tool('x5', 'admin.directory.get', { organizationId: org }), /Invalid/)
  await assert.rejects(run.tool('x6', 'admin.agents.unsupported', { agentId: created.agent.id }), /Unknown administration operation agents.unsupported/)
  await assert.rejects(run.tool('x'.repeat(161), 'admin.directory.get'), /Invalid administration call ID/)
  await assert.rejects(run.tool('x7', 'admin.settings.set', { target: 'agent', id: root, options: { set: 'x'.repeat(70000) } }), /Invalid settings.set arguments: too large/)
  await assert.rejects(run.tool('x8', 'admin.organizations.instructions_set', { organizationId: org, content: 'x'.repeat(70000) }), /Instructions|instructions|Invalid/)
  assert.equal(await ctx.operations(), 3)
})

test('tool calls and HTTP requests produce the same records and events', { skip: noDatabase, timeout: 90000 }, async t => {
  const viaHttp = await setup(t)
  const viaTools = await setup(t)
  const httpCursor = (await viaHttp.ok('GET', '/v1/directory')).cursor
  const httpOrganization = await script(httpApi(viaHttp), viaHttp.organizationId)
  const run = await viaTools.start()
  const toolCursor = (await viaTools.ok('GET', '/v1/directory')).cursor
  const results = []
  const toolOrganization = await script(toolApi(run, results), viaTools.organizationId)

  const fromHttp = normalizer(viaHttp.runtime.bootstrap)(await recordsAndEvents(viaHttp, httpCursor, httpOrganization.id))
  const fromTools = normalizer(viaTools.runtime.bootstrap)(await recordsAndEvents(viaTools, toolCursor, toolOrganization.id))
  assert.equal(fromTools.events.length, 29)
  assert.deepEqual(fromTools, fromHttp)

  // Every tool write is recorded under the admin agent with its attempt and call IDs.
  assert.equal(results.length, 23)
  for (const { callId, result } of results) {
    assert.equal(result.operationId, `${run.context.attemptId}:${callId}`)
    assert.equal(result.alreadyApplied, false)
  }
  const receipts = (await viaTools.db.query(`SELECT actor_kind, actor_id, operation_id, state FROM kipster.admin_operations WHERE actor_kind='agent' ORDER BY created_at, id`)).rows
  assert.deepEqual(receipts, results.map(({ callId }) => ({ actor_kind: 'agent', actor_id: viaTools.rootAgentId, operation_id: `${run.context.attemptId}:${callId}`, state: 'succeeded' })))
  assert.equal(await readFile(join(viaTools.runtime.home.organization(toolOrganization.id), 'instructions.md'), 'utf8'), 'Answer in British English.')
})

test('a repeated call ID returns the recorded result and acts once', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const org = ctx.organizationId
  const cursor = (await ctx.ok('GET', '/v1/directory')).cursor
  const agents = () => count(ctx.db, 'SELECT count(*) AS n FROM kipster.agents')

  const concurrent = await Promise.all([1, 2, 3].map(() => run.tool('create', 'admin.agents.create', { name: 'Scout', organizationId: org })))
  assert.equal(new Set(concurrent.map(result => result.agent.id)).size, 1)
  assert.equal(concurrent.filter(result => !result.alreadyApplied).length, 1)
  const before = await agents()
  await assert.rejects(run.tool('create', 'admin.agents.create', { name: 'Someone else' }), /different request/)
  const replay = await run.tool('create', 'admin.agents.create', { name: 'Scout', organizationId: org })
  assert.equal(replay.alreadyApplied, true)
  assert.deepEqual({ ...replay, alreadyApplied: false }, concurrent.find(result => !result.alreadyApplied))
  assert.equal(await agents(), before)

  const scout = replay.agent.id
  await run.tool('rename-1', 'admin.agents.update', { agentId: scout, name: 'Scout One' })
  await run.tool('rename-2', 'admin.agents.update', { agentId: scout, name: 'Scout Two' })
  assert.equal((await run.tool('rename-1', 'admin.agents.update', { agentId: scout, name: 'Scout One' })).agent.name, 'Scout One')
  assert.equal((await run.tool('r', 'admin.agents.get', { agentId: scout })).agent.name, 'Scout Two', 'a replay does not apply again')

  await run.tool('save-1', 'admin.organizations.instructions_set', { organizationId: org, content: 'First' })
  await run.tool('save-2', 'admin.organizations.instructions_set', { organizationId: org, content: 'Second' })
  const saved = await run.tool('save-1', 'admin.organizations.instructions_set', { organizationId: org, content: 'First' })
  assert.deepEqual(saved, { operationId: `${run.context.attemptId}:save-1`, alreadyApplied: true, instructions: { organizationId: org, bytes: 5 } })
  assert.equal((await ctx.ok('GET', `/v1/organizations/${org}/instructions`)).content, 'Second')

  const removed = await run.tool('remove', 'admin.memberships.remove', { membershipId: replay.membership.id })
  await run.tool('add-again', 'admin.memberships.add', { organizationId: org, agentId: scout })
  assert.deepEqual(await run.tool('remove', 'admin.memberships.remove', { membershipId: replay.membership.id }), { ...removed, alreadyApplied: true })
  assert.equal((await run.tool('r2', 'admin.agents.get', { agentId: scout })).memberships.length, 1, 'the replayed removal leaves the new membership')

  await run.tool('effort', 'admin.settings.set', { target: 'agent', id: scout, effort: 'low' })
  await assert.rejects(run.tool('effort', 'admin.settings.set', { target: 'agent', id: scout, effort: 'high' }), /different request/)
  await assert.rejects(run.tool('effort', 'admin.groups.create', { organizationId: org, name: 'Research' }), /already used for a different request/)
  await assert.rejects(run.tool('rename-1', 'admin.agents.update', { agentId: ctx.rootAgentId, name: 'Other target' }), /already used for a different request/)

  // One event per applied change; replays publish nothing.
  const events = (await ctx.events(cursor)).filter(event => directoryTypes.has(event.type))
  assert.deepEqual(events.map(event => event.type), [
    'agent-changed', 'settings-changed', 'membership-changed',
    'agent-changed', 'agent-changed',
    'membership-removed', 'membership-changed',
    'settings-changed',
  ])
  assert.equal(await count(ctx.db, "SELECT count(*) AS n FROM kipster.admin_operations WHERE actor_kind='agent'"), 8)
})

test('an ordinary agent is not offered the tools and is refused when it calls one', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const org = ctx.organizationId
  const scout = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Scout', organizationId: org })).agent.id
  const run = await ctx.start(scout, { kind: 'organization', organizationId: org })
  assert.equal(run.context.tools.some(tool => tool.name.startsWith('admin_')), false)
  assert.doesNotMatch(run.context.instructions, /kipster-admin/)
  const operations = await ctx.operations()
  const directory = await ctx.ok('GET', '/v1/directory')
  for (const name of toolNames) await assert.rejects(run.tool(`call-${name}`, name, {}), /Administration access denied/, name)
  await assert.rejects(run.tool('list', 'admin_operations', {}), /Administration access denied/)
  await assert.rejects(run.tool('create', 'admin.agents.create', { name: 'Rogue', organizationId: org }), /Administration access denied/)
  assert.equal(await ctx.operations(), operations)
  assert.deepEqual(await ctx.ok('GET', '/v1/directory'), directory)

})

test('the admin agent has no administration tools in an organization chat', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const org = ctx.organizationId
  const admin = await ctx.start(ctx.rootAgentId, { kind: 'organization', organizationId: org })
  assert.equal(admin.context.tools.some(tool => tool.name.startsWith('admin_')), false)
  const operations = await ctx.operations()
  for (const name of toolNames) await assert.rejects(admin.tool(`call-${name}`, name, {}), /Administration access denied/, name)
  await assert.rejects(admin.tool('create', 'admin.agents.create', { name: 'From the organization chat', organizationId: org }), /Administration access denied/)
  assert.equal(await ctx.operations(), operations)
  assert.equal(await count(ctx.db, "SELECT count(*) AS n FROM kipster.agents WHERE display_name='From the organization chat'"), 0)
  // The same agent in its installation chat has them.
  const installation = await ctx.start()
  assert.equal(installation.context.tools.some(tool => tool.name === 'admin_call'), true)
  assert.equal((await installation.tool('list', 'admin.directory.get')).agents.length, 1)
})

test('a run waiting on a person, or delegated work, cannot use the tools', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const operations = await ctx.operations()

  // After an approval request or a question the attempt still runs, but its run waits on the owner.
  for (const [name, args] of [['interactions_request_approval', { prompt: 'Create Alpha?', proposalId: 'alpha', proposal: 'Create the organization Alpha' }], ['interactions_ask', { prompt: 'Which name?', options: [{ id: 'a', label: 'Alpha' }], freeText: false }]]) {
    const run = await ctx.start()
    await run.tool('ask', name, args)
    assert.equal((await ctx.db.query('SELECT r.state, a.state AS attempt FROM kipster.text_runs r JOIN kipster.attempts a ON a.id=r.current_attempt_id WHERE r.id=$1', [run.runId])).rows[0].state, 'waiting')
    for (const tool of toolNames) await assert.rejects(run.tool(`waiting-${tool}`, tool, {}), /Attempt no longer owns administration tools/, tool)
    await assert.rejects(run.tool('create', 'admin.organizations.create', { name: 'Alpha' }), /no longer owns/)
  }
  assert.equal(await ctx.operations(), operations)
  assert.equal(await count(ctx.db, "SELECT count(*) AS n FROM kipster.organizations WHERE display_name='Alpha'"), 0)

  // A second admin agent that receives delegated work in the installation gets no tools there.
  const second = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Second admin', settings: fixture })).agent.id
  await ctx.db.query("INSERT INTO kipster.agent_roles(agent_id, role) VALUES ($1, 'root-admin')", [second])
  const recorded = await ctx.operations()
  const parent = await ctx.start()
  const delegation = await parent.tool('delegate', 'agents_delegate', { recipientId: second, request: 'Create an organization' })
  parent.handle.release({ kind: 'ended', attemptId: parent.context.attemptId, confirmed: true })
  const child = await until(() => ctx.executions.find(e => e.context.runId === delegation.childRunId), Boolean, 'delegated execution')
  assert.equal(child.context.agentId, second)
  assert.equal(child.context.tools.some(tool => tool.name.startsWith('admin_')), false)
  for (const tool of toolNames) await assert.rejects(toolCall(child, `child-${tool}`, tool, {}), /Administration access denied/, tool)
  await assert.rejects(toolCall(child, 'create', 'admin.organizations.create', { operationId: 'delegated-create', name: 'From delegated work' }), /Administration access denied/)
  assert.equal(await ctx.operations(), recorded)
})

test('a stopped, ended or superseded attempt cannot use the tools', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const org = ctx.organizationId
  const locks = new Postgres(ctx.url)
  ctx.closers.push(() => locks.close())
  const hold = work => {
    let release, ready
    const released = new Promise(resolve => { release = resolve })
    const holding = new Promise(resolve => { ready = resolve })
    const done = locks.transaction(async client => { await work(client); ready(); await released })
    ctx.closers.push(async () => { release(); await done.catch(() => undefined) })
    return { holding, release, done }
  }
  const lockWaiters = n => until(() => count(ctx.db, `SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`), value => value >= n, `${n} lock waiters`)
  const name = async () => (await ctx.ok('GET', '/v1/directory')).organizations.find(item => item.id === org).name

  // A write that holds the execution lock first commits; the Stop waits for it.
  const first = await ctx.start()
  const blocker = hold(client => client.query('SELECT 1 FROM kipster.organizations WHERE id=$1 FOR UPDATE', [org]))
  await blocker.holding
  const write = first.tool('rename', 'admin.organizations.update', { organizationId: org, name: 'Renamed before the stop' })
  await lockWaiters(1)
  const stop = ctx.control(first, 'stop')
  await lockWaiters(2)
  blocker.release()
  assert.equal((await write).organization.name, 'Renamed before the stop')
  assert.equal((await stop).data.outcome, 'accepted')
  assert.equal(await name(), 'Renamed before the stop')
  const operations = await ctx.operations()
  for (const tool of toolNames) await assert.rejects(first.tool(`after-${tool}`, tool, {}), /Attempt no longer owns administration tools/, tool)
  await assert.rejects(first.tool('rename-2', 'admin.organizations.update', { organizationId: org, name: 'After the stop' }), /no longer owns/)
  await assert.rejects(first.tool('rename', 'admin.organizations.update', { organizationId: org, name: 'Renamed before the stop' }), /no longer owns/, 'a stopped attempt gets no replay either')

  // A Stop that commits while the call waits refuses the call, and nothing is recorded.
  const second = await ctx.start()
  const stopping = hold(client => client.query('UPDATE kipster.text_runs SET stop_requested=true WHERE id=$1', [second.runId]))
  await stopping.holding
  const refused = second.tool('create', 'admin.agents.create', { name: 'Late', organizationId: org })
  await lockWaiters(1)
  stopping.release()
  await assert.rejects(refused, /no longer owns/)
  assert.equal(await ctx.operations(), operations)
  assert.equal(await count(ctx.db, "SELECT count(*) AS n FROM kipster.agents WHERE display_name='Late'"), 0)

  // An attempt that ended cannot call; after a failure and Retry, only the new attempt can.
  const third = await ctx.start()
  third.handle.release({ kind: 'failed', attemptId: third.context.attemptId, confirmedEnded: true, message: 'provider failed' })
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [third.runId])).rows[0].state, state => state === 'failed', 'failed run')
  await assert.rejects(third.tool('read', 'admin.directory.get'), /no longer owns/)
  assert.equal((await ctx.control(third, 'retry')).data.outcome, 'accepted')
  const retried = await until(() => ctx.executions.find(e => e.context.runId === third.runId && e.context.attemptId !== third.context.attemptId), Boolean, 'retried attempt')
  await assert.rejects(third.tool('rename-3', 'admin.organizations.update', { organizationId: org, name: 'From the old attempt' }), /no longer owns/)
  assert.equal((await toolCall(retried, 'rename-3', 'admin.organizations.update', { operationId: 'rename-retry', organizationId: org, name: 'From the new attempt' })).organization.name, 'From the new attempt')
  assert.equal(await ctx.operations(), operations + 1)
})

test('destructive admin requests bind Core approval cards to immutable targets; denial, cancellation and replay cannot act', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const create = async name => (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name })).agent.id
  const target = await create('Same name'), other = await create('Same name')
  const lifecycle = async id => (await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [id])).rows[0].lifecycle
  const cardOf = async id => (await ctx.db.query('SELECT * FROM kipster.interactions WHERE id=$1', [id])).rows[0]
  const answer = (run, card, kind, extra = {}) => ctx.call('POST', '/v1/work/interactions/answer', {
    version: 1, operationId: randomUUID(), interactionId: card.id, threadId: run.threadId, runId: run.runId,
    attemptId: run.context.attemptId, proposalId: card.proposal_id, answer: { kind }, ...extra,
  })
  const denied = await ctx.start()
  const request = await denied.tool('deny', 'admin.agents.archive', { agentId: target })
  const card = await cardOf(request.interactionId)
  assert.match(card.proposal, new RegExp(target)); assert.match(card.proposal, /Same name/)
  assert.equal(await lifecycle(target), 'active')
  assert.equal((await answer(denied, card, 'decline')).data.outcome, 'accepted')
  assert.equal(await lifecycle(target), 'active')
  assert.equal((await answer(denied, card, 'approve')).data.outcome, 'rejected')
  denied.handle.release({ kind: 'ended', attemptId: denied.context.attemptId, confirmed: true })

  const cancelled = await ctx.start()
  const pending = await cancelled.tool('cancel', 'admin.agents.archive', { agentId: target })
  await ctx.control(cancelled, 'stop')
  assert.equal((await answer(cancelled, await cardOf(pending.interactionId), 'approve')).data.outcome, 'rejected')
  assert.equal(await lifecycle(target), 'active')
  cancelled.handle.release({ kind: 'ended', attemptId: cancelled.context.attemptId, confirmed: true })

  const root = await ctx.start()
  await assert.rejects(root.tool('self', 'admin.agents.archive', { agentId: ctx.rootAgentId }), /denied/)
  await assert.rejects(root.tool('active', 'admin.agents.delete', { agentId: target }), /archived/)
  const approved = await root.tool('archive', 'admin.agents.archive', { agentId: target })
  const bound = await cardOf(approved.interactionId)
  await ctx.ok('PUT', `/v1/agents/${target}`, { version: 1, operationId: randomUUID(), name: 'Renamed' })
  assert.equal((await answer(root, bound, 'approve', { proposalId: randomUUID() })).data.outcome, 'rejected')
  assert.equal((await answer(root, bound, 'approve')).data.outcome, 'accepted')
  assert.equal(await lifecycle(target), 'archived'); assert.equal(await lifecycle(other), 'active')
  assert.equal((await answer(root, bound, 'approve')).data.outcome, 'rejected')
  root.handle.release({ kind: 'ended', attemptId: root.context.attemptId, confirmed: true })

  const deleting = await ctx.start()
  const archivedStatus = await deleting.tool('archive-status', 'admin.operations.get', { operationId: approved.operationId })
  assert.equal(archivedStatus.state, 'succeeded')
  assert.equal(archivedStatus.target.id, target)
  const deletion = await deleting.tool('delete', 'admin.agents.delete', { agentId: target, copyFilesToOrganizations: true })
  assert.equal(await lifecycle(target), 'archived')
  assert.equal((await answer(deleting, await cardOf(deletion.interactionId), 'approve')).data.outcome, 'accepted')
  await until(() => lifecycle(target), state => state === 'deleted', 'approved deletion')
  assert.equal(await lifecycle(other), 'active')
  deleting.handle.release({ kind: 'ended', attemptId: deleting.context.attemptId, confirmed: true })

  const orgRun = await ctx.start()
  const org = await orgRun.tool('org', 'admin.organizations.delete', { organizationId: ctx.organizationId })
  assert.equal((await answer(orgRun, await cardOf(org.interactionId), 'approve')).data.outcome, 'accepted')
  await until(async () => (await ctx.db.query('SELECT lifecycle FROM kipster.organizations WHERE id=$1', [ctx.organizationId])).rows[0].lifecycle, state => state === 'deleted', 'approved organization deletion')
  orgRun.handle.release({ kind: 'ended', attemptId: orgRun.context.attemptId, confirmed: true })
})

test('approval binding and accepted action survive SIGKILL before and after the human response commit', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const target = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Durable target' })).agent.id
  const run = await ctx.start()
  const requested = await run.tool('durable', 'admin.agents.archive', { agentId: target })
  const card = (await ctx.db.query('SELECT * FROM kipster.interactions WHERE id=$1', [requested.interactionId])).rows[0]
  run.handle.release({ kind: 'ended', attemptId: run.context.attemptId, confirmed: true })
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.attempts WHERE id=$1', [run.context.attemptId])).rows[0].state, s => s === 'settled', 'approval provider ended')
  await ctx.dispatcher.close()
  const request = { operationId: randomUUID(), interactionId: card.id, threadId: run.threadId, runId: run.runId, attemptId: run.context.attemptId, proposalId: card.proposal_id, answer: { kind: 'approve' } }
  const crash = boundary => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./fixtures/approval-crash.mjs', import.meta.url).pathname, ctx.url, ctx.runtime.home.root, JSON.stringify(request), boundary], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(await crash('before'), { code: null, signal: 'SIGKILL' })
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [target])).rows[0].lifecycle, 'active')
  assert.equal((await ctx.db.query('SELECT state FROM kipster.interactions WHERE id=$1', [card.id])).rows[0].state, 'pending')
  assert.deepEqual(await crash('after'), { code: null, signal: 'SIGKILL' })
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [target])).rows[0].lifecycle, 'archived')
  assert.deepEqual(await crash('never'), { code: 0, signal: null })
  assert.equal((await ctx.db.query("SELECT count(*)::int n FROM kipster.admin_operations WHERE kind='agent.archive' AND target_id=$1", [target])).rows[0].n, 1)
})


test('stable administration identities reconcile committed creates after reply loss and runtime restart', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const operationId = randomUUID()
  // The provider loses the reply; only the durable database receipt is retained by the test.
  await run.tool('old-provider-call', 'admin.agents.create', { operationId, name: 'Saved create' })
  const original = (await ctx.db.query('SELECT result FROM kipster.admin_operations WHERE operation_id=$1', [operationId])).rows[0].result
  run.handle.release({ kind: 'failed', attemptId: run.context.attemptId, confirmedEnded: true, message: 'reply lost' })
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [run.runId])).rows[0].state, state => state === 'failed', 'failed attempt')
  await ctx.server.close(); await ctx.dispatcher.close(); await ctx.runtime.close()
  const runtime = await openRuntime({ connectionString: ctx.url, home: ctx.runtime.home.root, names, executionLimit: 4 })
  ctx.closers.push(() => runtime.close())
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(context) { const handle = await inner.execute(context); executions.push({ context, handle }); return handle } })
  ctx.closers.push(() => dispatcher.close())
  await dispatcher.start()
  const actor = { installationId: ctx.installationId, personId: ctx.ownerId }
  await dispatcher.control(actor, { operationId: randomUUID(), context: run.chat, chatId: run.chatId, threadId: run.threadId, runId: run.runId, attemptId: run.context.attemptId, action: 'retry' })
  const retry = await until(() => executions.find(e => e.context.runId === run.runId), Boolean, 'retry after restart')
  assert.deepEqual(retry.context.administrationReceipts.receipts.find(r => r.operationId === operationId).result, original)
  const replay = await toolCall(retry, 'new-provider-call', 'admin.agents.create', { operationId, name: 'Saved create' })
  assert.equal(replay.agent.id, original.agent.id)
  assert.equal(replay.alreadyApplied, true)
  const distinct = await toolCall(retry, 'intentional-create', 'admin.agents.create', { operationId: randomUUID(), name: 'Saved create' })
  assert.notEqual(distinct.agent.id, original.agent.id)
  await assert.rejects(toolCall(retry, 'changed', 'admin.agents.create', { operationId, name: 'Changed' }), /different request/)
  await assert.rejects(dispatcher.adminTool(run.context.attemptId, 'stale', 'admin_call', { operation: 'agents.create', operationId, arguments: { name: 'Saved create' } }), /no longer owns/)
  assert.equal(Number((await runtime.db.query("SELECT count(*) FROM kipster.agents WHERE display_name='Saved create'")).rows[0].count), 2)
})

test('instruction staging does not hold the installation execution lock and rechecks lifecycle', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const home = ctx.runtime.home
  const prepare = home.prepareOrganizationInstructions.bind(home)
  let arrived, release
  const waiting = new Promise(resolve => { arrived = resolve })
  const gate = new Promise(resolve => { release = resolve })
  home.prepareOrganizationInstructions = async (...args) => { const staged = await prepare(...args); arrived(); await gate; return staged }
  ctx.closers.push(async () => { release(); home.prepareOrganizationInstructions = prepare })
  const saving = run.tool('instructions', 'admin.organizations.instructions_set', { organizationId: ctx.organizationId, content: 'Staged rules' })
  await waiting
  await ctx.db.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='500ms'")
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.installationId])
    await client.query("UPDATE kipster.organizations SET lifecycle='deleting' WHERE id=$1", [ctx.organizationId])
  })
  release()
  await assert.rejects(saving, /Organization not found/)
  assert.equal(await readFile(join(home.organization(ctx.organizationId), 'instructions.md'), 'utf8'), '# Organization instructions\n')
})

test('the catalog lists every operation by area and describes its arguments', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const listing = await run.tool('list', 'admin_operations', {})
  assert.deepEqual(listing.areas.map(area => area.area), ['directory', 'organizations', 'agents', 'identity', 'memberships', 'groups', 'settings', 'adapters', 'permissions', 'learning', 'interface', 'updates', 'operations'])
  const listed = listing.areas.flatMap(area => area.operations.map(item => item.operation))
  for (const name of toolNames) assert.ok(listed.includes(name.slice('admin.'.length)), name)
  for (const name of ['identity.set', 'learning.agent_set', 'interface.set', 'updates.install', 'updates.settings_set']) assert.ok(listed.includes(name), name)
  assert.deepEqual((await run.tool('area', 'admin_operations', { area: 'interface' })).areas.map(area => area.operations.map(item => item.operation)), [['interface.get', 'interface.set']])

  const identity = await run.tool('describe', 'admin_operations', { operation: 'identity.set' })
  assert.equal(identity.kind, 'write'); assert.equal(identity.operationId, 'not used')
  assert.deepEqual(identity.arguments.required, ['agentId', 'file', 'content', 'expectedSha256'])
  assert.deepEqual(identity.arguments.properties.file, { enum: ['AGENTS.md', 'soul.md', 'identity.md'] })
  assert.equal(identity.arguments.additionalProperties, false)
  const create = await run.tool('describe-create', 'admin_operations', { operation: 'agents.create' })
  assert.equal(create.operationId, 'required')
  assert.deepEqual(create.arguments.required, ['name'])
  assert.equal(create.arguments.properties.version, undefined, 'Core supplies the protocol version')
  assert.equal((await run.tool('describe-delete', 'admin_operations', { operation: 'agents.delete' })).kind, 'approval')
  await assert.rejects(run.tool('unknown', 'admin_operations', { operation: 'nothing.here' }), /Unknown administration operation nothing.here/)
  await assert.rejects(run.tool('needs-id', 'admin_call', { operation: 'agents.create', arguments: { name: 'No ID' } }), /agents.create needs an operationId/)
  assert.equal(await ctx.operations(), 2, 'listing and refused calls record nothing')
})

test('learning, interface, identity and update reads and writes match their HTTP routes', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const cursor = (await ctx.ok('GET', '/v1/directory')).cursor
  const scout = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Scout' })).agent.id

  // Learning
  const { version: _l, ...learning } = await ctx.ok('GET', '/v1/settings/learning')
  assert.deepEqual(await run.tool('learning', 'admin.learning.get'), learning)
  const sleep = await run.tool('sleep', 'admin.learning.set', { sleepTime: '04:30' })
  assert.equal(sleep.sleepTime, '04:30')
  assert.equal((await ctx.ok('GET', '/v1/settings/learning')).sleepTime, '04:30')
  const agentSleep = await run.tool('agent-sleep', 'admin.learning.agent_set', { agentId: scout, sleepTime: '01:15', enabled: false })
  assert.deepEqual([agentSleep.sleepTime, agentSleep.enabled], ['01:15', false])
  await assert.rejects(run.tool('bad-sleep', 'admin.learning.set', { sleepTime: '25:00' }), /Invalid wire value/)

  // Interface
  assert.deepEqual(await run.tool('look', 'admin.interface.get'), await ctx.ok('GET', '/v1/settings/interface'))
  assert.deepEqual(await run.tool('look-0', 'admin.interface.get'), { version: 1, revision: 0, palette: null, theme: null, desktopNotifications: null, notifyNeeds: null, notifyFailures: null, notifyReplies: null, inAppBanners: null, dockBadge: null })
  const dark = await run.tool('dark', 'admin.interface.set', { theme: 'dark', desktopNotifications: true, inAppBanners: true })
  assert.deepEqual(dark, { version: 1, revision: 1, palette: null, theme: 'dark', desktopNotifications: true, notifyNeeds: null, notifyFailures: null, notifyReplies: null, inAppBanners: true, dockBadge: null })
  assert.deepEqual(await run.tool('dark-again', 'admin.interface.set', { theme: 'dark' }), dark, 'saving the current value changes nothing')
  assert.deepEqual(await ctx.ok('PUT', '/v1/settings/interface', { version: 1, palette: 'pine' }), { ...dark, revision: 2, palette: 'pine' })
  await assert.rejects(run.tool('bad-theme', 'admin.interface.set', { theme: 'sepia' }), /Invalid wire value/)
  await assert.rejects(run.tool('no-change', 'admin.interface.set', {}), /no change given/)
  assert.equal((await ctx.call('PUT', '/v1/settings/interface', { version: 1, palette: 'neon' })).status, 400)

  // Identity files of another kip
  const soul = await run.tool('soul', 'admin.identity.get', { agentId: scout, file: 'soul.md' })
  assert.deepEqual(soul, await ctx.ok('GET', `/v1/agents/${scout}/identity/soul.md`))
  const saved = await run.tool('soul-set', 'admin.identity.set', { agentId: scout, file: 'soul.md', content: '# Soul\n\nCurious and precise.\n', expectedSha256: soul.sha256 })
  assert.equal(saved.content, '# Soul\n\nCurious and precise.\n')
  assert.equal(await readFile(join(ctx.runtime.home.agent(scout), 'soul.md'), 'utf8'), '# Soul\n\nCurious and precise.\n')
  await assert.rejects(run.tool('soul-stale', 'admin.identity.set', { agentId: scout, file: 'soul.md', content: 'Stale', expectedSha256: soul.sha256 }), /changed|conflict/i)
  const backups = await run.tool('backups', 'admin.identity.backups', { agentId: scout, file: 'soul.md' })
  assert.equal(backups.backups.length, 1)
  assert.equal((await run.tool('backup', 'admin.identity.backup_get', { agentId: scout, file: 'soul.md', backupId: backups.backups[0].id })).content, soul.content)
  const restored = await run.tool('restore', 'admin.identity.restore', { agentId: scout, file: 'soul.md', backupId: backups.backups[0].id, expectedSha256: saved.sha256 })
  assert.equal(restored.content, soul.content)
  const own = await run.tool('own', 'admin.identity.get', { agentId: ctx.rootAgentId, file: 'AGENTS.md' })
  await run.tool('own-set', 'admin.identity.set', { agentId: ctx.rootAgentId, file: 'AGENTS.md', content: `${own.content}\n- Answer in one paragraph.\n`, expectedSha256: own.sha256 })

  // Updates
  assert.deepEqual(await run.tool('updates', 'admin.updates.get'), await ctx.ok('GET', '/v1/updates'))
  const channel = await run.tool('channel', 'admin.updates.settings_set', { channel: 'next' })
  assert.deepEqual([channel.channel, channel.mode], ['next', 'automatic'])
  assert.deepEqual(await ctx.ok('GET', '/v1/settings/updates'), { version: 1, channel: 'next', mode: 'automatic' })
  await assert.rejects(run.tool('install', 'admin.updates.install', { target: '9.9.9' }), /managed updater/)

  // Every change reached the application stream.
  const types = (await ctx.events(cursor)).map(event => event.type)
  for (const type of ['learning-changed', 'interface-changed', 'identity-changed', 'updates-changed']) assert.ok(types.includes(type), type)
  assert.equal(types.filter(type => type === 'interface-changed').length, 2)
  assert.equal(types.filter(type => type === 'identity-changed').length, 3)
  const receipts = (await ctx.db.query("SELECT kind, actor_kind FROM kipster.admin_operations WHERE kind='updates.settings'")).rows
  assert.deepEqual(receipts, [{ kind: 'updates.settings', actor_kind: 'agent' }])
})

test('saving workspace instructions or an identity file over HTTP publishes a change event', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const cursor = (await ctx.ok('GET', '/v1/directory')).cursor
  await ctx.ok('PUT', `/v1/organizations/${ctx.organizationId}/instructions`, { version: 1, content: 'Be kind.' })
  const file = await ctx.ok('GET', `/v1/agents/${ctx.rootAgentId}/identity/identity.md`)
  const saved = await ctx.ok('PUT', `/v1/agents/${ctx.rootAgentId}/identity/identity.md`, { version: 1, content: 'I am Kip.\n', expectedSha256: file.sha256 })
  const events = (await ctx.events(cursor)).filter(event => ['instructions-changed', 'identity-changed'].includes(event.type))
  assert.deepEqual(events.map(event => [event.type, event.resourceId, event.data]), [
    ['instructions-changed', ctx.organizationId, { organizationId: ctx.organizationId }],
    ['identity-changed', ctx.rootAgentId, { agentId: ctx.rootAgentId, file: 'identity.md', sha256: saved.sha256 }],
  ])
})

test('the permission mode is saved in Core, published, and given to the next execution of every kip', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const cursor = (await ctx.ok('GET', '/v1/directory')).cursor
  assert.equal((await ctx.ok('GET', '/v1/bootstrap')).capabilities.permissionModes, true)
  assert.deepEqual(await ctx.ok('GET', '/v1/settings/permissions'), { version: 1, revision: 0, mode: 'auto', alwaysAllowed: [] })

  const first = await ctx.start()
  assert.equal(first.context.permissionMode, 'auto', 'a new installation runs in auto')
  assert.deepEqual(await first.tool('read', 'admin.permissions.get'), { version: 1, revision: 0, mode: 'auto', alwaysAllowed: [] })
  assert.deepEqual(await first.tool('edits', 'admin.permissions.set', { mode: 'acceptEdits' }), { version: 1, revision: 1, mode: 'acceptEdits', alwaysAllowed: [] })
  assert.deepEqual(await ctx.ok('PUT', '/v1/settings/permissions', { version: 1, mode: 'supervised' }), { version: 1, revision: 2, mode: 'supervised', alwaysAllowed: [] })
  assert.deepEqual(await ctx.ok('PUT', '/v1/settings/permissions', { version: 1, mode: 'supervised' }), { version: 1, revision: 2, mode: 'supervised', alwaysAllowed: [] }, 'saving the current mode changes nothing')
  assert.deepEqual(await first.tool('forget', 'admin.permissions.set', { removeAlwaysAllowed: ['00000000-0000-4000-8000-000000000000'] }), { version: 1, revision: 2, mode: 'supervised', alwaysAllowed: [] }, 'Kip can remove always-allowed actions; an unknown one changes nothing')
  assert.equal((await ctx.call('PUT', '/v1/settings/permissions', { version: 1, mode: 'yolo' })).status, 400)
  assert.equal((await ctx.call('PUT', '/v1/settings/permissions', { version: 1 })).status, 400)
  await assert.rejects(first.tool('bad', 'admin.permissions.set', { mode: 'everything' }), /Invalid wire value/)
  first.handle.release({ kind: 'ended', attemptId: first.context.attemptId, confirmed: true })

  const second = await ctx.start()
  assert.equal(second.context.permissionMode, 'supervised', 'the next execution uses the saved mode')

  // Kip asks the owner before giving every kip full access, as the interface asks the person to confirm.
  const requested = await second.tool('full', 'admin.permissions.set', { mode: 'fullAccess' })
  assert.equal(requested.status, 'pending')
  const card = (await ctx.db.query('SELECT * FROM kipster.interactions WHERE id=$1', [requested.interactionId])).rows[0]
  assert.equal(card.prompt, 'Give kips full access?')
  assert.match(card.proposal, /Supervised → Full access/)
  assert.equal((await ctx.ok('GET', '/v1/settings/permissions')).mode, 'supervised', 'nothing changes before the owner answers')
  const answer = kind => ctx.call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.id, threadId: second.threadId, runId: second.runId, attemptId: second.context.attemptId, proposalId: card.proposal_id, answer: { kind } })
  assert.equal((await answer('approve')).data.outcome, 'accepted')
  assert.deepEqual(await ctx.ok('GET', '/v1/settings/permissions'), { version: 1, revision: 3, mode: 'fullAccess', alwaysAllowed: [] })
  assert.equal((await ctx.db.query('SELECT result FROM kipster.admin_approvals WHERE interaction_id=$1', [card.id])).rows[0].result.mode, 'fullAccess')
  second.handle.release({ kind: 'ended', attemptId: second.context.attemptId, confirmed: true })
  const third = await ctx.start()
  assert.equal(third.context.permissionMode, 'fullAccess')
  third.handle.release({ kind: 'ended', attemptId: third.context.attemptId, confirmed: true })

  const changes = (await ctx.events(cursor)).filter(event => event.type === 'permissions-changed')
  assert.deepEqual(changes.map(event => [event.resourceId, event.revision, event.data]), [
    [ctx.installationId, 1, { revision: 1, mode: 'acceptEdits', alwaysAllowed: [] }],
    [ctx.installationId, 2, { revision: 2, mode: 'supervised', alwaysAllowed: [] }],
    [ctx.installationId, 3, { revision: 3, mode: 'fullAccess', alwaysAllowed: [] }],
  ])
})

test('a declined full access request leaves the permission mode unchanged', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start()
  const requested = await run.tool('full', 'admin.permissions.set', { mode: 'fullAccess' })
  const card = (await ctx.db.query('SELECT * FROM kipster.interactions WHERE id=$1', [requested.interactionId])).rows[0]
  const answer = await ctx.call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.id, threadId: run.threadId, runId: run.runId, attemptId: run.context.attemptId, proposalId: card.proposal_id, answer: { kind: 'decline' } })
  assert.equal(answer.data.outcome, 'accepted')
  assert.deepEqual(await ctx.ok('GET', '/v1/settings/permissions'), { version: 1, revision: 0, mode: 'auto', alwaysAllowed: [] })
  run.handle.release({ kind: 'ended', attemptId: run.context.attemptId, confirmed: true })
})

test('installing a Core version waits for the owner, then starts once', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t, { managed: true, coreVersion: '1.2.0' })
  const run = await ctx.start()
  await assert.rejects(run.tool('same', 'admin.updates.install', { target: '1.2.0' }), /already installed/)
  await assert.rejects(run.tool('older', 'admin.updates.install', { target: '1.1.0' }), /requires a backup/)
  const requested = await run.tool('install', 'admin.updates.install', { target: '1.3.0' })
  assert.equal(requested.status, 'pending')
  const card = (await ctx.db.query('SELECT * FROM kipster.interactions WHERE id=$1', [requested.interactionId])).rows[0]
  assert.equal(card.prompt, 'Install Kipster Core 1.3.0?')
  assert.match(card.proposal, /1\.2\.0 → 1\.3\.0/)
  const requests = () => ctx.db.query('SELECT request FROM kipster.update_requests').then(result => result.rows.map(row => row.request))
  assert.deepEqual(await requests(), [], 'nothing installs before the owner answers')
  const answer = () => ctx.call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.id, threadId: run.threadId, runId: run.runId, attemptId: run.context.attemptId, proposalId: card.proposal_id, answer: { kind: 'approve' } })
  assert.equal((await answer()).data.outcome, 'accepted')
  const [request] = await requests()
  assert.deepEqual([request.action, request.target, request.reason, request.id], ['install', '1.3.0', 'manual', (await ctx.db.query("SELECT id FROM kipster.admin_operations WHERE kind='updates.install'")).rows[0].id])
  const binding = (await ctx.db.query('SELECT result FROM kipster.admin_approvals WHERE interaction_id=$1', [card.id])).rows[0]
  assert.equal(binding.result.core.pinned, '1.3.0')
  assert.equal((await answer()).data.outcome, 'rejected')
  assert.equal((await requests()).length, 1, 'an answered card installs once')
  run.handle.release({ kind: 'ended', attemptId: run.context.attemptId, confirmed: true })
})
