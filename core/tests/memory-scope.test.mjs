import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MaintenanceService, MAINTENANCE_SWEEP_JOB_ID } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Organization home of learned memories, against real PostgreSQL with the deterministic fixture adapter.
// One agent works in organizations A and B and in the installation context.
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

async function setup(t) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_scope_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-scope-home-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Alpha', rootAgent: 'Root' }, embedding: { ...profile, async embed() { return [1, 0] } } })
  await runtime.memory.stopIndexing()
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const agentId = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  await runtime.learning.setInstallation(actor, { enabled: true })
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  t.after(async () => {
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const ctx = { runtime, db: runtime.db, actor, agentId, dispatcher, executions, handled: new Set(), service: new MaintenanceService(runtime.db, actor.installationId) }
  const place = async (organizationId) => {
    const context = organizationId ? { kind: 'organization', organizationId } : { kind: 'installation', installationId: actor.installationId }
    return { organizationId, context, chatId: (await resolveDirectChat(runtime.db, actor, context, agentId)).chatId }
  }
  ctx.installation = await place(null)
  ctx.a = await place(runtime.bootstrap.organizationId)
  ctx.b = await place(await organization(ctx, 'Beta'))
  return ctx
}
async function organization(ctx, name) {
  const id = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.organizations(id, installation_id, display_name, provisioned) VALUES ($1,$2,$3,true)`, [id, ctx.actor.installationId, name])
  await ctx.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [id, ctx.agentId])
  await ctx.db.query('INSERT INTO kipster.human_memberships(organization_id, person_id) VALUES ($1,$2)', [id, ctx.actor.personId])
  await ctx.runtime.home.provisionOrganization(id)
  return id
}

/** Starts a conversation in `where` and returns its live execution; `finish` completes it. */
async function startConversation(ctx, where, text) {
  const saved = await acceptText(ctx.db, ctx.runtime.jobs, ctx.runtime.artifacts, ctx.actor, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: ctx.actor.installationId, callerId: ctx.actor.personId },
    target: { context: where.context, chatId: where.chatId }, mode: 'root', parts: [{ kind: 'text', text }],
  })
  const found = await until(() => ctx.executions.find(e => e.context.runId === saved.runId && e.context.kind !== 'maintenance'), Boolean, `execution ${saved.runId}`)
  const finish = async () => {
    found.handle.release({ kind: 'text', attemptId: found.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
    found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true })
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).state, s => s === 'completed', `completed ${saved.runId}`)
    await learn(ctx, saved.runId, [])
  }
  return { ...saved, execution: found, finish, call: (name, args) => found.handle.callTool(randomUUID(), name, args) }
}
/** A completed conversation whose extraction learns `facts`, each `{ text, explicit?, author? }`, from its messages. */
async function conversation(ctx, where, text, facts = []) {
  const started = await startConversation(ctx, where, text)
  started.execution.handle.release({ kind: 'text', attemptId: started.execution.context.attemptId, messageId: 'answer', text: 'Noted.', final: true })
  started.execution.handle.release({ kind: 'ended', attemptId: started.execution.context.attemptId, confirmed: true })
  await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.text_runs WHERE id=$1', [started.runId])).state, s => s === 'completed', `completed ${started.runId}`)
  assert.equal(await learn(ctx, started.runId, facts), 'committed')
  return started
}
async function nextMaintenance(ctx) {
  await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
  const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && !ctx.handled.has(e)), Boolean, 'maintenance execution')
  ctx.handled.add(found)
  return found
}
async function learn(ctx, runId, facts) {
  const status = async () => (await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [runId]))?.status
  for (let i = 0; i < 12; i++) {
    if (['committed', 'skipped', 'fenced'].includes(await status())) return status()
    const found = await nextMaintenance(ctx)
    const mine = found.context.maintenance.sourceRunId === runId
    const entries = (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [found.context.maintenance.sourceRunId])).manifest.entries
    const candidates = []
    for (const fact of mine ? facts : []) {
      const entry = entries.find(item => item.author_class === (fact.author ?? 'human'))
      const text = (await row(ctx.db, 'SELECT parts FROM kipster.messages WHERE id=$1', [entry.message_id])).parts[0].text
      candidates.push({ kind: 'fact', text: fact.text, subject: 'scope', author_id: entry.author_id, author_class: entry.author_class, ...(fact.explicit === undefined ? {} : { explicit: fact.explicit }), citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: text.slice(0, 5) }] })
    }
    const attemptId = found.context.attemptId
    found.handle.release({ kind: 'provider', attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
    found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: JSON.stringify({ candidates }), final: true })
    found.handle.release({ kind: 'ended', attemptId, confirmed: true })
    await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]))?.state, s => ['completed', 'failed'].includes(s), 'maintenance settled')
  }
  throw new Error(`source ${runId} did not settle`)
}
const memory = (ctx, text) => row(ctx.db, `SELECT id, origin, importance, evidence, home_organization_id AS home FROM kipster.memory_records WHERE text=$1 AND scope='agent'`, [text])
/** Texts the agent's memory yields in `where` through context, search and get, outside any execution. */
async function visible(ctx, where, query, ids) {
  const context = (await ctx.runtime.memory.context(ctx.agentId, where.organizationId, query)).join('\n')
  const searched = (await ctx.runtime.memory.search(ctx.agentId, where.organizationId, query, 20)).map(hit => hit.record.text)
  const got = []
  for (const id of ids) { const found = await ctx.runtime.memory.get(ctx.agentId, where.organizationId, id); if (found) got.push(found.text) }
  return { context, searched, got }
}
/** Texts a live execution in `where` yields through automatic context, memory.search and memory.get. */
async function visibleToExecution(ctx, where, query, ids) {
  const live = await startConversation(ctx, where, query)
  const context = live.execution.context.memory.join('\n')
  const searched = (await live.call('memory.search', { query, limit: 20 })).map(hit => hit.record.text)
  const got = []
  for (const id of ids) { const found = await live.call('memory.get', { id }); if (found) got.push(found.text) }
  await live.finish()
  return { context, searched, got }
}
function assertSees(seen, text, expected, label) {
  assert.equal(seen.context.includes(text), expected, `${label}: context ${expected ? 'includes' : 'excludes'} ${text}`)
  assert.equal(seen.searched.includes(text), expected, `${label}: search ${expected ? 'includes' : 'excludes'} ${text}`)
  assert.equal(seen.got.includes(text), expected, `${label}: get ${expected ? 'returns' : 'hides'} ${text}`)
}

test('a memory learned in an organization surfaces only there; saves, explicit requests and installation learning are global', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const homed = 'Alpha client pricing is ninety euros per seat'
  const explicit = 'Office notes should be short summaries'
  const agentExplicit = 'Office notes arrive every Monday'
  const direct = 'Office plants need water on Fridays'
  const saved = 'Office badges are blue'
  await conversation(ctx, ctx.a, 'Our pricing is ninety euros per seat. Remember that office notes should be short summaries.', [
    { text: homed }, { text: explicit, explicit: true }, { text: agentExplicit, explicit: true, author: 'agent' }])
  await conversation(ctx, ctx.installation, 'The office plants need water on Fridays', [{ text: direct }])
  const saving = await startConversation(ctx, ctx.a, 'Note that office badges are blue')
  assert.equal((await saving.call('memory.save', { kind: 'fact', text: saved })).record.text, saved)
  await saving.finish()

  const rows = { homed: await memory(ctx, homed), explicit: await memory(ctx, explicit), agentExplicit: await memory(ctx, agentExplicit), direct: await memory(ctx, direct), saved: await memory(ctx, saved) }
  assert.deepEqual([rows.homed.origin, rows.homed.home, rows.homed.importance], ['learned', ctx.a.organizationId, 0.5])
  assert.deepEqual([rows.explicit.origin, rows.explicit.home, rows.explicit.importance], ['learned', null, 1])
  assert.equal(rows.agentExplicit.home, ctx.a.organizationId, 'only a human request is explicit')
  assert.deepEqual([rows.direct.origin, rows.direct.home], ['learned', null])
  assert.deepEqual([rows.saved.origin, rows.saved.home], ['deliberate', null])
  const ids = Object.values(rows).map(item => item.id)
  const query = 'office pricing notes plants badges seat'
  for (const indexed of [false, true]) {
    if (indexed) await ctx.runtime.memory.indexPending(20, true)
    for (const [label, where, sees] of [['A', ctx.a, true], ['B', ctx.b, false], ['installation', ctx.installation, false]]) {
      const seen = await visible(ctx, where, query, ids)
      assertSees(seen, homed, sees, `${label} (vectors ${indexed})`)
      assertSees(seen, agentExplicit, sees, `${label} (vectors ${indexed})`)
      for (const text of [explicit, direct, saved]) assertSees(seen, text, true, `${label} (vectors ${indexed})`)
    }
  }
  for (const [label, where, sees] of [['A', ctx.a, true], ['B', ctx.b, false], ['installation', ctx.installation, false]]) {
    const seen = await visibleToExecution(ctx, where, query, ids)
    assertSees(seen, homed, sees, `execution in ${label}`)
    for (const text of [explicit, direct, saved]) assertSees(seen, text, true, `execution in ${label}`)
  }
})

test('support and corrections from elsewhere never move a memory home or reveal it', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const fact = 'The launch date is the ninth of May'
  await conversation(ctx, ctx.a, 'Our launch date is the ninth of May', [{ text: fact }])
  await conversation(ctx, ctx.b, 'For us too, the launch date is the ninth of May', [{ text: fact }])
  const records = (await ctx.db.query(`SELECT id, home_organization_id AS home, evidence FROM kipster.memory_records WHERE text=$1 ORDER BY home_organization_id=$2 DESC`, [fact, ctx.a.organizationId])).rows
  assert.deepEqual(records.map(item => [item.home, item.evidence]), [[ctx.a.organizationId, 1], [ctx.b.organizationId, 1]], 'each organization forms its own memory')
  const [inA, inB] = records.map(item => item.id)
  const ids = (hits) => hits.map(hit => hit.record.id)
  assert.deepEqual(ids(await ctx.runtime.memory.search(ctx.agentId, ctx.a.organizationId, 'launch date')), [inA])
  assert.deepEqual(ids(await ctx.runtime.memory.search(ctx.agentId, ctx.b.organizationId, 'launch date')), [inB])
  assert.deepEqual(ids(await ctx.runtime.memory.search(ctx.agentId, null, 'launch date')), [])

  await conversation(ctx, ctx.a, 'Confirmed: the launch date is the ninth of May', [{ text: fact }])
  assert.deepEqual(await row(ctx.db, 'SELECT evidence, home_organization_id AS home FROM kipster.memory_records WHERE id=$1', [inA]), { evidence: 2, home: ctx.a.organizationId })

  // Tools in B cannot reach the memory homed in A.
  const live = await startConversation(ctx, ctx.b, 'What is the launch date?')
  assert.equal(await live.call('memory.get', { id: inA }), null)
  await assert.rejects(live.call('memory.correct', { id: inA, expectedRevision: 1, text: 'The launch date is the tenth of May' }), /Memory not found/)
  await assert.rejects(live.call('memory.publish', { id: inA, expectedSourceRevision: 1 }), /Source memory not found/)
  await live.finish()
  await assert.rejects(ctx.runtime.memory.correct(ctx.agentId, inA, 1, 'The launch date is the tenth of May', [{ sourceOrganizationId: ctx.b.organizationId }], ctx.b.organizationId), /Memory not found/)

  // A correction in A that cites B keeps the home in A.
  const corrected = await ctx.runtime.memory.correct(ctx.agentId, inA, 1, 'The launch date is the tenth of May', [{ sourceOrganizationId: ctx.b.organizationId }], ctx.a.organizationId)
  assert.equal(corrected.revision, 2)
  assert.equal((await row(ctx.db, 'SELECT home_organization_id AS home FROM kipster.memory_records WHERE id=$1', [inA])).home, ctx.a.organizationId)
  assert.equal(await ctx.runtime.memory.get(ctx.agentId, ctx.b.organizationId, inA), null)
  assert.deepEqual(ids(await ctx.runtime.memory.search(ctx.agentId, ctx.b.organizationId, 'tenth of May')), [inB])
  const publishing = await startConversation(ctx, ctx.a, 'Share the launch date with Alpha')
  const published = await publishing.call('memory.publish', { id: inA, expectedSourceRevision: 2 })
  assert.equal(published.record.scope, 'organization')
  await publishing.finish()
})

test('links and link expansion follow the organization home', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const homed = 'The Alpha office is in Pune'
  const global = 'The office moved to Hyderabad'
  await conversation(ctx, ctx.a, 'Our office is in Pune', [{ text: homed }])
  const inA = await startConversation(ctx, ctx.a, 'Remember the office moved to Hyderabad')
  const from = (await memory(ctx, homed)).id
  const to = (await inA.call('memory.save', { kind: 'fact', text: global })).record.id
  const owner = { kind: 'agent', ownerId: ctx.agentId }
  const linked = await inA.call('memory.link', { owner, fromId: from, toId: to, fromRevision: 1, toRevision: 1, kind: 'contradicts', weight: 0.9, evidence: [{ memoryId: from, revision: 1 }, { memoryId: to, revision: 1 }] })
  assert.equal((await inA.call('memory.relationship_list', { owner })).relationships.length, 1)
  await inA.finish()
  const pairA = (await ctx.runtime.memory.context(ctx.agentId, ctx.a.organizationId, 'office')).join('\n')
  assert.ok(pairA.includes(homed) && pairA.includes(global) && pairA.includes('contradicts'))
  const inB = (await ctx.runtime.memory.context(ctx.agentId, ctx.b.organizationId, 'office')).join('\n')
  assert.ok(inB.includes(global) && !inB.includes(homed) && !inB.includes('contradicts') && !inB.includes(from))

  const live = await startConversation(ctx, ctx.b, 'Where is the office?')
  assert.deepEqual((await live.call('memory.relationship_list', { owner })).relationships, [])
  assert.equal(await live.call('memory.relationship_get', { owner, relationshipId: linked.relationship.id }), null)
  await assert.rejects(live.call('memory.unlink', { owner, relationshipId: linked.relationship.id, expectedRevision: 1 }), /Relationship not found/)
  await assert.rejects(live.call('memory.link', { owner, fromId: from, toId: to, fromRevision: 1, toRevision: 1, kind: 'related_to', weight: 0.5, evidence: [{ memoryId: to, revision: 1 }] }), /outside owner/)
  const searched = await live.call('memory.search', { query: 'office' })
  assert.deepEqual(searched.map(hit => [hit.record.text, hit.relationship]), [[global, undefined]])
  await live.finish()
})

test('deleting an organization deletes the memories learned there and keeps global ones', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const gamma = await organization(ctx, 'Gamma')
  const inGamma = { organizationId: gamma, context: { kind: 'organization', organizationId: gamma }, chatId: (await resolveDirectChat(ctx.db, ctx.actor, { kind: 'organization', organizationId: gamma }, ctx.agentId)).chatId }
  const homed = 'Gamma budget is forty thousand'
  const saved = 'Budget reviews happen quarterly'
  await conversation(ctx, inGamma, 'Our budget is forty thousand', [{ text: homed }])
  const saving = await startConversation(ctx, inGamma, 'Keep in mind that budget reviews happen quarterly')
  await saving.call('memory.save', { kind: 'fact', text: saved })
  await saving.finish()
  const { id } = await memory(ctx, homed)
  assert.ok((await ctx.runtime.memory.context(ctx.agentId, gamma, 'budget')).join('\n').includes(homed))

  // Organization deletion: the maintenance hook runs first, then memberships and the organization go.
  await ctx.db.transaction(async client => {
    await ctx.service.purgeOrganizationContext(client, gamma)
    await client.query('DELETE FROM kipster.agent_memberships WHERE organization_id=$1', [gamma])
    await client.query('DELETE FROM kipster.human_memberships WHERE organization_id=$1', [gamma])
    await client.query('DELETE FROM kipster.organizations WHERE id=$1', [gamma])
  })
  assert.equal(await memory(ctx, homed), undefined)
  for (const table of ['memory_sources', 'memory_provenance', 'memory_index_intents', 'maintenance_candidate_claims']) {
    assert.equal((await row(ctx.db, `SELECT count(*)::int AS n FROM kipster.${table} WHERE memory_id=$1`, [id])).n, 0, table)
  }
  const kept = await memory(ctx, saved)
  assert.equal((await row(ctx.db, 'SELECT source_organization_id FROM kipster.memory_provenance WHERE memory_id=$1', [kept.id])).source_organization_id, null)
  for (const where of [ctx.a, ctx.b, ctx.installation]) {
    const seen = await visible(ctx, where, 'budget forty thousand quarterly', [id])
    assertSees(seen, homed, false, 'after deletion')
    assert.ok(seen.context.includes(saved), 'a deliberate save made there stays global')
  }
  const seen = await visibleToExecution(ctx, ctx.a, 'budget forty thousand quarterly', [id])
  assertSees(seen, homed, false, 'execution after deletion')
  assert.ok(seen.context.includes(saved))
})

test('an explicit request that repeats an already learned claim makes it global and essential', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const fact = 'Weekly reports go out on Thursdays'
  await conversation(ctx, ctx.a, 'Weekly reports go out on Thursdays', [{ text: fact }])
  const learned = await memory(ctx, fact)
  assert.deepEqual([learned.home, learned.importance, learned.evidence], [ctx.a.organizationId, 0.5, 1])
  assert.deepEqual((await ctx.runtime.memory.search(ctx.agentId, ctx.b.organizationId, 'weekly reports')).map(hit => hit.record.id), [])
  await conversation(ctx, ctx.a, 'From now on, remember: weekly reports go out on Thursdays', [{ text: fact, explicit: true }])
  const explicit = await memory(ctx, fact)
  assert.deepEqual([explicit.id, explicit.home, explicit.importance, explicit.evidence], [learned.id, null, 1, 2])
  for (const where of [ctx.b, ctx.installation]) {
    assert.deepEqual((await ctx.runtime.memory.search(ctx.agentId, where.organizationId, 'weekly reports')).map(hit => hit.record.id), [learned.id])
  }
})

test('relationship history hides revisions that cite a memory homed in another organization', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.dispatcher.start()
  const homedText = 'The Alpha rollout slipped a week'
  await conversation(ctx, ctx.a, 'Our rollout slipped a week', [{ text: homedText }])
  const homed = (await memory(ctx, homedText)).id
  const owner = { kind: 'agent', ownerId: ctx.agentId }
  const inA = await startConversation(ctx, ctx.a, 'Remember the release plan')
  const first = (await inA.call('memory.save', { kind: 'fact', text: 'Releases ship on Tuesdays' })).record.id
  const second = (await inA.call('memory.save', { kind: 'fact', text: 'Release notes are written by the team lead' })).record.id
  const linked = (await inA.call('memory.link', { owner, fromId: first, toId: second, fromRevision: 1, toRevision: 1, kind: 'related_to', weight: 0.5, evidence: [{ memoryId: first, revision: 1 }, { memoryId: homed, revision: 1 }] })).relationship
  await inA.call('memory.relationship_update', { owner, relationshipId: linked.id, expectedRevision: 1, fromRevision: 1, toRevision: 1, kind: 'related_to', weight: 0.6, evidence: [{ memoryId: first, revision: 1 }] })
  const inAHistory = (await inA.call('memory.relationship_get', { owner, relationshipId: linked.id })).history
  assert.deepEqual(inAHistory.map(change => change.evidence.map(item => item.memoryId)), [[first, homed], [first]])
  await inA.finish()

  const inB = await startConversation(ctx, ctx.b, 'What is the release plan?')
  const got = await inB.call('memory.relationship_get', { owner, relationshipId: linked.id })
  assert.deepEqual(got.history.map(change => [change.revision, change.evidence.map(item => item.memoryId)]), [[2, [first]]], 'the revision citing the homed memory is left out')
  const listed = await inB.call('memory.relationship_list', { owner })
  assert.deepEqual(listed.relationships.map(item => [item.id, item.history.length]), [[linked.id, 0]])
  for (const response of [got, listed]) assert.ok(!JSON.stringify(response).includes(homed), 'no trace of the memory homed in A')
  await inB.finish()
})
