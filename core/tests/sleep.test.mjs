import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MaintenanceService, SleepService, SLEEP, MEMORY_STRENGTH } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { learningSettings } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Sleep scheduling and the forgetting step against real PostgreSQL with the deterministic fixture adapter.
// The wall clock is injected; times are local to the host, as sleep times are.
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }

async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 400; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
}
const row = async (db, sql, params = []) => (await db.query(sql, params)).rows[0]
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n)

async function setup(t) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_sleep_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-sleep-home-'))
  const time = { now: new Date(2026, 0, 10, 12) }
  const runtime = await openRuntime({ connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, embedding: { ...profile, async embed() { return [1, 0] } } })
  await runtime.memory.stopIndexing()
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const agentId = runtime.bootstrap.rootAgentId
  const context = { kind: 'installation', installationId: actor.installationId }
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await runtime.learning.setInstallation(actor, { enabled: true })
  const { chatId } = await resolveDirectChat(runtime.db, actor, context, agentId)
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  const servers = []
  t.after(async () => {
    for (const server of servers) await server.close()
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const serve = async () => {
    const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0 })
    servers.push(server)
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  return { runtime, db: runtime.db, actor, agentId, context, chatId, dispatcher, executions, time, serve, sleeper: new SleepService(runtime.db, actor.installationId, runtime.home.identity) }
}

/** Sets the test clock to a local time on a January 2026 day. */
const at = (ctx, day, hours, minutes = 0) => { ctx.time.now = new Date(2026, 0, day, hours, minutes) }
const sleep = ctx => ctx.sleeper.run(ctx.time.now)
const slept = (started, finished, forgotten = 0, skipped = 0) => ({ started, finished, skipped, forgotten })
const sleeps = (ctx, agentId = ctx.agentId) => ctx.db.query(`SELECT sleep_on::text AS day, state, step, report FROM kipster.memory_sleeps WHERE agent_id=$1 ORDER BY sleep_on`, [agentId]).then(result => result.rows)
const days = async (ctx, agentId = ctx.agentId) => (await sleeps(ctx, agentId)).map(item => item.day)
/** Saves notes and ages the agent by `activeDays` so that they fall below the forget threshold. */
async function weakNotes(ctx, total, activeDays = 200) {
  await ctx.db.query(`INSERT INTO kipster.memory_activity(agent_id, active_on) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`, [ctx.agentId])
  for (let i = 0; i < total; i++) await ctx.runtime.memory.save(ctx.agentId, 'fact', `Note number ${i}`, [{ subject: 'notes' }])
  await ctx.db.query('UPDATE kipster.memory_activity SET active_days=active_days+$2 WHERE agent_id=$1', [ctx.agentId, activeDays])
}
const notes = ctx => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE text LIKE 'Note number %'`)
async function startConversation(ctx, text) {
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: ctx.context, chatId: ctx.chatId }, mode: 'root', parts: [{ kind: 'text', text }],
  })
  const found = await until(() => ctx.executions.find(e => e.context.runId === saved.runId && e.context.kind !== 'maintenance'), Boolean, `execution ${saved.runId}`)
  return async () => {
    found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
    found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).state, s => s === 'completed', `completed ${saved.runId}`)
  }
}

test('an agent sleeps once per sleep day, at or after its sleep time, even if it never worked', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_activity'), 0)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  assert.deepEqual(await sleeps(ctx), [{ day: '2026-01-10', state: 'finished', step: 'promote', report: {} }])
  assert.deepEqual(await sleep(ctx), slept(0, 0), 'once per day')
  at(ctx, 11, 0, 59)
  assert.deepEqual(await sleep(ctx), slept(0, 0), 'not before the sleep time')
  at(ctx, 11, 1, 0)
  assert.deepEqual(await sleep(ctx), slept(1, 1), 'at the sleep time')
  at(ctx, 11, 23, 59)
  assert.deepEqual(await sleep(ctx), slept(0, 0))
  at(ctx, 12, 1, 30)
  assert.deepEqual(await sleep(ctx), slept(1, 1), 'after the sleep time')
  assert.deepEqual(await days(ctx), ['2026-01-10', '2026-01-11', '2026-01-12'])
})

test('after downtime an agent sleeps once, never once per missed day', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  at(ctx, 15, 9)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  assert.deepEqual(await sleep(ctx), slept(0, 0))
  assert.deepEqual(await days(ctx), ['2026-01-10', '2026-01-15'])
  // Back before the sleep time: the missed night is caught up now, and the next one follows at the sleep time.
  at(ctx, 20, 0, 30)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  at(ctx, 20, 1)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  assert.deepEqual(await days(ctx), ['2026-01-10', '2026-01-15', '2026-01-19', '2026-01-20'])
})

test('an agent sleep time overrides the installation default and both change over HTTP', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const other = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, provisioned) VALUES ($1,$2,'Other',true)`, [other, ctx.actor.installationId])
  const call = await ctx.serve()
  assert.equal((await call('PUT', '/v1/settings/learning', { version: 1, sleepTime: '22:00' })).status, 200)
  assert.equal((await call('PUT', `/v1/agents/${other}/learning`, { version: 1, sleepTime: '03:30' })).status, 200)
  const settings = learningSettings.parse((await call('GET', '/v1/settings/learning')).data)
  assert.deepEqual([settings.sleepTime, settings.agents.map(agent => [agent.agentId, agent.sleepTime])], ['22:00', [[other, '03:30'], [ctx.agentId, null]]])
  // Noon on the 10th: the root agent's sleep day is still the 9th (22:00), the other agent's is the 10th (03:30).
  assert.deepEqual(await sleep(ctx), slept(2, 2))
  assert.deepEqual([await days(ctx), await days(ctx, other)], [['2026-01-09'], ['2026-01-10']])
  at(ctx, 10, 21, 59)
  assert.deepEqual(await sleep(ctx), slept(0, 0))
  at(ctx, 10, 22)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  at(ctx, 11, 3, 29)
  assert.deepEqual(await sleep(ctx), slept(0, 0))
  at(ctx, 11, 3, 30)
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  assert.deepEqual([await days(ctx), await days(ctx, other)], [['2026-01-09', '2026-01-10'], ['2026-01-10', '2026-01-11']])
  // Clearing the override puts the other agent back on the default; a day it already slept is not repeated.
  assert.equal((await call('PUT', `/v1/agents/${other}/learning`, { version: 1, sleepTime: null })).status, 200)
  at(ctx, 11, 22)
  assert.deepEqual(await sleep(ctx), slept(1, 1), 'only the root agent: the other already slept on the 11th')
  at(ctx, 12, 3, 30)
  assert.deepEqual(await sleep(ctx), slept(0, 0))
  at(ctx, 12, 22)
  assert.deepEqual(await sleep(ctx), slept(2, 2))
  assert.deepEqual([await days(ctx), await days(ctx, other)], [['2026-01-09', '2026-01-10', '2026-01-11', '2026-01-12'], ['2026-01-10', '2026-01-11', '2026-01-12']])
  assert.deepEqual((await sleeps(ctx, other)).map(item => item.state), ['finished', 'finished', 'finished'])
})

test('forgetting happens only during sleep: a weak memory survives maintenance ticks until the sleep runs', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await days(ctx), ['2026-01-10'])
  await weakNotes(ctx, 1)
  for (const [day, hours, minutes] of [[10, 18, 0], [11, 0, 0], [11, 0, 59]]) {
    at(ctx, day, hours, minutes)
    await ctx.dispatcher.maintenanceTick()
    assert.equal(await notes(ctx), 1, `kept at ${day} ${hours}:${minutes}`)
  }
  assert.deepEqual(await days(ctx), ['2026-01-10'])
  at(ctx, 11, 1)
  await ctx.dispatcher.maintenanceTick()
  assert.equal(await notes(ctx), 0)
  assert.deepEqual(await sleeps(ctx), [
    { day: '2026-01-10', state: 'finished', step: 'promote', report: {} },
    { day: '2026-01-11', state: 'finished', step: 'promote', report: { forgotten: 1 } },
  ])
})

test('sleep waits while one of the agent executions is in flight, before and during forgetting', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  assert.deepEqual(await sleep(ctx), slept(1, 1))
  await weakNotes(ctx, MEMORY_STRENGTH.forgetBatch + 5)
  at(ctx, 11, 2)
  const finish = await startConversation(ctx, 'Note number 0')
  const held = ctx.executions.find(e => e.context.kind !== 'maintenance')
  assert.ok(held.context.memory.join('\n').includes('Note number 0'), 'the held execution received the memory')
  await ctx.db.query('UPDATE kipster.memory_activity SET active_days=active_days+200 WHERE agent_id=$1', [ctx.agentId])
  assert.deepEqual(await sleep(ctx), slept(0, 0), 'no sleep begins while the agent works')
  assert.equal(await notes(ctx), MEMORY_STRENGTH.forgetBatch + 5, 'even the memory supplied to the held execution survives')
  assert.deepEqual(await days(ctx), ['2026-01-10'])
  await finish()
  assert.deepEqual(await sleep(ctx), slept(1, 0, MEMORY_STRENGTH.forgetBatch))
  const again = await startConversation(ctx, 'Another task')
  assert.deepEqual(await sleep(ctx), slept(0, 0), 'the sleep pauses while the agent works')
  assert.equal(await notes(ctx), 5)
  await again()
  assert.deepEqual(await sleep(ctx), slept(0, 1, 5))
  assert.deepEqual((await sleeps(ctx)).at(-1), { day: '2026-01-11', state: 'finished', step: 'promote', report: { forgotten: MEMORY_STRENGTH.forgetBatch + 5 } })
})

for (const target of ['agent', 'installation']) {
  test(`switching the ${target} learning switch off mid-sleep records the sleep as skipped and stops it`, { skip: noDatabase }, async t => {
    const ctx = await setup(t)
    await ctx.dispatcher.start()
    assert.deepEqual(await sleep(ctx), slept(1, 1))
    await weakNotes(ctx, MEMORY_STRENGTH.forgetBatch + 5)
    at(ctx, 11, 2)
    assert.deepEqual(await sleep(ctx), slept(1, 0, MEMORY_STRENGTH.forgetBatch))
    const set = enabled => target === 'agent' ? ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled }) : ctx.runtime.learning.setInstallation(ctx.actor, { enabled })
    await set(false)
    await ctx.dispatcher.maintenanceTick()
    assert.deepEqual((await sleeps(ctx)).at(-1), { day: '2026-01-11', state: 'skipped', step: 'forget', report: { forgotten: MEMORY_STRENGTH.forgetBatch, reason: 'learning_disabled' } })
    assert.ok((await row(ctx.db, `SELECT finished_at FROM kipster.memory_sleeps WHERE sleep_on='2026-01-11'`)).finished_at)
    assert.deepEqual(await sleep(ctx), slept(0, 0))
    assert.equal(await notes(ctx), 5, 'nothing further runs')
    // Switching back on the same day does not repeat that day's sleep; the next day's sleep runs as usual.
    await set(true)
    assert.deepEqual(await sleep(ctx), slept(0, 0))
    assert.equal(await notes(ctx), 5)
    at(ctx, 12, 2)
    assert.deepEqual(await sleep(ctx), slept(1, 1, 5))
  })
}

test('an agent whose sleep keeps failing does not hold back the others', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  // Forgetting fails for pinned notes, standing in for any error that repeats on every attempt.
  await ctx.db.query(`CREATE FUNCTION kipster.refuse_pinned() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pinned memory'; END $$`)
  await ctx.db.query(`CREATE TRIGGER refuse_pinned BEFORE DELETE ON kipster.memory_records FOR EACH ROW WHEN (OLD.text LIKE 'Pinned%') EXECUTE FUNCTION kipster.refuse_pinned()`)
  const agentWithWeakNote = async (agentId, text) => {
    await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, provisioned) VALUES ($1,$2,$3,true)`, [agentId, ctx.actor.installationId, text])
    await ctx.db.query(`INSERT INTO kipster.memory_activity(agent_id, active_on) VALUES ($1, CURRENT_DATE)`, [agentId])
    await ctx.runtime.memory.save(agentId, 'fact', text, [{ subject: 'notes' }])
    await ctx.db.query('UPDATE kipster.memory_activity SET active_days=200 WHERE agent_id=$1', [agentId])
  }
  // More failing agents than one run takes, all sorting before the healthy one.
  const failing = Array.from({ length: SLEEP.agentsPerRun + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  for (const [i, agentId] of failing.entries()) await agentWithWeakNote(agentId, `Pinned note ${i}`)
  const healthy = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  await agentWithWeakNote(healthy, 'A note nobody recalls')
  const note = () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE text='A note nobody recalls'`)

  await assert.rejects(sleep(ctx), /pinned memory/)
  assert.equal(await note(), 1, 'the first run is taken by failing agents')
  await assert.rejects(sleep(ctx), /pinned memory/, 'the failure is still reported')
  assert.equal(await note(), 0, 'failing sleeps sort after healthy ones, and a failure does not stop the run')
  assert.deepEqual((await sleeps(ctx, healthy)).map(item => item.state), ['finished'])
  const stuck = (await ctx.db.query(`SELECT state, failures FROM kipster.memory_sleeps WHERE agent_id=ANY($1::uuid[])`, [failing])).rows
  assert.equal(stuck.length, failing.length)
  assert.ok(stuck.every(item => item.state === 'running' && item.failures >= 1))
})

test('deleting an agent brain removes its sleeps, and only the latest sleeps are kept', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  for (let day = 10; day < 22; day++) {
    at(ctx, day, 12)
    assert.deepEqual(await sleep(ctx), slept(1, 1))
  }
  const kept = await days(ctx)
  assert.equal(kept.length, SLEEP.historyPerAgent)
  assert.deepEqual(kept, Array.from({ length: SLEEP.historyPerAgent }, (_, i) => `2026-01-${21 - SLEEP.historyPerAgent + 1 + i}`))
  const service = new MaintenanceService(ctx.db, ctx.actor.installationId)
  await ctx.db.transaction(client => service.purgeAgentBrain(client, ctx.agentId))
  assert.deepEqual(await sleeps(ctx), [])
})
