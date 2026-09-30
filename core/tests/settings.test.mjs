import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { AdapterRegistry, openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { agentCreateResult, effectiveSettings, executionAdapters, organizationResult, settingsResult, settingsSnapshot, textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Saved and effective execution settings and the execution adapter list, over HTTP against real
// PostgreSQL. Work runs through the deterministic fixture adapter.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixtureModels = [{ id: 'fixture-model', efforts: ['low', 'high'] }, { id: 'fixture-large' }]

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_settings_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-settings-home-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return { url: url.href, home, closers }
}

async function until(read, match, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (match(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}

/**
 * A runtime with an HTTP server and a dispatcher. By default the dispatcher runs the fixture adapter
 * directly, with a two-model catalog; `probe` replaces its readiness. `adapter` supplies another one.
 * `ctx.advance(ms)` moves the runtime clock.
 */
async function setup(t, { probe, adapter } = {}) {
  const base = await database(t)
  let offset = 0
  const runtime = await openRuntime({ connectionString: base.url, home: base.home, names, clock: () => new Date(Date.now() + offset) })
  base.closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  const ready = await inner.readiness()
  const catalogReadiness = { ...ready, catalog: { ...ready.catalog, models: fixtureModels } }
  const direct = {
    ...inner,
    async readiness() { return probe ? probe(catalogReadiness) : catalogReadiness },
    async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle },
  }
  dispatcher = new TextDispatcher(runtime, adapter ?? direct)
  base.closers.push(() => dispatcher.close())
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0, dispatcher })
    base.closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const call = await serve(actor)
  await dispatcher.start()
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  const context = organizationId => ({ kind: 'organization', organizationId })
  const ctx = {
    ...base, runtime, db: runtime.db, actor, installationId, ownerId, organizationId, rootAgentId, executions, dispatcher, serve, call, ok,
    appScope: { kind: 'application', installationId, callerId: ownerId },
    organization: async (name, settings) => organizationResult.parse(await ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name, ...(settings ? { settings } : {}) })).organization,
    agent: async (name, organizationId, settings) => agentCreateResult.parse(await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId, ...(settings ? { settings } : {}) })).agent,
    set: async (target, id, settings, operationId = randomUUID()) => settingsResult.parse(await ok('PUT', `/v1/${target}/${id}/settings`, { version: 1, operationId, settings })),
    effective: async (agentId, organizationId) => effectiveSettings.parse(await ok('GET', `/v1/agents/${agentId}/effective-settings${organizationId ? `?organizationId=${organizationId}` : ''}`)),
    adapters: async () => executionAdapters.parse(await ok('GET', '/v1/execution-adapters')),
    refresh: async () => executionAdapters.parse(await ok('POST', '/v1/execution-adapters/refresh', { version: 1 })),
    saved: async () => settingsSnapshot.parse(await ok('GET', '/v1/settings')),
    say: async (organizationId, agentId, text) => {
      const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context: context(organizationId), agentId })
      const response = await call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: context(organizationId), chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
      assert.equal(response.status, 202, JSON.stringify(response.data))
      return response.data
    },
    run: async runId => (await runtime.db.query('SELECT state, failure FROM kipster.text_runs WHERE id=$1', [runId])).rows[0],
    events: async cursor => (await readEvents(runtime.db, { kind: 'application', installationId, callerId: ownerId }, cursor)).events.map(event => textEvent.parse(event)),
  }
  /** Moves the runtime clock forward. */
  ctx.advance = ms => { offset += ms }
  ctx.execution = runId => until(() => executions.find(e => e.context.runId === runId), Boolean, `execution of ${runId}`)
  ctx.settled = (runId, state) => until(async () => (await ctx.run(runId))?.state, value => value === state, `${runId} ${state}`)
  return ctx
}

const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const count = async (db, sql, values) => Number((await db.query(sql, values)).rows[0].n)

/** Applies settings events as a client does: a record replaces one with an older or equal revision. */
function mergeSettings(snapshot, events) {
  const next = structuredClone(snapshot)
  const lists = { agent: 'agents', organization: 'organizations' }
  for (const event of events) {
    next.cursor = event.cursor
    if (event.type !== 'settings-changed') continue
    const list = lists[event.data.target]
    const current = next[list].find(item => item.id === event.resourceId)
    if (!current || current.revision <= event.revision) next[list] = [...next[list].filter(item => item.id !== event.resourceId), event.data]
  }
  return next
}
/** Applies adapter list events: the list is replaced when the revision is not older. */
function mergeAdapters(list, events) {
  const next = structuredClone(list)
  for (const event of events) {
    next.cursor = event.cursor
    if (event.type === 'adapters-changed' && event.revision >= next.revision) Object.assign(next, { revision: event.revision, adapters: event.data.adapters })
  }
  return next
}
const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id))
const comparable = s => ({ cursor: s.cursor, agents: byId(s.agents), organizations: byId(s.organizations) })

test('clearing an agent override restores the inherited value, and the next execution uses it', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id, { modelId: { set: 'fixture-large' } })
  let effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.settings, effective.sources], ['ready', null,
    { adapterId: 'deterministic-fixture', modelId: 'fixture-large' }, { adapterId: 'organization', modelId: 'agent' }])

  const cleared = await ctx.set('agents', scout.id, { modelId: { clear: true } })
  assert.deepEqual(cleared.settings, { target: 'agent', id: scout.id, revision: 2, settings: {} })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings.modelId, effective.sources.modelId], ['ready', 'fixture-model', 'organization'])

  // A changed organization default reaches the agent that inherits it.
  await ctx.set('organizations', org.id, { effort: { set: 'high' } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings.effort, effective.sources.effort], ['ready', 'high', 'organization'])
  const run = await ctx.say(org.id, scout.id, 'Plan the launch')
  const { context } = await ctx.execution(run.runId)
  assert.deepEqual(context.settings, { adapterId: 'deterministic-fixture', modelId: 'fixture-model', effort: 'high' })

  // The admin agent works in the installation, with its own settings.
  await ctx.set('agents', ctx.rootAgentId, { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-large' } })
  effective = await ctx.effective(ctx.rootAgentId, null)
  assert.deepEqual([effective.status, effective.organizationId, effective.sources], ['ready', null, { adapterId: 'agent', modelId: 'agent' }])
  // This adapter declares no default model, so a cleared model leaves the selection incomplete.
  await ctx.set('agents', ctx.rootAgentId, { modelId: { clear: true } })
  effective = await ctx.effective(ctx.rootAgentId, null)
  assert.deepEqual([effective.status, effective.reason, effective.settings], ['missing', 'Adapter and model must be configured', { adapterId: 'deterministic-fixture' }])

  // An organization default can be cleared too; an ordinary agent has no installation settings.
  await ctx.set('organizations', org.id, { modelId: { clear: true } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings, effective.sources], ['missing', { adapterId: 'deterministic-fixture', effort: 'high' }, { adapterId: 'organization', effort: 'organization' }])
  assert.equal((await ctx.call('PUT', `/v1/agents/${scout.id}/settings`, { version: 1, operationId: randomUUID(), settings: {} })).status, 400)
  assert.equal((await ctx.call('GET', `/v1/agents/${scout.id}/effective-settings`)).status, 400)
  assert.equal((await ctx.call('GET', `/v1/agents/${randomUUID()}/effective-settings?organizationId=${org.id}`)).status, 404)
  assert.equal((await ctx.call('GET', `/v1/agents/${scout.id}/effective-settings?organizationId=${randomUUID()}`)).status, 404)
})

test('an agent without settings uses the first adapter and its default model, and its own choices win', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { probe: ready => ({ ...ready, catalog: { ...ready.catalog, defaultModel: { id: 'fixture-model', effort: 'low' } } }) })
  const defaults = { adapterId: 'deterministic-fixture', modelId: 'fixture-model', effort: 'low' }
  const everyDefault = { adapterId: 'default', modelId: 'default', effort: 'default' }
  assert.deepEqual((await ctx.adapters()).adapters.map(adapter => adapter.defaultModel), [{ id: 'fixture-model', effort: 'low' }])
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id)
  let effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings, effective.sources], ['ready', defaults, everyDefault])
  const run = await ctx.say(org.id, scout.id, 'Plan the launch')
  assert.deepEqual((await ctx.execution(run.runId)).context.settings, defaults)

  // The admin agent needs no settings of its own in the installation.
  effective = await ctx.effective(ctx.rootAgentId, null)
  assert.deepEqual([effective.status, effective.settings, effective.sources], ['ready', defaults, everyDefault])

  // An organization effort replaces the default effort; the default model stays.
  await ctx.set('organizations', org.id, { effort: { set: 'high' } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings, effective.sources], ['ready', { ...defaults, effort: 'high' }, { ...everyDefault, effort: 'organization' }])

  // A chosen model comes without the default effort.
  await ctx.set('organizations', org.id, { effort: { clear: true } })
  await ctx.set('agents', scout.id, { modelId: { set: 'fixture-large' } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.settings, effective.sources], ['ready', { adapterId: 'deterministic-fixture', modelId: 'fixture-large' }, { adapterId: 'default', modelId: 'agent' }])
})

test('an incompatible inherited model or effort is reported with a reason and the saved values', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind', { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'retired-model' } })
  const scout = await ctx.agent('Scout', org.id)
  let effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.settings.modelId, effective.sources.modelId], ['incompatible', 'Model is unavailable for adapter', 'retired-model', 'organization'])
  const run = await ctx.say(org.id, scout.id, 'Plan the launch')
  await ctx.settled(run.runId, 'failed')
  assert.match((await ctx.run(run.runId)).failure, /Model is unavailable for adapter/)

  await ctx.set('organizations', org.id, { modelId: { set: 'fixture-large' }, effort: { set: 'high' } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.settings.effort, effective.sources.effort], ['incompatible', 'Effort is unsupported for model', 'high', 'organization'])
  // The agent's own model supports the inherited effort.
  await ctx.set('agents', scout.id, { modelId: { set: 'fixture-model' } })
  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.sources], ['ready', null, { adapterId: 'organization', modelId: 'agent', effort: 'organization' }])
})

test('a missing adapter keeps the saved selection and reports the reason', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id, { adapterId: { set: 'retired-adapter' }, modelId: { set: 'old-model' }, effort: { set: 'low' } })
  const effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.settings], ['incompatible', 'Adapter is unavailable', { adapterId: 'retired-adapter', modelId: 'old-model', effort: 'low' }])
  const saved = await ctx.saved()
  assert.deepEqual(saved.agents.find(record => record.id === scout.id).settings, { adapterId: 'retired-adapter', modelId: 'old-model', effort: 'low' })
  const run = await ctx.say(org.id, scout.id, 'Plan the launch')
  await ctx.settled(run.runId, 'failed')
  assert.match((await ctx.run(run.runId)).failure, /Adapter is unavailable/)
  assert.deepEqual((await ctx.saved()).agents.find(record => record.id === scout.id).settings, { adapterId: 'retired-adapter', modelId: 'old-model', effort: 'low' })
})

test('a throwing readiness probe does not stop startup; the adapter is unavailable until a refresh finds it ready', { skip: noDatabase }, async t => {
  let failing = true, probes = 0
  const ctx = await setup(t, { probe: ready => { probes++; if (failing) throw new Error('Provider login required'); return ready } })
  let list = await ctx.adapters()
  assert.deepEqual([list.revision, list.adapters], [1, [{ id: 'deterministic-fixture', version: '1', available: false, reason: 'Provider login required', models: [], defaultModel: null, supportedOptions: [], capabilities: null }]])
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id)
  let effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason, effective.settings], ['incompatible', 'Adapter is unavailable', { adapterId: 'deterministic-fixture', modelId: 'fixture-model' }])
  const refused = await ctx.say(org.id, scout.id, 'Plan the launch')
  await ctx.settled(refused.runId, 'failed')
  assert.match((await ctx.run(refused.runId)).failure, /Adapter is unavailable/)
  assert.equal(ctx.executions.length, 0)

  // A refresh that still fails changes nothing and publishes nothing.
  const before = await ctx.adapters()
  assert.deepEqual(await ctx.refresh(), before)
  failing = false
  const refreshed = await ctx.refresh()
  assert.equal(refreshed.revision, 2)
  assert.deepEqual(refreshed.adapters, [{ id: 'deterministic-fixture', version: '1', available: true, reason: null,
    models: [{ id: 'fixture-model', efforts: ['low', 'high'] }, { id: 'fixture-large', efforts: [] }], defaultModel: null, supportedOptions: [],
    capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false, maintenance: true } }])
  const events = await ctx.events(before.cursor)
  assert.deepEqual(events.filter(e => e.type === 'adapters-changed').map(e => [e.resourceId, e.revision]), [[ctx.installationId, 2]])
  list = mergeAdapters(before, events)
  assert.deepEqual(list, await ctx.adapters())
  assert.equal(probes, 3)

  effective = await ctx.effective(scout.id, org.id)
  assert.deepEqual([effective.status, effective.reason], ['ready', null])
  const run = await ctx.say(org.id, scout.id, 'Plan the launch again')
  const { context, handle } = await ctx.execution(run.runId)
  handle.release({ kind: 'text', attemptId: context.attemptId, messageId: randomUUID(), text: 'Planned', final: true })
  handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
  await ctx.settled(run.runId, 'completed')
})

test('work that selects an unavailable adapter probes it again at most once per interval, so a passing failure heals without a refresh', { skip: noDatabase }, async t => {
  let failing = true, probes = 0
  const ctx = await setup(t, { probe: ready => { probes++; if (failing) throw new Error('Provider starting'); return ready } })
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id)
  const refuse = async text => {
    const run = await ctx.say(org.id, scout.id, text)
    await ctx.settled(run.runId, 'failed')
    assert.match((await ctx.run(run.runId)).failure, /Adapter is unavailable/)
  }
  // Within the interval after the startup probe, work is refused without probing.
  await refuse('First')
  await refuse('Second')
  assert.equal(probes, 1)
  // After the interval, the next work probes once; it still fails, so that work and the next are refused.
  ctx.advance(31000)
  await refuse('Third')
  await refuse('Fourth')
  assert.equal(probes, 2)
  // Once the provider is ready, the next work after the interval probes, finds it ready and runs.
  failing = false
  ctx.advance(31000)
  const before = await ctx.adapters()
  const run = await ctx.say(org.id, scout.id, 'Fifth')
  const { context, handle } = await ctx.execution(run.runId)
  handle.release({ kind: 'text', attemptId: context.attemptId, messageId: randomUUID(), text: 'Done', final: true })
  handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
  await ctx.settled(run.runId, 'completed')
  assert.equal(probes, 3)
  const after = await ctx.adapters()
  assert.deepEqual([after.revision, after.adapters[0].available, after.adapters[0].reason], [before.revision + 1, true, null])
  assert.deepEqual((await ctx.events(before.cursor)).filter(e => e.type === 'adapters-changed').map(e => e.revision), [after.revision])
  // An available adapter is not probed again.
  const next = await ctx.say(org.id, scout.id, 'Sixth')
  await ctx.execution(next.runId)
  assert.equal(probes, 3)
})

test('a registered adapter that stops being ready, exits or is removed is listed with its reason and each change is published', { skip: noDatabase, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-settings-registry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installation = join(root, 'installation'), state = join(root, 'state.txt')
  await mkdir(join(installation, 'dist'), { recursive: true })
  await writeFile(join(installation, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(state, 'ready')
  await writeFile(join(installation, 'dist/index.mjs'), `import { readFileSync } from 'node:fs'
export function createAdapter() {
  return {
    id: 'probe-fixture', version: '2', contractMajor: 1,
    async readiness() {
      const state = readFileSync(${JSON.stringify(state)}, 'utf8')
      if (state === 'throw') throw new Error('Provider unreachable')
      return { ready: state === 'ready', ...(state === 'ready' ? {} : { reason: 'Provider login required' }), catalog: { models: [{ id: 'probe-model', efforts: ['low'] }], supportedOptions: ['temperature'], capabilities: { text: true, publication: true, cancellation: true, steering: false, nativeResume: false } } }
    },
    async execute(context) {
      return {
        events: (async function* () { yield { kind: 'text', attemptId: context.attemptId, messageId: 'reply', text: 'Planned', final: true }; yield { kind: 'ended', attemptId: context.attemptId, confirmed: true } })(),
        async cancel() { return { acknowledged: true, confirmedEnded: true } },
        async reconcile() { return 'ended' },
      }
    },
    async close() {},
  }
}
`)
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } }, join(root, 'generations'))
  t.after(() => registry.close())
  await registry.register('probe-fixture', installation, 'dist/index.mjs')
  const ctx = await setup(t, { adapter: registry })
  const org = await ctx.organization('Northwind', { adapterId: { set: 'probe-fixture' }, modelId: { set: 'probe-model' } })
  const scout = await ctx.agent('Scout', org.id)
  const start = await ctx.adapters()
  const available = { id: 'probe-fixture', version: '2', available: true, reason: null, models: [{ id: 'probe-model', efforts: ['low'] }], defaultModel: null, supportedOptions: ['temperature'], capabilities: { text: true, publication: true, cancellation: true, steering: false, nativeResume: false, maintenance: false } }
  assert.deepEqual([start.revision, start.adapters], [1, [available]])
  assert.equal((await ctx.effective(scout.id, org.id)).status, 'ready')

  await writeFile(state, 'not-ready')
  let list = await ctx.refresh()
  assert.deepEqual([list.revision, list.adapters], [2, [{ ...available, available: false, reason: 'Provider login required' }]])
  assert.deepEqual(await ctx.effective(scout.id, org.id).then(e => [e.status, e.reason, e.settings.adapterId]), ['incompatible', 'Adapter is unavailable', 'probe-fixture'])
  await writeFile(state, 'throw')
  list = await ctx.refresh()
  assert.deepEqual([list.revision, list.adapters[0].available, list.adapters[0].reason], [3, false, 'Provider unreachable'])
  // Work that selects it after the interval probes it again instead of waiting for a refresh.
  await writeFile(state, 'ready')
  ctx.advance(31000)
  const healed = await ctx.say(org.id, scout.id, 'Plan the launch')
  await ctx.settled(healed.runId, 'completed')
  list = await ctx.adapters()
  assert.deepEqual([list.revision, list.adapters], [4, [available]])

  // A runner that exits and a removal are recorded without a refresh.
  const route = registry.selected('probe-fixture', 'probe')
  route.adapter.child.kill('SIGKILL')
  list = await until(() => ctx.adapters(), value => value.revision === 5, 'runner exit recorded')
  assert.deepEqual(list.adapters, [{ ...available, available: false, reason: 'Adapter runner exited' }])
  route.release('probe')
  await registry.remove('probe-fixture')
  list = await until(() => ctx.adapters(), value => value.revision === 6, 'removal recorded')
  assert.deepEqual(list.adapters, [])
  assert.deepEqual(await ctx.effective(scout.id, org.id).then(e => [e.status, e.reason, e.settings]), ['incompatible', 'Adapter is unavailable', { adapterId: 'probe-fixture', modelId: 'probe-model' }])

  const events = (await ctx.events(start.cursor)).filter(e => e.type === 'adapters-changed')
  assert.deepEqual(events.map(e => e.revision), [2, 3, 4, 5, 6])
  assert.deepEqual(mergeAdapters(start, await ctx.events(start.cursor)), await ctx.adapters())
})

test('a repeated settings operation ID returns the recorded result', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id)
  const first = await ctx.set('agents', scout.id, { modelId: { set: 'fixture-large' } }, 'same')
  assert.equal((await ctx.call('PUT', `/v1/agents/${scout.id}/settings`, { version: 1, operationId: 'same', settings: { modelId: { set: 'fixture-model' } } })).status, 409)
  const again = await ctx.set('agents', scout.id, { modelId: { set: 'fixture-large' } }, 'same')
  assert.deepEqual([again.alreadyApplied, again.settings], [true, first.settings])
  assert.deepEqual((await ctx.saved()).agents.find(record => record.id === scout.id), { target: 'agent', id: scout.id, revision: 2, settings: { modelId: 'fixture-large' } })
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.app_events WHERE type='settings-changed' AND resource_id=$1`, [scout.id]), 2)

  const racing = await Promise.all([1, 2, 3].map(n => ctx.call('PUT', `/v1/organizations/${org.id}/settings`, { version: 1, operationId: 'race', settings: { effort: { set: n === 1 ? 'low' : 'high' } } })))
  assert.ok(racing.every(response => [200, 409].includes(response.status)))
  assert.ok(racing.some(response => response.status === 409), 'the competing changed payload conflicts')
  const accepted = racing.filter(response => response.status === 200)
  assert.equal(accepted.filter(response => !response.data.alreadyApplied).length, 1)
  for (const response of accepted) assert.deepEqual(response.data.settings, accepted[0].data.settings)
  assert.equal((await ctx.saved()).organizations.find(record => record.id === org.id).revision, 2)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.app_events WHERE type='settings-changed' AND resource_id=$1`, [org.id]), 2)

  const samePayload = await Promise.all([1, 2, 3].map(() => ctx.call('PUT', `/v1/agents/${scout.id}/settings`, { version: 1, operationId: 'race-same', settings: { effort: { set: 'low' } } })))
  assert.deepEqual(samePayload.map(response => response.status), [200, 200, 200])
  assert.deepEqual(samePayload.map(response => response.data.alreadyApplied).sort(), [false, true, true])
  for (const response of samePayload) assert.deepEqual(response.data.settings, samePayload[0].data.settings)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.app_events WHERE type='settings-changed' AND resource_id=$1`, [scout.id]), 3)

  // One operation ID names one request.
  assert.equal((await ctx.call('PUT', `/v1/agents/${ctx.rootAgentId}/settings`, { version: 1, operationId: 'same', settings: { modelId: { set: 'fixture-large' } } })).status, 409)
  assert.equal((await ctx.call('PUT', `/v1/agents/${scout.id}`, { version: 1, operationId: 'same', name: 'Renamed' })).status, 409)
  assert.equal((await ctx.call('PUT', `/v1/organizations/${org.id}/settings`, { version: 1, operationId: 'same', settings: { effort: { set: 'low' } } })).status, 409)
})

test('only the installation owner may read or change settings and adapters', { skip: noDatabase }, async t => {
  let probes = 0
  const ctx = await setup(t, { probe: ready => { probes++; return ready } })
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id)
  const before = await ctx.saved()
  const requests = [
    ['GET', '/v1/settings'],
    ['PUT', `/v1/agents/${scout.id}/settings`, { version: 1, operationId: 'x1', settings: { modelId: { set: 'fixture-large' } } }],
    ['PUT', `/v1/agents/${ctx.rootAgentId}/settings`, { version: 1, operationId: 'x2', settings: { modelId: { set: 'fixture-large' } } }],
    ['PUT', `/v1/organizations/${org.id}/settings`, { version: 1, operationId: 'x3', settings: { effort: { set: 'low' } } }],
    ['PUT', `/v1/agents/${scout.id}`, { version: 1, operationId: 'x4', settings: { effort: { set: 'low' } } }],
    ['GET', `/v1/agents/${scout.id}/effective-settings?organizationId=${org.id}`],
    ['GET', '/v1/execution-adapters'],
    ['POST', '/v1/execution-adapters/refresh', { version: 1 }],
  ]
  const person = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [person, ctx.installationId, 'Member'])
  await ctx.db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [org.id, person])
  const probesBefore = probes
  for (const actor of [{ installationId: ctx.installationId, personId: person }, { installationId: randomUUID(), personId: ctx.ownerId }]) {
    const call = await ctx.serve(actor)
    for (const [method, path, body] of requests) {
      const response = await call(method, path, body)
      assert.deepEqual([response.status, response.data.code], [403, 'forbidden'], `${method} ${path}`)
    }
  }
  assert.equal(probes, probesBefore)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.admin_operations WHERE operation_id LIKE 'x%'`), 0)
  // A server without a dispatcher has no adapters to list.
  const bare = await startTextServer(ctx.runtime, ctx.actor, { host: '127.0.0.1', port: 0 })
  ctx.closers.push(() => bare.close())
  for (const [method, body] of [['GET'], ['POST', { version: 1 }]]) {
    const response = await fetch(`${bare.url}/v1/execution-adapters${body ? '/refresh' : ''}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    assert.deepEqual([response.status, (await response.json()).code], [503, 'unavailable'])
  }
  assert.deepEqual(await ctx.saved(), before)
})

test('settings events let a client merge saved settings to match a fresh read', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const snapshot = await ctx.saved()
  assert.deepEqual(snapshot.agents.map(record => record.id), [ctx.rootAgentId])
  assert.deepEqual(snapshot.organizations.map(record => record.id), [ctx.organizationId])
  const org = await ctx.organization('Northwind', fixture)
  const scout = await ctx.agent('Scout', org.id, { modelId: { set: 'fixture-large' } })
  await ctx.set('agents', scout.id, { effort: { set: 'low' } }, 'effort')
  assert.equal((await ctx.call('PUT', `/v1/agents/${scout.id}/settings`, { version: 1, operationId: 'effort', settings: { effort: { set: 'high' } } })).status, 409)
  await ctx.set('agents', scout.id, { effort: { set: 'low' } }, 'effort')
  await ctx.ok('PUT', `/v1/agents/${scout.id}`, { version: 1, operationId: randomUUID(), name: 'Scout II', settings: { options: { set: { tone: 'brief' } } } })
  await ctx.ok('PUT', `/v1/organizations/${org.id}`, { version: 1, operationId: randomUUID(), settings: { effort: { set: 'high' } } })
  await ctx.set('organizations', ctx.organizationId, { adapterId: { set: 'deterministic-fixture' } })
  await ctx.set('agents', ctx.rootAgentId, fixture)
  await ctx.set('agents', scout.id, { modelId: { clear: true }, effort: { clear: true } })
  // A name-only update changes no settings.
  await ctx.ok('PUT', `/v1/organizations/${org.id}`, { version: 1, operationId: randomUUID(), name: 'Northwind Traders' })

  const events = await ctx.events(snapshot.cursor)
  assert.deepEqual(events.filter(e => e.type === 'settings-changed').map(e => [e.resourceId, e.revision]), [
    [org.id, 1], [scout.id, 1], [scout.id, 2], [scout.id, 3], [org.id, 2], [ctx.organizationId, 2], [ctx.rootAgentId, 2], [scout.id, 4]])
  const fresh = await ctx.saved()
  assert.deepEqual(comparable(mergeSettings(snapshot, events)), comparable(fresh))
  assert.deepEqual(fresh.agents.find(record => record.id === scout.id).settings, { options: { tone: 'brief' } })
  // Replaying from an older cursor converges too, because every merge checks revisions.
  assert.deepEqual(comparable(mergeSettings(mergeSettings(snapshot, events), events)), comparable(fresh))
})
