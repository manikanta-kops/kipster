import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { snapshot, readEvents } from '../dist/modules/synchronization/public.js'
import { agentLearningResult, learningSettings, textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Memory switch mechanics against real PostgreSQL with the deterministic fixture adapter.
const profile = { id: 'fixture-provider', contractMajor: 1, model: 'fixture-embedding' }

async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 400; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
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
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const context = { kind: 'installation', installationId: actor.installationId }
  const agentId = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const { chatId } = await resolveDirectChat(runtime.db, actor, context, agentId)
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } }, hooks)
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
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0, dispatcher })
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
const memoryDefaults = { nightlyModel: null, coreCardCount: 60, searchCardCount: 10, searchChunkCount: 6 }
const memoryRows = ctx => count(ctx.db, `SELECT (SELECT count(*) FROM kipster.thread_chunks) + (SELECT count(*) FROM kipster.cards) + (SELECT count(*) FROM kipster.diary)
  + (SELECT count(*) FROM kipster.memory_thread_state) AS n`)

test('memory is off for the installation and on for each agent by default', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  assert.deepEqual(await ctx.runtime.learning.get(ctx.actor), {
    enabled: false, sleepTime: '01:00', revision: 0, available: true,
    agents: [{ agentId: ctx.agentId, enabled: true, sleepTime: null, revision: 0, effective: false }],
    ...memoryDefaults,
  })
  await completeTextRun(ctx, 'The team meets on Tuesdays')
  assert.equal(await memoryRows(ctx), 0)
})

test('memory turns on without an embedding provider, and available reports that none is configured', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { embedding: false })
  const scope = { kind: 'application', installationId: ctx.actor.installationId, callerId: ctx.actor.personId }
  const start = (await snapshot(ctx.db, scope)).cursor
  const call = await ctx.serve(ctx.actor)
  const enabled = await call('PUT', '/v1/settings/learning', { version: 1, enabled: true })
  assert.equal(enabled.status, 200)
  assert.deepEqual(learningSettings.parse(enabled.data), { version: 1, enabled: true, sleepTime: '01:00', revision: 1, available: false, agents: [{ agentId: ctx.agentId, enabled: true, sleepTime: null, revision: 0, effective: true }], ...memoryDefaults })
  assert.deepEqual((await readEvents(ctx.db, scope, start)).events.map(event => event.type), ['learning-changed'])
})

test('with memory on, kips run turns with the memory tools and sections, none of the removed tools', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  await completeTextRun(ctx, 'Remember that the office opens at nine')
  const [execution] = ctx.executions
  assert.deepEqual(execution.context.memory, ['Memory search found nothing for the current message.'])
  const tools = execution.context.tools.map(tool => tool.name)
  assert.deepEqual(tools.filter(name => ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'].includes(name)), ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'])
  assert.ok(tools.includes('manage_vector_collections'))
  assert.equal(await memoryRows(ctx), 0)
})

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
  assert.deepEqual(learningSettings.parse(enabled.data), { version: 1, enabled: true, sleepTime: '01:00', revision: 1, available: true, agents: [{ agentId: ctx.agentId, enabled: true, sleepTime: null, revision: 0, effective: true }], ...memoryDefaults })
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
    ['learning-changed', ctx.actor.installationId, 1, { target: 'installation', enabled: true, sleepTime: '01:00', ...memoryDefaults }],
    ['learning-changed', ctx.agentId, 1, { target: 'agent', enabled: false, sleepTime: null }],
    ['learning-changed', ctx.actor.installationId, 2, { target: 'installation', enabled: true, sleepTime: '23:30', ...memoryDefaults }],
    ['learning-changed', ctx.agentId, 2, { target: 'agent', enabled: true, sleepTime: '04:15' }],
    ['learning-changed', ctx.agentId, 3, { target: 'agent', enabled: true, sleepTime: null }],
    ['learning-changed', ctx.agentId, 4, { target: 'agent', enabled: false, sleepTime: null }],
  ])
})

test('the nightly model and memory counts are installation settings, validated, bounded and checked against the adapter catalog', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const scope = { kind: 'application', installationId: ctx.actor.installationId, callerId: ctx.actor.personId }
  const start = (await snapshot(ctx.db, scope)).cursor
  const owner = await ctx.serve(ctx.actor)
  const stranger = await ctx.serve({ installationId: ctx.actor.installationId, personId: randomUUID() })
  const model = { adapterId: 'deterministic-fixture', modelId: 'fixture-model' }
  const changed = learningSettings.parse((await owner('PUT', '/v1/settings/learning', { version: 1, nightlyModel: model, coreCardCount: 0, searchCardCount: 50, searchChunkCount: 30 })).data)
  assert.deepEqual([changed.nightlyModel, changed.coreCardCount, changed.searchCardCount, changed.searchChunkCount, changed.enabled, changed.revision], [model, 0, 50, 30, false, 1])
  assert.equal(learningSettings.parse((await owner('PUT', '/v1/settings/learning', { version: 1, coreCardCount: 0 })).data).revision, 1, 'an unchanged value is not a change')
  const kips = learningSettings.parse((await owner('PUT', '/v1/settings/learning', { version: 1, nightlyModel: null, coreCardCount: 200 })).data)
  assert.deepEqual([kips.nightlyModel, kips.coreCardCount, kips.revision], [null, 200, 2])
  for (const bad of [
    { coreCardCount: 201 }, { coreCardCount: -1 }, { coreCardCount: 1.5 }, { searchCardCount: 51 }, { searchChunkCount: 31 }, { searchChunkCount: '6' },
    { nightlyModel: { adapterId: 'deterministic-fixture' } }, { nightlyModel: { ...model, extra: 1 } }, { nightlyModel: { ...model, modelId: '' } },
    // The connected catalog has no such adapter, model or effort.
    { nightlyModel: { adapterId: 'missing', modelId: 'fixture-model' } }, { nightlyModel: { ...model, modelId: 'missing' } }, { nightlyModel: { ...model, effort: 'high' } },
  ]) assert.equal((await owner('PUT', '/v1/settings/learning', { version: 1, ...bad })).status, 400, JSON.stringify(bad))
  assert.equal((await owner('PUT', `/v1/agents/${ctx.agentId}/learning`, { version: 1, coreCardCount: 5 })).status, 400, 'counts belong to the installation')
  assert.equal((await stranger('PUT', '/v1/settings/learning', { version: 1, coreCardCount: 5 })).status, 403)
  // The service checks the same rules for the admin tools.
  await assert.rejects(ctx.runtime.learning.setInstallation(ctx.actor, { searchCardCount: 99 }), /Invalid searchCardCount/)
  await assert.rejects(ctx.runtime.learning.setInstallation(ctx.actor, { nightlyModel: { adapterId: 'x', modelId: 'y' } }, ctx.dispatcher.catalog()), /Invalid nightly model/)
  const events = (await readEvents(ctx.db, scope, start)).events.map(event => textEvent.parse(JSON.parse(JSON.stringify(event))))
  assert.deepEqual(events.map(event => [event.type, event.revision, event.data]), [
    ['learning-changed', 1, { target: 'installation', enabled: false, sleepTime: '01:00', nightlyModel: model, coreCardCount: 0, searchCardCount: 50, searchChunkCount: 30 }],
    ['learning-changed', 2, { target: 'installation', enabled: false, sleepTime: '01:00', nightlyModel: null, coreCardCount: 200, searchCardCount: 50, searchChunkCount: 30 }],
  ])
})
