import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MAINTENANCE_SWEEP_JOB_ID, SleepService, MaintenanceService } from '../dist/modules/memory/public.js'
import { lockInstallation } from '../dist/modules/work/public.js'
import { changeLifecycle } from '../dist/modules/administration/public.js'
import { acceptText, resolveDirectChat } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Learning follows the live rule: extraction and sleep consolidation commit only for a live agent,
// under the same capacity lock as a lifecycle change, and sleep skips an agent that is not live.
// The fixture's scripted answers stand in for the model, whose judgment is outside these tests.

const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
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

async function setup(t, hooks = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_fence_learning_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-fence-learning-'))
  const vectors = new Map()
  const time = { now: new Date(2026, 0, 10, 12) }
  const runtime = await openRuntime({ connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' },
    embedding: { ...profile, async embed(text) { return vectors.get(text) ?? [0, 0, 1] } } })
  await runtime.memory.stopIndexing()
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const agentId = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await runtime.learning.setInstallation(actor, { enabled: true })
  const executions = [], handled = new Set()
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } }, undefined, hooks)
  await dispatcher.start()
  const locks = new Postgres(url.href)
  const context = { kind: 'installation', installationId: actor.installationId }
  const chatId = (await resolveDirectChat(runtime.db, actor, context, agentId)).chatId
  const ctx = { runtime, db: runtime.db, dispatcher, actor, agentId, executions, handled, vectors, time, chatId, context }
  t.after(async () => {
    await dispatcher.close().catch(() => undefined)
    await locks.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  ctx.flip = lifecycle => ctx.db.transaction(client => changeLifecycle(client, runtime.jobs, actor.installationId, 'agent', agentId, lifecycle, 'Agent was archived'))
  ctx.heldFlip = async () => {
    const flipped = deferred(), release = deferred()
    const done = ctx.db.transaction(async client => { await changeLifecycle(client, runtime.jobs, actor.installationId, 'agent', agentId, 'archived', 'Agent was archived'); flipped.resolve(); await release.promise })
    await flipped.promise
    return { commit: () => { release.resolve(); return done } }
  }
  ctx.hold = async (sql, params) => {
    const held = deferred(), release = deferred()
    const done = locks.transaction(async client => { await client.query(sql, params); held.resolve(); await release.promise }).catch(() => undefined)
    await held.promise
    return { release: () => { release.resolve(); return done } }
  }
  ctx.waiting = n => until(() => count(locks, `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`), value => value >= n, `${n} lock waiters`)
  return ctx
}

function releaseOutput(found, text) {
  const attemptId = found.context.attemptId
  found.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text, final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
}
/** Hands the answer over without ending the turn, so only the settlement is left. */
async function stage(ctx, found, text) {
  const attemptId = found.context.attemptId
  found.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text, final: true })
  await until(async () => (await row(ctx.db, 'SELECT staged_output FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId])).staged_output, Boolean, 'output staged')
}
const end = found => found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
const runSettled = (ctx, runId) => until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId]))?.state, s => ['completed', 'failed'].includes(s), `run ${runId} settled`)
const memory = (ctx, text) => row(ctx.db, `SELECT id, text FROM kipster.memory_records WHERE text=$1 AND scope='agent'`, [text])

/** A completed conversation whose extraction is handed to the adapter and not yet answered. */
async function extraction(ctx, text, importance) {
  ctx.vectors.set(text, [1, 0, 0])
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(), scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: ctx.context, chatId: ctx.chatId }, mode: 'root', parts: [{ kind: 'text', text: `Please note: ${text}` }],
  })
  const execution = await until(() => ctx.executions.find(e => e.context.runId === saved.runId), Boolean, `execution ${saved.runId}`)
  execution.handle.release({ kind: 'text', attemptId: execution.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
  execution.handle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
  await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
  const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && e.context.maintenance.sourceRunId === saved.runId && !ctx.handled.has(e)), Boolean, 'extraction')
  ctx.handled.add(found)
  const entry = (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).manifest.entries[0]
  const answer = JSON.stringify({ candidates: [{ kind: 'fact', text, subject: 'office', author_id: entry.author_id, author_class: entry.author_class, ...(importance ? { importance } : {}), citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] })
  return { saved, found, answer }
}
async function learned(ctx, text, importance) {
  const { found, answer } = await extraction(ctx, text, importance)
  releaseOutput(found, answer)
  await runSettled(ctx, found.context.runId)
  return memory(ctx, text)
}
/** Runs a maintenance tick, which begins the sleep, and returns the consolidation handed to the adapter. */
async function consolidation(ctx) {
  await ctx.dispatcher.maintenanceTick()
  const run = await until(() => row(ctx.db, `SELECT r.id FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps s ON s.id=r.sleep_id WHERE s.state='running' ORDER BY r.created_at DESC LIMIT 1`), Boolean, 'consolidation run')
  const found = await until(() => ctx.executions.find(e => e.context.runId === run.id && !ctx.handled.has(e)), Boolean, 'consolidation')
  ctx.handled.add(found)
  const payload = found.context.maintenance
  const ref = text => payload.memories.find(item => item.text === text).ref
  return { found, lesson: (text, ...memories) => JSON.stringify({ verdicts: [], lessons: [{ text, memories: memories.map(ref) }] }) }
}

test('extraction: a commit just before the lifecycle change lands; one just after is fenced', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const before = await extraction(ctx, 'The office opens at nine')
  await stage(ctx, before.found, before.answer)
  const barrier = await ctx.hold('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [before.saved.threadId])
  end(before.found)
  await ctx.waiting(1)
  const flipping = ctx.flip('archived')
  await ctx.waiting(2)
  await barrier.release()
  await flipping
  await runSettled(ctx, before.found.context.runId)
  assert.ok(await memory(ctx, 'The office opens at nine'), 'the earlier commit lands')
  assert.equal((await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [before.saved.runId])).status, 'committed')

  await ctx.flip('active')
  const after = await extraction(ctx, 'Parking is behind the office')
  const flip = await ctx.heldFlip()
  releaseOutput(after.found, after.answer)
  await ctx.waiting(1)
  await flip.commit()
  await runSettled(ctx, after.found.context.runId)
  assert.equal(await memory(ctx, 'Parking is behind the office'), undefined)
  assert.deepEqual({ ...await row(ctx.db, 'SELECT status, status_reason FROM kipster.maintenance_sources WHERE run_id=$1', [after.saved.runId]) }, { status: 'fenced', status_reason: 'source invalidated before commit' })
})

test('sleep consolidation: a commit just before the lifecycle change applies; one just after is fenced', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const hours = await learned(ctx, 'The office opens at nine')
  const closed = await learned(ctx, 'The office is closed on Mondays')
  while ((await ctx.runtime.memory.indexPending(20, true)).processed);
  const first = await consolidation(ctx)
  await stage(ctx, first.found, first.lesson('Check the hours before a visit', hours.text, closed.text))
  const barrier = await ctx.hold('SELECT 1 FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [first.found.context.runId])
  end(first.found)
  await ctx.waiting(1)
  const flipping = ctx.flip('archived')
  await ctx.waiting(2)
  await barrier.release()
  await flipping
  assert.equal(await runSettled(ctx, first.found.context.runId), 'completed')
  assert.ok(await memory(ctx, 'Check the hours before a visit'), 'the earlier consolidation applies')

  // The next night the agent is live again and has new material; this time the change comes first.
  await ctx.flip('active')
  await ctx.dispatcher.maintenanceTick()
  const parking = await learned(ctx, 'Parking is behind the office')
  const invoices = await learned(ctx, 'Invoices go out on Fridays')
  while ((await ctx.runtime.memory.indexPending(20, true)).processed);
  ctx.time.now = new Date(2026, 0, 11, 12)
  const second = await consolidation(ctx)
  const flip = await ctx.heldFlip()
  releaseOutput(second.found, second.lesson('Plan the visit around parking', parking.text, invoices.text))
  await ctx.waiting(1)
  await flip.commit()
  assert.equal(await runSettled(ctx, second.found.context.runId), 'failed')
  assert.equal((await row(ctx.db, 'SELECT failure FROM kipster.maintenance_runs WHERE id=$1', [second.found.context.runId])).failure, 'agent unavailable')
  assert.equal(await memory(ctx, 'Plan the visit around parking'), undefined)
})

test('a lifecycle change cancels queued maintenance, and sleep skips an agent that is not live', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const hours = await learned(ctx, 'The office opens at nine')
  await learned(ctx, 'The office is closed on Mondays')
  while ((await ctx.runtime.memory.indexPending(20, true)).processed);
  // Without a coordinator nothing claims the work queued below.
  await ctx.dispatcher.close()
  const sleep = new SleepService(ctx.db, ctx.actor.installationId)
  await sleep.run(ctx.time.now)
  const queued = await row(ctx.db, `SELECT r.id, r.state FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps s ON s.id=r.sleep_id WHERE s.state='running'`)
  assert.equal(queued.state, 'queued')
  const source = (await row(ctx.db, `SELECT run_id FROM kipster.maintenance_sources WHERE status='committed' LIMIT 1`)).run_id
  await ctx.db.query(`UPDATE kipster.maintenance_sources SET status='ready' WHERE run_id=$1`, [source])

  await ctx.flip('archived')
  assert.deepEqual({ ...await row(ctx.db, 'SELECT state, failure FROM kipster.maintenance_runs WHERE id=$1', [queued.id]) }, { state: 'failed', failure: 'Agent was archived' })
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.work_intents WHERE id=$1', [queued.id])).state, 'settled')
  assert.deepEqual({ ...await row(ctx.db, 'SELECT status, status_reason FROM kipster.maintenance_sources WHERE run_id=$1', [source]) }, { status: 'skipped', status_reason: 'Agent was archived' })

  const result = await sleep.run(ctx.time.now)
  assert.equal(result.skipped, 0, 'archive already ended the sleep')
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.memory_sleeps ORDER BY sleep_on DESC LIMIT 1`)).state, 'skipped')
  ctx.time.now = new Date(2026, 0, 12, 12)
  assert.deepEqual(await sleep.run(ctx.time.now), { started: 0, finished: 0, skipped: 0, forgotten: 0 }, 'no sleep begins while the agent is not live')
  assert.ok(await memory(ctx, hours.text), 'memories are kept')
})

test('identity promotion: a promotion answered after the lifecycle change is fenced and identity.md is unchanged', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  // Learned twice with full importance, the memory is strong enough to be promoted.
  await learned(ctx, 'The owner prefers short summaries', 1)
  await learned(ctx, 'The owner prefers short summaries', 1)
  const identity = join(ctx.runtime.home.agent(ctx.agentId), 'identity.md')
  const before = await readFile(identity, 'utf8')
  await ctx.dispatcher.maintenanceTick()
  const run = await until(() => row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE task_kind='identity'`), Boolean, 'promotion run')
  const found = await until(() => ctx.executions.find(e => e.context.runId === run.id), Boolean, 'promotion')
  const flip = await ctx.heldFlip()
  releaseOutput(found, JSON.stringify({ section: '- Prefers short summaries' }))
  await ctx.waiting(1)
  await flip.commit()
  assert.equal(await runSettled(ctx, run.id), 'failed')
  assert.equal((await row(ctx.db, 'SELECT failure FROM kipster.maintenance_runs WHERE id=$1', [run.id])).failure, 'agent unavailable')
  assert.equal(await readFile(identity, 'utf8'), before)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_promotions'), 0)
})

test('extraction claimed but not issued is fenced by the lifecycle change, and issue refuses an organization that is not live', { skip: noDatabase, timeout: 90000 }, async t => {
  const claimed = [], release = []
  const ctx = await setup(t, { async afterMaintenanceClaim(sourceRunId) { const gate = deferred(); claimed.push(sourceRunId); release.push(gate.resolve); await gate.promise } })
  const organizationId = ctx.runtime.bootstrap.organizationId
  const orgChat = (await resolveDirectChat(ctx.db, ctx.actor, { kind: 'organization', organizationId }, ctx.agentId)).chatId
  const converse = async (context, chatId, text) => {
    const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
      version: 1, submissionId: randomUUID(), scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
      target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
    const execution = await until(() => ctx.executions.find(e => e.context.runId === saved.runId), Boolean, `execution ${saved.runId}`)
    execution.handle.release({ kind: 'text', attemptId: execution.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
    execution.handle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
    await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
    await until(() => claimed.includes(saved.runId), Boolean, 'extraction claimed')
    return saved
  }
  const source = runId => row(ctx.db, 'SELECT s.status, s.status_reason, r.state FROM kipster.maintenance_sources s JOIN kipster.maintenance_runs r ON r.source_run_id=s.run_id WHERE s.run_id=$1', [runId])

  // The organization stops being live without a fence: issue refuses its source.
  const org = await converse({ kind: 'organization', organizationId }, orgChat, 'Please note: the Alpha office opens at nine')
  await ctx.db.query(`UPDATE kipster.organizations SET lifecycle='deleting' WHERE id=$1`, [organizationId])
  release.shift()()
  await until(() => source(org.runId), value => value?.state === 'failed', 'organization source ended')
  assert.deepEqual({ ...await source(org.runId) }, { status: 'skipped', status_reason: 'organization unavailable', state: 'failed' })

  // The agent's lifecycle change fences a claimed extraction before it is issued.
  const own = await converse(ctx.context, ctx.chatId, 'Please note: parking is behind the office')
  assert.equal((await source(own.runId)).state, 'preparing')
  await ctx.flip('archived')
  assert.deepEqual({ ...await source(own.runId) }, { status: 'skipped', status_reason: 'Agent was archived', state: 'failed' })
  release.shift()()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await source(own.runId)).status, 'skipped')
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0, 'no extraction reached the adapter')
})

for (const task of ['extract', 'consolidate', 'identity']) for (const recovery of [false, true]) test(`restore does not revive ${task} ${recovery ? 'recovery' : 'issued output'}`, { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const identity = join(ctx.runtime.home.agent(ctx.agentId), 'identity.md')
  const before = await readFile(identity, 'utf8')
  let found, answer
  if (task === 'extract') {
    const pending = await extraction(ctx, 'The office opens at nine')
    found = pending.found
    answer = pending.answer
  } else if (task === 'consolidate') {
    const hours = await learned(ctx, 'The office opens at nine')
    const closed = await learned(ctx, 'The office is closed on Mondays')
    while ((await ctx.runtime.memory.indexPending(20, true)).processed);
    const pending = await consolidation(ctx)
    found = pending.found
    answer = pending.lesson('Check the hours before a visit', hours.text, closed.text)
  } else {
    await learned(ctx, 'The owner prefers short summaries', 1)
    await learned(ctx, 'The owner prefers short summaries', 1)
    await ctx.dispatcher.maintenanceTick()
    found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && e.context.maintenance.task === 'identity'), Boolean, 'promotion')
    answer = JSON.stringify({ section: '- Prefers short summaries' })
  }
  await stage(ctx, found, answer)
  if (recovery) {
    found.handle.abortUnknown()
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId])).state, state => state === 'recovery-needed', 'recovery')
  }
  await ctx.flip('archived')
  await ctx.flip('active')
  // An archive cannot assert the provider ended or release its execution permit.
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits WHERE attempt_id=$1', [found.context.attemptId]), 1)
  if (recovery) {
    const service = new MaintenanceService(ctx.db, ctx.actor.installationId)
    const result = await ctx.db.transaction(async client => {
      await lockInstallation(client, ctx.actor.installationId)
      return service.settleReconcileEnded(client, ctx.runtime.jobs, found.context.runId, 'fixture confirmed end')
    })
    assert.deepEqual(result, { fenced: true }, 'confirmed end does not schedule a retry')
  } else end(found)
  assert.equal(await runSettled(ctx, found.context.runId), 'failed')
  if (task !== 'extract') assert.equal((await row(ctx.db, 'SELECT state FROM kipster.memory_sleeps WHERE id=(SELECT sleep_id FROM kipster.maintenance_runs WHERE id=$1)', [found.context.runId])).state, 'skipped')
  else {
    const source = await row(ctx.db, 'SELECT status, invalidated FROM kipster.maintenance_sources WHERE run_id=$1', [found.context.maintenance.sourceRunId])
    assert.deepEqual({ ...source }, { status: 'fenced', invalidated: true })
    assert.equal(await memory(ctx, 'The office opens at nine'), undefined)
  }
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits WHERE attempt_id=$1', [found.context.attemptId]), 0)
  assert.equal(await memory(ctx, 'Check the hours before a visit'), undefined)
  assert.equal(await readFile(identity, 'utf8'), before)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_promotions'), 0)
})
