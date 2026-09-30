import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MAINTENANCE_SWEEP_JOB_ID, MaintenanceService, PROMOTION, PROMOTION_INSTRUCTIONS_V1 } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Promotion of strong memories into the Learned section of identity.md, against real PostgreSQL and a real agent
// home, with the deterministic fixture adapter. Memories come from real extraction; the fixture's scripted sections
// stand in for the model, whose writing is outside these tests.
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
const BEGIN = '<!-- kipster:learned:begin -->'
const END = '<!-- kipster:learned:end -->'
const HEAD = '# Identity\nWritten by the owner.\n\n'
const TAIL = '\nAlso written by the owner.\n'
const hash = text => createHash('sha256').update(text).digest('hex')

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
  const database = `kipster_promotion_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-promotion-home-'))
  const time = { now: new Date(2026, 0, 10, 12) }
  const ctx = { time, executions: [], handled: new Set() }
  ctx.runtime = await openRuntime({ connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Alpha', rootAgent: 'Root' }, embedding: { ...profile, async embed() { return [0, 0, 1] } } })
  await ctx.runtime.memory.stopIndexing()
  ctx.db = ctx.runtime.db
  ctx.actor = { installationId: ctx.runtime.bootstrap.installationId, personId: ctx.runtime.bootstrap.ownerId }
  ctx.agentId = ctx.runtime.bootstrap.rootAgentId
  ctx.files = ctx.runtime.home.identity
  ctx.path = file => join(ctx.runtime.home.agent(ctx.agentId), file)
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(ctx.dispatcher).invokeTool(request) })
  ctx.dispatcher = new TextDispatcher(ctx.runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); ctx.executions.push({ context: value, handle }); return handle } })
  await ctx.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ctx.agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: true })
  t.after(async () => {
    await ctx.dispatcher.close().catch(() => undefined)
    await ctx.runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const place = async organizationId => {
    const context = organizationId ? { kind: 'organization', organizationId } : { kind: 'installation', installationId: ctx.actor.installationId }
    return { context, chatId: (await resolveDirectChat(ctx.db, ctx.actor, context, ctx.agentId)).chatId }
  }
  ctx.installation = await place(null)
  ctx.a = await place(ctx.runtime.bootstrap.organizationId)
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

/** A completed conversation in `where` that starts with a human message. Its extraction learns `text` with importance 1,
 * or nothing without it. Returns the conversation's execution. */
async function converse(ctx, where, message, text) {
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: where.context, chatId: where.chatId }, mode: 'root', parts: [{ kind: 'text', text: message }],
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
    const mine = text && found.context.maintenance.sourceRunId === saved.runId
    releaseOutput(found, JSON.stringify({ candidates: mine ? [{ kind: 'fact', text, subject: 'preferences', author_id: entry.author_id, author_class: entry.author_class, importance: 1, citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] : [] }))
    await settled(ctx, found.context.runId)
  }
  return execution
}
/** Learns `text` from a new conversation in `where`. Learning the same text again adds a supporting conversation to the
 * same memory. */
async function learned(ctx, where, text) {
  await converse(ctx, where, `Please note: ${text}`, text)
  return row(ctx.db, `SELECT m.id, m.evidence, m.home_organization_id AS home,
      kipster.memory_strength(m.importance, m.evidence, COALESCE(a.active_days, 0) - m.refreshed_day) AS strength
    FROM kipster.memory_records m LEFT JOIN kipster.memory_activity a ON a.agent_id=m.owner_id
    WHERE m.text=$1 AND m.scope='agent' AND m.home_organization_id IS NOT DISTINCT FROM $2::uuid`, [text, where.context.organizationId ?? null])
}

const at = (ctx, day) => { ctx.time.now = new Date(2026, 0, day, 12) }
/** Runs the maintenance tick, which sleeps the agent, and returns the promotion it hands to the adapter, if any. */
async function promotionOf(ctx) {
  await ctx.dispatcher.maintenanceTick()
  const run = await row(ctx.db, `SELECT r.id FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps s ON s.id=r.sleep_id
    WHERE s.state='running' AND r.task_kind='identity' AND r.state IN ('queued','preparing','running') ORDER BY r.created_at DESC LIMIT 1`)
  if (!run) return null
  const found = await until(() => ctx.executions.find(e => e.context.runId === run.id && !ctx.handled.has(e)), Boolean, 'promotion')
  ctx.handled.add(found)
  return found
}
/** Answers a promotion with a scripted section and waits for the run to settle; the next tick finishes the sleep. */
async function answer(ctx, found, section, raw) {
  releaseOutput(found, raw ?? JSON.stringify({ section }))
  const state = await settled(ctx, found.context.runId)
  await ctx.dispatcher.maintenanceTick()
  return state
}
const lastSleep = ctx => row(ctx.db, `SELECT sleep_on::text AS day, state, step, report FROM kipster.memory_sleeps WHERE agent_id=$1 ORDER BY sleep_on DESC LIMIT 1`, [ctx.agentId])
const promotions = ctx => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE task_kind='identity'`)
const live = (ctx, file) => readFile(ctx.path(file), 'utf8')
const backups = async ctx => Promise.all((await ctx.files.listBackups(ctx.agentId, 'identity.md')).map(async backup => ({ id: backup.id, content: (await ctx.files.readBackup(ctx.agentId, 'identity.md', backup.id)).content })))
const withSection = section => `${HEAD}${BEGIN}\n${section ? `${section}\n` : ''}${END}\n${TAIL}`
/** The owner's identity.md with text before and after an empty Learned section. */
async function ownerIdentity(ctx) {
  const current = await ctx.files.read(ctx.agentId, 'identity.md')
  await ctx.files.write(ctx.agentId, 'identity.md', withSection(''), current.sha256, 'owner')
}
/** Ages the agent's memories by moving its active-day clock forward. */
const age = (ctx, days) => ctx.db.query('UPDATE kipster.memory_activity SET active_days=active_days+$2 WHERE agent_id=$1', [ctx.agentId, days])

test('a memory is promoted after a second supporting conversation and leaves the section when it weakens or is forgotten', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ownerIdentity(ctx)
  const soul = await live(ctx, 'soul.md'), agents = await live(ctx, 'AGENTS.md')
  const untouched = async () => {
    assert.equal(await live(ctx, 'soul.md'), soul)
    assert.equal(await live(ctx, 'AGENTS.md'), agents)
    const identity = await live(ctx, 'identity.md')
    assert.ok(identity.startsWith(`${HEAD}${BEGIN}\n`) && identity.endsWith(`${END}\n${TAIL}`), 'text outside the markers is unchanged')
  }
  const text = 'The owner prefers short summaries'

  const once = await learned(ctx, ctx.installation, text)
  assert.deepEqual([once.evidence, once.strength], [1, 0.5])
  // An organization memory as strong as a promoted one is never promoted: identity loads in every context.
  await learned(ctx, ctx.a, 'Alpha invoices are due in ten days')
  const homed = await learned(ctx, ctx.a, 'Alpha invoices are due in ten days')
  assert.deepEqual([homed.home, homed.evidence, homed.strength], [ctx.runtime.bootstrap.organizationId, 2, 0.75])

  // The first night nothing is promotable and the section is empty: no model call and nothing recorded.
  assert.equal(await promotionOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: {} })
  await untouched()

  const twice = await learned(ctx, ctx.installation, text)
  assert.deepEqual([twice.id, twice.evidence, twice.strength], [once.id, 2, PROMOTION.strength])
  at(ctx, 11)
  const found = await promotionOf(ctx)
  const payload = found.context.maintenance
  assert.deepEqual([found.context.agentId, found.context.organizationId, payload.task, payload.section, payload.sectionMaxBytes], [ctx.agentId, null, 'identity', '', 2048])
  assert.deepEqual(payload.settings, { adapterId: 'deterministic-fixture', modelId: 'fixture-model' }, 'the agent\'s own model')
  assert.deepEqual(payload.memories, [{ ref: 'm1', text }])
  assert.ok(payload.instructions.startsWith(PROMOTION_INSTRUCTIONS_V1))
  assert.ok(payload.instructions.includes(`m1: ${text}`) && !payload.instructions.includes('Alpha'))
  assert.equal((await lastSleep(ctx)).step, 'promote', 'the sleep waits for its promotion')
  assert.equal(await answer(ctx, found, '- Prefers short summaries'), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection('- Prefers short summaries'))
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-11', state: 'finished', step: 'promote', report: { promotion: { memories: 1, added: 1, removed: 0, bytes: 25 } } })
  assert.deepEqual((await backups(ctx))[0].content, withSection(''), 'the replaced version is kept')
  await untouched()

  // The next execution, in any context, reads the new section.
  const next = await converse(ctx, ctx.a, 'Hello', null)
  assert.ok(next.context.instructions.includes(`${BEGIN}\n- Prefers short summaries\n${END}`))

  // An unchanged promotable set needs no model call.
  at(ctx, 12)
  assert.equal(await promotionOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-12', state: 'finished', step: 'promote', report: {} })
  assert.equal(await promotions(ctx), 1)

  // Once the memory weakens below promotion strength, the section is rebuilt without it.
  await age(ctx, 10)
  at(ctx, 13)
  const weakened = await promotionOf(ctx)
  assert.deepEqual([weakened.context.maintenance.memories, weakened.context.maintenance.section], [[], '- Prefers short summaries\n'])
  assert.ok(weakened.context.maintenance.instructions.endsWith('Memories, strongest first:\n(none)\n\nCurrent section:\n- Prefers short summaries\n'))
  assert.equal(await answer(ctx, weakened, ''), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection(''))
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 0, added: 0, removed: 1, bytes: 0 } })

  // Support in a third conversation promotes it again; once forgotten, it leaves the section in the same sleep.
  assert.equal((await learned(ctx, ctx.installation, text)).evidence, 3)
  at(ctx, 14)
  assert.equal(await answer(ctx, await promotionOf(ctx), '- Prefers short summaries'), 'completed')
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 1, added: 1, removed: 0, bytes: 25 } })
  await age(ctx, 1000)
  at(ctx, 15)
  const forgotten = await promotionOf(ctx)
  assert.deepEqual(forgotten.context.maintenance.memories, [])
  assert.equal(await row(ctx.db, 'SELECT id FROM kipster.memory_records WHERE id=$1', [once.id]), undefined, 'forgetting ran before promotion')
  assert.equal(await answer(ctx, forgotten, ''), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection(''))
  assert.deepEqual((await lastSleep(ctx)).report, { forgotten: 2, promotion: { memories: 0, added: 0, removed: 1, bytes: 0 } })
  assert.equal(await promotions(ctx), 4)
  assert.ok((await backups(ctx)).length <= 5)
  await untouched()

  // The agent brain purge removes what promotion recorded.
  await ctx.dispatcher.close()
  await ctx.db.transaction(client => new MaintenanceService(ctx.db, ctx.actor.installationId).purgeAgentBrain(client, ctx.agentId))
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_promotions WHERE agent_id=$1', [ctx.agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE agent_id=$1', [ctx.agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_sleeps WHERE agent_id=$1', [ctx.agentId]), 0)
})

test('invalid or oversized output writes nothing and the next sleep tries again', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ownerIdentity(ctx)
  const text = 'The owner wants answers in English'
  await learned(ctx, ctx.installation, text)
  await learned(ctx, ctx.installation, text)
  const original = await ctx.files.read(ctx.agentId, 'identity.md')
  const saved = await backups(ctx)

  const oversized = 'x'.repeat(PROMOTION.sectionBytes + 1)
  assert.equal(await answer(ctx, await promotionOf(ctx), oversized), 'failed')
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: { promotion: { failure: 'section_too_large' } } })
  at(ctx, 11)
  assert.equal(await answer(ctx, await promotionOf(ctx), `${END}\n- Answers in English`), 'failed')
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { failure: 'malformed_output' } })
  at(ctx, 12)
  assert.equal(await answer(ctx, await promotionOf(ctx), null, 'Answers in English'), 'failed')
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { failure: 'malformed_output' } })
  assert.deepEqual(await ctx.files.read(ctx.agentId, 'identity.md'), original, 'nothing was written')
  assert.deepEqual(await backups(ctx), saved)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_promotions'), 0)

  // A section of exactly the size limit is written. Multi-byte text counts in bytes.
  const largest = `- ${'é'.repeat((PROMOTION.sectionBytes - 2) / 2)}`
  assert.equal(Buffer.byteLength(largest), PROMOTION.sectionBytes)
  at(ctx, 13)
  assert.equal(await answer(ctx, await promotionOf(ctx), largest), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection(largest))
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 1, added: 1, removed: 0, bytes: PROMOTION.sectionBytes } })

  // When the set empties while the owner has already emptied the section, the change is recorded without a model call.
  const current = await ctx.files.read(ctx.agentId, 'identity.md')
  await ctx.files.write(ctx.agentId, 'identity.md', withSection(''), current.sha256, 'owner')
  await age(ctx, 10)
  at(ctx, 14)
  assert.equal(await promotionOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-14', state: 'finished', step: 'promote', report: { promotion: { memories: 0, added: 0, removed: 1, bytes: 0 } } })
  assert.equal(await promotions(ctx), 4)
  assert.deepEqual((await row(ctx.db, 'SELECT memories FROM kipster.memory_promotions WHERE agent_id=$1', [ctx.agentId])).memories, [])
})

test('an external edit during a promotion wins; the next sleep writes on top of it and five backups remain', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  for (let n = 1; n <= 6; n++) {
    const current = await ctx.files.read(ctx.agentId, 'identity.md')
    await ctx.files.write(ctx.agentId, 'identity.md', `${HEAD}Version ${n}.\n`, current.sha256, 'owner')
  }
  const text = 'The owner reviews pull requests in the morning'
  await learned(ctx, ctx.installation, text)
  await learned(ctx, ctx.installation, text)
  const saved = await backups(ctx)
  assert.equal(saved.length, 5)

  const found = await promotionOf(ctx)
  assert.equal(found.context.maintenance.section, '', 'a file without markers has an empty section')
  // An editor outside Kipster saves identity.md while the model is writing.
  const edited = `${HEAD}Version 6, edited by hand.\n`
  await writeFile(ctx.path('identity.md'), edited)
  assert.equal(await answer(ctx, found, '- Reviews in the morning'), 'failed')
  assert.equal(await live(ctx, 'identity.md'), edited, 'the edit is kept')
  assert.deepEqual(await backups(ctx), saved)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: { promotion: { failure: 'identity.md changed' } } })

  at(ctx, 11)
  const retry = await promotionOf(ctx)
  assert.equal(await answer(ctx, retry, '- Reviews in the morning'), 'completed')
  assert.equal(await live(ctx, 'identity.md'), `${edited}\n${BEGIN}\n- Reviews in the morning\n${END}\n`)
  const kept = await backups(ctx)
  assert.equal(kept.length, 5)
  assert.equal(kept[0].content, edited, 'the hand edit is the newest backup')
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 1, added: 1, removed: 0, bytes: 24 } })
  assert.equal(hash(await live(ctx, 'identity.md')), (await ctx.files.read(ctx.agentId, 'identity.md')).sha256)
})

test('learning switched off during a promotion fences its result; nothing is written', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ownerIdentity(ctx)
  const text = 'The owner signs emails with initials'
  await learned(ctx, ctx.installation, text)
  await learned(ctx, ctx.installation, text)
  const original = await live(ctx, 'identity.md')
  const saved = await backups(ctx)

  const found = await promotionOf(ctx)
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: false })
  releaseOutput(found, JSON.stringify({ section: '- Signs with initials' }))
  assert.equal(await settled(ctx, found.context.runId), 'failed')
  assert.equal((await row(ctx.db, 'SELECT failure FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId])).failure, 'learning_disabled')
  assert.equal(await live(ctx, 'identity.md'), original)
  assert.deepEqual(await backups(ctx), saved)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_promotions'), 0)
  await ctx.dispatcher.maintenanceTick()
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'skipped', step: 'promote', report: { reason: 'learning_disabled' } })

  // With learning back on, the next sleep promotes the memory.
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.agentId, { enabled: true })
  at(ctx, 11)
  assert.equal(await answer(ctx, await promotionOf(ctx), '- Signs with initials'), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection('- Signs with initials'))
})

test('malformed markers block promotion without a model call; a section already in place counts as written', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const seeded = await ctx.files.read(ctx.agentId, 'identity.md')
  await ctx.files.write(ctx.agentId, 'identity.md', `${HEAD}${BEGIN}\n- Unfinished\n`, seeded.sha256, 'owner')
  const text = 'The owner keeps meeting notes'
  await learned(ctx, ctx.installation, text)
  await learned(ctx, ctx.installation, text)

  assert.equal(await promotionOf(ctx), null)
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-10', state: 'finished', step: 'promote', report: { promotion: { failure: 'Invalid Learned section markers in identity.md' } } })
  assert.equal(await promotions(ctx), 0)

  // The owner repairs the file. While the model writes, the owner saves the very section it returns.
  const broken = await ctx.files.read(ctx.agentId, 'identity.md')
  await ctx.files.write(ctx.agentId, 'identity.md', withSection(''), broken.sha256, 'owner')
  at(ctx, 11)
  const found = await promotionOf(ctx)
  const repaired = await ctx.files.read(ctx.agentId, 'identity.md')
  await ctx.files.write(ctx.agentId, 'identity.md', withSection('- Keeps notes'), repaired.sha256, 'owner')
  const saved = await backups(ctx)
  assert.equal(await answer(ctx, found, '- Keeps notes'), 'completed')
  assert.equal(await live(ctx, 'identity.md'), withSection('- Keeps notes'))
  assert.deepEqual(await backups(ctx), saved)
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 1, added: 1, removed: 0, bytes: 13 } })
  at(ctx, 12)
  assert.equal(await promotionOf(ctx), null)
  assert.equal(await promotions(ctx), 1)
})

test('a promoted memory stays down to keep strength, while a new memory at that strength does not enter', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ownerIdentity(ctx)
  const kept = 'The owner prefers morning meetings'
  const newer = 'The owner prefers written agendas'
  await learned(ctx, ctx.installation, kept)
  const first = await learned(ctx, ctx.installation, kept)
  assert.equal(await answer(ctx, await promotionOf(ctx), '- Prefers morning meetings'), 'completed')

  // Both memories are at 0.75 x 0.5^(4/60), about 0.716: between keep strength and promotion strength.
  await learned(ctx, ctx.installation, newer)
  const second = await learned(ctx, ctx.installation, newer)
  await age(ctx, 4)
  const strengths = (await ctx.db.query(`SELECT m.text, kipster.memory_strength(m.importance, m.evidence, a.active_days - m.refreshed_day) AS s
    FROM kipster.memory_records m JOIN kipster.memory_activity a ON a.agent_id=m.owner_id WHERE m.id=ANY($1::uuid[])`, [[first.id, second.id]])).rows
  assert.equal(strengths.length, 2)
  for (const item of strengths) assert.ok(item.s >= PROMOTION.keepStrength && item.s < PROMOTION.strength, `${item.text}: ${item.s}`)
  at(ctx, 11)
  assert.equal(await promotionOf(ctx), null, 'the promoted memory stays and the new one does not enter')
  assert.deepEqual(await lastSleep(ctx), { day: '2026-01-11', state: 'finished', step: 'promote', report: {} })
  assert.equal(await live(ctx, 'identity.md'), withSection('- Prefers morning meetings'))

  // Below keep strength (0.75 x 0.5^(7/60), about 0.692) the promoted memory leaves.
  await age(ctx, 3)
  at(ctx, 12)
  const left = await promotionOf(ctx)
  assert.deepEqual(left.context.maintenance.memories, [])
  assert.equal(await answer(ctx, left, ''), 'completed')
  assert.deepEqual((await lastSleep(ctx)).report, { promotion: { memories: 0, added: 0, removed: 1, bytes: 0 } })
  assert.equal(await promotions(ctx), 2)
})
