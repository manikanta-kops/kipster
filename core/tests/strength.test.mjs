import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MaintenanceService, SleepService, SLEEP, MEMORY_STRENGTH, MAINTENANCE_SWEEP_JOB_ID } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Memory strength, reinforcement, decay and forgetting mechanics against real PostgreSQL with the deterministic
// fixture adapter. Agent clocks are advanced directly where a test needs many active days. Forgetting happens
// during sleep, driven by an injected wall clock that starts at noon on a fixed local day.
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

async function setup(t, { executionLimit, hooks = {} } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_strength_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-strength-home-'))
  const time = { now: new Date(2026, 0, 10, 12) }
  const runtime = await openRuntime({ connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, ...(executionLimit ? { executionLimit } : {}), embedding: { ...profile, async embed() { return [1, 0] } } })
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
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } }, undefined, hooks)
  const holders = []
  const releases = []
  t.after(async () => {
    for (const release of releases) release.resolve()
    for (const holder of holders) await holder.close().catch(() => undefined)
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const holder = () => { const db = new Postgres(url.href, 1); holders.push(db); return db }
  const service = new MaintenanceService(runtime.db, actor.installationId)
  return { runtime, db: runtime.db, actor, agentId, context, chatId, dispatcher, executions, handled: new Set(), holder, releases, service, time }
}
/** Runs sleep once at the test's current time. */
const sleep = ctx => new SleepService(ctx.db, ctx.actor.installationId, ctx.runtime.home.identity).run(ctx.time.now)
/** Moves the test clock to noon of the next local day, after that day's sleep time. */
const nextDay = ctx => { const now = ctx.time.now; ctx.time.now = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12) }
/** Sleep on the next day. */
const night = ctx => { nextDay(ctx); return sleep(ctx) }
const slept = (started, finished, forgotten) => ({ started, finished, skipped: 0, forgotten })

async function submit(ctx, text) {
  return acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: ctx.context, chatId: ctx.chatId }, mode: 'root', parts: [{ kind: 'text', text }],
  })
}
/** Starts a conversation and returns its live execution; `finish` completes it. */
async function startConversation(ctx, text) {
  const saved = await submit(ctx, text)
  const found = await until(() => ctx.executions.find(e => e.context.runId === saved.runId && e.context.kind !== 'maintenance'), Boolean, `execution ${saved.runId}`)
  const finish = async () => {
    found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
    found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).state, s => s === 'completed', `completed ${saved.runId}`)
  }
  return { ...saved, execution: found, finish }
}
async function conversation(ctx, text) {
  const started = await startConversation(ctx, text)
  await started.finish()
  return started
}
async function nextMaintenance(ctx) {
  await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
  const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && !ctx.handled.has(e)), Boolean, 'maintenance execution')
  ctx.handled.add(found)
  return found
}
function output(found, candidates) {
  const attemptId = found.context.attemptId
  found.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates }), final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
}
const sourceStatus = async (ctx, runId) => (await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [runId]))?.status
/** Extracts from one conversation: candidates build from its input message, other sources commit nothing. */
async function learn(ctx, runId, facts, extra = {}) {
  for (let i = 0; i < 12; i++) {
    const status = await sourceStatus(ctx, runId)
    if (['committed', 'skipped', 'fenced'].includes(status)) return status
    const found = await nextMaintenance(ctx)
    const mine = found.context.maintenance.sourceRunId === runId
    const input = (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [found.context.maintenance.sourceRunId])).manifest.entries[0]
    const text = (await row(ctx.db, 'SELECT parts FROM kipster.messages WHERE id=$1', [input.message_id])).parts[0].text
    output(found, mine ? facts.map(fact => ({ kind: 'fact', text: fact, subject: 'office', author_id: input.author_id, author_class: input.author_class, citations: [{ message_id: input.message_id, revision: input.revision, parts_hash: input.parts_sha256, excerpt: text.slice(0, 40) }], ...extra })) : [])
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]))?.state, s => ['completed', 'failed'].includes(s), 'maintenance settled')
  }
  throw new Error(`source ${runId} did not settle`)
}
const memory = (ctx, text) => row(ctx.db, `SELECT id, origin, importance, evidence, refreshed_day::int AS refreshed_day FROM kipster.memory_records WHERE text=$1 AND scope='agent'`, [text])
const clock = ctx => row(ctx.db, 'SELECT active_days::int AS active_days, active_on FROM kipster.memory_activity WHERE agent_id=$1', [ctx.agentId])
const setDays = (ctx, days) => ctx.db.query('UPDATE kipster.memory_activity SET active_days=$2 WHERE agent_id=$1', [ctx.agentId, days])
const strength = async (ctx, id) => Number((await row(ctx.db, `SELECT kipster.memory_strength(m.importance, m.evidence, a.active_days - m.refreshed_day) AS s
  FROM kipster.memory_records m JOIN kipster.memory_activity a ON a.agent_id=m.owner_id WHERE m.id=$1`, [id])).s)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`)

test('strength follows importance, evidence and active-day age', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const value = async (importance, evidence, age) => Number((await row(ctx.db, 'SELECT kipster.memory_strength($1, $2, $3) AS s', [importance, evidence, age])).s)
  close(await value(0.5, 1, 0), 0.25)
  close(await value(0.5, 1, 30), 0.125)
  close(await value(1, 1, 0), 0.5)
  close(await value(0.9, 3, 0), 0.7875)
  close(await value(0.9, 3, 90), 0.39375)
  close(await value(0.5, 1, -5), 0.25)
  assert.ok(await value(0.4, 10, 0) < 0.4)
  assert.ok(await value(0.5, 1, 69) >= MEMORY_STRENGTH.forgetBelow)
  assert.ok(await value(0.5, 1, 70) < MEMORY_STRENGTH.forgetBelow)
  assert.ok(await value(1, 1, 99) >= MEMORY_STRENGTH.forgetBelow)
  assert.ok(await value(1, 1, 100) < MEMORY_STRENGTH.forgetBelow)
})

test('the day counter advances once per active day, so an idle agent forgets nothing', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const first = await conversation(ctx, 'The office is in Pune')
  assert.equal(await learn(ctx, first.runId, ['The office is in Pune']), 'committed')
  const fact = await memory(ctx, 'The office is in Pune')
  assert.deepEqual([fact.origin, fact.importance, fact.evidence, fact.refreshed_day], ['learned', 0.5, 1, 0])
  assert.equal((await clock(ctx)).active_days, 0)
  await conversation(ctx, 'Another question on the same day')
  assert.equal((await clock(ctx)).active_days, 0)
  // A year passes without work: no active day is counted and nothing is forgotten.
  await ctx.db.query(`UPDATE kipster.memory_activity SET active_on=active_on - 365 WHERE agent_id=$1`, [ctx.agentId])
  assert.deepEqual(await night(ctx), slept(1, 1, 0))
  close(await strength(ctx, fact.id), 0.25)
  await conversation(ctx, 'Back at work')
  assert.equal((await clock(ctx)).active_days, 1)
  assert.ok(await memory(ctx, 'The office is in Pune'))
})

test('support from another conversation strengthens; recall into an execution refreshes without strengthening', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const first = await conversation(ctx, 'The office is in Pune')
  await learn(ctx, first.runId, ['The office is in Pune'])
  const fact = await memory(ctx, 'The office is in Pune')
  await setDays(ctx, 20)
  close(await strength(ctx, fact.id), 0.25 * 0.5 ** (20 / 30))
  await ctx.runtime.memory.search(ctx.agentId, null, 'office Pune')
  assert.equal((await memory(ctx, 'The office is in Pune')).refreshed_day, 0, 'retrieval not supplied to an execution does not refresh')
  const recall = await startConversation(ctx, 'Where is the office?')
  assert.ok(recall.execution.context.memory.join('\n').includes('The office is in Pune'))
  const recalled = await memory(ctx, 'The office is in Pune')
  assert.deepEqual([recalled.evidence, recalled.refreshed_day], [1, 20])
  close(await strength(ctx, fact.id), 0.25)
  await recall.finish()
  await learn(ctx, recall.runId, [])
  await setDays(ctx, 25)
  const second = await conversation(ctx, 'Yes, the office is in Pune')
  await learn(ctx, second.runId, ['The office is in Pune'])
  const supported = await memory(ctx, 'The office is in Pune')
  assert.equal(supported.id, fact.id)
  assert.deepEqual([supported.evidence, supported.refreshed_day], [2, 25])
  close(await strength(ctx, fact.id), 0.375)
  const repeat = await conversation(ctx, 'I said the office is in Pune')
  await learn(ctx, repeat.runId, ['The office is in Pune'], { importance: 1 })
  assert.equal((await memory(ctx, 'The office is in Pune')).evidence, 3, 'importance is set when a memory forms')
  assert.equal((await memory(ctx, 'The office is in Pune')).importance, 0.5)
})

test('a null importance from strict structured output means the default', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const first = await conversation(ctx, 'The warehouse is in Delft')
  assert.equal(await learn(ctx, first.runId, ['The warehouse is in Delft'], { importance: null }), 'committed')
  assert.equal((await memory(ctx, 'The warehouse is in Delft')).importance, 0.5)
})

test('weak memories are deleted with vectors, links and receipts; deliberate saves outlast learned ones', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const learned = 'The office is in Pune'
  const deliberate = 'The office moved to Hyderabad'
  const first = await conversation(ctx, learned)
  await learn(ctx, first.runId, [learned])
  const second = await startConversation(ctx, 'Remember that the office moved to Hyderabad')
  const saved = await second.execution.handle.callTool('save-1', 'memory_save', { kind: 'fact', text: deliberate })
  const from = (await memory(ctx, learned)).id
  const to = saved.record.id
  const linked = await second.execution.handle.callTool('link-1', 'memory_link', { owner: { kind: 'agent', ownerId: ctx.agentId }, fromId: from, toId: to, fromRevision: 1, toRevision: 1, kind: 'contradicts', weight: 0.9, evidence: [{ memoryId: from, revision: 1 }, { memoryId: to, revision: 1 }] })
  await second.finish()
  await learn(ctx, second.runId, [])
  await ctx.runtime.memory.indexPending(10, true)
  const pair = (await ctx.runtime.memory.context(ctx.agentId, null, 'office')).join('\n')
  assert.ok(pair.includes(learned) && pair.includes(deliberate) && pair.includes('contradicts'))
  const saveMemory = await memory(ctx, deliberate)
  assert.deepEqual([saveMemory.origin, saveMemory.importance, saveMemory.evidence], ['deliberate', 1, 1])
  const rows = async id => ({
    records: await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE id=$1', [id]),
    sources: await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_sources WHERE memory_id=$1', [id]),
    provenance: await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [id]),
    vectors: await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_index_intents WHERE memory_id=$1 AND status='ready'`, [id]),
    claims: await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [id]),
    receipts: await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_tool_receipts WHERE result->'record'->>'id'=$1`, [id]),
    links: await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationships WHERE from_id=$1 OR to_id=$1', [id]),
  })
  assert.deepEqual(await rows(from), { records: 1, sources: 1, provenance: 1, vectors: 1, claims: 1, receipts: 0, links: 1 })
  assert.deepEqual(await rows(to), { records: 1, sources: 1, provenance: 1, vectors: 1, claims: 0, receipts: 1, links: 1 })
  // Same evidence and age: the learned memory fades below the threshold first. This test covers forgetting only, so
  // the indexed learned memory counts as already consolidated.
  await ctx.db.query(`UPDATE kipster.memory_records SET consolidated_evidence=evidence WHERE origin='learned'`)
  await setDays(ctx, 70)
  assert.deepEqual(await night(ctx), slept(1, 1, 1))
  assert.deepEqual(await rows(from), { records: 0, sources: 0, provenance: 0, vectors: 0, claims: 0, receipts: 0, links: 0 })
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationship_changes WHERE relationship_id=$1', [linked.relationship.id]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationship_evidence WHERE relationship_id=$1', [linked.relationship.id]), 0)
  assert.deepEqual(await row(ctx.db, 'SELECT revision::int, relationship_count FROM kipster.memory_relationship_owner_versions WHERE owner_id=$1', [ctx.agentId]), { revision: 2, relationship_count: 0 })
  assert.deepEqual(await rows(to), { records: 1, sources: 1, provenance: 1, vectors: 1, claims: 0, receipts: 1, links: 0 })
  await setDays(ctx, 100)
  assert.deepEqual(await sleep(ctx), slept(0, 0, 0), 'the agent sleeps once a day')
  assert.deepEqual(await night(ctx), slept(1, 1, 1))
  assert.deepEqual(await rows(to), { records: 0, sources: 0, provenance: 0, vectors: 0, claims: 0, receipts: 0, links: 0 })
})

test('forgetting is bounded and a sleep interrupted by a crash resumes and finishes once', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  await conversation(ctx, 'Start the day')
  const total = MEMORY_STRENGTH.forgetBatch * 2 + 5
  for (let i = 0; i < total; i++) await ctx.runtime.memory.save(ctx.agentId, 'fact', `Note number ${i}`, [{ subject: 'notes' }])
  await setDays(ctx, 200)
  const notes = () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE text LIKE 'Note number %'`)
  const first = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE text LIKE 'Note number %' ORDER BY id LIMIT 1`)).id
  const blocker = ctx.holder()
  const held = Promise.withResolvers()
  const release = Promise.withResolvers()
  ctx.releases.push(release)
  const holding = blocker.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.memory_sources WHERE memory_id=$1 FOR UPDATE', [first])
    held.resolve()
    await release.promise
  })
  await held.promise
  nextDay(ctx)
  const crashed = sleep(ctx)
  const waiting = await until(async () => (await ctx.db.query(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND query LIKE 'DELETE FROM kipster.memory_sources%'`)).rows[0]?.pid, Boolean, 'sweep waits mid-batch')
  await ctx.db.query('SELECT pg_terminate_backend($1)', [waiting])
  await assert.rejects(crashed)
  release.resolve()
  await holding
  assert.equal(await notes(), total)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_index_intents i JOIN kipster.memory_records m ON m.id=i.memory_id WHERE m.text LIKE 'Note number %'`), total)
  const progress = () => row(ctx.db, `SELECT state, step, report FROM kipster.memory_sleeps WHERE agent_id=$1`, [ctx.agentId])
  assert.deepEqual(await progress(), { state: 'running', step: 'forget', report: {} }, 'the sleep began and resumes after the crash')
  assert.deepEqual(await sleep(ctx), slept(0, 0, MEMORY_STRENGTH.forgetBatch))
  assert.deepEqual(await progress(), { state: 'running', step: 'forget', report: { forgotten: MEMORY_STRENGTH.forgetBatch } })
  assert.deepEqual(await sleep(ctx), slept(0, 0, MEMORY_STRENGTH.forgetBatch))
  assert.deepEqual(await sleep(ctx), slept(0, 1, 5))
  assert.equal(await notes(), 0)
  assert.deepEqual(await progress(), { state: 'finished', step: 'promote', report: { forgotten: total } })
  assert.deepEqual(await sleep(ctx), slept(0, 0, 0))
})

test('sleep waits for an extraction commit and keeps the memory it reinforces', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const fact = 'The office is in Pune'
  const first = await conversation(ctx, fact)
  await learn(ctx, first.runId, [fact])
  const second = await conversation(ctx, 'As I said, the office is in Pune')
  const { id } = await memory(ctx, fact)
  await setDays(ctx, 70)
  assert.ok(await strength(ctx, id) < MEMORY_STRENGTH.forgetBelow)
  const blocker = ctx.holder()
  const held = Promise.withResolvers()
  const release = Promise.withResolvers()
  ctx.releases.push(release)
  const holding = blocker.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.memory_records WHERE id=$1 FOR SHARE', [id])
    held.resolve()
    await release.promise
  })
  await held.promise
  const committing = learn(ctx, second.runId, [fact])
  const lockWait = like => until(async () => count(ctx.db, `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND query LIKE $1`, [like]), n => n >= 1, `waiting on ${like}`)
  await lockWait('%FROM kipster.memory_records WHERE id=ANY%FOR UPDATE%')
  nextDay(ctx)
  const sweeping = sleep(ctx)
  await lockWait('%FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE%')
  release.resolve()
  await holding
  assert.equal(await committing, 'committed')
  assert.deepEqual(await sweeping, slept(1, 1, 0))
  const kept = await memory(ctx, fact)
  assert.deepEqual([kept.id, kept.evidence, kept.refreshed_day], [id, 2, 70])
})

test('an agent that is not learning keeps its memories and its clock', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const first = await conversation(ctx, 'The office is in Pune')
  await learn(ctx, first.runId, ['The office is in Pune'])
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false })
  await ctx.db.query(`UPDATE kipster.memory_activity SET active_on=active_on - 1 WHERE agent_id=$1`, [ctx.agentId])
  await conversation(ctx, 'A question on a new day while learning is off')
  assert.equal((await clock(ctx)).active_days, 0)
  await setDays(ctx, 70)
  assert.deepEqual(await night(ctx), slept(0, 0, 0))
  await ctx.dispatcher.maintenanceTick()
  assert.ok(await memory(ctx, 'The office is in Pune'))
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: true })
  await ctx.dispatcher.maintenanceTick()
  assert.equal(await memory(ctx, 'The office is in Pune'), undefined)
})

test('agents with executions in flight do not hold back sleep for others', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { executionLimit: 20 })
  await ctx.dispatcher.start()
  await conversation(ctx, 'Start the day')
  const note = await ctx.runtime.memory.save(ctx.agentId, 'fact', 'A note nobody recalls', [{ subject: 'notes' }])
  await setDays(ctx, 100)
  const stuck = SLEEP.agentsPerRun + 1
  for (let i = 0; i < stuck; i++) {
    const agentId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, settings, provisioned) VALUES ($1,$2,$3,$4,true)`,
      [agentId, ctx.actor.installationId, `Stuck ${i}`, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
    await ctx.runtime.home.provisionAgent(agentId)
    await ctx.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [ctx.runtime.bootstrap.organizationId, agentId])
    const context = { kind: 'organization', organizationId: ctx.runtime.bootstrap.organizationId }
    const { chatId } = await resolveDirectChat(ctx.db, ctx.actor, context, agentId)
    await startConversation({ ...ctx, context, chatId }, `A long task ${i}`)
    await ctx.db.query(`UPDATE kipster.memory_activity SET active_days=200 WHERE agent_id=$1`, [agentId])
  }
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_activity WHERE active_days=200`), stuck)
  assert.deepEqual(await night(ctx), slept(1, 1, 1))
  assert.equal(await memory(ctx, note.text), undefined)
})

test('forgetting leaves other agents and organization copies untouched', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  await conversation(ctx, 'Start the day')
  const other = randomUUID()
  // The other agent does not learn, so it does not sleep, although its memory is weak.
  await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, provisioned, learning_enabled) VALUES ($1,$2,'Other',true,false)`, [other, ctx.actor.installationId])
  const theirs = await ctx.runtime.memory.save(other, 'fact', 'The other agent prefers tea', [{ subject: 'drinks' }])
  await ctx.db.query(`INSERT INTO kipster.memory_activity(agent_id, active_days, active_on) VALUES ($1, 200, CURRENT_DATE)`, [other])
  const mine = await ctx.runtime.memory.save(ctx.agentId, 'fact', 'Invoices go out on Fridays', [{ subject: 'billing' }])
  const shared = await ctx.runtime.memory.publish(ctx.agentId, ctx.runtime.bootstrap.organizationId, mine.id, 1)
  await setDays(ctx, 100)
  assert.deepEqual(await night(ctx), slept(1, 1, 1))
  assert.equal(await memory(ctx, mine.text), undefined)
  assert.equal((await row(ctx.db, 'SELECT id FROM kipster.memory_records WHERE id=$1', [theirs.id])).id, theirs.id)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [theirs.id]), 1)
  const copy = await row(ctx.db, `SELECT scope, text, published_from FROM kipster.memory_records WHERE id=$1`, [shared.id])
  assert.deepEqual(copy, { scope: 'organization', text: mine.text, published_from: null })
  await setDays(ctx, 1000)
  assert.deepEqual(await night(ctx), slept(1, 1, 0))
  assert.ok(await row(ctx.db, 'SELECT 1 FROM kipster.memory_records WHERE id=$1', [shared.id]))
})

test('memory.search and memory.get from a live execution refresh age without adding evidence', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const first = await conversation(ctx, 'The office is in Pune')
  await learn(ctx, first.runId, ['The office is in Pune'])
  const { id } = await memory(ctx, 'The office is in Pune')
  const live = await startConversation(ctx, 'Tell me about something else')
  await setDays(ctx, 10)
  const found = await live.execution.handle.callTool('search-1', 'memory_search', { query: 'office Pune' })
  assert.ok(found.some(hit => hit.record.id === id))
  assert.deepEqual([(await memory(ctx, 'The office is in Pune')).refreshed_day, (await memory(ctx, 'The office is in Pune')).evidence], [10, 1])
  await setDays(ctx, 15)
  assert.equal((await live.execution.handle.callTool('get-1', 'memory_get', { id })).id, id)
  assert.deepEqual([(await memory(ctx, 'The office is in Pune')).refreshed_day, (await memory(ctx, 'The office is in Pune')).evidence], [15, 1])
  await live.finish()
})


test('a link between surviving memories keeps its history minus citations of a forgotten memory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const live = await startConversation(ctx, 'Remember these')
  const save = async (callId, text) => (await live.execution.handle.callTool(callId, 'memory_save', { kind: 'fact', text })).record.id
  const [a, b, x] = [await save('a', 'The office is in Pune'), await save('b', 'The team sits on floor three'), await save('x', 'Someone mentioned a parking pass')]
  const link = (await live.execution.handle.callTool('link', 'memory_link', { owner: { kind: 'agent', ownerId: ctx.agentId }, fromId: a, toId: b, fromRevision: 1, toRevision: 1, kind: 'related_to', weight: 0.6, evidence: [{ memoryId: a, revision: 1 }, { memoryId: x, revision: 1 }] })).relationship
  await live.finish()
  await learn(ctx, live.runId, [])
  await ctx.db.query('UPDATE kipster.memory_records SET importance=0.2 WHERE id=$1', [x])
  await setDays(ctx, 50)
  assert.deepEqual(await night(ctx), slept(1, 1, 1))
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE id=ANY($1::uuid[])', [[a, b, x]]), 2)
  assert.deepEqual(await row(ctx.db, 'SELECT from_id, to_id, active FROM kipster.memory_relationships WHERE id=$1', [link.id]), { from_id: link.fromId, to_id: link.toId, active: true })
  assert.deepEqual((await ctx.db.query('SELECT memory_id FROM kipster.memory_relationship_evidence WHERE relationship_id=$1', [link.id])).rows, [{ memory_id: a }])
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationship_changes WHERE relationship_id=$1', [link.id]), 1)
  assert.equal((await row(ctx.db, 'SELECT relationship_count FROM kipster.memory_relationship_owner_versions WHERE owner_id=$1', [ctx.agentId])).relationship_count, 1)
})


test('issued conversations count injected UTC days once, including midnight and backward clock movement', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  ctx.time.now = new Date('2031-02-03T23:59:59Z')
  await ctx.dispatcher.start()
  const activity = async () => row(ctx.db, "SELECT active_days::int AS days, active_on::text AS day FROM kipster.memory_activity WHERE agent_id=$1", [ctx.agentId])
  await conversation(ctx, 'First day')
  assert.deepEqual(await activity(), { days: 0, day: '2031-02-03' })
  await conversation(ctx, 'Same day')
  assert.deepEqual(await activity(), { days: 0, day: '2031-02-03' })
  ctx.time.now = new Date('2031-02-04T00:00:00Z')
  await conversation(ctx, 'Next UTC day')
  assert.deepEqual(await activity(), { days: 1, day: '2031-02-04' })
  ctx.time.now = new Date('2031-02-02T12:00:00Z')
  await conversation(ctx, 'Clock moved backward')
  assert.deepEqual(await activity(), { days: 1, day: '2031-02-04' })
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: false })
  ctx.time.now = new Date('2031-02-05T12:00:00Z')
  await conversation(ctx, 'Learning disabled')
  assert.deepEqual(await activity(), { days: 1, day: '2031-02-04' })
})
