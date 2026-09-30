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

// The admin agent administers the installation through `admin.*` tool calls, which the deterministic
// fixture adapter makes through the Core tool host against real PostgreSQL.

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
async function setup(t) {
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
  const runtime = await openRuntime({ connectionString: url.href, home, names, executionLimit: 4 })
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
      return { ...execution, chat: context, chatId, runId: accepted.runId, threadId: accepted.threadId, tool: (callId, toolName, args = {}) => execution.handle.callTool(callId, toolName, (/\.(create|update|restore|add|remove|rename|reorder|instructions_set|set|clear)$/.test(toolName) || toolName === 'admin.groups.delete') ? { operationId: `${execution.context.attemptId}:${callId}`, ...args } : args) }
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
  assert.equal(run.context.administrationEnabled, true)
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
  await assert.rejects(run.tool('x2', 'admin.organizations.update', { name: 'No target' }), /Invalid admin.organizations.update arguments/)
  await assert.rejects(run.tool('x3', 'admin.agents.create', { name: 'Scout', operationId: '' }), /Invalid/)
  await assert.rejects(run.tool('x4', 'admin.agents.create', { name: 'Scout', admin: true }), /Invalid wire value/)
  await assert.rejects(run.tool('x5', 'admin.directory.get', { organizationId: org }), /Invalid/)
  await assert.rejects(run.tool('x6', 'admin.agents.unsupported', { agentId: created.agent.id }), /Unsupported administration tool/)
  await assert.rejects(run.tool('x'.repeat(161), 'admin.directory.get'), /Invalid administration call ID/)
  await assert.rejects(run.tool('x7', 'admin.settings.set', { target: 'agent', id: root, options: { set: 'x'.repeat(70000) } }), /Invalid admin.settings.set arguments/)
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
  assert.equal(run.context.administrationEnabled, false)
  const operations = await ctx.operations()
  const directory = await ctx.ok('GET', '/v1/directory')
  for (const name of toolNames) await assert.rejects(run.tool(`call-${name}`, name, {}), /Administration access denied/, name)
  await assert.rejects(run.tool('create', 'admin.agents.create', { name: 'Rogue', organizationId: org }), /Administration access denied/)
  assert.equal(await ctx.operations(), operations)
  assert.deepEqual(await ctx.ok('GET', '/v1/directory'), directory)

})

test('the admin agent has no administration tools in an organization chat', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const org = ctx.organizationId
  const admin = await ctx.start(ctx.rootAgentId, { kind: 'organization', organizationId: org })
  assert.equal(admin.context.administrationEnabled, false)
  const operations = await ctx.operations()
  for (const name of toolNames) await assert.rejects(admin.tool(`call-${name}`, name, {}), /Administration access denied/, name)
  await assert.rejects(admin.tool('create', 'admin.agents.create', { name: 'From the organization chat', organizationId: org }), /Administration access denied/)
  assert.equal(await ctx.operations(), operations)
  assert.equal(await count(ctx.db, "SELECT count(*) AS n FROM kipster.agents WHERE display_name='From the organization chat'"), 0)
  // The same agent in its installation chat has them.
  const installation = await ctx.start()
  assert.equal(installation.context.administrationEnabled, true)
  assert.equal((await installation.tool('list', 'admin.directory.get')).agents.length, 1)
})

test('a run waiting on a person, or delegated work, cannot use the tools', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const operations = await ctx.operations()

  // After an approval request or a question the attempt still runs, but its run waits on the owner.
  for (const [name, args] of [['interactions.request_approval', { prompt: 'Create Alpha?', proposalId: 'alpha', proposal: 'Create the organization Alpha' }], ['interactions.ask', { prompt: 'Which name?', options: [{ id: 'a', label: 'Alpha' }], freeText: false }]]) {
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
  const delegation = await parent.tool('delegate', 'agents.delegate', { recipientId: second, request: 'Create an organization' })
  parent.handle.release({ kind: 'ended', attemptId: parent.context.attemptId, confirmed: true })
  const child = await until(() => ctx.executions.find(e => e.context.runId === delegation.childRunId), Boolean, 'delegated execution')
  assert.equal(child.context.agentId, second)
  assert.equal(child.context.administrationEnabled, false)
  for (const tool of toolNames) await assert.rejects(child.handle.callTool(`child-${tool}`, tool, {}), /Administration access denied/, tool)
  await assert.rejects(child.handle.callTool('create', 'admin.organizations.create', { operationId: 'delegated-create', name: 'From delegated work' }), /Administration access denied/)
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
  assert.equal((await retried.handle.callTool('rename-3', 'admin.organizations.update', { operationId: 'rename-retry', organizationId: org, name: 'From the new attempt' })).organization.name, 'From the new attempt')
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
  const replay = await retry.handle.callTool('new-provider-call', 'admin.agents.create', { operationId, name: 'Saved create' })
  assert.equal(replay.agent.id, original.agent.id)
  assert.equal(replay.alreadyApplied, true)
  const distinct = await retry.handle.callTool('intentional-create', 'admin.agents.create', { operationId: randomUUID(), name: 'Saved create' })
  assert.notEqual(distinct.agent.id, original.agent.id)
  await assert.rejects(retry.handle.callTool('changed', 'admin.agents.create', { operationId, name: 'Changed' }), /different request/)
  await assert.rejects(dispatcher.adminTool(run.context.attemptId, 'stale', 'admin.agents.create', { operationId, name: 'Saved create' }), /no longer owns/)
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
