import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MaintenanceService, MAINTENANCE_LIMITS, MAINTENANCE_SWEEP_JOB_ID } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import * as operator from '../dist/maintenance.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Maintenance behavior against real PostgreSQL with a deterministic
// maintenance-capable fixture. The fixture proves Core mechanics only;
// production provider termination, embedding quality and semantic judgment
// are outside these tests.
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
const row = async (db, sql, params = []) => (await db.query(sql, params)).rows[0]
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n)

async function setup(t, { maintenance = true, hooks = {}, embedding = true } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_maintenance_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_maintenance-home-'))
  const embed = { fail: false }
  const embedder = { async embed() { if (embed.fail) throw new Error('fixture embedder unavailable'); return [1, 0] } }
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, ...(embedding ? { embedding: { ...profile, ...embedder } } : {}) })
  await runtime.memory?.stopIndexing()
  const ctx = { admin, database, url, home, runtime, db: runtime.db, embed, executions: [], dispatchers: [], service: null, cleanups: [] }
  ctx.service = new MaintenanceService(ctx.db, runtime.bootstrap.installationId)
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const context = { kind: 'installation', installationId: actor.installationId }
  ctx.actor = actor
  ctx.context = context
  if (maintenance) await runtime.learning.setInstallation(actor, { enabled: true })
  const { chatId } = await resolveDirectChat(ctx.db, actor, context, runtime.bootstrap.rootAgentId)
  ctx.chatId = chatId
  await ctx.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  addDispatcher(ctx, hooks)
  t.after(async () => {
    for (const cleanup of ctx.cleanups.reverse()) await cleanup()
    for (const dispatcher of ctx.dispatchers.splice(0)) await dispatcher.close().catch(() => undefined)
    await ctx.runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return ctx
}

function addDispatcher(ctx, hooks = {}) {
  let dispatcher
  const lazy = { now: () => new Date().toISOString(), invokeTool: (request) => textPublicationHost(dispatcher).invokeTool(request) }
  const inner = fixtureAdapter(lazy)
  const adapter = { ...inner, async execute(context) { const handle = await inner.execute(context); ctx.executions.push({ context, handle }); return handle } }
  dispatcher = new TextDispatcher(ctx.runtime, adapter, undefined, hooks)
  ctx.dispatchers.push(dispatcher)
  ctx.adapter = adapter
  ctx.inner = inner
  return { dispatcher, start: () => dispatcher.start() }
}

async function setLearning(ctx, enabled) {
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled })
}
async function submitText(ctx, text, opts = {}) {
  return acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: opts.context ?? ctx.context, chatId: opts.chatId ?? ctx.chatId },
    mode: 'root', parts: [{ kind: 'text', text }],
  })
}
async function textExec(ctx, runId, fromIndex = 0) {
  return until(() => ctx.executions.slice(fromIndex).find(e => e.context.runId === runId && e.context.kind !== 'maintenance'), Boolean, `text execution ${runId}`)
}
async function maintExec(ctx, fromIndex = 0) {
  return until(() => ctx.executions.slice(fromIndex).find(e => e.context.kind === 'maintenance'), Boolean, 'maintenance execution')
}
async function runState(ctx, runId) {
  return (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [runId]))?.state
}
async function completeTextRun(ctx, text, opts = {}) {
  const saved = await submitText(ctx, text, opts)
  const found = await textExec(ctx, saved.runId, opts.fromIndex ?? 0)
  const attemptId = found.context.attemptId
  found.handle.release({ kind: 'text', attemptId, messageId: 'answer', text: opts.answer ?? `Acknowledged: ${text}`.slice(0, 200), final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
  await until(async () => runState(ctx, saved.runId), s => s === 'completed', `run completed ${saved.runId}`)
  return saved
}
function providerEvent(attemptId) {
  return { kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture-maint', modelId: 'fixture-model' }
}
async function driveMaintenance(ctx, fromIndex, candidates, { provider = true } = {}) {
  const found = await maintExec(ctx, fromIndex)
  ctx.handledMaint ??= new Set()
  ctx.handledMaint.add(found)
  const attemptId = found.context.attemptId
  if (provider) found.handle.release(providerEvent(attemptId))
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates }), final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
  return found
}
async function nextMaintExec(ctx) {
  ctx.handledMaint ??= new Set()
  const pending = ctx.executions.find(e => e.context.kind === 'maintenance' && !ctx.handledMaint.has(e))
  if (pending) {
    ctx.handledMaint.add(pending)
    return pending
  }
  const mark = ctx.executions.length
  await sweep(ctx)
  const found = await maintExec(ctx, mark)
  ctx.handledMaint.add(found)
  return found
}
/** Drive one source to terminal, disposing of any other claimable sources with empty (covering) output. */
async function commitSource(ctx, runId, revision, candidates, { provider = true } = {}) {
  for (let i = 0; i < 12; i++) {
    const status = await sourceStatus(ctx, runId, revision)
    if (['committed', 'skipped', 'fenced'].includes(status)) return status
    const found = await nextMaintExec(ctx)
    const attemptId = found.context.attemptId
    const mine = found.context.maintenance.sourceRunId === runId && found.context.maintenance.sourceRevision === revision
    if (provider) found.handle.release(providerEvent(attemptId))
    found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: mine ? candidates : [] }), final: true })
    found.handle.release({ kind: 'ended', attemptId, confirmed: true })
    await maintRunSettled(ctx, found.context.runId)
  }
  throw new Error(`Timed out: source terminal ${runId} r${revision}`)
}
async function sourceStatus(ctx, runId, revision) {
  return (await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2', [runId, revision]))?.status
}
async function sweep(ctx) {
  await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
}
async function resetEligible(ctx, runId, revision = 1) {
  await ctx.db.query(`UPDATE kipster.maintenance_sources SET next_eligible_at=now() WHERE run_id=$1 AND source_revision=$2`, [runId, revision])
  await sweep(ctx)
}
async function sourceTerminal(ctx, runId, revision) {
  return until(async () => sourceStatus(ctx, runId, revision), s => ['committed', 'skipped', 'fenced'].includes(s), `source terminal ${runId} r${revision}`)
}
/** Releases settle asynchronously; wait for the driven run to leave active states before rereading sources. */
async function maintRunSettled(ctx, runId) {
  return until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId]))?.state, s => ['completed', 'failed', 'recovery-needed'].includes(s), `maintenance run settled ${runId}`)
}
async function manifestOf(ctx, runId, revision = 1) {
  return until(async () => (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2', [runId, revision]))?.manifest, Boolean, `manifest ${runId}`)
}
async function messageText(ctx, messageId) {
  const parts = (await row(ctx.db, 'SELECT parts FROM kipster.messages WHERE id=$1', [messageId])).parts
  return parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
}
function candidateFor(entry, text, excerpt, { kind = 'fact', subject = 'test subject' } = {}) {
  return { kind, text, subject, author_id: entry.author_id, author_class: entry.author_class, citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt }] }
}
/** Delegation-child manifests list the request (input) first; the answer is the second entry. */
function answerEntry(manifest) {
  assert.equal(manifest.entries.length, 2)
  return manifest.entries[1]
}

test('extraction commits cited memories from a refs-only manifest with no public output', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const fact = 'The Amsterdam office opens at nine'
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, `Remember this fact: ${fact}`)
  const manifest = await manifestOf(ctx, saved.runId)
  assert.ok(manifest.entries.length >= 2)
  assert.ok(!JSON.stringify(manifest).includes(fact), 'manifest stores references and hashes only')
  const input = manifest.entries[0]
  const excerpt = `Remember this fact: ${fact}`.slice(0, 50)
  await driveMaintenance(ctx, mark, [candidateFor(input, fact, excerpt, { subject: 'office hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memories = (await ctx.db.query(`SELECT id, scope, owner_id, kind, text, revision FROM kipster.memory_records WHERE scope='agent' AND kind='fact'`)).rows
  assert.equal(memories.length, 1)
  assert.equal(memories[0].text, fact)
  assert.equal(memories[0].owner_id, ctx.runtime.bootstrap.rootAgentId)
  const evidence = (await ctx.db.query('SELECT source_message_id, source_message_revision, source_parts_hash, excerpt, subject FROM kipster.memory_provenance WHERE memory_id=$1', [memories[0].id])).rows
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].source_message_id, input.message_id)
  assert.equal(evidence[0].source_message_revision, String(input.revision))
  assert.equal(evidence[0].source_parts_hash, input.parts_sha256)
  assert.equal(evidence[0].subject, 'office hours')
  const intent = await row(ctx.db, 'SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1', [memories[0].id])
  assert.equal(intent.status, 'pending')
  await ctx.runtime.memory.indexPending(10, true)
  const included = await ctx.runtime.memory.context(ctx.runtime.bootstrap.rootAgentId, null, 'Amsterdam office')
  assert.ok(included.join('\n').includes(fact))
  const maintAttempt = (await row(ctx.db, `SELECT current_attempt_id AS id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [saved.runId])).id
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.messages WHERE source_attempt_id=$1', [maintAttempt]), 0)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.notifications WHERE run_id=$1`, [saved.runId]), 1)
  const outputs = await readdir(join(ctx.home, 'agents', ctx.runtime.bootstrap.rootAgentId, 'outputs')).catch(() => [])
  assert.deepEqual(outputs.filter(name => name === maintAttempt), [])
})

test('invalid citations fail boundedly while valid citations are accepted without entailment checks', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Bergen office opens at ten')
  const manifest = await manifestOf(ctx, saved.runId)
  const input = manifest.entries[0]
  const bad = candidateFor(input, 'The Bergen office opens at ten', 'Bergen office opens', { subject: 'hours' })
  bad.citations[0].message_id = randomUUID()
  await driveMaintenance(ctx, mark, [bad])
  assert.equal(await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'ready', 'source ready for retry'), 'ready')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`), 0)
  mark = ctx.executions.length
  await resetEligible(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [bad])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'fenced')
  assert.equal((await row(ctx.db, 'SELECT failure_class FROM kipster.maintenance_runs WHERE source_run_id=$1 ORDER BY created_at DESC LIMIT 1', [saved.runId])).failure_class, 'invalid_output')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`), 0)
  // Citations prove existence only: a valid citation with unsupported entailment is accepted.
  mark = ctx.executions.length
  const saved2 = await completeTextRun(ctx, 'The Bergen office opens at ten')
  const manifest2 = await manifestOf(ctx, saved2.runId)
  const input2 = manifest2.entries[0]
  await driveMaintenance(ctx, mark, [candidateFor(input2, 'The Bergen office never closes', 'Bergen office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved2.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Bergen office never closes'`), 1)
})

test('redelivery and restart recovery commit a source exactly once', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Cairo office opens at eight')
  await manifestOf(ctx, saved.runId)
  await sweep(ctx)
  await sweep(ctx)
  const manifest = await manifestOf(ctx, saved.runId)
  const found = await maintExec(ctx, mark)
  const attemptId = found.context.attemptId
  found.handle.release(providerEvent(attemptId))
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifest.entries[0], 'The Cairo office opens at eight', 'Cairo office opens', { subject: 'hours' })] }), final: true })
  // Restart before the terminal event: close fences owned issued work to recovery with the permit retained.
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await until(async () => (await row(ctx.db, `SELECT state FROM kipster.maintenance_runs WHERE source_run_id=$1`, [saved.runId]))?.state, s => s === 'recovery-needed', 'run recovery-needed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.owned_permits`), 1)
  const { dispatcher } = addDispatcher(ctx)
  await dispatcher.start()
  ctx.inner.reconcileScript.push('ended')
  await ctx.service.requestAction('op-reconcile', 'reconcile', { runId: (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [saved.runId])).id })
  await dispatcher.pumpMaintenance()
  assert.equal(await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'ready', 'source ready after reconcile'), 'ready')
  mark = ctx.executions.length
  await resetEligible(ctx, saved.runId)
  // The redelivered sweep and the reconcile-triggered retry converge on one claim; duplicate evidence attaches once.
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The Cairo office opens at eight', 'Cairo office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Cairo office opens at eight'`), 1)
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Cairo office opens at eight'`)).id
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 1)
})

test('close fences an issued run while a provider record is in flight without deadlocking', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'Close ordering probe')
  const found = await maintExec(ctx, mark)
  const attemptId = found.context.attemptId
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'issued', 'issued')
  // Hold the attempt row so the provider record and the close fence both queue behind it.
  const holder = new Postgres(ctx.url.href, 1)
  t.after(() => holder.close())
  const held = deferred()
  const release = deferred()
  const holding = holder.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.attempts WHERE id=$1 FOR UPDATE', [attemptId])
    held.resolve()
    await release.promise
  })
  await held.promise
  const lockWaiters = like => count(ctx.db, `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`, [like])
  found.handle.release(providerEvent(attemptId))
  await until(() => lockWaiters('%provider_metadata%'), n => n >= 1, 'provider record waits')
  const closing = ctx.dispatchers[0].close()
  await until(() => lockWaiters('%FOR UPDATE OF r%'), n => n >= 1, 'close fence waits')
  release.resolve()
  await holding
  await closing
  ctx.dispatchers.splice(0, 1)
  const run = await row(ctx.db, 'SELECT state, recovery_ref FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
  assert.equal(run.state, 'recovery-needed')
  assert.equal(run.recovery_ref.providerIds.processId, 4242)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
})

test('a stale manifest during preparation recaptures and extracts only the new revision', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Denver office opens at seven')
  const manifest = await manifestOf(ctx, saved.runId)
  // White-box message edit after freeze: bump the input revision with new parts.
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [manifest.entries[0].message_id, JSON.stringify([{ kind: 'text', text: 'The Denver office opens at seven sharp' }])])
  // Preparation detects the mismatch, recaptures, and restarts once within the same sweep (only the new claim executes).
  assert.equal(await until(async () => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), n => n === 2, 'recaptured revision'), 2)
  const restarted = await maintExec(ctx, mark)
  assert.equal(restarted.context.maintenance.sourceRevision, 2)
  const statuses = (await ctx.db.query('SELECT source_revision, status FROM kipster.maintenance_sources WHERE run_id=$1 ORDER BY source_revision', [saved.runId])).rows
  assert.deepEqual(statuses.map(r => r.status), ['superseded', 'issued'])
  const fresh = await manifestOf(ctx, saved.runId, 2)
  assert.equal(fresh.entries[0].revision, manifest.entries[0].revision + 1)
  const attemptId = restarted.context.attemptId
  restarted.handle.release(providerEvent(attemptId))
  restarted.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(fresh.entries[0], 'The Denver office opens at seven sharp', 'Denver office opens at seven', { subject: 'hours' })] }), final: true })
  restarted.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, saved.runId, 2), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`), 1)
})

test('the scanner repairs changed terminal sources once and skips unchanged epochs', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Erie office opens at six')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The Erie office opens at six', 'Erie office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [manifest.entries[0].message_id, JSON.stringify([{ kind: 'text', text: 'The Erie office opens at six sharp' }])])
  const tick = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.ok(tick.repaired >= 1)
  const revisions = (await ctx.db.query('SELECT source_revision, status FROM kipster.maintenance_sources WHERE run_id=$1 ORDER BY source_revision', [saved.runId])).rows
  assert.deepEqual(revisions.map(r => ({ revision: Number(r.source_revision), status: r.status })), [{ revision: 1, status: 'committed' }, { revision: 2, status: 'ready' }])
  mark = ctx.executions.length
  await sweep(ctx)
  const fresh = await manifestOf(ctx, saved.runId, 2)
  await driveMaintenance(ctx, mark, [candidateFor(fresh.entries[0], 'The Erie office opens at six sharp', 'Erie office opens at six', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 2), 'committed')
  const again = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(again.repaired, 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), 2)
})

test('organization deletion tombstones context and fences in-flight output', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const orgId = ctx.runtime.bootstrap.organizationId
  const orgContext = { kind: 'organization', organizationId: orgId }
  const { chatId } = await resolveDirectChat(ctx.db, ctx.actor, orgContext, ctx.runtime.bootstrap.rootAgentId)
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Fargo office opens at five', { context: orgContext, chatId })
  const manifest = await manifestOf(ctx, saved.runId)
  // One memory is homed in the organization; an explicit request is global.
  await driveMaintenance(ctx, mark, [
    candidateFor(manifest.entries[0], 'The Fargo office opens at five', 'Fargo office opens', { subject: 'hours' }),
    { ...candidateFor(manifest.entries[0], 'Office hours matter to the owner', 'Fargo office opens', { subject: 'priorities' }), explicit: true },
  ])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const homedId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Fargo office opens at five'`)).id
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='Office hours matter to the owner'`)).id
  await ctx.db.transaction(async client => { await ctx.service.purgeOrganizationContext(client, orgId) })
  assert.equal(await row(ctx.db, 'SELECT id FROM kipster.memory_records WHERE id=$1', [homedId]), undefined)
  assert.ok((await row(ctx.db, 'SELECT text FROM kipster.memory_records WHERE id=$1', [memoryId])).text)
  const source = await row(ctx.db, 'SELECT status, manifest, manifest_purged FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])
  assert.equal(source.status, 'source_deleted')
  assert.equal(source.manifest, null)
  assert.equal(source.manifest_purged, true)
  const evidence = await row(ctx.db, 'SELECT excerpt, source_organization_deleted FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId])
  assert.equal(evidence.excerpt, null)
  assert.equal(evidence.source_organization_deleted, true)
  const claim = await row(ctx.db, 'SELECT context_tombstoned FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [memoryId])
  assert.equal(claim.context_tombstoned, true)
  // In-flight output fences without salvaging after the purge.
  const org2 = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.organizations(id, installation_id, display_name, provisioned) VALUES ($1,$2,'Second',true)`, [org2, ctx.actor.installationId])
  await ctx.db.query(`INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)`, [org2, ctx.runtime.bootstrap.rootAgentId])
  await ctx.db.query(`INSERT INTO kipster.human_memberships(organization_id, person_id) VALUES ($1,$2)`, [org2, ctx.actor.personId])
  await ctx.runtime.home.provisionOrganization(org2)
  const org2Context = { kind: 'organization', organizationId: org2 }
  const chat2 = (await resolveDirectChat(ctx.db, ctx.actor, org2Context, ctx.runtime.bootstrap.rootAgentId)).chatId
  mark = ctx.executions.length
  const live = await completeTextRun(ctx, 'The Greeley office opens at four', { context: org2Context, chatId: chat2 })
  const liveManifest = await manifestOf(ctx, live.runId)
  const found = await maintExec(ctx, mark)
  const attemptId = found.context.attemptId
  found.handle.release(providerEvent(attemptId))
  await ctx.db.transaction(async client => { await ctx.service.purgeOrganizationContext(client, org2) })
  assert.equal(await sourceStatus(ctx, live.runId, 1), 'issued')
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(liveManifest.entries[0], 'The Greeley office opens at four', 'Greeley office opens', { subject: 'hours' })] }), final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, live.runId, 1), 'fenced')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Greeley office opens at four'`), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

async function delegateChild(ctx, text, recipientId, request, opts = {}) {
  const saved = await submitText(ctx, text, opts)
  const parent = await textExec(ctx, saved.runId)
  await parent.handle.callTool('delegate-1', 'agents.delegate', { recipientId, request })
  const attemptId = parent.context.attemptId
  parent.handle.release({ kind: 'waiting', attemptId, for: 'child', interactionId: 'delegation' })
  parent.handle.release({ kind: 'text', attemptId, messageId: 'answer', text: 'Delegated', final: true })
  parent.handle.release({ kind: 'ended', attemptId, confirmed: true })
  const childId = await until(async () => (await row(ctx.db, 'SELECT child_run_id AS id FROM kipster.delegations WHERE parent_run_id=$1', [saved.runId]))?.id, Boolean, 'child run')
  return { parentId: saved.runId, childId }
}

/** Core delegates to ordinary agents only inside an organization context. */
async function orgDelegation(ctx, agentId) {
  await ctx.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.runtime.bootstrap.organizationId, agentId])
  const context = { kind: 'organization', organizationId: ctx.runtime.bootstrap.organizationId }
  const { chatId } = await resolveDirectChat(ctx.db, ctx.actor, context, ctx.runtime.bootstrap.rootAgentId)
  return { context, chatId }
}

test('agent-brain deletion removes owned rows and fences in-flight output at the provisioned check', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const agentId = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, settings, provisioned) VALUES ($1,$2,'Aux',$3,true)`, [agentId, ctx.actor.installationId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await ctx.runtime.home.provisionAgent(agentId)
  const org = await orgDelegation(ctx, agentId)
  const { parentId, childId } = await delegateChild(ctx, 'Summarize Helena hours', agentId, 'Summarize Helena hours', org)
  const child = await textExec(ctx, childId)
  child.handle.release({ kind: 'text', attemptId: child.context.attemptId, messageId: 'answer', text: 'The Helena office opens at three', final: true })
  child.handle.release({ kind: 'ended', attemptId: child.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, childId), s => s === 'completed', 'child completed')
  const parentAgain = await textExec(ctx, parentId, ctx.executions.findIndex(e => e.context.runId === parentId) + 1)
  parentAgain.handle.release({ kind: 'text', attemptId: parentAgain.context.attemptId, messageId: 'answer2', text: 'Done', final: true })
  parentAgain.handle.release({ kind: 'ended', attemptId: parentAgain.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, parentId), s => s === 'completed', 'parent completed')
  const manifest = await manifestOf(ctx, childId)
  assert.equal((await row(ctx.db, 'SELECT agent_id FROM kipster.maintenance_sources WHERE run_id=$1', [childId])).agent_id, agentId)
  assert.deepEqual(manifest.delegation, { delegation_id: (await row(ctx.db, 'SELECT id FROM kipster.delegations WHERE child_run_id=$1', [childId])).id, sender: ctx.runtime.bootstrap.rootAgentId, recipient: agentId })
  assert.equal(await commitSource(ctx, childId, 1, [candidateFor(answerEntry(manifest), 'The Helena office opens at three', 'Helena office opens', { subject: 'hours' })]), 'committed')
  // Independent org publication survives the brain wipe via SET NULL.
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Helena office opens at three'`)).id
  await ctx.runtime.memory.publish(agentId, ctx.runtime.bootstrap.organizationId, memoryId, 1)
  const purged = await ctx.db.transaction(async client => ctx.service.purgeAgentBrain(client, agentId))
  assert.deepEqual(purged, { removedRuns: 1, retainedRuns: 0 })
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND owner_id=$1`, [agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_candidate_claims WHERE owner_id=$1', [agentId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [childId]), 0)
  const publication = await row(ctx.db, `SELECT text, published_from FROM kipster.memory_records WHERE scope='organization' AND text='The Helena office opens at three'`)
  assert.equal(publication.text, 'The Helena office opens at three')
  assert.equal(publication.published_from, null)
  // In-flight work retains minimal execution evidence, then fences at the provisioned check.
  const second = await delegateChild(ctx, 'Summarize Inlet hours', agentId, 'Summarize Inlet hours', org)
  const child2 = await textExec(ctx, second.childId)
  child2.handle.release({ kind: 'text', attemptId: child2.context.attemptId, messageId: 'answer', text: 'The Inlet office opens at two', final: true })
  child2.handle.release({ kind: 'ended', attemptId: child2.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, second.childId), s => s === 'completed', 'child2 completed')
  const parent2Again = await textExec(ctx, second.parentId, ctx.executions.findIndex(e => e.context.runId === second.parentId) + 1)
  parent2Again.handle.release({ kind: 'text', attemptId: parent2Again.context.attemptId, messageId: 'answer2', text: 'Done', final: true })
  parent2Again.handle.release({ kind: 'ended', attemptId: parent2Again.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, second.parentId), s => s === 'completed', 'parent2 completed')
  const manifest2 = await manifestOf(ctx, second.childId)
  let inFlight = await nextMaintExec(ctx)
  while (inFlight.context.maintenance.sourceRunId !== second.childId) {
    // Dispose stale ready sources (e.g., the first-half parent) with empty cover.
    inFlight.handle.release(providerEvent(inFlight.context.attemptId))
    inFlight.handle.release({ kind: 'text', attemptId: inFlight.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [] }), final: true })
    inFlight.handle.release({ kind: 'ended', attemptId: inFlight.context.attemptId, confirmed: true })
    await maintRunSettled(ctx, inFlight.context.runId)
    inFlight = await nextMaintExec(ctx)
  }
  assert.equal(inFlight.context.maintenance.sourceRunId, second.childId)
  inFlight.handle.release(providerEvent(inFlight.context.attemptId))
  const held = await ctx.db.transaction(async client => {
    const result = await ctx.service.purgeAgentBrain(client, agentId)
    await client.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1', [agentId])
    return result
  })
  assert.deepEqual(held, { removedRuns: 0, retainedRuns: 1 })
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  inFlight.handle.release({ kind: 'text', attemptId: inFlight.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(answerEntry(manifest2), 'The Inlet office opens at two', 'Inlet office opens', { subject: 'hours' })] }), final: true })
  inFlight.handle.release({ kind: 'ended', attemptId: inFlight.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, second.childId, 1), 'fenced')
  assert.equal((await row(ctx.db, 'SELECT status_reason FROM kipster.maintenance_sources WHERE run_id=$1', [second.childId])).status_reason, 'agent unavailable')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  const purgedAgain = await ctx.db.transaction(async client => ctx.service.purgeAgentBrain(client, agentId))
  assert.deepEqual(purgedAgain, { removedRuns: 1, retainedRuns: 0 })
})

test('duplicates attach within a context while other contexts and subjects stay distinct', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const text = 'The Juneau office opens at one'
  let mark = ctx.executions.length
  const first = await completeTextRun(ctx, `Note: ${text}`)
  const manifest1 = await manifestOf(ctx, first.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest1.entries[0], text, 'Juneau office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, first.runId, 1), 'committed')
  mark = ctx.executions.length
  const second = await completeTextRun(ctx, `Note again: ${text}`)
  const manifest2 = await manifestOf(ctx, second.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest2.entries[0], text, 'Juneau office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, second.runId, 1), 'committed')
  const memories = (await ctx.db.query(`SELECT id FROM kipster.memory_records WHERE scope='agent' AND text=$1`, [text])).rows
  assert.equal(memories.length, 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memories[0].id]), 2)
  // Same text/author/subject in another organization is a distinct memory.
  const org2 = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.organizations(id, installation_id, display_name, provisioned) VALUES ($1,$2,'Second',true)`, [org2, ctx.actor.installationId])
  await ctx.db.query(`INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)`, [org2, ctx.runtime.bootstrap.rootAgentId])
  await ctx.db.query(`INSERT INTO kipster.human_memberships(organization_id, person_id) VALUES ($1,$2)`, [org2, ctx.actor.personId])
  await ctx.runtime.home.provisionOrganization(org2)
  const org2Context = { kind: 'organization', organizationId: org2 }
  const chat2 = (await resolveDirectChat(ctx.db, ctx.actor, org2Context, ctx.runtime.bootstrap.rootAgentId)).chatId
  mark = ctx.executions.length
  const third = await completeTextRun(ctx, `Org note: ${text}`, { context: org2Context, chatId: chat2 })
  const manifest3 = await manifestOf(ctx, third.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest3.entries[0], text, 'Juneau office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, third.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text=$1`, [text]), 2)
  // Same text/author/context with a different subject is distinct.
  mark = ctx.executions.length
  const fourth = await completeTextRun(ctx, `Subject note: ${text}`)
  const manifest4 = await manifestOf(ctx, fourth.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest4.entries[0], text, 'Juneau office opens', { subject: 'opening time' })])
  assert.equal(await sourceTerminal(ctx, fourth.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text=$1`, [text]), 3)
  // Global reads return all; maintenance writes agent scope only.
  const included = await ctx.runtime.memory.context(ctx.runtime.bootstrap.rootAgentId, null, 'Juneau office')
  assert.ok(included.join('\n').includes(text))
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='organization'`), 0)
})

test('first-person attribution follows the cited author, never the speaker', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'I live in Paris', { answer: 'I live in Paris' })
  const manifest = await manifestOf(ctx, saved.runId)
  const input = manifest.entries.find(e => e.author_class === 'human')
  const agent = manifest.entries.find(e => e.author_class === 'agent')
  assert.ok(input && agent)
  await driveMaintenance(ctx, mark, [
    candidateFor(input, 'I live in Paris', 'I live in Paris', { subject: 'residence' }),
    candidateFor(agent, 'I live in Paris', 'I live in Paris', { subject: 'residence' }),
  ])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memories = (await ctx.db.query(`SELECT id, text FROM kipster.memory_records WHERE scope='agent' AND text='I live in Paris'`)).rows
  assert.equal(memories.length, 2)
  // Delegation-child inputs assert the sender-agent class.
  const aux = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, settings, provisioned) VALUES ($1,$2,'Aux',$3,true)`, [aux, ctx.actor.installationId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await ctx.runtime.home.provisionAgent(aux)
  const org = await orgDelegation(ctx, aux)
  const { parentId, childId } = await delegateChild(ctx, 'Ask Aux', aux, 'Reply briefly', org)
  const child = await textExec(ctx, childId)
  child.handle.release({ kind: 'text', attemptId: child.context.attemptId, messageId: 'answer', text: 'Brief reply', final: true })
  child.handle.release({ kind: 'ended', attemptId: child.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, childId), s => s === 'completed', 'child completed')
  const childManifest = await manifestOf(ctx, childId)
  assert.equal(childManifest.entries[0].author_class, 'agent')
  assert.equal(childManifest.entries[0].author_id, ctx.runtime.bootstrap.rootAgentId)
  const parentAgain = await textExec(ctx, parentId, ctx.executions.findIndex(e => e.context.runId === parentId) + 1)
  parentAgain.handle.release({ kind: 'text', attemptId: parentAgain.context.attemptId, messageId: 'answer2', text: 'Done', final: true })
  parentAgain.handle.release({ kind: 'ended', attemptId: parentAgain.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, parentId), s => s === 'completed', 'parent completed')
  // A deleted author keeps the frozen class; existence is never required at commit.
  const person = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people(id, installation_id, display_name) VALUES ($1,$2,$3)', [person, ctx.actor.installationId, 'Ghost'])
  const authored = await completeTextRun(ctx, 'Ghost note for deletion')
  const authoredManifest = await manifestOf(ctx, authored.runId)
  const attemptId = (await row(ctx.db, 'SELECT current_attempt_id AS id FROM kipster.text_runs WHERE id=$1', [authored.runId])).id
  const ghostMessage = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.messages(id, thread_id, position, author_id, parts, final, source_attempt_id) VALUES ($1,$2,99,$3,$4::jsonb,true,$5)`,
    [ghostMessage, authored.threadId, person, JSON.stringify([{ kind: 'text', text: 'Ghost testifies' }]), attemptId])
  const allocated = await ctx.db.transaction(async client => ctx.service.allocateSource(client, ctx.runtime.jobs, authored.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, authored.threadId))
  assert.equal(allocated.created, true)
  await ctx.db.query('DELETE FROM kipster.people WHERE id=$1', [person])
  const ghostManifest = await manifestOf(ctx, authored.runId, allocated.revision)
  const ghost = ghostManifest.entries.find(e => e.message_id === ghostMessage)
  assert.equal(ghost.author_class, 'human')
  assert.equal(await commitSource(ctx, authored.runId, allocated.revision, [candidateFor(ghost, 'Ghost testifies', 'Ghost testifies', { subject: 'testimony' })]), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='Ghost testifies'`), 1)
})

test('maintenance never merges into manual memories and flags text overlap', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const manual = await ctx.runtime.memory.save(ctx.runtime.bootstrap.rootAgentId, 'fact', 'The Kiel office opens at noon', [{ authorId: ctx.actor.personId, subject: 'hours' }])
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Kiel office opens at noon')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The Kiel office opens at noon', 'Kiel office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memories = (await ctx.db.query(`SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Kiel office opens at noon' ORDER BY id`)).rows
  assert.equal(memories.length, 2)
  assert.ok(memories.some(m => m.id === manual.id))
  const maintained = memories.find(m => m.id !== manual.id)
  const claim = await row(ctx.db, 'SELECT manual_text_overlap FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [maintained.id])
  assert.equal(claim.manual_text_overlap, true)
  assert.equal((await row(ctx.db, 'SELECT text, revision FROM kipster.memory_records WHERE id=$1', [manual.id])).text, 'The Kiel office opens at noon')
})

test('corrected targets suppress re-extraction, historical manual text does not, and claim targets cannot be deleted', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Lima office opens at eleven')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The Lima office opens at eleven', 'Lima office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Lima office opens at eleven'`)).id
  await ctx.runtime.memory.correct(ctx.runtime.bootstrap.rootAgentId, memoryId, 1, 'The Lima office opens at midnight', [{ authorId: ctx.actor.personId, subject: 'hours' }])
  mark = ctx.executions.length
  const second = await completeTextRun(ctx, 'The Lima office opens at eleven')
  const manifest2 = await manifestOf(ctx, second.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest2.entries[0], 'The Lima office opens at eleven', 'Lima office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, second.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Lima office opens at eleven'`), 0)
  assert.equal((await row(ctx.db, 'SELECT revision FROM kipster.memory_records WHERE id=$1', [memoryId])).revision, '2')
  // Matching only historical manual text creates a new maintenance memory.
  const manual = await ctx.runtime.memory.save(ctx.runtime.bootstrap.rootAgentId, 'fact', 'The Mena office opens at dawn', [{ authorId: ctx.actor.personId, subject: 'hours' }])
  await ctx.runtime.memory.correct(ctx.runtime.bootstrap.rootAgentId, manual.id, 1, 'The Mena office opens at dusk', [{ authorId: ctx.actor.personId, subject: 'hours' }])
  mark = ctx.executions.length
  const third = await completeTextRun(ctx, 'The Mena office opens at dawn')
  const manifest3 = await manifestOf(ctx, third.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest3.entries[0], 'The Mena office opens at dawn', 'Mena office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, third.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Mena office opens at dawn'`), 1)
  // The claim foreign key keeps maintenance targets from being deleted underneath a claim.
  await assert.rejects(ctx.db.query('DELETE FROM kipster.memory_records WHERE id=$1', [memoryId]), /violates foreign key constraint/)
})

function canonicalForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalForTest(entry)}`).join(',')}}`
  return JSON.stringify(value)
}
/** White-box source revision over real messages. Setup only; the commit path stays real. */
async function fabricateSource(ctx, messageIds, agentId, contextKind, contextId, threadId, runId, revision = 2) {
  const { createHash } = await import('node:crypto')
  const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
  const entries = []
  for (const messageId of messageIds) {
    const msg = await row(ctx.db, 'SELECT position, revision, author_id, parts FROM kipster.messages WHERE id=$1', [messageId])
    const isPerson = await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.people WHERE id=$1', [msg.author_id])
    const isAgent = isPerson ? 0 : await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.agents WHERE id=$1', [msg.author_id])
    entries.push({ message_id: messageId, position: Number(msg.position), revision: Number(msg.revision), parts_sha256: sha(canonicalForTest(msg.parts)), author_id: msg.author_id, author_class: isPerson ? 'human' : isAgent ? 'agent' : 'unknown' })
  }
  const manifest = { version: 1, entries, excluded_over_cap: 0 }
  const hash = sha(canonicalForTest({ version: 1, entries, delegation: null }))
  await ctx.db.query(`INSERT INTO kipster.maintenance_sources(installation_id, run_id, source_revision, manifest_hash, manifest, agent_id, context_kind, context_id, source_thread_id, status) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'ready')`,
    [ctx.actor.installationId, runId, revision, hash, JSON.stringify(manifest), agentId, contextKind, contextId, threadId])
  return { manifest, hash, revision }
}

test('evidence caps hold per commit and per memory with overflow recorded', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const messageIds = []
  const runIds = []
  for (let i = 0; i < 9; i++) {
    const saved = await completeTextRun(ctx, `Naples note number ${i} with padding text to cite`)
    messageIds.push(saved.messageId)
    runIds.push(saved.runId)
  }
  const owner = ctx.runtime.bootstrap.rootAgentId
  const threadId = (await row(ctx.db, 'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [runIds[0]])).thread_id
  const runId = runIds[0]
  const { manifest } = await fabricateSource(ctx, messageIds, owner, 'installation', ctx.actor.installationId, threadId, runId)
  // Per-commit cap: 9 citations attach 8 receipts and record overflow without creating more.
  const citations = manifest.entries.map(e => ({ message_id: e.message_id, revision: e.revision, parts_hash: e.parts_sha256, excerpt: 'Naples note' }))
  const attempt = await commitSource(ctx, runId, 2, [{ kind: 'fact', text: 'Naples overflow fact', subject: 'overflow', author_id: manifest.entries[0].author_id, author_class: manifest.entries[0].author_class, citations }])
  assert.equal(attempt, 'committed')
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='Naples overflow fact'`)).id
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 8)
  assert.equal((await row(ctx.db, 'SELECT status FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [memoryId])).status, 'evidence_overflow')
  assert.equal((await row(ctx.db, 'SELECT evidence_overflow FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=2', [runId])).evidence_overflow, true)
  // Per-memory cap: the 33rd lifetime row is refused with overflow recorded and zero new memories.
  for (let i = 0; i < 24; i++) {
    await ctx.db.query(`INSERT INTO kipster.memory_provenance(id, memory_id, author_id, subject, source_message_id, source_message_revision) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), memoryId, ctx.actor.personId, 'overflow', randomUUID(), 1])
  }
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 32)
  const runId2 = runIds[1]
  await fabricateSource(ctx, messageIds.slice(0, 2), owner, 'installation', ctx.actor.installationId, threadId, runId2)
  const manifest2 = await manifestOf(ctx, runId2, 2)
  const citations2 = manifest2.entries.map(e => ({ message_id: e.message_id, revision: e.revision, parts_hash: e.parts_sha256, excerpt: 'Naples note' }))
  assert.equal(await commitSource(ctx, runId2, 2, [{ kind: 'fact', text: 'Naples overflow fact', subject: 'overflow', author_id: manifest2.entries[0].author_id, author_class: manifest2.entries[0].author_class, citations: citations2 }]), 'committed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 32)
  assert.equal((await row(ctx.db, 'SELECT evidence_overflow FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=2', [runId2])).evidence_overflow, true)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='Naples overflow fact'`), 1)
})

test('identical keys collapse within one output and attach across commits', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Oslo office opens at noon')
  const manifest = await manifestOf(ctx, saved.runId)
  const twice = candidateFor(manifest.entries[0], 'The Oslo office opens at noon', 'Oslo office opens', { subject: 'hours' })
  await driveMaintenance(ctx, mark, [twice, { ...twice }])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Oslo office opens at noon'`), 1)
  // Same key racing a second commit attaches duplicate evidence instead of creating.
  mark = ctx.executions.length
  const second = await completeTextRun(ctx, 'The Oslo office opens at noon again')
  const manifest2 = await manifestOf(ctx, second.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest2.entries[0], 'The Oslo office opens at noon', 'Oslo office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, second.runId, 1), 'committed')
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Oslo office opens at noon'`)).id
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 2)
  // Identical commit order reproduces the identical structure.
  mark = ctx.executions.length
  const third = await completeTextRun(ctx, 'The Porto office opens at noon')
  const manifest3 = await manifestOf(ctx, third.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest3.entries[0], 'The Porto office opens at noon', 'Porto office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, third.runId, 1), 'committed')
  mark = ctx.executions.length
  const fourth = await completeTextRun(ctx, 'The Porto office opens at noon again')
  const manifest4 = await manifestOf(ctx, fourth.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest4.entries[0], 'The Porto office opens at noon', 'Porto office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, fourth.runId, 1), 'committed')
  const portoId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Porto office opens at noon'`)).id
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [portoId]), 2)
  // Concurrent commits cannot race: at-most-one owner serializes claims.
  mark = ctx.executions.length
  const fifth = await completeTextRun(ctx, 'The Quito office opens at noon')
  await manifestOf(ctx, fifth.runId)
  const before = ctx.executions.length
  await sweep(ctx)
  await sweep(ctx)
  const running = await maintExec(ctx, mark)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(ctx.executions.slice(before).filter(e => e.context.kind === 'maintenance').length, 1)
  const attemptId = running.context.attemptId
  running.handle.release(providerEvent(attemptId))
  const manifest5 = await manifestOf(ctx, fifth.runId)
  running.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifest5.entries[0], 'The Quito office opens at noon', 'Quito office opens', { subject: 'hours' })] }), final: true })
  running.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, fifth.runId, 1), 'committed')
  // Stored maintenance text byte-equals its normalized key, including decomposed Unicode.
  const { createHash } = await import('node:crypto')
  const padded = 'Café \u0065\u0301 padded'
  mark = ctx.executions.length
  const normalized = await completeTextRun(ctx, `Note: ${padded} with excerpt context`)
  const normalizedManifest = await manifestOf(ctx, normalized.runId)
  await driveMaintenance(ctx, mark, [candidateFor(normalizedManifest.entries[0], `  ${padded}  `, padded.slice(0, 20), { subject: '  normalization  ' })])
  assert.equal(await sourceTerminal(ctx, normalized.runId, 1), 'committed')
  const normalizedMemory = await row(ctx.db, `SELECT id, text FROM kipster.memory_records WHERE scope='agent' AND text LIKE '%padded'`)
  const claim = await row(ctx.db, 'SELECT text_sha256 FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [normalizedMemory.id])
  const stored = normalizedMemory.text
  assert.equal(createHash('sha256').update(stored.normalize('NFC').trim(), 'utf8').digest('hex'), claim.text_sha256)
  assert.equal(stored, stored.normalize('NFC').trim())
  assert.ok(!stored.startsWith(' ') && !stored.endsWith(' '))
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function counterOf(ctx) {
  return Number((await row(ctx.db, 'SELECT maintenance_counter FROM kipster.execution_permits')).maintenance_counter)
}

test('a due reservation holds back text until maintenance commits, then held-back text runs without new submissions', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  for (let i = 0; i < 8; i++) await completeTextRun(ctx, `Fairness filler ${i}`)
  assert.equal(await counterOf(ctx), 8)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources'), 0)
  await setLearning(ctx, true)
  let mark = ctx.executions.length
  const runA = await completeTextRun(ctx, 'Fairness anchor')
  assert.equal(await counterOf(ctx), 9)
  const manifestA = await manifestOf(ctx, runA.runId)
  const queued = []
  for (let i = 0; i < 2; i++) queued.push(await submitText(ctx, `Saturating text ${i}`))
  const runB = queued[0].runId
  await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'claimed' || s === 'issued', 'source claimed')
  assert.equal((await row(ctx.db, 'SELECT reserved FROM kipster.maintenance_sources WHERE run_id=$1', [runA.runId])).reserved, true)
  await until(async () => (await runState(ctx, runB)) === 'queued' && (await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1 AND state=$2', [runB, 'settled'])) >= 1, Boolean, '9th text denied by reservation')
  assert.ok(!ctx.executions.some(e => e.context.runId === runB), 'denied text never reaches the provider')
  await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'issued', 'maintenance issued into reservation')
  assert.equal(await counterOf(ctx), 0)
  const maint = await maintExec(ctx, mark)
  const attemptId = maint.context.attemptId
  maint.handle.release(providerEvent(attemptId))
  maint.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifestA.entries[0], 'Fairness anchor fact', 'Fairness anchor', { subject: 'fairness' })] }), final: true })
  maint.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, runA.runId, 1), 'committed')
  // Releasing the maintenance permit alone must wake every held-back text; nothing new is submitted.
  const submitted = await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.text_runs')
  const targets = queued.map(q => q.runId)
  const driven = new Set()
  for (let i = 0; i < targets.length; i++) {
    const found = await until(() => ctx.executions.find(e => e.context.kind !== 'maintenance' && targets.includes(e.context.runId) && !driven.has(e)), Boolean, 'next denied text issues')
    driven.add(found)
    found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: 'Finally running', final: true })
    found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
    await until(async () => runState(ctx, found.context.runId), s => s === 'completed', 'denied text completes')
  }
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.text_runs'), submitted)
})

test('an unknown maintenance end retains capacity visibly until reconciliation releases held-back text', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  for (let i = 0; i < 8; i++) await completeTextRun(ctx, `Stall filler ${i}`)
  await setLearning(ctx, true)
  const mark = ctx.executions.length
  const runA = await completeTextRun(ctx, 'Stall anchor')
  const runB = (await submitText(ctx, 'Stalled text')).runId
  const maint = await maintExec(ctx, mark)
  maint.handle.release(providerEvent(maint.context.attemptId))
  maint.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'recovery', 'source recovery')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  await until(async () => (await runState(ctx, runB)) === 'queued' && (await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1', [runB])) >= 1, Boolean, 'text stalls')
  const runsBefore = await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs')
  await sweep(ctx)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs'), runsBefore)
  assert.equal(ctx.executions.slice(mark).filter(e => e.context.kind === 'maintenance').length, 1)
  const inspected = await operator.inspect({ connectionString: ctx.url.href, sourceRunId: runA.runId })
  assert.equal(inspected.status, 'recovery')
  assert.equal(inspected.runs[0].permitRetained, true)
  assert.equal(inspected.runs[0].state, 'recovery-needed')
  assert.ok(!ctx.executions.some(e => e.context.runId === runB))
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'reconcile-stalled', action: 'reconcile', target: { runId: inspected.runs[0].id } })
  await ctx.dispatchers[0].pumpMaintenance()
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits WHERE attempt_id=$1', [maint.context.attemptId]), 0)
  const stalled = await textExec(ctx, runB)
  stalled.handle.release({ kind: 'text', attemptId: stalled.context.attemptId, messageId: 'answer', text: 'Released', final: true })
  stalled.handle.release({ kind: 'ended', attemptId: stalled.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, runB), s => s === 'completed', 'stalled text completes after reconciliation')
})

test('slow preparation holds its reservation under repeated text admission', { skip: noDatabase }, async (t) => {
  const gate = deferred()
  const ctx = await setup(t, { maintenance: false, hooks: { afterMaintenanceClaim: async () => { await gate.promise } } })
  await ctx.dispatchers[0].start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=2')
  for (let i = 0; i < 8; i++) await completeTextRun(ctx, `Reservation filler ${i}`)
  await setLearning(ctx, true)
  let mark = ctx.executions.length
  const runA = await completeTextRun(ctx, 'Reservation anchor')
  const manifestA = await manifestOf(ctx, runA.runId)
  const runB = (await submitText(ctx, 'Reservation text B')).runId
  await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'claimed', 'maintenance claimed and blocked in prep')
  const handleB = await textExec(ctx, runB)
  assert.equal(await runState(ctx, runB), 'running')
  const runC = (await submitText(ctx, 'Reservation text C')).runId
  await until(async () => (await runState(ctx, runC)) === 'queued' && (await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1 AND state=$2', [runC, 'settled'])) >= 1, Boolean, 'second text denied while reserved')
  gate.resolve()
  await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'issued', 'maintenance issued into its reservation')
  assert.equal(await counterOf(ctx), 0)
  handleB.handle.release({ kind: 'text', attemptId: handleB.context.attemptId, messageId: 'answer', text: 'B done', final: true })
  handleB.handle.release({ kind: 'ended', attemptId: handleB.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, runB), s => s === 'completed', 'B completes')
  const maint = await maintExec(ctx, mark)
  const attemptId = maint.context.attemptId
  maint.handle.release(providerEvent(attemptId))
  maint.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifestA.entries[0], 'Reservation anchor fact', 'Reservation anchor', { subject: 'reservation' })] }), final: true })
  maint.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, runA.runId, 1), 'committed')
  const handleC = await textExec(ctx, runC)
  handleC.handle.release({ kind: 'text', attemptId: handleC.context.attemptId, messageId: 'answer', text: 'C done', final: true })
  handleC.handle.release({ kind: 'ended', attemptId: handleC.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, runC), s => s === 'completed', 'C completes after maintenance')
})

test('a failed preparation returns the claim to ready and charges one preparation try', { skip: noDatabase }, async (t) => {
  const gate = deferred()
  gate.promise.catch(() => undefined)
  const ctx = await setup(t, { hooks: { afterMaintenanceClaim: async () => { await gate.promise } } })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Restart prep anchor')
  await manifestOf(ctx, saved.runId)
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'claimed', 'claimed and blocked')
  gate.reject(new Error('simulated restart'))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
  assert.equal((await row(ctx.db, 'SELECT prep_failed_tries, tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).prep_failed_tries, 1)
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_runs WHERE source_run_id=$1`, [saved.runId])).state, 'failed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1 AND next_eligible_at > now()', [saved.runId]), 1)
  const { dispatcher } = addDispatcher(ctx)
  await dispatcher.start()
  await resetEligible(ctx, saved.runId)
  const manifest = await manifestOf(ctx, saved.runId)
  assert.equal(await commitSource(ctx, saved.runId, 1, [candidateFor(manifest.entries[0], 'Restart prep anchor fact', 'Restart prep anchor', { subject: 'restart' })]), 'committed')
  assert.equal((await row(ctx.db, 'SELECT tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).tries_total, 2)
  void dispatcher
})

test('an unknown end retains its permit, is visible to operators, and reconciles without automatic retry', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Quincy office opens at nine')
  const manifest = await manifestOf(ctx, saved.runId)
  const found = await maintExec(ctx, mark)
  ctx.handledMaint ??= new Set()
  ctx.handledMaint.add(found)
  found.handle.release(providerEvent(found.context.attemptId))
  found.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'recovery', 'source recovery')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs'), 1)
  assert.equal((await row(ctx.db, 'SELECT issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).issued_tries, 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  assert.equal((await row(ctx.db, 'SELECT recovery_impaired FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])).recovery_impaired, false)
  const listed = await operator.list({ connectionString: ctx.url.href, status: 'recovery' })
  assert.equal(listed.length, 1)
  const state = await operator.status({ connectionString: ctx.url.href })
  assert.equal(state.runs['recovery-needed'], 1)
  const runId = (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [saved.runId])).id
  const unknown = await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-unknown', action: 'reconcile', target: { runId } })
  assert.equal(unknown.duplicate, false)
  await dispatcher.pumpMaintenance()
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_runs WHERE id=$1`, [runId])).state, 'recovery-needed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-ended', action: 'reconcile', target: { runId } })
  await dispatcher.pumpMaintenance()
  assert.equal(await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'ready', 'retry ready after reconcile'), 'ready')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1 AND next_eligible_at > now()', [saved.runId]), 1)
  await resetEligible(ctx, saved.runId)
  assert.equal(await commitSource(ctx, saved.runId, 1, [candidateFor(manifest.entries[0], 'The Quincy office opens at nine', 'Quincy office opens', { subject: 'hours' })]), 'committed')
})

test('durable reconcile rejects incompatible recovery identities and flags generation upgrades', async (t) => {
  const { AdapterRegistry } = await import('../dist/workflows/adapter-registry.js')
  const { writeFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  const home = await mkdtemp(join(tmpdir(), 'kipster_maintenance-reg-'))
  const root = await mkdtemp(join(tmpdir(), 'kipster_maintenance-adapter-'))
  t.after(async () => { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) })
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'tests/.build/tests/fixtures/deterministic-adapter.js')).href
  await writeFile(join(root, 'entry.mjs'), `export { fixtureAdapter as createAdapter } from '${fixtureUrl}'\n`)
  const host = { now: () => new Date().toISOString(), invokeTool: async () => ({}) }
  const registry = new AdapterRegistry(host, home)
  t.after(async () => { await registry.close().catch(() => undefined) })
  const gen1 = await registry.register('deterministic-fixture', root, 'entry.mjs')
  assert.equal(gen1.readiness.catalog.capabilities.maintenance, true)
  const ref = { adapterId: 'deterministic-fixture', contractMajor: 1, recoveryVersion: 1, stateScope: 'shared-codex-home', generationId: gen1.generationId, digest: gen1.installationDigest, providerIds: { threadId: 't' } }
  assert.deepEqual(await registry.durableReconcile('deterministic-fixture', { ...ref, recoveryVersion: 99 }), { outcome: 'unknown', evidence: 'incompatible recovery identity', generationMismatch: false })
  assert.deepEqual(await registry.durableReconcile('deterministic-fixture', { ...ref, stateScope: 'elsewhere' }), { outcome: 'unknown', evidence: 'incompatible recovery identity', generationMismatch: false })
  await writeFile(join(root, 'entry.mjs'), `import { fixtureAdapter } from '${fixtureUrl}'\nexport function createAdapter(host) { const adapter = fixtureAdapter(host); adapter.reconcileScript.push('unknown', 'ended'); return adapter }\n`)
  const gen2 = await registry.register('deterministic-fixture', root, 'entry.mjs')
  assert.notEqual(gen2.generationId, gen1.generationId)
  const upgraded = await registry.durableReconcile('deterministic-fixture', ref)
  assert.equal(upgraded.outcome, 'unknown')
  assert.equal(upgraded.generationMismatch, true)
  // A compatible recovery version on a newer generation may confirm the end, with the upgrade flagged.
  assert.deepEqual(await registry.durableReconcile('deterministic-fixture', ref), { outcome: 'ended', evidence: 'fixture ended', generationMismatch: true })
  const textRoot = await mkdtemp(join(tmpdir(), 'kipster_maintenance-textonly-'))
  t.after(async () => { await rm(textRoot, { recursive: true, force: true }) })
  await writeFile(join(textRoot, 'entry.mjs'), `export function createAdapter(host) { void host; return { id: 'text-only', version: '1', contractMajor: 1, async readiness() { return { ready: true, catalog: { models: [{ id: 'm' }], capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false } } } }, async execute() { throw new Error('nope') }, async close() {} } }\n`)
  await registry.register('text-only', textRoot, 'entry.mjs')
  assert.equal(registry.selected('text-only', randomUUID(), 'maintenance'), undefined)
  const textRoute = registry.selected('text-only', randomUUID(), 'text')
  assert.ok(textRoute)
  textRoute.release(randomUUID())
})

test('repeated permit contention refunds the claim and consumes no try budget', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t, { maintenance: false })
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  const runA = await completeTextRun(ctx, 'Contention anchor')
  const runT = (await submitText(ctx, 'Permit holder')).runId
  const holder = await textExec(ctx, runT)
  assert.equal(await runState(ctx, runT), 'running')
  await setLearning(ctx, true)
  const threadId = (await row(ctx.db, 'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [runA.runId])).thread_id
  await ctx.db.transaction(async client => { await ctx.service.allocateSource(client, ctx.runtime.jobs, runA.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, threadId) })
  await ctx.db.query('UPDATE kipster.execution_permits SET maintenance_counter=8')
  // Exact result of repeated contention: the claim-time try is refunded, so budgets stay at zero
  // and the source remains claimable; only the 10s scheduling backoff is consumed.
  for (let expected = 1; expected <= 2; expected++) {
    if (expected > 1) await resetEligible(ctx, runA.runId)
    await until(async () => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs'), n => n === expected, `contention cycle ${expected}`)
    await until(async () => sourceStatus(ctx, runA.runId, 1), s => s === 'ready', `contention backoff ${expected}`)
    const current = await row(ctx.db, 'SELECT tries_total, prep_failed_tries, issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [runA.runId])
    assert.deepEqual([current.tries_total, current.prep_failed_tries, current.issued_tries], [0, 0, 0])
  }
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1 AND next_eligible_at > now()', [runA.runId]), 1)
  holder.handle.release({ kind: 'text', attemptId: holder.context.attemptId, messageId: 'answer', text: 'Released', final: true })
  holder.handle.release({ kind: 'ended', attemptId: holder.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, runT), s => s === 'completed', 'holder completes')
  await resetEligible(ctx, runA.runId)
  const manifestA = await manifestOf(ctx, runA.runId)
  assert.equal(await commitSource(ctx, runA.runId, 1, [candidateFor(manifestA.entries[0], 'Contention anchor fact', 'Contention anchor', { subject: 'contention' })]), 'committed')
  assert.equal((await row(ctx.db, 'SELECT issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [runA.runId])).issued_tries, 1)
  assert.equal((await row(ctx.db, 'SELECT tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [runA.runId])).tries_total, 1)
  void dispatcher
})

test('mixed wakeups, close fencing, profile serialization and tool denial', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  // Mixed wakeups route without drops: text id, sweep id and garbage are all consumed exactly once.
  const saved = await completeTextRun(ctx, 'Routing probe')
  await manifestOf(ctx, saved.runId)
  await ctx.db.transaction(async client => {
    await ctx.runtime.jobs.send(client, saved.runId)
    await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    await ctx.runtime.jobs.send(client, randomUUID())
  })
  await until(async () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster_jobs.job WHERE name='dispatch' AND state='completed'`), n => n >= 4, 'wakeups consumed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster_jobs.job WHERE name='dispatch' AND state='failed'`), 0)
  assert.equal(await commitSource(ctx, saved.runId, 1, []), 'committed')
  // Joint close fences owned issued maintenance with the permit retained.
  const mark = ctx.executions.length
  const live = await completeTextRun(ctx, 'Close fence probe')
  const running = await maintExec(ctx, mark)
  ctx.handledMaint ??= new Set()
  ctx.handledMaint.add(running)
  await until(async () => sourceStatus(ctx, live.runId, 1), s => s === 'issued', 'maintenance issued')
  running.handle.release(providerEvent(running.context.attemptId))
  await dispatcher.close()
  ctx.dispatchers.splice(0, 1)
  assert.equal(await sourceStatus(ctx, live.runId, 1), 'recovery')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  const { dispatcher: dispatcher2 } = addDispatcher(ctx)
  await dispatcher2.start()
  void running
  // Later probes need a clear maintenance owner: reconcile the fenced run, then skip its retry.
  const liveRunId = (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [live.runId])).id
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-reconcile-live', action: 'reconcile', target: { runId: liveRunId } })
  await dispatcher2.pumpMaintenance()
  await until(async () => sourceStatus(ctx, live.runId, 1), s => s === 'ready', 'live reconciled to ready')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-skip-live', action: 'skip-source', target: { sourceRunId: live.runId, sourceRevision: 1 } })
  await dispatcher2.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, live.runId, 1), 'skipped')
  // Profile activation serializes against the maintenance commit in lock order.
  const { Client } = await import('pg')
  const blocker = new Client({ connectionString: ctx.url.href })
  await blocker.connect()
  // Client.end() resolves after the socket closes, before the database is dropped.
  ctx.cleanups.push(() => blocker.end())
  let blockerReleased = false
  ctx.cleanups.push(async () => { if (!blockerReleased) { await blocker.query('ROLLBACK'); blockerReleased = true } })
  await blocker.query('BEGIN')
  await blocker.query('SELECT generation FROM kipster.memory_profiles WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
  const blocked = await completeTextRun(ctx, 'Serialization probe')
  const blockedManifest = await manifestOf(ctx, blocked.runId)
  const held = await nextMaintExec(ctx)
  assert.equal(held.context.maintenance.sourceRunId, blocked.runId)
  held.handle.release(providerEvent(held.context.attemptId))
  held.handle.release({ kind: 'text', attemptId: held.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(blockedManifest.entries[0], 'Serialization probe fact', 'Serialization probe', { subject: 'locks' })] }), final: true })
  held.handle.release({ kind: 'ended', attemptId: held.context.attemptId, confirmed: true })
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(await sourceStatus(ctx, blocked.runId, 1), 'issued')
  await blocker.query('COMMIT')
  blockerReleased = true
  assert.equal(await sourceTerminal(ctx, blocked.runId, 1), 'committed')
  const generation = Number((await row(ctx.db, 'SELECT generation FROM kipster.memory_profiles WHERE installation_id=$1', [ctx.actor.installationId])).generation)
  const activated = await ctx.runtime.memory.activateRebuild(ctx.actor.personId, generation, { ...profile, model: 'fixture-embedding-v2', async embed() { return [0, 1] } })
  assert.equal(activated, generation + 1)
  // Text-field leakage is rejected pre-routing; every maintenance tool call is denied with zero side effects.
  const { AdapterRegistry } = await import('../dist/workflows/adapter-registry.js')
  const { writeFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  const regHome = await mkdtemp(join(tmpdir(), 'kipster_maintenance-reg-'))
  const regRoot = await mkdtemp(join(tmpdir(), 'kipster_maintenance-adapter-'))
  t.after(async () => { await rm(regHome, { recursive: true, force: true }); await rm(regRoot, { recursive: true, force: true }) })
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'tests/.build/tests/fixtures/deterministic-adapter.js')).href
  await writeFile(join(regRoot, 'entry.mjs'), `import { fixtureAdapter } from '${fixtureUrl}'; export function createAdapter(host) { return { ...fixtureAdapter(host), id: 'leak-probe' } }\n`)
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), invokeTool: async () => ({}) }, regHome)
  t.after(async () => { await registry.close().catch(() => undefined) })
  await registry.register('leak-probe', regRoot, 'entry.mjs')
  const attemptId = randomUUID()
  const route = registry.selected('leak-probe', attemptId, 'maintenance')
  assert.ok(route)
  route.release(attemptId)
  const denied = await completeTextRun(ctx, 'Denial probe')
  const deniedManifest = await manifestOf(ctx, denied.runId)
  void deniedManifest
  const calls = await nextMaintExec(ctx)
  await assert.rejects(calls.handle.callTool('tool-1', 'memory.save', { kind: 'fact', text: 'smuggled', provenance: [] }), /Maintenance tools denied/)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='smuggled'`), 0)
  calls.handle.release(providerEvent(calls.context.attemptId))
  calls.handle.release({ kind: 'text', attemptId: calls.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [] }), final: true })
  calls.handle.release({ kind: 'ended', attemptId: calls.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, denied.runId, 1), 'committed')
  void dispatcher2
})

test('maintenance stays idle until learning is on, and switching it off fences in-flight work and skips claimed work', { skip: noDatabase }, async (t) => {
  const gate = deferred()
  gate.promise.catch(() => undefined)
  const ctx = await setup(t, { maintenance: false, hooks: { afterMaintenanceClaim: async () => { await gate.promise } } })
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  await completeTextRun(ctx, 'Disabled probe one')
  await completeTextRun(ctx, 'Disabled probe two')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs'), 0)
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
  await setLearning(ctx, true)
  let mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'Enabled probe')
  const manifest = await manifestOf(ctx, saved.runId)
  gate.resolve()
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'Enabled probe fact', 'Enabled probe', { subject: 'opt-in' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  // Switch off with an issued attempt in flight: it runs to terminal, is fenced at commit and releases.
  mark = ctx.executions.length
  const live = await completeTextRun(ctx, 'Disable in-flight probe')
  const liveManifest = await manifestOf(ctx, live.runId)
  const running = await maintExec(ctx, mark)
  await until(async () => sourceStatus(ctx, live.runId, 1), s => s === 'issued', 'issued before disable')
  await setLearning(ctx, false)
  const nextRevisionGate = deferred()
  t.after(() => nextRevisionGate.resolve())
  dispatcher.hooks = { afterMaintenanceClaim: id => id === live.runId ? nextRevisionGate.promise : Promise.resolve() }
  running.handle.release(providerEvent(running.context.attemptId))
  running.handle.release({ kind: 'text', attemptId: running.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(liveManifest.entries[0], 'Disable in-flight fact', 'Disable in-flight probe', { subject: 'opt-out' })] }), final: true })
  running.handle.release({ kind: 'ended', attemptId: running.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, live.runId, 1), 'fenced')
  assert.equal((await row(ctx.db, 'SELECT status_reason FROM kipster.maintenance_sources WHERE run_id=$1', [live.runId])).status_reason, 'learning_disabled')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope=$1 AND text=$2', ['agent', 'Disable in-flight fact']), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  // Claimed-unissued work is skipped at the issue fence without a provider call.
  await setLearning(ctx, true)
  const gate2 = deferred()
  gate2.promise.catch(() => undefined)
  dispatcher.hooks = { afterMaintenanceClaim: async () => { await gate2.promise } }
  const pending = await completeTextRun(ctx, 'Disable at issue probe')
  await manifestOf(ctx, pending.runId)
  await until(async () => sourceStatus(ctx, pending.runId, 1), s => s === 'claimed', 'claimed and blocked')
  const before = ctx.executions.filter(e => e.context.kind === 'maintenance').length
  await setLearning(ctx, false)
  gate2.resolve()
  await until(async () => sourceStatus(ctx, pending.runId, 1), s => s === 'skipped', 'skipped at issue')
  const refused = await row(ctx.db, 'SELECT status_reason, issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [pending.runId])
  assert.deepEqual([refused.status_reason, refused.issued_tries], ['learning_disabled', 0])
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, before)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  // Operator actions still run while learning is off; a skipped source stays skipped.
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-skip', action: 'skip-source', target: { sourceRunId: pending.runId, sourceRevision: 1 } })
  await dispatcher.pumpMaintenance()
  assert.equal((await row(ctx.db, "SELECT state FROM kipster.maintenance_operator_intents WHERE op_id='op-skip'")).state, 'done')
  assert.equal(await sourceStatus(ctx, pending.runId, 1), 'skipped')
})

test('sources are enqueued once per completed run and never for failed, cancelled or uncertain runs', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const aux = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.agents(id, installation_id, display_name, settings, provisioned) VALUES ($1,$2,'Aux',$3,true)`, [aux, ctx.actor.installationId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await ctx.runtime.home.provisionAgent(aux)
  const org = await orgDelegation(ctx, aux)
  const { parentId, childId } = await delegateChild(ctx, 'Parent work', aux, 'Child work', org)
  const child = await textExec(ctx, childId)
  child.handle.release({ kind: 'text', attemptId: child.context.attemptId, messageId: 'answer', text: 'Child done', final: true })
  child.handle.release({ kind: 'ended', attemptId: child.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, childId), s => s === 'completed', 'child completed')
  const parentAgain = await textExec(ctx, parentId, ctx.executions.findIndex(e => e.context.runId === parentId) + 1)
  parentAgain.handle.release({ kind: 'text', attemptId: parentAgain.context.attemptId, messageId: 'answer2', text: 'Parent done', final: true })
  parentAgain.handle.release({ kind: 'ended', attemptId: parentAgain.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, parentId), s => s === 'completed', 'parent completed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [parentId]), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [childId]), 1)
  assert.equal((await row(ctx.db, 'SELECT agent_id FROM kipster.maintenance_sources WHERE run_id=$1', [childId])).agent_id, aux)
  const failed = await submitText(ctx, 'Failing work')
  const failing = await textExec(ctx, failed.runId)
  failing.handle.release({ kind: 'failed', attemptId: failing.context.attemptId, confirmedEnded: true, message: 'provider failed' })
  await until(async () => runState(ctx, failed.runId), s => s === 'failed', 'run failed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [failed.runId]), 0)
  const doomed = await delegateChild(ctx, 'Doomed parent', aux, 'Doomed child', org)
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  const { cancelDelegationTree } = await import('../dist/modules/work/public.js')
  await ctx.db.transaction(async client => { await cancelDelegationTree(client, doomed.parentId) })
  assert.equal(await runState(ctx, doomed.childId), 'cancelled')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [doomed.childId]), 0)
  const { dispatcher: reopened } = addDispatcher(ctx)
  await reopened.start()
  void reopened
  const lost = await submitText(ctx, 'Lost work')
  const losing = await textExec(ctx, lost.runId)
  losing.handle.abortUnknown()
  await until(async () => runState(ctx, lost.runId), s => s === 'recovery-needed', 'run recovery')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [lost.runId]), 0)
})

test('each try resolves current settings and receives least-privilege extraction input', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Freshness probe')
  await setLearning(ctx, true)
  await ctx.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ctx.runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'missing-adapter', modelId: 'missing-model' })])
  const threadId = (await row(ctx.db, 'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [saved.runId])).thread_id
  await ctx.db.transaction(async client => { await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, threadId) })
  await manifestOf(ctx, saved.runId)
  await until(async () => {
    const current = await row(ctx.db, 'SELECT status, prep_failed_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])
    return current.status === 'ready' && current.prep_failed_tries === 1 ? true : false
  }, Boolean, 'first try fails preparation on missing adapter')
  await ctx.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ctx.runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const mark = ctx.executions.length
  await resetEligible(ctx, saved.runId)
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'Freshness probe fact', 'Freshness probe', { subject: 'freshness' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const maint = ctx.executions.slice(mark).find(e => e.context.kind === 'maintenance')
  assert.deepEqual(Object.keys(maint.context).sort(), ['agentId', 'attemptGeneration', 'attemptId', 'incarnation', 'kind', 'maintenance', 'organizationId', 'runId'])
  const { MAINTENANCE_INSTRUCTIONS_V1 } = await import('../dist/modules/memory/public.js')
  assert.ok(maint.context.maintenance.instructions.startsWith(MAINTENANCE_INSTRUCTIONS_V1))
  assert.ok(maint.context.maintenance.instructions.includes('Freshness probe'))
  assert.ok(maint.context.maintenance.instructions.includes('"candidates"'))
  for (const source of maint.context.maintenance.sources) {
    assert.deepEqual(Object.keys(source).sort(), ['authorClass', 'authorId', 'messageId', 'partsHash', 'position', 'revision', 'text'])
  }
  assert.deepEqual(maint.context.maintenance.settings, { adapterId: 'deterministic-fixture', modelId: 'fixture-model' })
})

test('a candidate built only from the extraction prompt passes validation', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Oslo office closes at five')
  const found = await maintExec(ctx, mark)
  const header = /^--- message_id=(\S+) revision=(\d+) parts_hash=(\S+) author_id=(\S+) author_class=(\S+) position=\d+ ---\n(.+)$/m
  const [, messageId, revision, partsHash, authorId, authorClass, text] = header.exec(found.context.maintenance.instructions)
  const attemptId = found.context.attemptId
  const candidate = { kind: 'fact', text, subject: 'office hours', author_id: authorId, author_class: authorClass, citations: [{ message_id: messageId, revision: Number(revision), parts_hash: partsHash, excerpt: text }] }
  found.handle.release(providerEvent(attemptId))
  found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidate] }), final: true })
  found.handle.release({ kind: 'ended', attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text=$1`, ['The Oslo office closes at five']), 1)
})

test('validation writes nothing for unchanged sources, skips superseded revisions and revives one matching current content', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'Validation probe')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'Validation probe fact', 'Validation probe', { subject: 'epochs' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const before = await row(ctx.db, 'SELECT updated_at FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])
  const tick = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(tick.repaired, 0)
  const after = await row(ctx.db, 'SELECT updated_at FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])
  assert.equal(new Date(after.updated_at).getTime(), new Date(before.updated_at).getTime())
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), 1)
  // A superseded revision is skipped even though its frozen manifest no longer matches.
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [manifest.entries[0].message_id, JSON.stringify([{ kind: 'text', text: 'Validation probe edited' }])])
  const repair = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(repair.repaired, 1)
  await ctx.db.query(`UPDATE kipster.maintenance_sources SET status='superseded' WHERE run_id=$1 AND source_revision=2`, [saved.runId])
  // Superseded rows are excluded from validation. The current content matches superseded rev2, which becomes eligible again.
  const revived = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(revived.validated, 1, 'superseded revision is not validated')
  assert.equal(revived.repaired, 1)
  assert.notEqual(await sourceStatus(ctx, saved.runId, 2), 'superseded')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), 2)
})

test('an embedding outage keeps the canonical commit, lexical recall and a pending index intent', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  ctx.embed.fail = true
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The Reno office opens at eight')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The Reno office opens at eight', 'Reno office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The Reno office opens at eight'`)).id
  assert.equal((await row(ctx.db, 'SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1', [memoryId])).status, 'pending')
  const lexical = await ctx.runtime.memory.context(ctx.runtime.bootstrap.rootAgentId, null, 'Reno office')
  assert.ok(lexical.join('\n').includes('The Reno office opens at eight'))
  ctx.embed.fail = false
  const indexed = await ctx.runtime.memory.indexPending(10, true)
  assert.ok(indexed.ready >= 1)
  assert.equal((await row(ctx.db, 'SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1', [memoryId])).status, 'ready')
})

test('lease expiry, switching learning off and supersession are fenced at issue and commit', { skip: noDatabase }, async (t) => {
  const gate = deferred()
  gate.promise.catch(() => undefined)
  const ctx = await setup(t, { hooks: { afterMaintenanceClaim: async () => { await gate.promise } } })
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  // Expired lease at issue refuses and resets with prep-failure accounting and zero permits.
  const saved = await completeTextRun(ctx, 'Expiry race probe')
  await manifestOf(ctx, saved.runId)
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'claimed', 'claimed and blocked')
  await ctx.db.query(`UPDATE kipster.maintenance_sources SET claim_lease_until=now()-($1||' milliseconds')::interval WHERE run_id=$2`, ['1000', saved.runId])
  gate.resolve()
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'ready', 'expired claim reset')
  const expired = await row(ctx.db, 'SELECT tries_total, prep_failed_tries, issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])
  assert.deepEqual([expired.tries_total, expired.prep_failed_tries, expired.issued_tries], [1, 1, 0])
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
  // Switching learning off before issue skips the claimed source and every pending one.
  const gate2 = deferred()
  gate2.promise.catch(() => undefined)
  dispatcher.hooks = { afterMaintenanceClaim: async () => { await gate2.promise } }
  const pending = await completeTextRun(ctx, 'Disable race probe')
  await manifestOf(ctx, pending.runId)
  await until(async () => sourceStatus(ctx, pending.runId, 1), s => s === 'claimed', 'second claim blocked')
  await setLearning(ctx, false)
  gate2.resolve()
  await until(async () => sourceStatus(ctx, pending.runId, 1), s => s === 'skipped', 'claim skipped at issue')
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'skipped', 'pending source skipped at claim')
  const refused = await row(ctx.db, 'SELECT issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [pending.runId])
  assert.equal(refused.issued_tries, 0)
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
  await setLearning(ctx, true)
  // Supersession while issued flags the old revision, holds its permit, and never double-runs the provider.
  dispatcher.hooks = {}
  const mark = ctx.executions.length
  const live = await completeTextRun(ctx, 'Supersede race probe')
  const liveManifest = await manifestOf(ctx, live.runId)
  let running = await nextMaintExec(ctx)
  for (let i = 0; running.context.maintenance.sourceRunId !== live.runId && i < 12; i++) {
    running.handle.release(providerEvent(running.context.attemptId))
    running.handle.release({ kind: 'text', attemptId: running.context.attemptId, messageId: 'output', final: true, text: JSON.stringify({ candidates: [] }) })
    running.handle.release({ kind: 'ended', attemptId: running.context.attemptId, confirmed: true })
    await maintRunSettled(ctx, running.context.runId)
    running = await nextMaintExec(ctx)
  }
  assert.equal(running.context.maintenance.sourceRunId, live.runId)
  await until(async () => sourceStatus(ctx, live.runId, 1), s => s === 'issued', 'issued before supersession')
  const maintBefore = ctx.executions.filter(e => e.context.kind === 'maintenance').length
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [liveManifest.entries[0].message_id, JSON.stringify([{ kind: 'text', text: 'Supersede race probe edited' }])])
  const threadId = (await row(ctx.db, 'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [live.runId])).thread_id
  await ctx.db.transaction(async client => { await ctx.service.allocateSource(client, ctx.runtime.jobs, live.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, threadId) })
  assert.equal((await row(ctx.db, 'SELECT invalidated FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=1', [live.runId])).invalidated, true)
  assert.equal(await sourceStatus(ctx, live.runId, 1), 'issued')
  await sweep(ctx)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, maintBefore)
  const nextRevisionGate = deferred()
  t.after(() => nextRevisionGate.resolve())
  dispatcher.hooks = { afterMaintenanceClaim: id => id === live.runId ? nextRevisionGate.promise : Promise.resolve() }
  running.handle.release(providerEvent(running.context.attemptId))
  running.handle.release({ kind: 'text', attemptId: running.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(liveManifest.entries[0], 'Supersede race fact', 'Supersede race probe', { subject: 'races' })] }), final: true })
  running.handle.release({ kind: 'ended', attemptId: running.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, live.runId, 1), 'fenced')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  const fresh = await manifestOf(ctx, live.runId, 2)
  nextRevisionGate.resolve()
  dispatcher.hooks = {}
  assert.equal(await commitSource(ctx, live.runId, 2, [candidateFor(fresh.entries[0], 'Supersede race probe edited', 'Supersede race probe edited', { subject: 'races' })]), 'committed')
  // Uncertain-source repair inserts but cannot claim until reconcile resolves.
  const uncertain = await completeTextRun(ctx, 'Uncertain repair probe')
  await manifestOf(ctx, uncertain.runId)
  let doomed = null
  for (let i = 0; i < 4 && !doomed; i++) {
    const candidate = await nextMaintExec(ctx)
    if (candidate.context.maintenance.sourceRunId === uncertain.runId) {
      doomed = candidate
    } else {
      candidate.handle.release(providerEvent(candidate.context.attemptId))
      candidate.handle.release({ kind: 'text', attemptId: candidate.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [] }), final: true })
      candidate.handle.release({ kind: 'ended', attemptId: candidate.context.attemptId, confirmed: true })
    }
  }
  assert.ok(doomed)
  doomed.handle.release(providerEvent(doomed.context.attemptId))
  doomed.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, uncertain.runId, 1), s => s === 'recovery', 'uncertain source')
  const bumpId = (await manifestOf(ctx, uncertain.runId)).entries[0].message_id
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [bumpId, JSON.stringify([{ kind: 'text', text: 'Uncertain repair probe edited' }])])
  const repaired = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.ok(repaired.repaired >= 1)
  assert.equal(await sourceStatus(ctx, uncertain.runId, 2), 'ready')
  await sweep(ctx)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(await sourceStatus(ctx, uncertain.runId, 2), 'ready')
  ctx.inner.reconcileScript.push('ended')
  const recoveryId = (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1 AND source_revision=1`, [uncertain.runId])).id
  await setLearning(ctx, false)
  await ctx.service.requestAction('op-reconcile', 'reconcile', { runId: recoveryId })
  await dispatcher.pumpMaintenance()
  await until(async () => sourceStatus(ctx, uncertain.runId, 1), s => s === 'fenced', 'invalidated old revision fences on confirmation')
  await until(async () => sourceStatus(ctx, uncertain.runId, 2), s => s === 'skipped', 'pending revision skipped while learning is off')
})

test('output events: recovery reference first, staged final, missing reference, stream drop and double final', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  // Provider reference arrives first and persists before any output.
  let mark = ctx.executions.length
  const first = await completeTextRun(ctx, 'The Tampa office opens at nine')
  const manifest1 = await manifestOf(ctx, first.runId)
  const one = await maintExec(ctx, mark)
  one.handle.release(providerEvent(one.context.attemptId))
  await until(async () => (await row(ctx.db, 'SELECT provider_metadata FROM kipster.attempts WHERE id=$1', [one.context.attemptId])).provider_metadata?.threadId, Boolean, 'provider metadata persisted')
  const ref1 = (await row(ctx.db, 'SELECT recovery_ref FROM kipster.maintenance_runs WHERE source_run_id=$1', [first.runId])).recovery_ref
  assert.equal(ref1.providerIds.threadId, 'fixture-thread')
  assert.equal(ref1.stateScope, 'shared-codex-home')
  // A single final stages without committing until the terminal event.
  one.handle.release({ kind: 'text', attemptId: one.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifest1.entries[0], 'The Tampa office opens at nine', 'Tampa office opens', { subject: 'hours' })] }), final: true })
  await until(async () => (await row(ctx.db, 'SELECT staged_output FROM kipster.maintenance_runs WHERE source_run_id=$1', [first.runId])).staged_output?.candidates?.length, n => n === 1, 'output staged')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`), 0)
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_runs WHERE source_run_id=$1`, [first.runId])).state, 'running')
  one.handle.release({ kind: 'ended', attemptId: one.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, first.runId, 1), 'committed')
  // Confirmed end without a prior ref settles with the missing-ref flag.
  mark = ctx.executions.length
  const second = await completeTextRun(ctx, 'The Utica office opens at nine')
  const manifest2 = await manifestOf(ctx, second.runId)
  const two = await maintExec(ctx, mark)
  two.handle.release({ kind: 'text', attemptId: two.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifest2.entries[0], 'The Utica office opens at nine', 'Utica office opens', { subject: 'hours' })] }), final: true })
  two.handle.release({ kind: 'ended', attemptId: two.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, second.runId, 1), 'committed')
  assert.equal((await row(ctx.db, `SELECT recovery_ref_missing FROM kipster.maintenance_runs WHERE source_run_id=$1`, [second.runId])).recovery_ref_missing, true)
  // A second final text event is bounded invalid output, not a second result.
  mark = ctx.executions.length
  const fourth = await completeTextRun(ctx, 'The Waco office opens at nine')
  const manifest4 = await manifestOf(ctx, fourth.runId)
  const four = await maintExec(ctx, mark)
  four.handle.release(providerEvent(four.context.attemptId))
  four.handle.release({ kind: 'text', attemptId: four.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidateFor(manifest4.entries[0], 'The Waco office opens at nine', 'Waco office opens', { subject: 'hours' })] }), final: true })
  four.handle.release({ kind: 'text', attemptId: four.context.attemptId, messageId: 'output2', text: JSON.stringify({ candidates: [] }), final: true })
  four.handle.release({ kind: 'ended', attemptId: four.context.attemptId, confirmed: true })
  await until(async () => sourceStatus(ctx, fourth.runId, 1), s => s === 'ready', 'double-final bounded failure')
  assert.equal((await row(ctx.db, `SELECT failure FROM kipster.maintenance_runs WHERE source_run_id=$1 ORDER BY created_at DESC LIMIT 1`, [fourth.runId])).failure, 'multiple_final_results')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent' AND text='The Waco office opens at nine'`), 0)
  // Stream drop without a ref goes unknown with the permit retained and recovery impaired.
  // Recovery blocks later claims by design, so this section runs last.
  mark = ctx.executions.length
  const third = await completeTextRun(ctx, 'The Vigo office opens at nine')
  await manifestOf(ctx, third.runId)
  const three = await maintExec(ctx, mark)
  three.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, third.runId, 1), s => s === 'recovery', 'drop recovery')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits WHERE attempt_id=$1', [three.context.attemptId]), 1)
  assert.equal((await row(ctx.db, `SELECT recovery_impaired FROM kipster.maintenance_runs WHERE source_run_id=$1`, [third.runId])).recovery_impaired, true)
})

test('operator intents are idempotent, reaped, safely re-issued and bounded by reconcile deadlines', { skip: noDatabase }, async (t) => {
  const previousLimits = { reconcileMs: MAINTENANCE_LIMITS.reconcileMs }
  Object.assign(MAINTENANCE_LIMITS, { reconcileMs: 250 })
  t.after(() => Object.assign(MAINTENANCE_LIMITS, previousLimits))
  const ctx = await setup(t)
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  const saved = await completeTextRun(ctx, 'Intent probe')
  await manifestOf(ctx, saved.runId)
  const first = await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-skip', action: 'skip-source', target: { sourceRunId: saved.runId, sourceRevision: 1 } })
  const again = await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-skip', action: 'skip-source', target: { sourceRunId: saved.runId, sourceRevision: 1 } })
  assert.deepEqual([first.duplicate, again.duplicate], [false, true])
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.maintenance_operator_intents WHERE op_id='op-skip'`), 1)
  await dispatcher.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'skipped')
  // Crash between validate and settle reaps to pending at most 3 times, then orphans.
  const installationId = ctx.actor.installationId
  await ctx.db.query(`INSERT INTO kipster.maintenance_operator_intents(installation_id, op_id, action, source_run_id, state, lease_until, executions) VALUES ($1,'op-reap','skip-source',$2,'executing',now()-($3||' milliseconds')::interval,1)`, [installationId, saved.runId, '1000'])
  await ctx.db.query(`INSERT INTO kipster.maintenance_operator_intents(installation_id, op_id, action, source_run_id, state, lease_until, executions) VALUES ($1,'op-orphan','skip-source',$2,'executing',now()-($3||' milliseconds')::interval,4)`, [installationId, saved.runId, '1000'])
  const reaped = await ctx.db.transaction(async client => ctx.service.reapIntents(client))
  assert.deepEqual(reaped, { reaped: 1, orphaned: 1 })
  // Re-issued cancel is bounded and side-effect-safe: confirmed cancel fences once, then conflicts.
  const mark = ctx.executions.length
  const live = await completeTextRun(ctx, 'Cancel probe')
  await manifestOf(ctx, live.runId)
  const running = await maintExec(ctx, mark)
  ctx.handledMaint ??= new Set()
  ctx.handledMaint.add(running)
  await until(async () => sourceStatus(ctx, live.runId, 1), s => s === 'issued', 'issued for cancel')
  running.handle.cancel = async () => ({ acknowledged: true, confirmedEnded: true })
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-cancel-1', action: 'cancel', target: { runId: (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [live.runId])).id } })
  await dispatcher.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, live.runId, 1), 'fenced')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-cancel-2', action: 'cancel', target: { runId: (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [live.runId])).id } })
  await dispatcher.pumpMaintenance()
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_operator_intents WHERE op_id='op-cancel-2'`)).state, 'rejected')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE source_run_id=$1`, [live.runId]), 1)
  // A timed-out reconcile call terminalizes nothing: unknown with the reservation preserved.
  const stuck = await completeTextRun(ctx, 'Hang probe')
  await manifestOf(ctx, stuck.runId)
  const hanging = await nextMaintExec(ctx)
  assert.equal(hanging.context.maintenance.sourceRunId, stuck.runId)
  hanging.handle.release(providerEvent(hanging.context.attemptId))
  hanging.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, stuck.runId, 1), s => s === 'recovery', 'hang recovery')
  ctx.inner.reconcileScript.push('hang')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'op-hang', action: 'reconcile', target: { runId: (await row(ctx.db, `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1`, [stuck.runId])).id } })
  await dispatcher.pumpMaintenance()
  assert.ok(ctx.inner.reconcileCalls.length > 0)
  assert.equal((await row(ctx.db, `SELECT result FROM kipster.maintenance_operator_intents WHERE op_id='op-hang'`)).result.unknown, 'reconcile timed out')
  assert.equal((await row(ctx.db, `SELECT state FROM kipster.maintenance_operator_intents WHERE op_id='op-hang'`)).state, 'done')
  assert.equal(await sourceStatus(ctx, stuck.runId, 1), 'recovery')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  assert.ok((await row(ctx.db, `SELECT last_reconcile_attempt FROM kipster.maintenance_runs WHERE source_run_id=$1`, [stuck.runId])).last_reconcile_attempt)
})

test('the repair budget is FIFO across ticks and worker deadlines persist progress', { skip: noDatabase }, async t => {
  const previousLimits = { repairInsertsPerEpoch: MAINTENANCE_LIMITS.repairInsertsPerEpoch, scannerValidatePage: MAINTENANCE_LIMITS.scannerValidatePage }
  Object.assign(MAINTENANCE_LIMITS, { repairInsertsPerEpoch: 2, scannerValidatePage: 2 })
  t.after(() => Object.assign(MAINTENANCE_LIMITS, previousLimits))
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const runs = []
  for (let i = 0; i < 3; i++) runs.push(await completeTextRun(ctx, `Budget probe ${i}`))
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  // White-box terminal history: sources are real canonical run manifests; no
  // concurrently executing provider can race this scanner-only budget fixture.
  await capacityTx(ctx, async client => {
    for (const run of runs) await ctx.service.allocateSource(client, ctx.runtime.jobs, run.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, run.threadId, false)
    await client.query("UPDATE kipster.maintenance_sources SET status='committed'")
  })
  await ctx.db.query("UPDATE kipster.messages SET revision=revision+1 WHERE id IN (SELECT input_message_id FROM kipster.text_runs)")
  const tick1 = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(tick1.repaired, 2)
  const expected = runs.map(r => r.runId).sort().slice(0, 2)
  const repaired = (await ctx.db.query('SELECT run_id FROM kipster.maintenance_sources GROUP BY run_id HAVING count(*)=2')).rows.map(r => r.run_id).sort()
  assert.deepEqual(repaired, expected)
  const restarted = new MaintenanceService(ctx.db, ctx.actor.installationId)
  assert.equal((await restarted.tickScanner(ctx.runtime.jobs)).repaired, 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources'), 6)
  assert.equal((await restarted.tickScanner(ctx.runtime.jobs)).repaired, 0)
  await ctx.db.query("UPDATE kipster.messages SET revision=revision+1 WHERE id IN (SELECT input_message_id FROM kipster.text_runs)")
  await ctx.db.query("UPDATE kipster.maintenance_scheduler SET last_run_id=NULL,last_source_revision=NULL,repair_inserts_used=0")
  let calls = 0
  const jump = () => Date.now() + (++calls > 2 ? 130000 : 0)
  const cut = await restarted.tickScanner(ctx.runtime.jobs, jump)
  assert.equal(cut.pages, 1)
  const progress = await row(ctx.db, 'SELECT last_run_id,last_source_revision FROM kipster.maintenance_scheduler')
  assert.ok(progress.last_run_id && progress.last_source_revision)
  const afterRestart = new MaintenanceService(ctx.db, ctx.actor.installationId)
  await afterRestart.tickScanner(ctx.runtime.jobs)
  await afterRestart.tickScanner(ctx.runtime.jobs)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources'), 9)
  assert.equal((await afterRestart.tickScanner(ctx.runtime.jobs)).repaired, 0)
})

test('evidence receipts stay unique across redelivery and unchanged revisions', { skip: noDatabase }, async (t) => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const mark = ctx.executions.length
  const saved = await completeTextRun(ctx, 'The York office opens at nine')
  const manifest = await manifestOf(ctx, saved.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest.entries[0], 'The York office opens at nine', 'York office opens', { subject: 'hours' })])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  const memoryId = (await row(ctx.db, `SELECT id FROM kipster.memory_records WHERE scope='agent' AND text='The York office opens at nine'`)).id
  // Redelivery after the commit ack re-settles to a no-op.
  const attempt = await row(ctx.db, 'SELECT id, intent_id, generation, incarnation FROM kipster.attempts WHERE intent_id=(SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1)', [saved.runId])
  const resettled = await ctx.db.transaction(async client => {
    await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.actor.installationId])
    await client.query('SELECT ceiling FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
    return ctx.service.settleMaintenance(client, ctx.runtime.jobs, { id: attempt.id, intentId: attempt.intent_id, generation: Number(attempt.generation), incarnation: attempt.incarnation, state: 'settled' }, attempt.incarnation, { kind: 'extract' })
  })
  assert.equal(resettled.outcome, 'noop')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 1)
  // Same evidence from a new revision no-ops while bumped evidence adds exactly one row.
  const entries = (await manifestOf(ctx, saved.runId)).entries
  const input = entries[0]
  const agent = entries.find(e => e.message_id !== input.message_id)
  await ctx.db.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [agent.message_id, JSON.stringify([{ kind: 'text', text: 'York answer edited' }])])
  const repaired = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.ok(repaired.repaired >= 1)
  const fresh = await manifestOf(ctx, saved.runId, 2)
  const sameInput = fresh.entries.find(e => e.message_id === input.message_id)
  assert.equal(sameInput.revision, input.revision)
  const bumpedAgent = fresh.entries.find(e => e.message_id === agent.message_id)
  const candidate = candidateFor(sameInput, 'The York office opens at nine', 'York office opens', { subject: 'hours' })
  assert.ok(bumpedAgent.revision > agent.revision)
  assert.equal(await commitSource(ctx, saved.runId, 2, [candidate]), 'committed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 1, 'unchanged human evidence is a receipt no-op')
  await ctx.db.query('UPDATE kipster.messages SET revision=revision+1 WHERE id=$1', [input.message_id])
  assert.equal((await ctx.service.tickScanner(ctx.runtime.jobs)).repaired, 1)
  const bumped = (await manifestOf(ctx, saved.runId, 3)).entries.find(e => e.message_id === input.message_id)
  assert.equal(await commitSource(ctx, saved.runId, 3, [candidateFor(bumped, 'The York office opens at nine', 'York office opens', { subject: 'hours' })]), 'committed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId]), 2)
})

async function capacityTx(ctx, work) {
  return ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
    return work(client)
  })
}
async function crashSeed(t) {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Crash checkpoint anchor')
  ctx.executions.length = 0 // Seed text execution precedes the crash/restart observation window.
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  const threadId = (await row(ctx.db, 'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [saved.runId])).thread_id
  await capacityTx(ctx, client => ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, threadId))
  return { ctx, saved }
}
async function killAtCheckpoint(t, ctx, phase) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [join(process.cwd(), 'tests/fixtures/maintenance-crash.mjs'), phase, ctx.url.href, ctx.home], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let checkpoint
  let output = ''
  child.on('message', message => { checkpoint = message.stage })
  child.stdout.on('data', data => { output = (output + data).slice(-8192) })
  child.stderr.on('data', data => { output = (output + data).slice(-8192) })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await until(() => ({ checkpoint, dead: child.exitCode !== null, output }), value => {
    if (value.dead) throw new Error(`Fixture died before ${phase}: ${value.output}`)
    return value.checkpoint === phase
  }, `process checkpoint ${phase}`)
  child.kill('SIGKILL')
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' })
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'owned process is gone')
}

async function reopenCrashRuntime(ctx, enabled = true) {
  await ctx.runtime.close()
  ctx.runtime = await openRuntime({ connectionString: ctx.url.href, home: ctx.home, embedding: { ...profile, async embed() { return [1, 0] } } })
  await ctx.runtime.memory.stopIndexing()
  await setLearning(ctx, enabled)
  ctx.db = ctx.runtime.db
  ctx.service = new MaintenanceService(ctx.db, ctx.actor.installationId)
}

test('SIGKILL during unissued preparation resets the run without refunding its claim', { skip: noDatabase }, async t => {
  const { ctx, saved } = await crashSeed(t)
  await killAtCheckpoint(t, ctx, 'claim')
  const before = await row(ctx.db, 'SELECT id,current_attempt_id FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
  await reopenCrashRuntime(ctx)
  const gate = deferred()
  const { dispatcher } = addDispatcher(ctx, { afterStartupRecovery: () => gate.promise })
  const starting = dispatcher.start()
  await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [before.id])).state, state => state === 'queued', 'startup resets run')
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
  assert.equal((await row(ctx.db, 'SELECT state,current_attempt_id FROM kipster.maintenance_runs WHERE id=$1', [before.id])).state, 'queued')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.deepEqual(Object.values(await row(ctx.db, 'SELECT tries_total,prep_failed_tries,issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])), [1, 0, 0])
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.attempts WHERE id=$1', [before.current_attempt_id])).state, 'settled')
  gate.resolve()
  await starting
  const found = await maintExec(ctx)
  assert.equal(found.context.runId, before.id, 'same logical run, new fenced attempt')
  assert.notEqual(found.context.attemptId, before.current_attempt_id)
  assert.equal(found.context.attemptGeneration, 2)
  await driveMaintenance(ctx, 0, [])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.equal((await row(ctx.db, 'SELECT tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).tries_total, 2)
})

test('SIGKILL after provider evidence retains capacity until compatible confirmation', { skip: noDatabase }, async t => {
  const { ctx, saved } = await crashSeed(t)
  await killAtCheckpoint(t, ctx, 'provider')
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])).state, 'running')
  await reopenCrashRuntime(ctx)
  const { dispatcher } = addDispatcher(ctx)
  await dispatcher.start()
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'recovery')
  const uncertain = await row(ctx.db, 'SELECT id,recovery_ref,permit_retained FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
  assert.equal(uncertain.permit_retained, true)
  assert.equal(uncertain.recovery_ref.providerIds.threadId, 'fixture-crash')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  assert.equal(ctx.executions.length, 0, 'no auto-reexecution')
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'crash-reconcile', action: 'reconcile', target: { runId: uncertain.id } })
  await dispatcher.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('SIGKILL after commit and before acknowledgement keeps one receipt on redelivery', { skip: noDatabase }, async t => {
  const { ctx, saved } = await crashSeed(t)
  await killAtCheckpoint(t, ctx, 'commit')
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'committed')
  const memory = await row(ctx.db, "SELECT id FROM kipster.memory_records WHERE text='Crash proof retained fact'")
  assert.ok(memory)
  await reopenCrashRuntime(ctx)
  const { dispatcher } = addDispatcher(ctx)
  await dispatcher.start()
  await sweep(ctx)
  await sweep(ctx)
  const tick = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(tick.repaired, 0)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(ctx.executions.length, 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1', [memory.id]), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_candidate_claims WHERE memory_id=$1', [memory.id]), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('SIGKILL after an operator intent claim reaps and applies the operation once', { skip: noDatabase }, async t => {
  const { ctx, saved } = await crashSeed(t)
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'crash-intent', action: 'skip-source', target: { sourceRunId: saved.runId } })
  await killAtCheckpoint(t, ctx, 'intent')
  assert.equal((await row(ctx.db, "SELECT state FROM kipster.maintenance_operator_intents WHERE op_id='crash-intent'")).state, 'executing')
  await ctx.db.query("UPDATE kipster.maintenance_operator_intents SET lease_until=now()-interval '1 second' WHERE op_id='crash-intent'")
  await reopenCrashRuntime(ctx, false)
  const { dispatcher } = addDispatcher(ctx)
  await dispatcher.start()
  await dispatcher.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'skipped')
  assert.equal((await row(ctx.db, "SELECT state FROM kipster.maintenance_operator_intents WHERE op_id='crash-intent'")).state, 'done')
  const duplicate = await operator.requestAction({ connectionString: ctx.url.href, opId: 'crash-intent', action: 'skip-source', target: { sourceRunId: saved.runId } })
  assert.equal(duplicate.duplicate, true)
  assert.equal(await dispatcher.pumpMaintenance(), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('the final charged claim keeps its reservation through preparation, then held-back text runs', { skip: noDatabase }, async t => {
  const gate = deferred()
  const ctx = await setup(t, { maintenance: false, hooks: { afterMaintenanceClaim: () => gate.promise } })
  t.after(() => gate.resolve())
  await ctx.dispatchers[0].start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  const saved = await completeTextRun(ctx, 'Final charged claim')
  await setLearning(ctx, true)
  await capacityTx(ctx, async client => {
    await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId)
    // Two failed preparations, one ended issue and one interrupted claim.
    await client.query('UPDATE kipster.maintenance_sources SET tries_total=4, prep_failed_tries=2, issued_tries=1 WHERE run_id=$1', [saved.runId])
    await client.query('UPDATE kipster.execution_permits SET maintenance_counter=8')
  })
  await until(async () => sourceStatus(ctx, saved.runId, 1), value => value === 'claimed', 'fifth claim held')
  assert.equal((await row(ctx.db, 'SELECT tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).tries_total, 5)
  const text = await submitText(ctx, 'Must leave final permit reserved')
  await until(async () => count(ctx.db, "SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1 AND state='settled'", [text.runId]), n => n > 0, 'text admission denied')
  assert.ok(!ctx.executions.some(e => e.context.runId === text.runId))
  assert.equal(await capacityTx(ctx, client => ctx.service.maintenanceDue(client)), true)
  gate.resolve()
  await driveMaintenance(ctx, 0, [])
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.deepEqual(Object.values(await row(ctx.db, 'SELECT tries_total,prep_failed_tries,issued_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])), [5, 2, 2])
  const denied = await textExec(ctx, text.runId)
  denied.handle.release({ kind: 'text', attemptId: denied.context.attemptId, messageId: 'answer', text: 'Admitted after maintenance', final: true })
  denied.handle.release({ kind: 'ended', attemptId: denied.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, text.runId), s => s === 'completed', 'denied text completes after maintenance')
})

test('a direct adapter without declared maintenance capability fails closed', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const readiness = await ctx.inner.readiness()
  ctx.adapter.readiness = async () => ({ ...readiness, catalog: { ...readiness.catalog, capabilities: { ...readiness.catalog.capabilities, maintenance: false } } })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Text still works')
  await until(async () => (await row(ctx.db, 'SELECT prep_failed_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]))?.prep_failed_tries, value => value === 1, 'unsupported preparation failure')
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
})

test('an unknown attempt releases only after confirmation and is not retried once learning is off', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  const saved = await completeTextRun(ctx, 'Invalidated recovery source')
  const found = await maintExec(ctx)
  found.handle.release(providerEvent(found.context.attemptId))
  found.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, saved.runId, 1), value => value === 'recovery', 'unknown retained')
  await setLearning(ctx, false)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'invalidated-ended', action: 'reconcile', target: { runId: found.context.runId } })
  await dispatcher.pumpMaintenance()
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
  await sweep(ctx)
  await until(async () => sourceStatus(ctx, saved.runId, 1), value => value === 'skipped', 'retry skipped at claim')
  await setLearning(ctx, true)
  await sweep(ctx)
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'skipped')
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 1)
})

test('a target corrected back to identical text accepts duplicate support', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const text = 'Restored exact claim'
  const first = await completeTextRun(ctx, text)
  const manifest = await manifestOf(ctx, first.runId)
  await driveMaintenance(ctx, 0, [candidateFor(manifest.entries[0], text, text)])
  await sourceTerminal(ctx, first.runId, 1)
  const memory = await row(ctx.db, 'SELECT id,revision FROM kipster.memory_records WHERE text=$1', [text])
  await ctx.runtime.memory.correct(ctx.runtime.bootstrap.rootAgentId, memory.id, 1, 'Temporary manual correction', [{ authorId: ctx.actor.personId, subject: 'manual correction' }])
  await ctx.runtime.memory.correct(ctx.runtime.bootstrap.rootAgentId, memory.id, 2, text, [{ authorId: ctx.actor.personId, subject: 'manual correction' }])
  const mark = ctx.executions.length
  const second = await completeTextRun(ctx, text)
  const manifest2 = await manifestOf(ctx, second.runId)
  await driveMaintenance(ctx, mark, [candidateFor(manifest2.entries[0], text, text)])
  assert.equal(await sourceTerminal(ctx, second.runId, 1), 'committed')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE text=$1', [text]), 1)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE memory_id=$1 AND source_message_id IS NOT NULL', [memory.id]), 2)
  assert.equal((await row(ctx.db, 'SELECT revision FROM kipster.memory_records WHERE id=$1', [memory.id])).revision, '3')
})

test('the scanner tuple cursor pages through more than fifty revisions of one run', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Tuple cursor source')
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  const input = (await row(ctx.db, 'SELECT input_message_id FROM kipster.text_runs WHERE id=$1', [saved.runId])).input_message_id
  for (let revision = 1; revision <= 55; revision++) {
    await ctx.db.query('UPDATE kipster.messages SET revision=$2 WHERE id=$1', [input, revision])
    await capacityTx(ctx, async client => {
      await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId, false)
      await client.query("UPDATE kipster.maintenance_sources SET status='committed' WHERE run_id=$1", [saved.runId])
    })
  }
  const old = (await ctx.db.query('SELECT source_revision,manifest_hash FROM kipster.maintenance_sources ORDER BY source_revision')).rows
  assert.equal(old.length, 55)
  await ctx.db.query('UPDATE kipster.messages SET revision=56 WHERE id=$1', [input])
  await ctx.db.query("INSERT INTO kipster.maintenance_scheduler(installation_id) VALUES ($1) ON CONFLICT (installation_id) DO UPDATE SET last_run_id=NULL,last_source_revision=NULL,repair_inserts_used=0", [ctx.actor.installationId])
  const tick = await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(tick.repaired, 1)
  assert.equal(tick.validated, 56, 'tuple paging continues within the same run')
  assert.equal(tick.pages, 2)
  assert.deepEqual((await ctx.db.query('SELECT source_revision,manifest_hash FROM kipster.maintenance_sources WHERE source_revision<=55 ORDER BY source_revision')).rows, old)
  assert.equal((await row(ctx.db, 'SELECT max(source_revision)::int AS n FROM kipster.maintenance_sources')).n, 56)
  assert.equal((await new MaintenanceService(ctx.db, ctx.actor.installationId).tickScanner(ctx.runtime.jobs)).repaired, 0)
})

test('scanner pages roll back at PostgreSQL lock, statement and transaction deadlines', { skip: noDatabase }, async t => {
  const previousLimits = { lockMs: MAINTENANCE_LIMITS.lockMs, statementMs: MAINTENANCE_LIMITS.statementMs, pageTxMs: MAINTENANCE_LIMITS.pageTxMs }
  Object.assign(MAINTENANCE_LIMITS, { lockMs: 200, statementMs: 500, pageTxMs: 900 })
  t.after(() => Object.assign(MAINTENANCE_LIMITS, previousLimits))
  for (const kind of ['lock', 'statement', 'transaction']) await t.test(kind, async t => {
    const ctx = await setup(t, { maintenance: false })
    await ctx.db.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [ctx.actor.installationId])
    const original = ctx.db.transaction.bind(ctx.db)
    let release, held
    let blocker
    if (kind === 'lock') {
      const locked = new Promise(resolve => held = resolve)
      const gate = new Promise(resolve => release = resolve)
      blocker = original(async client => {
        await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
        held()
        await gate
      })
      await locked
    } else {
      ctx.db.transaction = callback => original(client => callback({ query: async (sql, args) => {
        if (sql.startsWith('SELECT 1 FROM kipster.execution_permits')) {
          if (kind === 'transaction') await client.query('SET LOCAL statement_timeout=0')
          await client.query('SELECT pg_sleep(2)')
        }
        return client.query(sql, args)
      } }))
    }
    const started = Date.now()
    try { await assert.rejects(ctx.service.tickScanner(ctx.runtime.jobs), /timeout|terminat|connection|closed/i) }
    finally { ctx.db.transaction = original; release?.(); await blocker }
    const elapsed = Date.now() - started
    assert.ok(elapsed >= (kind === 'lock' ? 150 : kind === 'statement' ? 450 : 850), `${kind} actual deadline elapsed ${elapsed}`)
    assert.ok(elapsed < 5000)
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
    assert.equal((await ctx.service.tickScanner(ctx.runtime.jobs)).repaired, 0, 'page can resume after rollback')
  })
})

test('operator skip refuses live and uncertain attempts without releasing capacity', { skip: noDatabase }, async t => {
  let gate, entered
  const claimed = new Promise(resolve => entered = resolve)
  const barrier = new Promise(resolve => gate = resolve)
  const ctx = await setup(t, { hooks: { afterMaintenanceIssue: async () => { entered(); await barrier } } })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Issue versus skip')
  await claimed
  const skip = await capacityTx(ctx, client => ctx.service.skipSource(client, ctx.runtime.jobs, saved.runId, 1))
  assert.match(skip.conflict, /active or uncertain/)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  gate()
  const exec = await maintExec(ctx)
  exec.handle.release(providerEvent(exec.context.attemptId))
  exec.handle.abortUnknown()
  await until(() => sourceStatus(ctx, saved.runId, 1), status => status === 'recovery', 'uncertain issue')
  const retained = await capacityTx(ctx, client => ctx.service.skipSource(client, ctx.runtime.jobs, saved.runId, 1))
  assert.match(retained.conflict, /active or uncertain/)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  await setLearning(ctx, false)
  const run = await row(ctx.db, 'SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
  ctx.inner.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'skip-race-reconcile', action: 'reconcile', target: { runId: run.id } })
  await ctx.dispatchers[0].pumpMaintenance()
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('registered maintenance issue pins generation, runner incarnation, digest and root', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Generation pin source')
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  const { AdapterRegistry } = await import('../dist/workflows/adapter-registry.js')
  const { writeFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  const root = await mkdtemp(join(tmpdir(), 'kipster_maintenance-pin-'))
  ctx.cleanups.push(async () => rm(root, { recursive: true, force: true }))
  const fixtureUrl = pathToFileURL(join(process.cwd(), 'tests/.build/tests/fixtures/deterministic-adapter.js')).href
  await writeFile(join(root, 'entry.mjs'), `import { fixtureAdapter } from '${fixtureUrl}';
export function createAdapter(host) { const adapter = fixtureAdapter(host); return { ...adapter, async execute(context) {
const handle = await adapter.execute(context); const attemptId = context.attemptId;
handle.release({ kind:'provider', attemptId, threadId:'pin-fixture', processId:process.pid, providerStateScope:'shared-codex-home', workingDirectory:'/tmp/pin-fixture', modelId:'fixture-model' });
handle.release({ kind:'text', attemptId, messageId:'output', final:true, text:'{"candidates":[]}' });
handle.release({ kind:'ended', attemptId, confirmed:true }); return handle; } } }
`)
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), invokeTool: async () => ({}) }, ctx.home)
  const generation = await registry.register('deterministic-fixture', root, 'entry.mjs')
  const probeId = randomUUID()
  const selected = registry.selected('deterministic-fixture', probeId, 'maintenance')
  assert.ok(selected)
  const pinnedRoot = selected.installationRoot
  selected.release(probeId)
  assert.notEqual(pinnedRoot, root, 'execution pins the immutable installation snapshot')
  ctx.cleanups.push(() => registry.close())
  let pinned
  const dispatcher = new TextDispatcher(ctx.runtime, registry, undefined, { afterMaintenanceIssue: async runId => {
    pinned = await row(ctx.db, "SELECT adapter_id,adapter_generation_id,runner_incarnation,adapter_installation_digest,adapter_installation_root FROM kipster.attempts WHERE intent_id=$1 AND state='issued'", [runId])
  } })
  ctx.dispatchers.push(dispatcher)
  await setLearning(ctx, true)
  await capacityTx(ctx, client => ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId))
  await dispatcher.start()
  await until(() => sourceStatus(ctx, saved.runId, 1), status => status === 'committed', 'registered issue commit')
  assert.deepEqual(pinned, { adapter_id: 'deterministic-fixture', adapter_generation_id: generation.generationId, runner_incarnation: generation.incarnation, adapter_installation_digest: generation.installationDigest, adapter_installation_root: pinnedRoot })
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('malformed output, zero or unsupported events, invalid identity text and author mismatch are bounded failures', { skip: noDatabase }, async t => {
  for (const kind of ['malformed', 'zero-final', 'unsupported-event', 'invalid-identity', 'nul-identity', 'author-mismatch']) await t.test(kind, async t => {
    const ctx = await setup(t)
    await ctx.dispatchers[0].start()
    const saved = await completeTextRun(ctx, 'Validation anchor fact')
    const manifest = await manifestOf(ctx, saved.runId)
    const exec = await maintExec(ctx)
    exec.handle.release(providerEvent(exec.context.attemptId))
    const candidate = candidateFor(manifest.entries[0], 'Validation anchor fact', 'Validation anchor', { subject: 'validation' })
    if (kind === 'invalid-identity') candidate.text = '\ud800'
    if (kind === 'nul-identity') candidate.text = '\0'
    if (kind === 'author-mismatch') candidate.author_id = ctx.runtime.bootstrap.rootAgentId
    if (kind === 'unsupported-event') exec.handle.release({ kind: 'progress', attemptId: exec.context.attemptId })
    if (kind !== 'zero-final') exec.handle.release({ kind: 'text', attemptId: exec.context.attemptId, messageId: 'output', final: true, text: kind === 'malformed' ? '{broken' : JSON.stringify({ candidates: [candidate] }) })
    exec.handle.release({ kind: 'ended', attemptId: exec.context.attemptId, confirmed: true })
    await until(() => sourceStatus(ctx, saved.runId, 1), status => status === 'ready', 'invalid output retry budget')
    const failed = await row(ctx.db, 'SELECT failure,failure_class FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
    assert.equal(failed.failure_class, 'invalid_output')
    const expected = { 'zero-final': 'zero_final_result', 'unsupported-event': 'unsupported_event', 'author-mismatch': 'citation_author_mismatch' }
    assert.equal(failed.failure, expected[kind] ?? 'malformed_output')
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records'), 0)
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
    assert.equal((await row(ctx.db, 'SELECT issued_tries,tries_total FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).issued_tries, 1)
  })
})

test('handshake rejection and late completion retain capacity without a late commit or unhandled rejection', { skip: noDatabase }, async t => {
  const previousLimits = { executeHandshakeMs: MAINTENANCE_LIMITS.executeHandshakeMs }
  Object.assign(MAINTENANCE_LIMITS, { executeHandshakeMs: 250 })
  t.after(() => Object.assign(MAINTENANCE_LIMITS, previousLimits))
  for (const kind of ['reject', 'late']) await t.test(kind, async t => {
    const ctx = await setup(t)
    const execute = ctx.adapter.execute.bind(ctx.adapter)
    const gate = deferred()
    let lateHandle
    ctx.adapter.execute = async context => {
      if (context.kind !== 'maintenance') return execute(context)
      if (kind === 'reject') throw new Error('fixture handshake failure')
      await gate.promise
      lateHandle = await execute(context)
      return lateHandle
    }
    const unhandled = []
    const observe = error => unhandled.push(error)
    process.on('unhandledRejection', observe)
    t.after(() => process.off('unhandledRejection', observe))
    await ctx.dispatchers[0].start()
    const saved = await completeTextRun(ctx, 'Handshake anchor')
    await until(() => sourceStatus(ctx, saved.runId, 1), status => status === 'recovery', 'handshake unknown')
    if (kind === 'late') assert.equal(lateHandle, undefined, 'the real deadline fires while execute is still pending')
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
    assert.equal((await row(ctx.db, 'SELECT recovery_impaired FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])).recovery_impaired, true)
    if (kind === 'late') {
      gate.resolve()
      await until(() => lateHandle, Boolean, 'late handle returned')
      const execution = ctx.executions.find(e => e.context.kind === 'maintenance')
      lateHandle.release(providerEvent(execution.context.attemptId))
      lateHandle.release({ kind: 'text', attemptId: execution.context.attemptId, messageId: 'late', final: true, text: '{"candidates":[]}' })
      lateHandle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(await sourceStatus(ctx, saved.runId, 1), 'recovery')
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records'), 0)
    assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
    assert.deepEqual(unhandled, [])
  })
})

test('held-back text resumes after a failed preparation or a confirmed cancel releases maintenance capacity', { skip: noDatabase }, async t => {
  const gate = deferred()
  gate.promise.catch(() => undefined)
  const ctx = await setup(t, { maintenance: false, hooks: { afterMaintenanceClaim: () => gate.promise } })
  const dispatcher = ctx.dispatchers[0]
  await dispatcher.start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  const saved = await completeTextRun(ctx, 'Held-back anchor')
  await setLearning(ctx, true)
  await capacityTx(ctx, async client => {
    await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId)
    await client.query('UPDATE kipster.execution_permits SET maintenance_counter=8')
  })
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'claimed', 'reserved claim in preparation')
  const first = await submitText(ctx, 'Held back by preparation')
  await until(async () => count(ctx.db, "SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1 AND state='settled'", [first.runId]), n => n > 0, 'text held back by the reservation')
  assert.ok(!ctx.executions.some(e => e.context.runId === first.runId))
  gate.reject(new Error('fixture preparation failure'))
  const resumed = await textExec(ctx, first.runId)
  resumed.handle.release({ kind: 'text', attemptId: resumed.context.attemptId, messageId: 'answer', text: 'Resumed', final: true })
  resumed.handle.release({ kind: 'ended', attemptId: resumed.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, first.runId), s => s === 'completed', 'text completes after failed preparation')
  assert.equal((await row(ctx.db, 'SELECT prep_failed_tries FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId])).prep_failed_tries, 1)
  // A running maintenance attempt holds the only permit until a confirmed cancel.
  dispatcher.hooks = {}
  const mark = ctx.executions.length
  await resetEligible(ctx, saved.runId)
  const running = await maintExec(ctx, mark)
  const runningSource = running.context.maintenance.sourceRunId
  await until(async () => sourceStatus(ctx, runningSource, 1), s => s === 'issued', 'maintenance holds the permit')
  const second = await submitText(ctx, 'Held back by running maintenance')
  await until(async () => count(ctx.db, "SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1 AND state='settled'", [second.runId]), n => n > 0, 'text held back by capacity')
  running.handle.cancel = async () => ({ acknowledged: true, confirmedEnded: true })
  await ctx.service.requestAction('cancel-running', 'cancel', { runId: running.context.runId })
  await dispatcher.pumpMaintenance()
  assert.equal(await sourceStatus(ctx, runningSource, 1), 'fenced')
  const after = await textExec(ctx, second.runId)
  after.handle.release({ kind: 'text', attemptId: after.context.attemptId, messageId: 'answer', text: 'Resumed', final: true })
  after.handle.release({ kind: 'ended', attemptId: after.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, second.runId), s => s === 'completed', 'text completes after cancel')
})

test('a failing timer tick is reported without rejecting, skips idle work, never overlaps, and close waits for it', { skip: noDatabase }, async t => {
  const failures = []
  // The observer throws once, then rejects: neither may escape the coordinator.
  const maintenanceFailed = error => {
    failures.push(error)
    if (failures.length === 1) throw new Error('observer threw')
    return Promise.reject(new Error('observer rejected'))
  }
  const ctx = await setup(t, { maintenance: false, hooks: { maintenanceFailed } })
  const unhandled = []
  const observe = error => unhandled.push(error)
  process.on('unhandledRejection', observe)
  process.on('uncaughtException', observe)
  t.after(() => { process.off('unhandledRejection', observe); process.off('uncaughtException', observe) })
  const dispatcher = ctx.dispatchers[0]
  await ctx.runtime.artifacts.stopRecovery()
  const query = ctx.db.query.bind(ctx.db)
  const transaction = ctx.db.transaction.bind(ctx.db)
  t.after(() => { ctx.db.query = query; ctx.db.transaction = transaction })
  let mode = 'observe'
  let gate
  let reached
  const seen = []
  let transactions = 0
  const isTick = sql => sql.startsWith('SELECT installation_id FROM kipster.bootstrap')
  const ticks = () => seen.filter(isTick).length
  ctx.db.query = (sql, values) => {
    seen.push(sql)
    if (!isTick(sql) || mode === 'observe') return query(sql, values)
    if (mode === 'fail') return Promise.reject(new Error('fixture tick failure'))
    reached?.()
    reached = undefined
    return gate.promise.then(() => { throw new Error('fixture blocked tick failure') })
  }
  // Ticks come from the dispatcher's own timer, shortened for the test.
  const tickMs = MAINTENANCE_LIMITS.scannerTickMs
  MAINTENANCE_LIMITS.scannerTickMs = 50
  t.after(() => { MAINTENANCE_LIMITS.scannerTickMs = tickMs })
  await dispatcher.start()
  ctx.db.transaction = work => { transactions++; return transaction(work) }
  // Disabled with nothing pending: one bounded check per tick, no capacity lock and no intent pump.
  await until(async () => ticks(), n => n >= 3, 'timer ticks')
  assert.ok(seen.some(sql => sql.includes('maintenance_operator_intents')))
  assert.equal(transactions, 0)
  mode = 'fail'
  await until(async () => failures.length, n => n >= 2, 'timer tick failures reported')
  assert.match(failures[0].message, /fixture tick failure/)
  const reported = await until(async () => (await operator.status({ connectionString: ctx.url.href })).scheduler?.lastError, Boolean, 'failure recorded for operators')
  assert.match(reported, /fixture tick failure/)
  gate = deferred()
  const entered = new Promise(resolve => { reached = resolve })
  mode = 'block'
  await entered
  const blockedAt = ticks()
  await dispatcher.maintenanceTick()
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(ticks(), blockedAt, 'neither timer nor direct ticks overlap a tick in progress')
  const failed = failures.length
  // close() bounds its wait at 2 s; the tick is held for 1 s, then released.
  let closedAt = 0
  const closing = dispatcher.close().then(() => { closedAt = Date.now() })
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(closedAt, 0, 'close waits for the in-flight tick')
  const releasedAt = Date.now()
  gate.resolve()
  await closing
  assert.ok(closedAt - releasedAt < 500, `close resolves once the tick ends (${closedAt - releasedAt} ms)`)
  ctx.dispatchers.splice(0, 1)
  assert.equal(failures.length, failed + 1)
  assert.match(failures.at(-1).message, /fixture blocked tick failure/)
  const after = ticks()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(ticks(), after, 'the timer stops with the dispatcher')
  assert.deepEqual(unhandled, [])
})

test('a failing maintenance sweep is reported, and a later clean tick clears the recorded failure', { skip: noDatabase }, async t => {
  const failures = []
  const ctx = await setup(t, { hooks: { maintenanceFailed: async error => { failures.push(error) } } })
  const dispatcher = ctx.dispatchers[0]
  await ctx.runtime.artifacts.stopRecovery()
  const service = dispatcher.maintenance
  const claimSource = service.claimSource
  service.claimSource = async () => { throw new Error('fixture sweep failure') }
  await dispatcher.start() // Startup sends a sweep hint to the job worker.
  await until(async () => failures.length, n => n > 0, 'sweep failure reported')
  assert.match(failures[0].message, /fixture sweep failure/)
  const failed = await until(async () => (await operator.status({ connectionString: ctx.url.href })).scheduler, value => value?.lastError, 'sweep failure recorded')
  assert.match(failed.lastError, /fixture sweep failure/)
  assert.ok(failed.lastErrorAt)
  service.claimSource = claimSource
  await dispatcher.maintenanceTick()
  const cleared = (await operator.status({ connectionString: ctx.url.href })).scheduler
  assert.equal(cleared.lastError, null)
  assert.equal(cleared.lastErrorAt, null)
})

test('text is admitted at ceiling one when due maintenance cannot run on this coordinator', { skip: noDatabase }, async t => {
  const gate = deferred()
  t.after(() => gate.resolve())
  const ctx = await setup(t, { hooks: { afterMaintenanceClaim: () => gate.promise } })
  const readiness = await ctx.inner.readiness()
  ctx.adapter.readiness = async () => ({ ...readiness, catalog: { ...readiness.catalog, capabilities: { ...readiness.catalog.capabilities, maintenance: false } } })
  await ctx.dispatchers[0].start()
  await ctx.db.query('UPDATE kipster.execution_permits SET ceiling=1')
  const saved = await completeTextRun(ctx, 'Unservable anchor')
  await until(async () => sourceStatus(ctx, saved.runId, 1), s => s === 'claimed', 'claim held in preparation')
  await ctx.db.query('UPDATE kipster.execution_permits SET maintenance_counter=8')
  assert.equal(await capacityTx(ctx, client => ctx.service.maintenanceDue(client)), true, 'a claimed source is otherwise due')
  const text = await submitText(ctx, 'Admitted without a reservation')
  const found = await textExec(ctx, text.runId)
  found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: 'Admitted', final: true })
  found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
  await until(async () => runState(ctx, text.runId), s => s === 'completed', 'text completes')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1', [text.runId]), 1, 'admitted on the first attempt')
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'claimed')
})

test('staged provider output is discarded at every terminal transition and inspection shows only digests', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const staged = async runId => (await row(ctx.db, 'SELECT staged_output FROM kipster.maintenance_runs WHERE id=$1', [runId])).staged_output
  const stage = async (text, candidateText, excerpt, cite = manifest => manifest.entries[0]) => {
    const mark = ctx.executions.length
    const saved = await completeTextRun(ctx, text)
    const manifest = await manifestOf(ctx, saved.runId)
    const exec = await maintExec(ctx, mark)
    exec.handle.release(providerEvent(exec.context.attemptId))
    const candidate = candidateFor(cite(manifest), candidateText, excerpt, { subject: 'retention' })
    if (!cite(manifest).message_id) candidate.citations[0].message_id = randomUUID()
    exec.handle.release({ kind: 'text', attemptId: exec.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates: [candidate] }), final: true })
    await until(async () => (await staged(exec.context.runId))?.candidates?.length, n => n === 1, 'output staged')
    return { saved, exec }
  }
  const committed = await stage('The Zurich office opens at nine', 'The Zurich office opens at nine', 'Zurich office opens')
  const running = await operator.inspectRun({ connectionString: ctx.url.href, runId: committed.exec.context.runId })
  assert.equal(running.staged.candidates, 1)
  assert.match(running.staged.sha256, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(running).includes('Zurich'), 'inspection omits candidate text and excerpts')
  committed.exec.handle.release({ kind: 'ended', attemptId: committed.exec.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, committed.saved.runId, 1), 'committed')
  assert.equal(await staged(committed.exec.context.runId), null)
  assert.equal((await operator.inspectRun({ connectionString: ctx.url.href, runId: committed.exec.context.runId })).staged, null)
  // Bounded failure.
  const invalid = await stage('The Bern office opens at nine', 'The Bern office opens at nine', 'Bern office opens', () => ({ revision: 1, parts_sha256: 'x', author_id: randomUUID(), author_class: 'human' }))
  invalid.exec.handle.release({ kind: 'ended', attemptId: invalid.exec.context.attemptId, confirmed: true })
  await maintRunSettled(ctx, invalid.exec.context.runId)
  assert.equal(await staged(invalid.exec.context.runId), null)
  // Confirmed operator cancel.
  const cancelled = await stage('The Chur office opens at nine', 'The Chur office opens at nine', 'Chur office opens')
  cancelled.exec.handle.cancel = async () => ({ acknowledged: true, confirmedEnded: true })
  await ctx.service.requestAction('cancel-staged', 'cancel', { runId: cancelled.exec.context.runId })
  await ctx.dispatchers[0].pumpMaintenance()
  assert.equal(await sourceStatus(ctx, cancelled.saved.runId, 1), 'fenced')
  assert.equal(await staged(cancelled.exec.context.runId), null)
  // Thread deletion clears in-flight output before the attempt ends.
  const purged = await stage('The Davos office opens at nine', 'The Davos office opens at nine', 'Davos office opens')
  await ctx.db.transaction(async client => { await ctx.service.purgeThreadContext(client, purged.saved.threadId) })
  assert.equal(await staged(purged.exec.context.runId), null)
  purged.exec.handle.release({ kind: 'ended', attemptId: purged.exec.context.attemptId, confirmed: true })
  await maintRunSettled(ctx, purged.exec.context.runId)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.memory_records WHERE text='The Davos office opens at nine'`), 0)
  // Unknown end keeps the permit but not the output.
  const unknown = await stage('The Emmen office opens at nine', 'The Emmen office opens at nine', 'Emmen office opens')
  unknown.exec.handle.abortUnknown()
  await until(async () => sourceStatus(ctx, unknown.saved.runId, 1), s => s === 'recovery', 'unknown end')
  assert.equal(await staged(unknown.exec.context.runId), null)
  assert.equal(await count(ctx.db, "SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE staged_output IS NOT NULL AND state<>'running'"), 0)
  await assert.rejects(ctx.db.query(`UPDATE kipster.maintenance_runs SET staged_output='{"candidates":[]}' WHERE id=$1`, [unknown.exec.context.runId]), /check constraint/)
})

test('a database failure on a later candidate rolls back earlier candidates and permits retry', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'The Faro office opens at nine and Gaia at ten')
  const manifest = await manifestOf(ctx, saved.runId)
  const exec = await maintExec(ctx)
  const candidates = [
    candidateFor(manifest.entries[0], 'The Gaia office opens at ten', 'Gaia at ten', { subject: 'hours' }),
    candidateFor(manifest.entries[0], 'The Faro office opens at nine', 'Faro office opens', { subject: 'hours' }),
  ]
  exec.handle.release(providerEvent(exec.context.attemptId))
  exec.handle.release({ kind: 'text', attemptId: exec.context.attemptId, messageId: 'output', text: JSON.stringify({ candidates }), final: true })
  await until(async () => (await row(ctx.db, 'SELECT staged_output FROM kipster.maintenance_runs WHERE id=$1', [exec.context.runId])).staged_output?.candidates?.length, n => n === 2, 'both candidates staged')
  // A real storage failure on the second insert must undo the first candidate's writes too.
  await ctx.db.query(`CREATE FUNCTION kipster.fail_second_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture second candidate write failed'; END $$`)
  await ctx.db.query(`CREATE TRIGGER fail_second_candidate BEFORE INSERT ON kipster.memory_records FOR EACH ROW WHEN (NEW.text='The Faro office opens at nine') EXECUTE FUNCTION kipster.fail_second_candidate()`)
  const attempt = await row(ctx.db, 'SELECT id, intent_id, generation, incarnation FROM kipster.attempts WHERE id=$1', [exec.context.attemptId])
  await assert.rejects(capacityTx(ctx, client => ctx.service.settleMaintenance(client, ctx.runtime.jobs,
    { id: attempt.id, intentId: attempt.intent_id, generation: Number(attempt.generation), incarnation: attempt.incarnation, state: 'issued' },
    attempt.incarnation, { kind: 'extract' })), /fixture second candidate write failed/)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_candidate_claims WHERE source_run_id=$1', [saved.runId]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE source_message_id=$1', [manifest.entries[0].message_id]), 0)
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'issued', 'failed transaction does not acknowledge the source')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1)
  await ctx.db.query('DROP TRIGGER fail_second_candidate ON kipster.memory_records')
  exec.handle.release({ kind: 'ended', attemptId: exec.context.attemptId, confirmed: true })
  assert.equal(await sourceTerminal(ctx, saved.runId, 1), 'committed')
  assert.deepEqual((await ctx.db.query('SELECT text FROM kipster.memory_records ORDER BY text')).rows.map(r => r.text), candidates.map(c => c.text).sort())
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_candidate_claims WHERE source_run_id=$1', [saved.runId]), 2)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_provenance WHERE source_message_id=$1', [manifest.entries[0].message_id]), 2)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 0)
})

test('claims without a live preparation return to ready and a reverted manifest fences instead of sticking', { skip: noDatabase }, async t => {
  const gate = deferred()
  t.after(() => gate.resolve())
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const orphan = await completeTextRun(ctx, 'Orphaned claim')
  const saved = await completeTextRun(ctx, 'Reverted content')
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  await capacityTx(ctx, async client => {
    await ctx.service.allocateSource(client, ctx.runtime.jobs, orphan.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, orphan.threadId, false)
    await client.query(`UPDATE kipster.maintenance_sources SET status='claimed', claim_lease_until=now()-interval '1 second' WHERE run_id=$1`, [orphan.runId])
  })
  assert.equal((await capacityTx(ctx, client => ctx.service.expireUnissuedClaims(client, ctx.runtime.jobs))).expired, 1)
  assert.equal(await sourceStatus(ctx, orphan.runId, 1), 'ready')
  await ctx.db.query(`UPDATE kipster.maintenance_sources SET status='skipped' WHERE run_id=$1`, [orphan.runId])
  // Revision 2 is claimed, then the content returns to revision 1's manifest.
  const input = await row(ctx.db, 'SELECT id, revision, parts FROM kipster.messages WHERE id=(SELECT input_message_id FROM kipster.text_runs WHERE id=$1)', [saved.runId])
  await capacityTx(ctx, async client => {
    await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId, false)
    await client.query(`UPDATE kipster.maintenance_sources SET status='committed' WHERE run_id=$1`, [saved.runId])
    await client.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [input.id, JSON.stringify([{ kind: 'text', text: 'Edited content' }])])
    await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId, false)
  })
  await addDispatcher(ctx, { afterMaintenanceClaim: () => gate.promise }).start()
  await until(async () => sourceStatus(ctx, saved.runId, 2), s => s === 'claimed', 'revision 2 claimed')
  await ctx.db.query('UPDATE kipster.messages SET revision=$2, parts=$3::jsonb WHERE id=$1', [input.id, input.revision, JSON.stringify(input.parts)])
  gate.resolve()
  assert.equal(await until(async () => sourceStatus(ctx, saved.runId, 2), s => s !== 'claimed', 'revision 2 settles'), 'fenced')
  assert.equal((await row(ctx.db, 'SELECT status_reason FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=2', [saved.runId])).status_reason, 'stale manifest')
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), 2)
  assert.equal(await count(ctx.db, "SELECT count(*)::int AS n FROM kipster.maintenance_runs WHERE state='preparing'"), 0)
  assert.equal(ctx.executions.filter(e => e.context.kind === 'maintenance').length, 0)
})

test('content edited away and back is extracted again, and requeue acts on the revision matching current content', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Reverted source')
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  const input = await row(ctx.db, 'SELECT id, revision, parts FROM kipster.messages WHERE id=(SELECT input_message_id FROM kipster.text_runs WHERE id=$1)', [saved.runId])
  const allocate = client => ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, ctx.runtime.bootstrap.rootAgentId, 'installation', ctx.actor.installationId, saved.threadId, false)
  const requeue = revision => capacityTx(ctx, client => ctx.service.requeueSource(client, ctx.runtime.jobs, saved.runId, revision))
  const setStatus = (revision, status) => ctx.db.query('UPDATE kipster.maintenance_sources SET status=$3 WHERE run_id=$1 AND source_revision=$2', [saved.runId, revision, status])
  await capacityTx(ctx, async client => {
    await allocate(client)
    await client.query(`UPDATE kipster.messages SET revision=revision+1, parts=$2::jsonb WHERE id=$1`, [input.id, JSON.stringify([{ kind: 'text', text: 'Edited source' }])])
    assert.equal((await allocate(client)).revision, 2)
  })
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'superseded')
  await setStatus(2, 'committed')
  await ctx.db.query('UPDATE kipster.messages SET revision=$2, parts=$3::jsonb WHERE id=$1', [input.id, input.revision, JSON.stringify(input.parts)])
  for (let i = 0; i < 3 && await sourceStatus(ctx, saved.runId, 1) === 'superseded'; i++) await ctx.service.tickScanner(ctx.runtime.jobs)
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready', 'the scanner revives the never-extracted revision')
  assert.deepEqual(await requeue(2), { done: true, revision: 1, alreadyQueued: true })
  await setStatus(1, 'superseded')
  assert.deepEqual(await requeue(2), { done: true, revision: 1 })
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
  await setStatus(1, 'committed')
  assert.deepEqual(await requeue(2), { done: true, revision: 1 })
  assert.equal(await sourceStatus(ctx, saved.runId, 1), 'ready')
  assert.equal((await row(ctx.db, 'SELECT cycles FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=1', [saved.runId])).cycles, 2)
  await setStatus(1, 'issued')
  assert.deepEqual(await requeue(2), { conflict: 'revision 1 matching the current content is issued' })
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources WHERE run_id=$1', [saved.runId]), 2)
})

test('agent-brain purge removes queued runs with their intents; operator targets are validated', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { maintenance: false })
  await ctx.dispatchers[0].start()
  const saved = await completeTextRun(ctx, 'Queued purge probe')
  await ctx.dispatchers[0].close()
  ctx.dispatchers.splice(0, 1)
  await setLearning(ctx, true)
  const agentId = ctx.runtime.bootstrap.rootAgentId
  await capacityTx(ctx, async client => {
    await ctx.service.allocateSource(client, ctx.runtime.jobs, saved.runId, agentId, 'installation', ctx.actor.installationId, saved.threadId, false)
    await ctx.service.claimSource(client, randomUUID(), true)
    await ctx.service.expireUnissuedClaims(client, ctx.runtime.jobs, { all: true })
  })
  const queued = await row(ctx.db, 'SELECT id, state FROM kipster.maintenance_runs WHERE source_run_id=$1', [saved.runId])
  assert.equal(queued.state, 'queued')
  await operator.requestAction({ connectionString: ctx.url.href, opId: 'queued-reconcile', action: 'reconcile', target: { runId: queued.id } })
  await assert.rejects(operator.requestAction({ connectionString: ctx.url.href, opId: 'missing-run', action: 'cancel', target: { runId: randomUUID() } }), /Maintenance run not found/)
  await assert.rejects(operator.status({ connectionString: ctx.url.href, installationId: randomUUID() }), /Installation not found/)
  const purged = await ctx.db.transaction(async client => ctx.service.purgeAgentBrain(client, agentId))
  assert.deepEqual(purged, { removedRuns: 1, retainedRuns: 0 })
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_runs'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_operator_intents'), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.maintenance_sources'), 0)
})
