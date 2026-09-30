import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { MaintenanceService } from '../dist/modules/memory/public.js'
import { snapshot, readEvents } from '../dist/modules/synchronization/public.js'
import { agentLearningResult, learningSettings, textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Learning switch mechanics against real PostgreSQL with the deterministic fixture adapter.
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }

async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 400; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
}
function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n)

async function setup(t, { embedding = true, hooks = {}, executionLimit } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_learning_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-learning-home-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, ...(executionLimit ? { executionLimit } : {}), ...(embedding ? { embedding: { ...profile, async embed() { return [1, 0] } } } : {}) })
  await runtime.memory?.stopIndexing()
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const context = { kind: 'installation', installationId: actor.installationId }
  const agentId = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const { chatId } = await resolveDirectChat(runtime.db, actor, context, agentId)
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } }, undefined, hooks)
  const servers = []
  const holders = []
  const releases = []
  t.after(async () => {
    for (const release of releases) release.resolve()
    for (const holder of holders) await holder.close().catch(() => undefined)
    for (const server of servers) await server.close()
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0 })
    servers.push(server)
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const holder = () => { const db = new Postgres(url.href, 1); holders.push(db); return db }
  return { runtime, db: runtime.db, actor, context, agentId, chatId, dispatcher, executions, serve, holder, releases }
}

async function completeTextRun(ctx, text) {
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: ctx.context, chatId: ctx.chatId }, mode: 'root', parts: [{ kind: 'text', text }],
  })
  const found = await until(() => ctx.executions.find(e => e.context.runId === saved.runId), Boolean, `text execution ${saved.runId}`)
  found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: `Acknowledged: ${text}`, final: true })
  found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).rows[0]?.state, state => state === 'completed', `run completed ${saved.runId}`)
  return saved
}
const sources = (ctx, runId) => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [runId])
const source = async (ctx, runId) => (await ctx.db.query('SELECT status, status_reason FROM kipster.maintenance_sources WHERE run_id=$1', [runId])).rows[0]
const maintenanceCalls = ctx => ctx.executions.filter(e => e.context.kind === 'maintenance').length

test('learning is off for the installation and on for each agent by default, and captures nothing', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  assert.deepEqual(await ctx.runtime.learning.get(ctx.actor), {
    enabled: false, sleepTime: '01:00', revision: 0, available: true,
    agents: [{ agentId: ctx.agentId, enabled: true, sleepTime: null, revision: 0, effective: false }],
  })
  const saved = await completeTextRun(ctx, 'The team meets on Tuesdays')
  assert.equal(await sources(ctx, saved.runId), 0)
  assert.equal(maintenanceCalls(ctx), 0)
})

test('enabling learning without an embedding profile fails clearly and changes nothing', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { embedding: false })
  const scope = { kind: 'application', installationId: ctx.actor.installationId, callerId: ctx.actor.personId }
  const start = (await snapshot(ctx.db, scope)).cursor
  await assert.rejects(ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true }), /An embedding profile is required for learning/)
  const call = await ctx.serve(ctx.actor)
  const refused = await call('PUT', '/v1/settings/learning', { version: 1, enabled: true })
  assert.equal(refused.status, 400)
  assert.equal(refused.data.message, 'An embedding profile is required for learning')
  const state = learningSettings.parse((await call('GET', '/v1/settings/learning')).data)
  assert.equal(state.enabled, false)
  assert.equal(state.available, false)
  assert.deepEqual(state.agents.map(agent => agent.effective), [false])
  assert.equal((await readEvents(ctx.db, scope, start)).events.length, 0)
})

test('an agent switched off captures nothing while the installation learns', { skip: noDatabase }, async t => {
  const gate = deferred()
  t.after(() => gate.resolve())
  const ctx = await setup(t, { hooks: { afterMaintenanceClaim: () => gate.promise } })
  await ctx.dispatcher.start()
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false })
  const off = await completeTextRun(ctx, 'Invoices go out on the first')
  assert.equal(await sources(ctx, off.runId), 0)
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: true })
  const on = await completeTextRun(ctx, 'Invoices are due in thirty days')
  await until(() => sources(ctx, on.runId), n => n === 1, 'source captured once learning is on')
  assert.equal(await sources(ctx, off.runId), 0)
})

for (const target of ['installation', 'agent']) {
  test(`switching learning off for the ${target} skips queued work at claim and issue without a model call`, { skip: noDatabase }, async t => {
    const gate = deferred()
    t.after(() => gate.resolve())
    const ctx = await setup(t, { hooks: { afterMaintenanceClaim: () => gate.promise } })
    await ctx.dispatcher.start()
    const learning = ctx.runtime.learning
    const setSwitch = enabled => target === 'installation' ? learning.setInstallation(ctx.actor, { enabled }) : learning.setAgent(ctx.actor, ctx.agentId, { enabled })
    await learning.setInstallation(ctx.actor, { enabled: true })
    const claimed = await completeTextRun(ctx, 'The Lisbon office opens at nine')
    await until(async () => (await source(ctx, claimed.runId))?.status, status => status === 'claimed', 'first source claimed')
    const queued = await completeTextRun(ctx, 'The Porto office opens at ten')
    assert.equal((await source(ctx, queued.runId)).status, 'ready')
    await setSwitch(false)
    assert.deepEqual(await until(() => source(ctx, queued.runId), row => row.status !== 'ready', 'queued source settles'), { status: 'skipped', status_reason: 'learning_disabled' })
    gate.resolve()
    assert.deepEqual(await until(() => source(ctx, claimed.runId), row => row.status !== 'claimed', 'claimed source settles'), { status: 'skipped', status_reason: 'learning_disabled' })
    assert.equal(maintenanceCalls(ctx), 0)
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
    const service = new MaintenanceService(ctx.db, ctx.actor.installationId)
    assert.deepEqual(await ctx.db.transaction(client => service.requeueSource(client, ctx.runtime.jobs, queued.runId, 1)), { conflict: 'learning disabled' })
    // Turning learning back on does not revive skipped work.
    await setSwitch(true)
    await new Promise(resolve => setTimeout(resolve, 1000))
    assert.equal((await source(ctx, queued.runId)).status, 'skipped')
    assert.equal((await source(ctx, claimed.runId)).status, 'skipped')
    assert.equal(maintenanceCalls(ctx), 0)
  })
}

test('owners read and update the switches and sleep times over HTTP, others are denied, and each change emits one event', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const scope = { kind: 'application', installationId: ctx.actor.installationId, callerId: ctx.actor.personId }
  const start = (await snapshot(ctx.db, scope)).cursor
  const owner = await ctx.serve(ctx.actor)
  const stranger = await ctx.serve({ installationId: ctx.actor.installationId, personId: randomUUID() })
  const initial = learningSettings.parse((await owner('GET', '/v1/settings/learning')).data)
  assert.deepEqual([initial.enabled, initial.revision, initial.available], [false, 0, true])

  const enabled = await owner('PUT', '/v1/settings/learning', { version: 1, enabled: true })
  assert.equal(enabled.status, 200)
  assert.deepEqual(learningSettings.parse(enabled.data), { version: 1, enabled: true, sleepTime: '01:00', revision: 1, available: true, agents: [{ agentId: ctx.agentId, enabled: true, sleepTime: null, revision: 0, effective: true }] })
  assert.equal(learningSettings.parse((await owner('PUT', '/v1/settings/learning', { version: 1, enabled: true })).data).revision, 1, 'an unchanged value is not a change')

  const agentPath = `/v1/agents/${ctx.agentId}/learning`
  const agentOff = await owner('PUT', agentPath, { version: 1, enabled: false })
  assert.equal(agentOff.status, 200)
  assert.deepEqual(agentLearningResult.parse(agentOff.data), { version: 1, agentId: ctx.agentId, enabled: false, sleepTime: null, revision: 1, effective: false })
  assert.deepEqual(learningSettings.parse((await owner('GET', '/v1/settings/learning')).data).agents, [{ agentId: ctx.agentId, enabled: false, sleepTime: null, revision: 1, effective: false }])

  // Sleep times: the installation default and an agent's own, which null clears.
  const defaultTime = learningSettings.parse((await owner('PUT', '/v1/settings/learning', { version: 1, sleepTime: '23:30' })).data)
  assert.deepEqual([defaultTime.enabled, defaultTime.sleepTime, defaultTime.revision], [true, '23:30', 2])
  const own = agentLearningResult.parse((await owner('PUT', agentPath, { version: 1, enabled: true, sleepTime: '04:15' })).data)
  assert.deepEqual([own.enabled, own.sleepTime, own.revision], [true, '04:15', 2])
  assert.equal(agentLearningResult.parse((await owner('PUT', agentPath, { version: 1, sleepTime: '04:15' })).data).revision, 2, 'an unchanged sleep time is not a change')
  const cleared = agentLearningResult.parse((await owner('PUT', agentPath, { version: 1, sleepTime: null })).data)
  assert.deepEqual([cleared.enabled, cleared.sleepTime, cleared.revision], [true, null, 3])
  assert.equal((await owner('PUT', agentPath, { version: 1, enabled: false })).status, 200)

  for (const bad of [{ version: 1, enabled: 'yes' }, { version: 1 }, { version: 1, sleepTime: '24:00' }, { version: 1, sleepTime: '1:00' }, { version: 1, sleepTime: null }, { version: 1, enabled: true, extra: 1 }]) {
    assert.equal((await owner('PUT', '/v1/settings/learning', bad)).status, 400, JSON.stringify(bad))
  }
  for (const bad of [{ enabled: true }, { version: 1 }, { version: 1, sleepTime: '07:60' }]) assert.equal((await owner('PUT', agentPath, bad)).status, 400, JSON.stringify(bad))
  assert.equal((await owner('PUT', `/v1/agents/${randomUUID()}/learning`, { version: 1, enabled: true })).status, 404)
  for (const [method, path, body] of [['GET', '/v1/settings/learning'], ['PUT', '/v1/settings/learning', { version: 1, enabled: false }], ['PUT', '/v1/settings/learning', { version: 1, sleepTime: '02:00' }], ['PUT', agentPath, { version: 1, enabled: true }], ['PUT', agentPath, { version: 1, sleepTime: '02:00' }]]) {
    const denied = await stranger(method, path, body)
    assert.equal(denied.status, 403, `${method} ${path}`)
    assert.equal(denied.data.code, 'forbidden')
  }
  const after = learningSettings.parse((await owner('GET', '/v1/settings/learning')).data)
  assert.deepEqual([after.enabled, after.sleepTime, after.agents[0].enabled, after.agents[0].sleepTime], [true, '23:30', false, null])

  const events = (await readEvents(ctx.db, scope, start)).events.map(event => textEvent.parse(JSON.parse(JSON.stringify(event))))
  assert.deepEqual(events.map(event => [event.type, event.resourceId, event.revision, event.data]), [
    ['learning-changed', ctx.actor.installationId, 1, { target: 'installation', enabled: true, sleepTime: '01:00' }],
    ['learning-changed', ctx.agentId, 1, { target: 'agent', enabled: false, sleepTime: null }],
    ['learning-changed', ctx.actor.installationId, 2, { target: 'installation', enabled: true, sleepTime: '23:30' }],
    ['learning-changed', ctx.agentId, 2, { target: 'agent', enabled: true, sleepTime: '04:15' }],
    ['learning-changed', ctx.agentId, 3, { target: 'agent', enabled: true, sleepTime: null }],
    ['learning-changed', ctx.agentId, 4, { target: 'agent', enabled: false, sleepTime: null }],
  ])
})

test('with learning off, a leftover ready source neither holds back text nor is learned later', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { executionLimit: 1 })
  await ctx.dispatcher.start()
  const earlier = await completeTextRun(ctx, 'The Oslo office opens at eight')
  // A source left ready while learning was off, as after a lost sweep hint or an upgrade.
  const service = new MaintenanceService(ctx.db, ctx.actor.installationId)
  const thread = (await ctx.db.query('SELECT thread_id FROM kipster.text_runs WHERE id=$1', [earlier.runId])).rows[0].thread_id
  await ctx.db.query('UPDATE kipster.installations SET learning_enabled=true WHERE id=$1', [ctx.actor.installationId])
  await ctx.db.transaction(client => service.allocateSource(client, ctx.runtime.jobs, earlier.runId, ctx.agentId, 'installation', ctx.actor.installationId, thread, false))
  await ctx.db.query('UPDATE kipster.installations SET learning_enabled=false WHERE id=$1', [ctx.actor.installationId])
  await ctx.db.query('UPDATE kipster.execution_permits SET maintenance_counter=100 WHERE installation_id=$1', [ctx.actor.installationId])
  assert.equal((await source(ctx, earlier.runId)).status, 'ready')
  const later = await completeTextRun(ctx, 'The Bergen office opens at nine')
  assert.equal(await sources(ctx, later.runId), 0)
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await source(ctx, earlier.runId), { status: 'skipped', status_reason: 'learning_disabled' })
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal((await source(ctx, earlier.runId)).status, 'skipped')
  assert.equal(maintenanceCalls(ctx), 0)
})

test('switching learning off waits for an extraction commit that already passed its gate', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  const fact = 'The Tromso office opens at seven'
  const saved = await completeTextRun(ctx, fact)
  const maintenance = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance'), Boolean, 'maintenance execution')
  const input = (await ctx.db.query('SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).rows[0].manifest.entries[0]
  const memories = () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`)
  const waiting = like => until(() => count(ctx.db, `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND query LIKE $1`, [like]), n => n >= 1, `waiting on ${like}`)
  // Hold the commit after its learning gate: it waits on the embedding profile while holding the capacity lock.
  const blocker = ctx.holder()
  const held = deferred()
  const release = deferred()
  ctx.releases.push(release)
  const holding = blocker.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.memory_profiles FOR UPDATE')
    held.resolve()
    await release.promise
  })
  await held.promise
  const attemptId = maintenance.context.attemptId
  maintenance.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  maintenance.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [{ kind: 'fact', text: fact, subject: 'office hours', author_id: input.author_id, author_class: input.author_class, citations: [{ message_id: input.message_id, revision: input.revision, parts_hash: input.parts_sha256, excerpt: fact }] }] }), final: true })
  maintenance.handle.release({ kind: 'ended', attemptId, confirmed: true })
  await waiting('%FROM kipster.memory_profiles WHERE installation_id=$1 FOR SHARE%')
  const switched = ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false }).then(async () => memories())
  await waiting('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE')
  release.resolve()
  await holding
  assert.equal(await switched, 1, 'the commit linearizes before the switch returns')
  await until(() => source(ctx, saved.runId), row => row.status === 'committed', 'source committed')
  assert.equal(await memories(), 1)
})
