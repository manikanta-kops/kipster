import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { CONSOLIDATION, CONSOLIDATION_INSTRUCTIONS_V1, MAINTENANCE_SWEEP_JOB_ID, MaintenanceService, SleepService } from '../dist/modules/memory/public.js'
import { createAgent, archiveAgent, restoreAgent } from '../dist/modules/administration/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import * as operator from '../dist/maintenance.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Sleep consolidation against real PostgreSQL with the deterministic fixture adapter. Learned memories come from
// real extraction; their vectors are chosen per text so that tests decide which memories are nearest. The fixture's
// scripted answers stand in for the model, whose judgment is outside these tests.
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
  const database = `kipster_consolidation_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-consolidation-home-'))
  const vectors = new Map()
  const time = { now: new Date(2026, 0, 10, 12) }
  const ctx = { url, home, vectors, time, executions: [], handled: new Set(), gates: [] }
  ctx.open = async () => {
    ctx.runtime = await openRuntime({ connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Alpha', rootAgent: 'Root' }, embedding: { ...profile, async embed(text) { return vectors.get(text) ?? [0, 0, 1] } } })
    await ctx.runtime.memory.stopIndexing()
    ctx.db = ctx.runtime.db
    ctx.actor = { installationId: ctx.runtime.bootstrap.installationId, personId: ctx.runtime.bootstrap.ownerId }
    ctx.agentId = ctx.runtime.bootstrap.rootAgentId
    let dispatcher
    ctx.inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
    dispatcher = new TextDispatcher(ctx.runtime, { ...ctx.inner, async execute(value) { const handle = await ctx.inner.execute(value); ctx.executions.push({ context: value, handle }); return handle } })
    ctx.dispatcher = dispatcher
  }
  ctx.close = async () => {
    for (const release of ctx.gates) release()
    await ctx.dispatcher.close().catch(() => undefined)
    await ctx.runtime.close().catch(() => undefined)
  }
  await ctx.open()
  await ctx.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ctx.agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  t.after(async () => {
    await ctx.close()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const place = async organizationId => {
    const context = organizationId ? { kind: 'organization', organizationId } : { kind: 'installation', installationId: ctx.actor.installationId }
    return { organizationId, context, chatId: (await resolveDirectChat(ctx.db, ctx.actor, context, ctx.agentId)).chatId }
  }
  ctx.installation = await place(null)
  ctx.a = await place(ctx.runtime.bootstrap.organizationId)
  const beta = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.organizations(id, installation_id, display_name, provisioned) VALUES ($1,$2,'Beta',true)`, [beta, ctx.actor.installationId])
  await ctx.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [beta, ctx.agentId])
  await ctx.db.query('INSERT INTO kipster.human_memberships(organization_id, person_id) VALUES ($1,$2)', [beta, ctx.actor.personId])
  await ctx.runtime.home.provisionOrganization(beta)
  ctx.b = await place(beta)
  await ctx.dispatcher.start()
  return ctx
}

function releaseOutput(found, text) {
  const attemptId = found.context.attemptId
  found.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text, final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
}
const settled = (ctx, runId) => until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId]))?.state, s => ['completed', 'failed'].includes(s), `run ${runId} settled`)

/** A completed conversation in `where` whose extraction learns `text` from the human message, with a chosen vector. */
async function learned(ctx, where, text, { vector = [0, 0, 1], importance } = {}) {
  ctx.vectors.set(text, vector)
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: where.context, chatId: where.chatId }, mode: 'root', parts: [{ kind: 'text', text: `Please note: ${text}` }],
  })
  const execution = await until(() => ctx.executions.find(e => e.context.runId === saved.runId && e.context.kind !== 'maintenance'), Boolean, `execution ${saved.runId}`)
  execution.handle.release({ kind: 'text', attemptId: execution.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
  execution.handle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
  await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).state, s => s === 'completed', `completed ${saved.runId}`)
  const status = async () => (await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]))?.status
  while (await status() !== 'committed') {
    await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
    const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && !ctx.handled.has(e)), Boolean, 'extraction')
    ctx.handled.add(found)
    const entry = (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [found.context.maintenance.sourceRunId])).manifest.entries[0]
    const mine = found.context.maintenance.sourceRunId === saved.runId
    releaseOutput(found, JSON.stringify({ candidates: mine ? [{ kind: 'fact', text, subject: 'office', author_id: entry.author_id, author_class: entry.author_class, ...(importance ? { importance } : {}), citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] : [] }))
    await settled(ctx, found.context.runId)
  }
  return memory(ctx, text)
}
const memory = (ctx, text) => row(ctx.db, `SELECT id, text, origin, kind, revision::int AS revision, evidence, importance, home_organization_id AS home, consolidated_evidence
  FROM kipster.memory_records WHERE text=$1 AND scope='agent'`, [text])
async function indexAll(ctx) { while ((await ctx.runtime.memory.indexPending(20, true)).processed); }
const at = (ctx, day) => { ctx.time.now = new Date(2026, 0, day, 12) }
/** Runs the maintenance tick, which sleeps the agent, and returns the consolidation it hands to the adapter, if any. */
async function consolidationOf(ctx) {
  await ctx.dispatcher.maintenanceTick()
  const run = await row(ctx.db, `SELECT r.id FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps s ON s.id=r.sleep_id
    WHERE s.state='running' AND r.state IN ('queued','preparing','running') ORDER BY r.created_at DESC LIMIT 1`)
  if (!run) return null
  const found = await until(() => ctx.executions.find(e => e.context.runId === run.id && !ctx.handled.has(e)), Boolean, 'consolidation')
  ctx.handled.add(found)
  return found
}
/** Answers a consolidation with scripted verdicts and lessons named by memory text, and waits for it to settle. */
async function answer(ctx, found, { verdicts = [], lessons = [] }, raw) {
  const payload = found.context.maintenance
  const ref = text => payload.memories.find(item => item.text === text)?.ref ?? `missing ${text}`
  const pair = (a, b) => payload.pairs.find(item => [ref(a), ref(b)].every(value => item.memories.includes(value)))?.ref ?? `missing ${a} ~ ${b}`
  releaseOutput(found, raw ?? JSON.stringify({
    verdicts: verdicts.map(([a, b, verdict]) => ({ pair: pair(a, b), verdict })),
    lessons: lessons.map(([text, ...memories]) => ({ text, memories: memories.map(ref) })),
  }))
  return settled(ctx, found.context.runId)
}
const hasPair = (payload, a, b) => {
  const ref = text => payload.memories.find(item => item.text === text)?.ref
  return payload.pairs.some(item => [ref(a), ref(b)].every(value => value && item.memories.includes(value)))
}
const lastSleep = ctx => row(ctx.db, `SELECT sleep_on::text AS day, state, step, report FROM kipster.memory_sleeps WHERE agent_id=$1 ORDER BY sleep_on DESC LIMIT 1`, [ctx.agentId])
const links = ctx => ctx.db.query(`SELECT r.kind, f.text AS from_text, t.text AS to_text, r.revision, c.actor_id, c.attempt_id FROM kipster.memory_relationships r
  JOIN kipster.memory_records f ON f.id=r.from_id JOIN kipster.memory_records t ON t.id=r.to_id
  JOIN kipster.memory_relationship_changes c ON c.relationship_id=r.id AND c.revision=r.revision ORDER BY r.kind, f.text`).then(result => result.rows)
const consolidations = ctx => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE task_kind='consolidate'`)

test('every verdict applies, lessons form, and sleep output is not new material the next night', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const hours = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const again = await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  const closed = await learned(ctx, ctx.installation, 'The office is closed on Mondays', { vector: [1, 0.3, 0], importance: 0.8 })
  const open = await learned(ctx, ctx.installation, 'The office is open on Mondays', { vector: [1, 0.31, 0] })
  const parking = await learned(ctx, ctx.installation, 'Parking is behind the office', { vector: [1, 0.2, 0] })
  const invoices = await learned(ctx, ctx.installation, 'Invoices go out on Fridays', { vector: [0, 1, 0] })
  await indexAll(ctx)

  const found = await consolidationOf(ctx)
  const payload = found.context.maintenance
  assert.deepEqual(Object.keys(found.context).sort(), ['agentId', 'attemptGeneration', 'attemptId', 'incarnation', 'kind', 'maintenance', 'organizationId', 'runId'])
  assert.deepEqual([found.context.agentId, found.context.organizationId, payload.task, payload.lessonsMax], [ctx.agentId, null, 'consolidate', CONSOLIDATION.lessons])
  assert.deepEqual(payload.settings, { adapterId: 'deterministic-fixture', modelId: 'fixture-model' }, 'the agent\'s own model')
  assert.ok(payload.instructions.startsWith(CONSOLIDATION_INSTRUCTIONS_V1))
  assert.deepEqual(payload.memories.map(item => item.text).sort(), [hours, again, closed, open, parking, invoices].map(item => item.text).sort())
  for (const item of payload.memories) assert.ok(payload.instructions.includes(`${item.ref} (new): ${item.text}`))
  assert.ok(payload.pairs.every(item => payload.instructions.includes(`${item.ref}: ${item.memories.join(' ')}`)))
  assert.ok(payload.pairs.length <= payload.memories.length * CONSOLIDATION.neighbours)
  assert.deepEqual((await lastSleep(ctx)).step, 'consolidate', 'the sleep waits for its consolidation')

  assert.equal(await answer(ctx, found, {
    verdicts: [[hours.text, again.text, 'same'], [closed.text, open.text, 'contradicts'], [parking.text, hours.text, 'related'], [invoices.text, parking.text, 'none']],
    lessons: [['Check opening hours before a visit', hours.text, closed.text]],
  }), 'completed')

  // Same: the newer learned memory is absorbed as evidence into the older one, whose text is unchanged.
  assert.equal(await memory(ctx, again.text), undefined)
  const kept = await memory(ctx, hours.text)
  assert.deepEqual([kept.id, kept.revision, kept.evidence, kept.consolidated_evidence], [hours.id, 1, 2, 2])
  const receipts = (await ctx.db.query('SELECT subject, note FROM kipster.memory_provenance WHERE memory_id=$1 ORDER BY created_at', [kept.id])).rows
  assert.deepEqual([receipts.length, receipts[0].subject, receipts[1]], [2, 'office', { subject: null, note: 'absorbed during sleep' }])
  // Contradicts and related add typed links by the agent; none adds nothing.
  assert.deepEqual((await links(ctx)).map(item => [item.kind, [item.from_text, item.to_text].sort(), item.actor_id, item.attempt_id]), [
    ['contradicts', [closed.text, open.text].sort(), ctx.agentId, found.context.attemptId],
    ['related_to', [hours.text, parking.text].sort(), ctx.agentId, found.context.attemptId],
  ])
  assert.equal((await row(ctx.db, 'SELECT relationship_count FROM kipster.memory_relationship_owner_versions WHERE owner_id=$1', [ctx.agentId])).relationship_count, 2)
  // The lesson is global, cites its inputs' conversations as evidence and takes their highest importance.
  const lesson = await memory(ctx, 'Check opening hours before a visit')
  assert.deepEqual([lesson.origin, lesson.kind, lesson.home, lesson.evidence, lesson.importance], ['lesson', 'observation', null, 2, 0.8])
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1 AND excerpt IS NULL AND source_thread_id IS NOT NULL', [lesson.id]), 2)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_index_intents WHERE memory_id=$1 AND status='pending'`, [lesson.id]), 1)

  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: { consolidation: { inputs: 6, absorbed: 1, contradicts: 1, related: 1, lessons: 1, skipped: 0 } } })

  // The next night has no new material: links, the lesson and absorbed evidence are sleep output. No model call.
  await indexAll(ctx)
  at(ctx, 11)
  assert.equal(await consolidationOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-11', state: 'finished', step: 'promote', report: {} })
  assert.equal(await consolidations(ctx), 1)

  // New support from another conversation makes a memory new material again.
  await learned(ctx, ctx.installation, hours.text, { vector: [1, 0, 0] })
  assert.equal((await memory(ctx, hours.text)).evidence, 3)
  at(ctx, 12)
  const next = await consolidationOf(ctx)
  assert.deepEqual(next.context.maintenance.memories.filter(item => next.context.maintenance.instructions.includes(`${item.ref} (new)`)).map(item => item.text), [hours.text])
  await answer(ctx, next, {})
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual((await lastSleep(ctx)).report, { consolidation: { inputs: 1, absorbed: 0, contradicts: 0, related: 0, lessons: 0, skipped: 0 } })
})

test('a deliberate save is never altered or absorbed away; it only gains evidence', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  // The learned memory is older than the save, yet the save is what is kept.
  const same = await learned(ctx, ctx.installation, 'Opening time is nine in the morning', { vector: [1, 0.01, 0] })
  ctx.vectors.set('The office opens at nine', [1, 0, 0])
  const save = await ctx.runtime.memory.save(ctx.agentId, 'fact', 'The office opens at nine', [{ subject: 'hours' }])
  const before = await row(ctx.db, 'SELECT text, revision, source_hash, origin, importance, home_organization_id FROM kipster.memory_records WHERE id=$1', [save.id])
  const other = await learned(ctx, ctx.installation, 'The office opens at ten', { vector: [1, 0.02, 0] })
  await indexAll(ctx)
  const found = await consolidationOf(ctx)
  assert.equal(await answer(ctx, found, { verdicts: [[same.text, save.text, 'same'], [other.text, save.text, 'contradicts']] }), 'completed')
  assert.equal(await memory(ctx, same.text), undefined)
  assert.deepEqual(await row(ctx.db, 'SELECT text, revision, source_hash, origin, importance, home_organization_id FROM kipster.memory_records WHERE id=$1', [save.id]), before)
  assert.equal((await memory(ctx, save.text)).evidence, 2, 'the absorbed conversation counts as evidence for the save')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_sources WHERE memory_id=$1', [save.id]), 1)
  assert.deepEqual((await links(ctx)).map(item => item.kind), ['contradicts'])
  assert.ok(await memory(ctx, other.text))
})

test('consolidation never offers a neighbour homed in another organization, and absorption keeps the wider memory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const alpha = await learned(ctx, ctx.a, 'Alpha pays invoices within ten days', { vector: [1, 0, 0] })
  const beta = await learned(ctx, ctx.b, 'Beta pays invoices within ten days', { vector: [1, 0, 0] })
  const global = await learned(ctx, ctx.installation, 'Invoices are usually paid within ten days', { vector: [1, 0.01, 0] })
  ctx.vectors.set('Invoices need a purchase order', [1, 0.02, 0])
  await ctx.runtime.memory.save(ctx.agentId, 'fact', 'Invoices need a purchase order', [{ subject: 'billing' }])
  await indexAll(ctx)
  assert.deepEqual([alpha.home, beta.home, global.home], [ctx.a.organizationId, ctx.b.organizationId, null])
  const found = await consolidationOf(ctx)
  const payload = found.context.maintenance
  // Each homed memory is paired only with global memories; the global input is paired only with the global save.
  const texts = item => item.memories.map(ref => payload.memories.find(entry => entry.ref === ref).text).sort()
  assert.deepEqual(payload.pairs.map(texts).sort(), [
    [alpha.text, global.text], [alpha.text, 'Invoices need a purchase order'], [beta.text, global.text], [beta.text, 'Invoices need a purchase order'], [global.text, 'Invoices need a purchase order'],
  ].map(pair => pair.sort()).sort())
  assert.ok(!hasPair(payload, alpha.text, beta.text), 'memories homed in different organizations are never paired')
  // Same between a homed memory and an older global one keeps the global memory; its home does not change.
  assert.equal(await answer(ctx, found, { verdicts: [[alpha.text, global.text, 'same']] }), 'completed')
  assert.equal(await memory(ctx, alpha.text), undefined)
  const kept = await memory(ctx, global.text)
  assert.deepEqual([kept.home, kept.evidence], [null, 2])
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1 AND subject IS NOT NULL AND source_organization_id IS NOT NULL', [kept.id]), 0, 'no claim subject from the organization travels')
  assert.ok(await memory(ctx, beta.text))
})

test('a single memory with nothing to pair it with makes no model call', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const only = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  await indexAll(ctx)
  assert.equal(await consolidationOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: {} })
  assert.equal(await consolidations(ctx), 0)
  assert.equal((await memory(ctx, only.text)).consolidated_evidence, null, 'it stays new material for a later sleep')
})

test('an invalid lesson is skipped and the rest of the answer applies', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office is closed on Mondays', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  const found = await consolidationOf(ctx)
  const ref = text => found.context.maintenance.memories.find(item => item.text === text).ref
  const pair = found.context.maintenance.pairs[0].ref
  assert.equal(await answer(ctx, found, {}, JSON.stringify({
    verdicts: [{ pair, verdict: 'related' }],
    lessons: [
      { text: 'x'.repeat(CONSOLIDATION.lessonTextChars + 1), memories: [ref(first.text), ref(second.text)] },
      { text: 'A lesson citing one memory twice', memories: [ref(first.text), ref(first.text)] },
      { text: 'Check the office hours', memories: [ref(first.text), ref(second.text)] },
    ],
  })), 'completed')
  assert.deepEqual((await links(ctx)).map(item => item.kind), ['related_to'])
  assert.deepEqual((await ctx.db.query(`SELECT text FROM kipster.memory_records WHERE origin='lesson'`)).rows, [{ text: 'Check the office hours' }])
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual((await lastSleep(ctx)).report, { consolidation: { inputs: 2, absorbed: 0, contradicts: 0, related: 1, lessons: 1, skipped: 2 } })
})

test('the agent brain purge removes memories, lessons and links a sleep made', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at ten', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  const found = await consolidationOf(ctx)
  assert.equal(await answer(ctx, found, { verdicts: [[first.text, second.text, 'contradicts']], lessons: [['Opening hours vary', first.text, second.text]] }), 'completed')
  await ctx.dispatcher.maintenanceTick()
  assert.equal((await links(ctx)).length, 1)
  const purged = await ctx.db.transaction(client => new MaintenanceService(ctx.db, ctx.actor.installationId).purgeAgentBrain(client, ctx.agentId))
  assert.equal(purged.retainedRuns, 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE owner_id=$1', [ctx.agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationships'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE agent_id=$1', [ctx.agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_sleeps WHERE agent_id=$1', [ctx.agentId]), 0)
})

test('no new material means no model call; a learned memory waits until its vector is ready', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.runtime.memory.save(ctx.agentId, 'fact', 'Invoices go out on Fridays', [{ subject: 'billing' }])
  await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  assert.equal(await consolidationOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: {} })
  assert.equal(await consolidations(ctx), 0)
  await indexAll(ctx)
  at(ctx, 11)
  const found = await consolidationOf(ctx)
  assert.deepEqual(found.context.maintenance.memories.map(item => item.text), ['The office opens at nine', 'Invoices go out on Fridays'])
  await answer(ctx, found, {})
  await ctx.dispatcher.maintenanceTick()
  assert.equal((await lastSleep(ctx)).state, 'finished')
})

test('learning switched off during a consolidation fences its result and skips the sleep', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  const found = await consolidationOf(ctx)
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false })
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'skipped', step: 'consolidate', report: { reason: 'learning_disabled' } })
  await answer(ctx, found, { verdicts: [[first.text, second.text, 'same']], lessons: [['Opening hours matter', first.text, second.text]] })
  assert.deepEqual(await row(ctx.db, 'SELECT state, failure FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]), { state: 'failed', failure: 'learning_disabled' })
  assert.ok(await memory(ctx, second.text))
  assert.equal(await memory(ctx, 'Opening hours matter'), undefined)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  // Back on, the next sleep offers the same memories again: nothing was consolidated.
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: true })
  at(ctx, 11)
  const again = await consolidationOf(ctx)
  assert.deepEqual(again.context.maintenance.memories.map(item => item.text).sort(), [first.text, second.text].sort())
})

test('a consolidation queued when learning stops is never issued', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  await ctx.dispatcher.close()
  await new SleepService(ctx.db, ctx.actor.installationId, ctx.runtime.home.identity).run(ctx.time.now)
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_runs WHERE task_kind='consolidate'`)).state, 'queued')
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: false })
  await new SleepService(ctx.db, ctx.actor.installationId, ctx.runtime.home.identity).run(ctx.time.now)
  assert.deepEqual(await row(ctx.db, `SELECT r.state, r.failure, i.state AS intent FROM kipster.maintenance_runs r JOIN kipster.work_intents i ON i.id=r.id WHERE r.task_kind='consolidate'`),
    { state: 'failed', failure: 'learning_disabled', intent: 'settled' })
  assert.equal((await lastSleep(ctx)).state, 'skipped')
})

test('malformed output settles as invalid without changes, and the material is offered again the next night', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  const outputs = [
    'I think these are the same.',
    JSON.stringify({ verdicts: [{ pair: 'p9', verdict: 'same' }], lessons: [] }),
    JSON.stringify({ verdicts: [], lessons: 'none' }),
    JSON.stringify({ verdicts: [{ pair: 'p1', verdict: 'maybe' }], lessons: [] }),
  ]
  for (const [night, raw] of outputs.entries()) {
    at(ctx, 10 + night)
    const found = await consolidationOf(ctx)
    assert.ok(found, `night ${night}`)
    assert.equal(await answer(ctx, found, {}, raw), 'failed')
    assert.deepEqual(await row(ctx.db, 'SELECT failure, failure_class FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]), { failure: 'malformed_output', failure_class: 'invalid_output' })
    await ctx.dispatcher.maintenanceTick()
    assert.deepEqual(await lastSleep(ctx), { day: `2026-01-${10 + night}`, state: 'finished', step: 'promote', report: { consolidation: { failure: 'malformed_output' } } })
    assert.deepEqual([(await memory(ctx, first.text)).consolidated_evidence, (await memory(ctx, second.text)).consolidated_evidence], [null, null])
  }
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE origin='lesson'`), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationships'), 0)
})

test('whatever names a memory changed since the freeze is skipped, not failed', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  const third = await learned(ctx, ctx.installation, 'The office is closed on Mondays', { vector: [1, 0.02, 0] })
  await indexAll(ctx)
  const found = await consolidationOf(ctx)
  await ctx.runtime.memory.correct(ctx.agentId, second.id, 1, 'The office opens at 9:30 am', [{ subject: 'hours' }])
  assert.equal(await answer(ctx, found, {
    verdicts: [[first.text, second.text, 'same'], [first.text, third.text, 'contradicts']],
    lessons: [['Hours change', second.text, third.text], ['Mondays differ', first.text, third.text]],
  }), 'completed')
  assert.equal((await memory(ctx, 'The office opens at 9:30 am')).revision, 2, 'the corrected memory is neither absorbed nor changed')
  assert.deepEqual((await links(ctx)).map(item => item.kind), ['contradicts'])
  assert.equal(await memory(ctx, 'Hours change'), undefined)
  assert.equal((await memory(ctx, 'Mondays differ')).origin, 'lesson')
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual((await lastSleep(ctx)).report, { consolidation: { inputs: 3, absorbed: 0, contradicts: 1, related: 0, lessons: 1, skipped: 2 } })
  assert.equal((await memory(ctx, 'The office opens at 9:30 am')).consolidated_evidence, null, 'a stale input stays new material')
  assert.equal((await memory(ctx, first.text)).consolidated_evidence, 1)
})

test('sleep stops linking at its share of the link limit', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at ten', { vector: [1, 0.01, 0] })
  const third = await learned(ctx, ctx.installation, 'Parking is behind the office', { vector: [1, 0.02, 0] })
  await indexAll(ctx)
  await ctx.db.query(`INSERT INTO kipster.memory_relationship_owner_versions(installation_id, owner_kind, owner_id, relationship_count) VALUES ($1,'agent',$2,$3)`,
    [ctx.actor.installationId, ctx.agentId, CONSOLIDATION.linkLimit - 1])
  const found = await consolidationOf(ctx)
  assert.equal(await answer(ctx, found, { verdicts: [[first.text, second.text, 'contradicts'], [first.text, third.text, 'related']] }), 'completed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationships'), 1)
  assert.equal((await row(ctx.db, 'SELECT relationship_count FROM kipster.memory_relationship_owner_versions WHERE owner_id=$1', [ctx.agentId])).relationship_count, CONSOLIDATION.linkLimit)
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual((await lastSleep(ctx)).report.consolidation, { inputs: 3, absorbed: 0, contradicts: 1, related: 0, lessons: 0, skipped: 1 })
})

test('a crash before the result is applied recovers, asks again and applies once', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const first = await learned(ctx, ctx.installation, 'The office opens at nine', { vector: [1, 0, 0] })
  const second = await learned(ctx, ctx.installation, 'The office opens at 9 am', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  await ctx.dispatcher.close()
  await new SleepService(ctx.db, ctx.actor.installationId, ctx.runtime.home.identity).run(ctx.time.now)
  const runId = (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE task_kind='consolidate'`)).id

  // A coordinator issues the consolidation and dies once the provider has started.
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/fixtures/maintenance-crash.mjs'), 'provider', ctx.url.href, ctx.home], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let checkpoint
  child.on('message', message => { checkpoint = message.stage })
  const exited = new Promise(resolve => child.once('exit', resolve))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await until(() => checkpoint, value => value === 'provider', 'provider checkpoint')
  child.kill('SIGKILL')
  await exited
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId])).state, 'running')

  await ctx.close()
  await ctx.open()
  const before = ctx.executions.length
  await ctx.dispatcher.start()
  assert.deepEqual(await row(ctx.db, 'SELECT state, permit_retained FROM kipster.maintenance_runs WHERE id=$1', [runId]), { state: 'recovery-needed', permit_retained: true })
  assert.equal(ctx.executions.length, before, 'no automatic re-execution before reconciliation')
  await ctx.dispatcher.maintenanceTick()
  assert.equal((await lastSleep(ctx)).state, 'running', 'the sleep waits for its consolidation')

  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'consolidation-reconcile', action: 'reconcile', target: { runId } })
  await ctx.dispatcher.pumpMaintenance()
  const retry = await until(() => ctx.executions.slice(before).find(e => e.context.maintenance?.task === 'consolidate'), Boolean, 'second attempt')
  assert.deepEqual([retry.context.runId, retry.context.attemptGeneration], [runId, 2])
  assert.equal(await answer(ctx, retry, { verdicts: [[first.text, second.text, 'same']], lessons: [['Opening hours are stable', first.text, second.text]] }), 'completed')
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: { consolidation: { inputs: 2, absorbed: 1, contradicts: 0, related: 0, lessons: 1, skipped: 0 } } })
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE origin='lesson'`), 1)
  assert.equal(await memory(ctx, second.text), undefined)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.deepEqual((await ctx.db.query('SELECT state FROM kipster.attempts WHERE intent_id=$1 ORDER BY generation', [runId])).rows.map(item => item.state), ['settled', 'settled'])
})


async function pausedSnapshot(ctx, readers = 1) {
  let count = 0, arrived, release
  const ready = new Promise(resolve => { arrived = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const db = {
    query: ctx.db.query.bind(ctx.db),
    transaction: work => ctx.db.transaction(client => work({ query: async (sql, args) => {
      if (sql.includes('WITH eligible AS MATERIALIZED')) { if (++count === readers) arrived(); await gate }
      return client.query(sql, args)
    } })),
  }
  ctx.gates.push(release)
  return { service: new SleepService(db, ctx.actor.installationId, ctx.runtime.home.identity), ready, release }
}
async function snapshotFixture(t, ordinary = false) {
  const ctx = await setup(t)
  if (ordinary) {
    const organizationId = ctx.runtime.bootstrap.organizationId
    const created = await createAgent(ctx.db, ctx.runtime.home, ctx.actor, randomUUID(), { name: 'Worker', organizationId, settings: { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } } })
    ctx.agentId = created.agent.id
    const context = { kind: 'organization', organizationId }
    ctx.installation = { context, chatId: (await resolveDirectChat(ctx.db, ctx.actor, context, ctx.agentId)).chatId }
  }
  await learned(ctx, ctx.installation, 'First source', { vector: [1, 0, 0] })
  await learned(ctx, ctx.installation, 'Second source', { vector: [1, 0.01, 0] })
  await indexAll(ctx)
  return ctx
}

test('consolidation snapshot permits conversation admission and waits while that execution is live', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t)
  const paused = await pausedSnapshot(ctx)
  t.after(paused.release)
  const sleeping = paused.service.run(ctx.time.now)
  await paused.ready
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(), scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: ctx.installation.context, chatId: ctx.installation.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Run while snapshot reads' }],
  })
  const executing = await until(() => ctx.executions.find(e => e.context.runId === saved.runId), Boolean, 'admission during snapshot')
  paused.release(); await sleeping
  assert.equal(await consolidations(ctx), 0, 'the locked queue step rechecks that the agent is idle')
  releaseOutput(executing, 'Done')
})

test('learning disabled during a coherent snapshot discards its candidate', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t)
  const paused = await pausedSnapshot(ctx)
  t.after(paused.release)
  const sleeping = paused.service.run(ctx.time.now)
  await paused.ready
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false })
  paused.release(); await sleeping
  assert.equal(await consolidations(ctx), 0)
  assert.equal((await lastSleep(ctx)).state, 'skipped')
})

test('concurrent snapshots enqueue only one consolidation for the exact sleep', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t)
  const paused = await pausedSnapshot(ctx, 2)
  t.after(paused.release)
  const first = paused.service.run(ctx.time.now)
  const second = paused.service.run(ctx.time.now)
  await paused.ready
  paused.release(); await Promise.all([first, second])
  assert.equal(await consolidations(ctx), 1)
})

test('a candidate for a replaced sleep is discarded', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t)
  const paused = await pausedSnapshot(ctx)
  t.after(paused.release)
  const sleeping = paused.service.run(ctx.time.now)
  await paused.ready
  try { await ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
    await client.query("UPDATE kipster.memory_sleeps SET state='skipped', finished_at=now() WHERE agent_id=$1 AND state='running'", [ctx.agentId])
    await client.query("INSERT INTO kipster.memory_sleeps(id,agent_id,sleep_on,step) VALUES (gen_random_uuid(),$1,'2026-01-11','consolidate')", [ctx.agentId])
  }) } finally { paused.release() }
  await sleeping
  assert.equal(await consolidations(ctx), 0)
})


test('archive and restore during a snapshot never enqueue its old sleep candidate', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t, true)
  const paused = await pausedSnapshot(ctx)
  const sleeping = paused.service.run(ctx.time.now)
  await paused.ready
  try {
    await archiveAgent(ctx.db, ctx.runtime.jobs, ctx.actor, ctx.agentId, randomUUID())
    await restoreAgent(ctx.db, ctx.runtime.jobs, ctx.actor, ctx.agentId, randomUUID())
  } finally { paused.release() }
  await sleeping
  assert.equal(await consolidations(ctx), 0)
  assert.equal((await lastSleep(ctx)).state, 'skipped')
})

test('snapshot timeout is reported and deferred rather than an empty successful sleep', { skip: noDatabase }, async t => {
  const ctx = await snapshotFixture(t)
  const db = { query: ctx.db.query.bind(ctx.db), transaction: work => ctx.db.transaction(client => work({ query: async (sql, args) => {
    if (sql.includes('WITH eligible AS MATERIALIZED')) throw Object.assign(new Error('snapshot statement timeout'), { code: '57014' })
    return client.query(sql, args)
  } })) }
  await assert.rejects(new SleepService(db, ctx.actor.installationId, ctx.runtime.home.identity).run(ctx.time.now), /snapshot statement timeout/)
  assert.equal(await consolidations(ctx), 0)
  assert.equal((await lastSleep(ctx)).state, 'running')
  assert.equal(Number((await row(ctx.db, 'SELECT failures FROM kipster.memory_sleeps WHERE agent_id=$1', [ctx.agentId])).failures), 1)
})
