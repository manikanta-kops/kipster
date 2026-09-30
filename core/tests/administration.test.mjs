import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { bootstrap } from '../dist/modules/administration/public.js'
import { readDirectory } from '../dist/modules/administration/public.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { acceptText } from '../dist/modules/conversations/public.js'
import { agentCreateResult, agentResult, directorySnapshot, organizationInstructions, organizationResult, textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Organization and agent administration over HTTP against real PostgreSQL and a real home directory.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_admin_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-admin-home-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return { url: url.href, home, closers }
}

async function start(base) {
  const runtime = await openRuntime({ connectionString: base.url, home: base.home, names })
  let closed = false
  const close = async () => { if (!closed) { closed = true; await runtime.close() } }
  base.closers.push(close)
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0 })
    base.closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  return { ...base, runtime, db: runtime.db, actor, installationId, ownerId, organizationId, rootAgentId, serve, close, call: await serve(actor), appScope: { kind: 'application', installationId, callerId: ownerId } }
}

async function setup(t) { return start(await database(t)) }

const exists = path => readFile(path).then(() => true, () => false)
const count = async (db, sql, values) => Number((await db.query(sql, values)).rows[0].n)
const operation = async (db, operationId) => (await db.query('SELECT kind, target_id, options, state FROM kipster.admin_operations WHERE operation_id=$1', [operationId])).rows[0]

async function crash(ctx, kind, operationId, moment, organizationId) {
  const script = new URL('./fixtures/admin-crash.mjs', import.meta.url).pathname
  const child = spawn(process.execPath, [script, ctx.url, ctx.home, ctx.installationId, ctx.ownerId, kind, operationId, moment, ...(organizationId ? [organizationId] : [])], { stdio: 'ignore' })
  const death = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  assert.equal(death.signal, 'SIGKILL')
}

/** Applies directory events as a client does; see the directory tests for the full rules. */
function merge(directory, events) {
  const next = structuredClone(directory)
  const lists = { organization: 'organizations', agent: 'agents', membership: 'memberships', group: 'groups' }
  for (const event of events) {
    next.cursor = event.cursor
    const [, kind] = /^(organization|agent|membership|group)-changed$/.exec(event.type) ?? []
    if (!kind) continue
    const current = next[lists[kind]].find(item => item.id === event.resourceId)
    if (!current || current.revision <= event.revision) next[lists[kind]] = [...next[lists[kind]].filter(item => item.id !== event.resourceId), event.data]
  }
  return next
}
const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id))
const comparable = d => ({ cursor: d.cursor, organizations: byId(d.organizations), agents: byId(d.agents), memberships: byId(d.memberships), groups: byId(d.groups) })

test('the owner creates and updates organizations and agents', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const created = await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'org-1', name: 'Northwind', description: 'Wholesale', settings: { adapterId: { set: 'codex' }, modelId: { set: 'm1' }, effort: { set: 'high' } } })
  assert.equal(created.status, 200)
  const { organization } = organizationResult.parse(created.data)
  assert.deepEqual([created.data.operationId, created.data.alreadyApplied, organization.name, organization.description, organization.lifecycle, organization.revision], ['org-1', false, 'Northwind', 'Wholesale', 'active', 1])
  const row = (await ctx.db.query('SELECT provisioned, settings FROM kipster.organizations WHERE id=$1', [organization.id])).rows[0]
  assert.deepEqual(row, { provisioned: true, settings: { adapterId: 'codex', modelId: 'm1', effort: 'high' } })
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.human_memberships WHERE organization_id=$1 AND person_id=$2', [organization.id, ctx.ownerId]), 1)
  assert.equal(await readFile(join(ctx.runtime.home.organization(organization.id), 'instructions.md'), 'utf8'), '# Organization instructions\n')

  const added = await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'agent-1', name: 'Scout', description: 'Finds leads', settings: { modelId: { set: 'm2' } }, organizationId: organization.id })
  assert.equal(added.status, 200)
  const scout = agentCreateResult.parse(added.data)
  assert.deepEqual([scout.agent.name, scout.agent.description, scout.agent.admin, scout.agent.lifecycle], ['Scout', 'Finds leads', false, 'active'])
  assert.deepEqual([scout.membership.organizationId, scout.membership.agentId], [organization.id, scout.agent.id])
  assert.deepEqual((await ctx.db.query('SELECT settings FROM kipster.agents WHERE id=$1', [scout.agent.id])).rows[0].settings, { modelId: 'm2' })
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agent_roles WHERE agent_id=$1`, [scout.agent.id]), 0)
  for (const file of ['AGENTS.md', 'soul.md', 'identity.md']) assert.ok(await exists(join(ctx.runtime.home.agent(scout.agent.id), file)))
  const solo = agentCreateResult.parse((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'agent-2', name: 'Solo' })).data)
  assert.equal(solo.membership, null)

  const renamed = await ctx.call('PUT', `/v1/organizations/${organization.id}`, { version: 1, operationId: 'org-1-rename', name: 'Northwind Traders', settings: { effort: { clear: true }, modelId: { set: 'm3' } } })
  assert.equal(renamed.status, 200)
  assert.deepEqual([organizationResult.parse(renamed.data).organization.name, renamed.data.organization.revision, renamed.data.organization.description], ['Northwind Traders', 2, 'Wholesale'])
  assert.deepEqual((await ctx.db.query('SELECT settings FROM kipster.organizations WHERE id=$1', [organization.id])).rows[0].settings, { adapterId: 'codex', modelId: 'm3' })
  const described = agentResult.parse((await ctx.call('PUT', `/v1/agents/${scout.agent.id}`, { version: 1, operationId: 'agent-1-describe', description: 'Qualifies leads' })).data)
  assert.deepEqual([described.agent.name, described.agent.description, described.agent.revision], ['Scout', 'Qualifies leads', 2])
  const tuned = agentResult.parse((await ctx.call('PUT', `/v1/agents/${scout.agent.id}`, { version: 1, operationId: 'agent-1-tune', settings: { modelId: { clear: true } } })).data)
  assert.equal(tuned.agent.revision, 2)
  assert.deepEqual((await ctx.db.query('SELECT settings FROM kipster.agents WHERE id=$1', [scout.agent.id])).rows[0].settings, {})
  const root = agentResult.parse((await ctx.call('PUT', `/v1/agents/${ctx.rootAgentId}`, { version: 1, operationId: 'root-rename', name: 'Admin' })).data)
  assert.deepEqual([root.agent.name, root.agent.admin], ['Admin', true])

  const directory = directorySnapshot.parse((await ctx.call('GET', '/v1/directory')).data)
  assert.deepEqual(directory.organizations.find(o => o.id === organization.id), renamed.data.organization)
  assert.deepEqual(directory.agents.find(a => a.id === scout.agent.id), tuned.agent)
  assert.deepEqual(directory.memberships.find(m => m.agentId === scout.agent.id), scout.membership)
  assert.deepEqual((await operation(ctx.db, 'agent-1')).state, 'succeeded')

  // Rejected requests change nothing and record no operation.
  const rejected = [
    ['POST', '/v1/agents', { version: 1, operationId: 'bad-1', name: 'Boss', admin: true }, 400],
    ['POST', '/v1/organizations', { version: 1, operationId: 'bad-2', name: '   ' }, 400],
    ['POST', '/v1/organizations', { version: 1, operationId: 'bad-3', name: 'X', settings: { adapterId: { clear: false } } }, 400],
    ['PUT', `/v1/organizations/${organization.id}`, { version: 1, operationId: 'bad-4' }, 400],
    ['PUT', `/v1/agents/${randomUUID()}`, { version: 1, operationId: 'bad-5', name: 'Nobody' }, 404],
    ['POST', '/v1/agents', { version: 1, operationId: 'bad-6', name: 'Lost', organizationId: randomUUID() }, 404],
  ]
  await ctx.db.query(`UPDATE kipster.agents SET lifecycle='archived' WHERE id=$1`, [solo.agent.id])
  rejected.push(['PUT', `/v1/agents/${solo.agent.id}`, { version: 1, operationId: 'bad-7', name: 'Revived' }, 404])
  for (const [method, path, body, status] of rejected) assert.equal((await ctx.call(method, path, body)).status, status, JSON.stringify(body))
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.admin_operations WHERE operation_id LIKE 'bad-%'`), 0)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agents WHERE display_name IN ('Boss','Lost','Revived')`), 0)
})

test('a repeated operation ID returns the recorded result', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'same', name: 'Acme' })
  assert.equal((await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'same', name: 'Different' })).status, 409)
  const again = await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'same', name: 'Acme' })
  assert.deepEqual([again.status, again.data.alreadyApplied, again.data.organization], [200, true, first.data.organization])
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.organizations WHERE display_name IN ('Acme','Different')`), 1)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.app_events WHERE resource_id=$1 AND type='organization-changed'`, [first.data.organization.id]), 1)

  const racing = await Promise.all([1, 2, 3].map(() => ctx.call('POST', '/v1/agents', { version: 1, operationId: 'race', name: 'Racer', organizationId: first.data.organization.id })))
  assert.deepEqual(racing.map(r => r.status), [200, 200, 200])
  assert.equal(new Set(racing.map(r => r.data.agent.id)).size, 1)
  assert.deepEqual(racing.map(r => r.data.alreadyApplied).sort(), [false, true, true])
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agents WHERE display_name='Racer'`), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.agent_memberships WHERE agent_id=$1', [racing[0].data.agent.id]), 1)

  // Replaying an older update returns its recorded result and leaves the later save in place.
  const orgPath = `/v1/organizations/${first.data.organization.id}`
  const toA = await ctx.call('PUT', orgPath, { version: 1, operationId: 'rename-a', name: 'Acme A' })
  await ctx.call('PUT', orgPath, { version: 1, operationId: 'rename-b', name: 'Acme B' })
  const replay = await ctx.call('PUT', orgPath, { version: 1, operationId: 'rename-a', name: 'Acme A' })
  assert.deepEqual([replay.data.alreadyApplied, replay.data.organization], [true, toA.data.organization])
  assert.equal((await readDirectory(ctx.db, ctx.actor)).organizations.find(o => o.id === first.data.organization.id).name, 'Acme B')

  // One operation ID names one request.
  assert.equal((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'same', name: 'Acme' })).data.code, 'conflict')
  assert.equal((await ctx.call('PUT', `/v1/organizations/${ctx.organizationId}`, { version: 1, operationId: 'rename-a', name: 'Acme A' })).status, 409)
  assert.equal((await readDirectory(ctx.db, ctx.actor)).organizations.find(o => o.id === ctx.organizationId).name, 'Org')
})

test('a creation killed around its home seeding finishes on retry with the recorded IDs', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const before = await readDirectory(ctx.db, ctx.actor)

  await crash(ctx, 'organization', 'org-crash', 'before-seed')
  const planned = await operation(ctx.db, 'org-crash')
  assert.equal(planned.state, 'pending')
  assert.equal((await ctx.db.query('SELECT provisioned FROM kipster.organizations WHERE id=$1', [planned.target_id])).rows[0].provisioned, false)
  assert.equal(await exists(join(ctx.runtime.home.organization(planned.target_id), 'instructions.md')), false)
  assert.equal((await readDirectory(ctx.db, ctx.actor)).organizations.some(o => o.id === planned.target_id), false)
  const retried = organizationResult.parse((await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'org-crash', name: 'Northwind' })).data)
  assert.deepEqual([retried.organization.id, retried.alreadyApplied], [planned.target_id, true])
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.organizations WHERE display_name='Northwind'`), 1)
  assert.equal(await exists(join(ctx.runtime.home.organization(planned.target_id), 'instructions.md')), true)

  await crash(ctx, 'agent', 'agent-crash', 'before-seed', planned.target_id)
  const agentPlan = await operation(ctx.db, 'agent-crash')
  assert.equal(agentPlan.state, 'pending')
  const agent = agentCreateResult.parse((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'agent-crash', name: 'Scout', organizationId: planned.target_id })).data)
  assert.deepEqual([agent.agent.id, agent.membership.id, agent.membership.organizationId, agent.alreadyApplied], [agentPlan.target_id, agentPlan.options.membershipId, planned.target_id, true])
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agents WHERE display_name='Scout'`), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.agent_memberships WHERE agent_id=$1', [agent.agent.id]), 1)
  assert.equal(await exists(join(ctx.runtime.home.agent(agent.agent.id), 'AGENTS.md')), true)

  // Killed after seeding: the retry keeps the seeded home and finishes with the same agent.
  await crash(ctx, 'agent', 'agent-late', 'after-seed')
  const late = await operation(ctx.db, 'agent-late')
  assert.equal(late.state, 'pending')
  assert.equal(await exists(join(ctx.runtime.home.agent(late.target_id), 'soul.md')), true)
  const lateAgent = agentCreateResult.parse((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'agent-late', name: 'Scout' })).data)
  assert.deepEqual([lateAgent.agent.id, lateAgent.membership], [late.target_id, null])

  // Each finished creation published its records once, when it became visible.
  const events = (await readEvents(ctx.db, ctx.appScope, before.cursor)).events.map(event => textEvent.parse(event))
  assert.deepEqual(events.map(e => [e.type, e.resourceId]), [
    ['organization-changed', planned.target_id], ['settings-changed', planned.target_id],
    ['agent-changed', agent.agent.id], ['settings-changed', agent.agent.id], ['membership-changed', agent.membership.id],
    ['agent-changed', late.target_id], ['settings-changed', late.target_id]])
  assert.deepEqual(comparable(merge(before, events)), comparable(await readDirectory(ctx.db, ctx.actor)))
})

test('the startup sweep finishes an interrupted creation', { skip: noDatabase }, async t => {
  const first = await setup(t)
  await first.close()
  await crash(first, 'agent', 'swept', 'before-seed', first.organizationId)
  const planned = await (async () => { const db = new Postgres(first.url); try { return await operation(db, 'swept') } finally { await db.close() } })()
  assert.equal(planned.state, 'pending')

  const ctx = await start(first)
  assert.equal((await operation(ctx.db, 'swept')).state, 'succeeded')
  assert.equal(await exists(join(ctx.runtime.home.agent(planned.target_id), 'identity.md')), true)
  const directory = await readDirectory(ctx.db, ctx.actor)
  assert.equal(directory.agents.find(a => a.id === planned.target_id).name, 'Scout')
  assert.equal(directory.memberships.find(m => m.agentId === planned.target_id).id, planned.options.membershipId)
  const repeat = agentCreateResult.parse((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'swept', name: 'Scout', organizationId: first.organizationId })).data)
  assert.deepEqual([repeat.agent.id, repeat.membership.id, repeat.alreadyApplied], [planned.target_id, planned.options.membershipId, true])
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agents WHERE display_name='Scout'`), 1)
})

test('concurrent instruction saves never leave a partial file and the latest save wins', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const org = organizationResult.parse((await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'org', name: 'Northwind' })).data).organization
  const path = `/v1/organizations/${org.id}/instructions`
  const file = join(ctx.runtime.home.organization(org.id), 'instructions.md')
  assert.deepEqual(organizationInstructions.parse((await ctx.call('GET', path)).data), { version: 1, organizationId: org.id, content: '# Organization instructions\n' })

  const saves = ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => `# Rules ${letter}\n${letter.repeat(60 * 1024)}\n`)
  const allowed = new Set(['# Organization instructions\n', ...saves])
  let writing = true
  const observed = []
  const reader = (async () => { while (writing) observed.push(await readFile(file, 'utf8')) })()
  const results = await Promise.all(saves.map(content => ctx.call('PUT', path, { version: 1, content })))
  writing = false
  await reader
  assert.deepEqual(results.map(r => r.status), saves.map(() => 200))
  assert.ok(observed.length > 0)
  for (const content of observed) assert.ok(allowed.has(content), `partial file of ${content.length} characters`)
  const settled = await readFile(file, 'utf8')
  assert.ok(saves.includes(settled))
  assert.equal((await ctx.call('GET', path)).data.content, settled)
  assert.deepEqual((await readdir(ctx.runtime.home.organization(org.id))).filter(name => name.endsWith('.tmp')), [])

  await ctx.call('PUT', path, { version: 1, content: 'First rule\n' })
  await ctx.call('PUT', path, { version: 1, content: 'Latest rule\n' })
  assert.equal((await ctx.call('GET', path)).data.content, 'Latest rule\n')
  assert.equal(await readFile(file, 'utf8'), 'Latest rule\n')

  const oversized = await ctx.call('PUT', path, { version: 1, content: 'x'.repeat(64 * 1024 + 1) })
  assert.equal(oversized.status, 400)
  assert.equal((await ctx.call('GET', `/v1/organizations/${randomUUID()}/instructions`)).status, 404)
  await ctx.db.query(`UPDATE kipster.organizations SET lifecycle='deleting' WHERE id=$1`, [org.id])
  assert.equal((await ctx.call('PUT', path, { version: 1, content: 'Too late\n' })).status, 404)
  assert.equal(await readFile(file, 'utf8'), 'Latest rule\n')
})

test('the next execution reads the saved organization instructions', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(ctx.runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  ctx.closers.push(() => dispatcher.close())
  const org = organizationResult.parse((await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'org', name: 'Northwind', settings: { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } } })).data).organization
  const agent = agentCreateResult.parse((await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'agent', name: 'Scout', organizationId: org.id })).data).agent
  const context = { kind: 'organization', organizationId: org.id }
  const { chatId } = (await ctx.call('POST', '/v1/direct-chats', { version: 1, context, agentId: agent.id })).data
  await dispatcher.start()
  const run = async (text, instructions) => {
    await ctx.call('PUT', `/v1/organizations/${org.id}/instructions`, { version: 1, content: instructions })
    await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, { version: 1, submissionId: randomUUID(), scope: { installationId: ctx.installationId, callerId: ctx.ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
    const index = executions.length
    for (let i = 0; i < 400 && executions.length === index; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const { context: execution, handle } = executions[index]
    handle.release({ kind: 'text', attemptId: execution.attemptId, messageId: randomUUID(), text: 'Done', final: true })
    handle.release({ kind: 'ended', attemptId: execution.attemptId, confirmed: true })
    return execution
  }
  const first = await run('Plan the launch', 'Always quote prices in euros.\n')
  assert.equal(first.organizationId, org.id)
  assert.ok(first.instructions.includes('Always quote prices in euros.'))
  const second = await run('Plan the follow-up', 'Always quote prices in dollars.\n')
  assert.ok(second.instructions.includes('Always quote prices in dollars.'))
  assert.equal(second.instructions.includes('euros'), false)
})

test('only the installation owner may administer', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const organization = ctx.organizationId
  const requests = [
    ['POST', '/v1/organizations', { version: 1, operationId: 'x1', name: 'Rogue' }],
    ['POST', '/v1/agents', { version: 1, operationId: 'x2', name: 'Rogue', organizationId: organization }],
    ['PUT', `/v1/organizations/${organization}`, { version: 1, operationId: 'x3', name: 'Rogue' }],
    ['PUT', `/v1/agents/${ctx.rootAgentId}`, { version: 1, operationId: 'x4', name: 'Rogue' }],
    ['GET', `/v1/organizations/${organization}/instructions`],
    ['PUT', `/v1/organizations/${organization}/instructions`, { version: 1, content: 'Rogue\n' }],
  ]
  const person = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [person, ctx.installationId, 'Member'])
  await ctx.db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [organization, person])
  for (const actor of [{ installationId: ctx.installationId, personId: person }, { installationId: randomUUID(), personId: ctx.ownerId }]) {
    const call = await ctx.serve(actor)
    for (const [method, path, body] of requests) {
      const response = await call(method, path, body)
      assert.deepEqual([response.status, response.data.code], [403, 'forbidden'], `${method} ${path}`)
    }
  }
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.admin_operations'), 0)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.agents WHERE display_name='Rogue'`) + await count(ctx.db, `SELECT count(*) AS n FROM kipster.organizations WHERE display_name='Rogue'`), 0)
  assert.equal((await ctx.call('GET', `/v1/organizations/${organization}/instructions`)).data.content, '# Organization instructions\n')
})

test('administration events let a client merge the directory to match a fresh read', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const before = directorySnapshot.parse((await ctx.call('GET', '/v1/directory')).data)
  const org = (await ctx.call('POST', '/v1/organizations', { version: 1, operationId: 'o', name: 'Northwind' })).data.organization
  const scout = (await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'a', name: 'Scout', organizationId: org.id })).data
  const solo = (await ctx.call('POST', '/v1/agents', { version: 1, operationId: 'b', name: 'Solo' })).data.agent
  await ctx.call('PUT', `/v1/organizations/${org.id}`, { version: 1, operationId: 'o2', name: 'Northwind Traders' })
  await ctx.call('PUT', `/v1/agents/${solo.id}`, { version: 1, operationId: 'b2', description: 'Works alone' })
  await ctx.call('PUT', `/v1/agents/${scout.agent.id}`, { version: 1, operationId: 'a2', settings: { effort: { set: 'low' } } })

  const events = (await readEvents(ctx.db, ctx.appScope, before.cursor)).events.map(event => textEvent.parse(event))
  assert.deepEqual(events.map(e => [e.type, e.resourceId, e.revision]), [
    ['organization-changed', org.id, 1], ['settings-changed', org.id, 1],
    ['agent-changed', scout.agent.id, 1], ['settings-changed', scout.agent.id, 1], ['membership-changed', scout.membership.id, 1],
    ['agent-changed', solo.id, 1], ['settings-changed', solo.id, 1], ['organization-changed', org.id, 2], ['agent-changed', solo.id, 2],
    ['settings-changed', scout.agent.id, 2]])
  assert.deepEqual(events.at(-1).data, { target: 'agent', id: scout.agent.id, revision: 2, settings: { effort: 'low' } })
  assert.deepEqual(comparable(merge(before, events)), comparable(directorySnapshot.parse((await ctx.call('GET', '/v1/directory')).data)))
})

test('bootstrap provisions homes only for active rows', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const organizationHome = ctx.runtime.home.organization(ctx.organizationId)
  const soul = join(ctx.runtime.home.agent(ctx.rootAgentId), 'soul.md')
  await ctx.db.query(`UPDATE kipster.organizations SET lifecycle='deleted', deleted_at=now() WHERE id=$1`, [ctx.organizationId])
  await rm(organizationHome, { recursive: true })
  await rm(soul)
  assert.deepEqual(await bootstrap(ctx.db, ctx.runtime.home, names), ctx.runtime.bootstrap)
  assert.equal(await exists(join(organizationHome, 'instructions.md')), false)
  assert.equal(await readFile(soul, 'utf8'), '# Soul\n')
})


test('administration receipt comparison ignores object order and preserves omitted, clear and array order', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const path = `/v1/agents/${ctx.rootAgentId}`
  const first = { version: 1, operationId: 'canonical', name: 'Root', settings: { modelId: { set: 'model' }, effort: { set: 'low' } } }
  assert.equal((await ctx.call('PUT', path, first)).status, 200)
  const replay = await ctx.call('PUT', path, { settings: { effort: { set: 'low' }, modelId: { set: 'model' } }, name: 'Root', operationId: 'canonical', version: 1 })
  assert.equal(replay.status, 200); assert.equal(replay.data.alreadyApplied, true)
  assert.equal((await ctx.call('PUT', path, { ...first, settings: { effort: { clear: true } } })).status, 409)
  assert.equal((await ctx.call('PUT', path, { version: 1, operationId: 'canonical', name: 'Root' })).status, 409)
  const group = async name => (await ctx.call('POST', `/v1/organizations/${ctx.organizationId}/groups`, { version: 1, operationId: randomUUID(), name })).data.group.id
  const ids = [await group('A'), await group('B')]
  const orderPath = `/v1/organizations/${ctx.organizationId}/groups/order`
  assert.equal((await ctx.call('PUT', orderPath, { version: 1, operationId: 'order', groupIds: ids })).status, 200)
  assert.equal((await ctx.call('PUT', orderPath, { version: 1, operationId: 'order', groupIds: ids.toReversed() })).status, 409)
})
