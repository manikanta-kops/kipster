process.env.TZ = 'UTC'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MemoryService, deleteOrganizationMemory, removeThreadMemory, searchMemory, turnMemory } from '../dist/modules/memory/public.js'
import { acceptText, removeThreads, resolveDirectChat } from '../dist/modules/conversations/public.js'
import { addMembership, createAgent, createOrganization } from '../dist/modules/administration/public.js'
import { organizationDeletionSteps } from '../dist/workflows/organization-deletion.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Kip memory's diary pages against real PostgreSQL (decision record 10, sections 1 to 5): a page belongs to one context
// and is shown only where that context may be seen, a deleted thread leaves nothing in the diary, and rows waiting for an
// embedding are repaired by a later night. The nightly model is scripted and the embedding provider deterministic.

const day = '2026-10-12'
const at = (time, date = day) => new Date(`${date}T${time}:00Z`)
const fixtureSettings = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

/** A 768-dimension bag of words, so texts sharing words are near. `state.fail` makes it throw. */
function embedder(state, calls) {
  return {
    id: 'fake-embedding', contractMajor: 1, model: 'fake-gemma',
    async embed(text) {
      calls.push(text)
      if (state.fail) throw new Error('embedding down')
      const vector = new Array(768).fill(0)
      vector[767] = 0.01
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) vector[createHash('sha256').update(word).digest().readUInt16BE(0) % 767] += 1
      return vector
    },
  }
}

/** Nightly answers: no topic splits and no card changes; a diary summary that keeps the current one and adds the code
 * words (such as GARDENSECRET742) of the new messages, so a page shows which threads it was written from. */
function nightly(context) {
  const { step, instructions } = context.maintenance
  if (step === 'chunks') return { topics: [{ start: 'm1', title: 'Topic' }] }
  if (step === 'memories' || step === 'lessons') return { changes: [] }
  if (step === 'core') return { core: [] }
  const days = instructions.split('\n\n---\n\n').map(block => block.match(/Day (\d{4}-\d\d-\d\d) \([^)]*\)\nCurrent summary: (.*)\nNew messages:\n([\s\S]*)$/)).filter(Boolean)
  return { days: days.map(([, date, current, messages]) => ({ day: date, summary: [current === '(none)' ? `Diary of ${date}:` : current, ...(messages.match(/\b[A-Z]{4,}\d+\b/g) ?? [])].join(' ') })) }
}

async function setup(t, { embedding = true } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_diary_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-diary-home-'))
  const clock = { now: at('12:00') }
  const embeddingState = { fail: false }
  const embeddingCalls = []
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Sam', organization: 'Garden', rootAgent: 'Kip' }, clock: () => clock.now, ...(embedding ? { embedding: embedder(embeddingState, embeddingCalls) } : {}) })
  const db = runtime.db
  const installationId = runtime.bootstrap.installationId
  const actor = { installationId, personId: runtime.bootstrap.ownerId }
  const kip = runtime.bootstrap.rootAgentId
  const garden = runtime.bootstrap.organizationId
  await db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [kip, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const studio = (await createOrganization(db, runtime.home, actor, 'studio', { name: 'Studio' })).organization.id
  const scout = (await createAgent(db, runtime.home, actor, 'scout', { name: 'Scout', organizationId: garden, settings: fixtureSettings })).agent.id
  await addMembership(db, actor, 'scout-studio', studio, scout)

  // Text runs use the deterministic fixture with Kipster's tools; nightly steps answer from `nightly`.
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  const executions = [], calls = []
  const adapter = {
    id: inner.id, version: inner.version, contractMajor: 1, recoveryVersions: inner.recoveryVersions, recoveryStateScopes: inner.recoveryStateScopes,
    readiness: () => inner.readiness(), durableReconcile: request => inner.durableReconcile(request), close: () => inner.close(),
    async execute(context) {
      if (context.kind !== 'maintenance') { const handle = await inner.execute(context); executions.push({ context, handle }); return handle }
      calls.push(context)
      const answer = nightly(context)
      const events = (async function* () {
        yield { kind: 'text', attemptId: context.attemptId, messageId: 'answer', text: JSON.stringify(answer), final: true }
        yield { kind: 'ended', attemptId: context.attemptId, confirmed: true }
      })()
      return { events, async cancel() { return { acknowledged: true, confirmedEnded: true } }, async reconcile() { return 'ended' } }
    },
  }
  dispatcher = new TextDispatcher(runtime, adapter)
  t.after(async () => {
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  await dispatcher.start()
  await runtime.learning.setInstallation(actor, { enabled: true })

  const context = organizationId => organizationId ? { kind: 'organization', organizationId } : { kind: 'installation', installationId }
  const chat = async (agentId, organizationId) => (await resolveDirectChat(db, actor, context(organizationId), agentId)).chatId
  /** A thread with one message from the user, written at `when`, for the nightly run to process. */
  async function thread(agentId, organizationId, text, when = at('09:00')) {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.threads(id, chat_id, next_message_position) VALUES ($1,$2,2)', [id, await chat(agentId, organizationId)])
    await db.query('INSERT INTO kipster.messages(id, thread_id, position, author_id, parts, final, created_at) VALUES ($1,$2,1,$3,$4::jsonb,true,$5)',
      [randomUUID(), id, actor.personId, JSON.stringify([{ kind: 'text', text }]), when])
    return id
  }
  /** Starts a turn and waits for its execution; `finish()` ends it. */
  async function turn(agentId, organizationId, text, threadId) {
    const chatId = await chat(agentId, organizationId)
    const receipt = await acceptText(db, runtime.jobs, runtime.artifacts, actor, { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: actor.personId }, target: { context: context(organizationId), chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] })
    const index = executions.length
    for (let i = 0; i < 400 && executions.length === index; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const { context: execution, handle } = executions[index]
    let count = 0
    return {
      receipt, memory: (execution.memory ?? []).join('\n\n'),
      tool: (name, args) => handle.callTool(`call-${++count}`, name, args),
      async finish() {
        handle.release({ kind: 'ended', attemptId: execution.attemptId, confirmed: true })
        for (let i = 0; i < 400; i++) {
          if ((await db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [receipt.runId])).rows[0].state === 'completed') return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('turn did not complete')
      },
    }
  }
  /** Runs the nightly memory at `when`. */
  async function night(when) {
    clock.now = when
    await dispatcher.nightlyTick()
  }
  const rows = (sql, params = []) => db.query(sql, params).then(result => result.rows)
  const diaryItems = result => result.items.filter(item => item.kind === 'diary')
  return { runtime, db, actor, installationId, kip, scout, garden, studio, embeddingState, embeddingCalls, calls, thread, turn, night, rows, diaryItems }
}

test('a diary page belongs to its threads\' context: prompts and search_memory show it only where those threads may be seen', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const kipSolo = await ctx.thread(ctx.kip, null, 'Solo day SOLOPAGE321', at('09:00', '2026-10-11'))
  const kipHome = await ctx.thread(ctx.kip, null, 'Lunch plans KIPHOME101')
  const kipOther = await ctx.thread(ctx.kip, null, 'Dinner plans KIPOTHER202', at('10:00'))
  const kipGarden = await ctx.thread(ctx.kip, ctx.garden, 'GARDENSECRET742 budget is 400 euros')
  const scoutGarden = await ctx.thread(ctx.scout, ctx.garden, 'Roses GARDENROSE555')
  const scoutStudio = await ctx.thread(ctx.scout, ctx.studio, 'STUDIOSECRET913 rent is due')
  await ctx.night(at('01:30', '2026-10-13'))
  // Room for every item Kip's tools may see.
  await ctx.runtime.learning.setInstallation(ctx.actor, { searchChunkCount: 30 })
  const query = 'SOLOPAGE321 KIPHOME101 KIPOTHER202 GARDENSECRET742 GARDENROSE555 STUDIOSECRET913 budget rent'

  // (a) Kip in the installation: its own installation pages only, never the Garden page or its thread.
  const kip = await ctx.turn(ctx.kip, null, query)
  assert.match(kip.memory, /KIPHOME101/)
  assert.match(kip.memory, /SOLOPAGE321/)
  for (const hidden of ['GARDENSECRET742', 'GARDENROSE555', 'STUDIOSECRET913', kipGarden, scoutGarden, scoutStudio]) assert.ok(!kip.memory.includes(hidden), hidden)
  // (c) Kip's search_memory with no agent still finds every kip's organization pages.
  const everything = await kip.tool('search_memory', { query })
  assert.equal(everything.status, 'ok')
  const found = ctx.diaryItems(everything)
  assert.deepEqual(found.find(item => item.summary.includes('GARDENSECRET742'))?.threadIds, [kipGarden])
  assert.deepEqual(found.find(item => item.summary.includes('STUDIOSECRET913'))?.threadIds, [scoutStudio])
  assert.equal(found.find(item => item.summary.includes('GARDENSECRET742')).organizationId, ctx.garden)
  await kip.finish()

  // (b) Scout in the Garden: its Garden page, never its Studio page or Studio thread IDs, in the prompt or the tool.
  const scout = await ctx.turn(ctx.scout, ctx.garden, query)
  assert.match(scout.memory, /GARDENROSE555/)
  for (const hidden of ['STUDIOSECRET913', scoutStudio, 'GARDENSECRET742', 'KIPHOME101']) assert.ok(!scout.memory.includes(hidden), hidden)
  const own = await scout.tool('search_memory', { query })
  assert.equal(own.status, 'ok')
  assert.ok(ctx.diaryItems(own).some(item => item.summary.includes('GARDENROSE555')))
  for (const item of ctx.diaryItems(own)) {
    assert.ok(!item.summary.includes('STUDIOSECRET913'), item.summary)
    assert.deepEqual(item.threadIds.filter(id => id !== scoutGarden), [], 'only thread IDs the caller may see')
  }
  await scout.finish()

  // (d) A page covering only the current thread is left out; a page covering it and another visible thread stays.
  const solo = await ctx.turn(ctx.kip, null, query, kipSolo)
  assert.ok(!solo.memory.includes('SOLOPAGE321'), 'the page of the current thread alone adds nothing to its history')
  assert.match(solo.memory, new RegExp(`\\[diary ${day}, threads ${kipHome}, ${kipOther}\\]`))
  await solo.finish()
  const shared = await ctx.turn(ctx.kip, null, query, kipHome)
  assert.match(shared.memory, new RegExp(`\\[diary ${day}, threads ${kipHome}, ${kipOther}\\]\\nDiary of ${day}: KIPHOME101 KIPOTHER202`))
  await shared.finish()

  // One page per kip, day and context.
  assert.deepEqual(await ctx.rows('SELECT agent_id, day::text AS day, organization_id, thread_ids FROM kipster.diary ORDER BY day, agent_id, organization_id NULLS FIRST'), [
    { agent_id: ctx.kip, day: '2026-10-11', organization_id: null, thread_ids: [kipSolo] },
    ...[
      { agent_id: ctx.kip, day, organization_id: null, thread_ids: [kipHome, kipOther] },
      { agent_id: ctx.kip, day, organization_id: ctx.garden, thread_ids: [kipGarden] },
      { agent_id: ctx.scout, day, organization_id: ctx.garden, thread_ids: [scoutGarden] },
      { agent_id: ctx.scout, day, organization_id: ctx.studio, thread_ids: [scoutStudio] },
    ].sort((a, b) => a.agent_id.localeCompare(b.agent_id) || (a.organization_id === null ? -1 : b.organization_id === null ? 1 : a.organization_id.localeCompare(b.organization_id))),
  ])
})

test('a deleted thread leaves nothing in the diary, and the next night rebuilds the page from the remaining threads', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const alpha = await ctx.thread(ctx.kip, null, 'Moving house ALPHAGONE111')
  const bravo = await ctx.thread(ctx.kip, null, 'Booked flights BRAVOSTAY222', at('10:00'))
  await ctx.night(at('01:30', '2026-10-13'))
  assert.deepEqual(await ctx.rows('SELECT summary, thread_ids, embedding IS NOT NULL AS embedded FROM kipster.diary'), [{ summary: `Diary of ${day}: ALPHAGONE111 BRAVOSTAY222`, thread_ids: [alpha, bravo], embedded: true }])

  // The thread goes as thread deletion removes it: the page keeps no text of it and no embedding.
  await ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.installationId])
    await removeThreads(client, ctx.installationId, [alpha], async threadId => removeThreadMemory(client, [threadId]))
  })
  assert.equal((await ctx.rows(`SELECT count(*)::int AS n FROM kipster.diary WHERE summary LIKE '%ALPHAGONE111%'`))[0].n, 0)
  assert.deepEqual(await ctx.rows('SELECT summary, thread_ids, embedding IS NULL AS unembedded, embedding_model FROM kipster.diary'), [{ summary: null, thread_ids: [bravo], unembedded: true, embedding_model: null }])
  // Neither Kip's prompt nor its widest search finds the page while it owes a rebuild.
  const query = 'ALPHAGONE111 BRAVOSTAY222 moving flights'
  const prompt = await turnMemory(ctx.db, ctx.runtime.embedding, { installationId: ctx.installationId, agentId: ctx.kip, organizationId: null, threadId: randomUUID(), query })
  assert.ok(!prompt.sections.join('\n').includes('ALPHAGONE111'))
  const widest = await searchMemory(ctx.db, ctx.installationId, ctx.runtime.embedding, { query, memories: 'all', threads: { agents: null, organizations: 'all' }, memoryCount: 10, lessonCount: 0, itemCount: 30, timeoutMs: 5000 })
  assert.equal(widest.status, 'ok')
  assert.deepEqual(ctx.diaryItems(widest), [], 'a page owing a rebuild is not searched')
  assert.ok(!JSON.stringify(widest).includes('ALPHAGONE111'))

  // The next night is due for the rebuild alone: the page is written again from scratch from the remaining thread.
  const before = ctx.calls.length
  await ctx.night(at('01:30', '2026-10-14'))
  const rebuilt = ctx.calls.slice(before).filter(call => call.maintenance.step === 'diary')
  assert.equal(rebuilt.length, 1)
  assert.match(rebuilt[0].maintenance.instructions, new RegExp(`Day ${day} \\([^)]*\\)\\nCurrent summary: \\(none\\)\\n`))
  assert.match(rebuilt[0].maintenance.instructions, /BRAVOSTAY222/)
  assert.doesNotMatch(rebuilt[0].maintenance.instructions, /ALPHAGONE111/)
  assert.deepEqual(await ctx.rows('SELECT summary, thread_ids, embedding_model FROM kipster.diary'), [{ summary: `Diary of ${day}: BRAVOSTAY222`, thread_ids: [bravo], embedding_model: 'fake-gemma' }])
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failures, failure FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip]), [{ night: '2026-10-14', failures: 0, failure: null }])

  // Deleting the last thread deletes the page.
  await ctx.db.transaction(async client => removeThreads(client, ctx.installationId, [bravo], async threadId => removeThreadMemory(client, [threadId])))
  assert.deepEqual(await ctx.rows('SELECT day FROM kipster.diary'), [])
})

test('deleting an organization deletes its diary pages; the kip\'s other pages stay', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const kept = await ctx.thread(ctx.scout, ctx.garden, 'In the garden GARDENKEEP333')
  await ctx.thread(ctx.scout, ctx.studio, 'Studio plans STUDIOGONE444')
  await ctx.night(at('01:30', '2026-10-13'))
  // Organization deletion's chat and memory steps, as its operation runs them.
  const steps = organizationDeletionSteps({ runtime: ctx.runtime, forgetProviderState: async adapterId => ({ outcome: 'forgotten', adapterId }) })
  const operation = { installationId: ctx.installationId, targetId: ctx.studio }
  for (const name of ['delete-chats', 'delete-memory']) {
    const step = steps.find(item => item.name === name)
    while ((await ctx.db.transaction(client => step.run(client, operation))).status === 'more');
  }
  assert.equal((await ctx.rows(`SELECT count(*)::int AS n FROM kipster.diary WHERE summary LIKE '%STUDIOGONE444%'`))[0].n, 0)
  assert.deepEqual(await ctx.rows('SELECT organization_id, summary, thread_ids FROM kipster.diary'), [{ organization_id: ctx.garden, summary: `Diary of ${day}: GARDENKEEP333`, thread_ids: [kept] }])

  // A page left in an organization without its threads goes with the organization's memory too.
  const left = await createOrganization(ctx.db, ctx.runtime.home, ctx.actor, 'left', { name: 'Left' })
  await ctx.db.query(`INSERT INTO kipster.diary(agent_id, day, organization_id, installation_id, summary) VALUES ($1,$2,$3,$4,'Left over')`, [ctx.scout, day, left.organization.id, ctx.installationId])
  assert.equal(await ctx.db.transaction(client => deleteOrganizationMemory(client, left.organization.id, 10)), 1)
  assert.deepEqual((await ctx.rows('SELECT organization_id FROM kipster.diary')).map(row => row.organization_id), [ctx.garden])
})

test('rows waiting for an embedding are embedded by a later night without new messages, and a failing provider is no failure', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const unembedded = async () => Object.fromEntries((await ctx.rows(`SELECT 'thread_chunks' AS t, count(*) FILTER (WHERE embedding IS NULL)::int AS n FROM kipster.thread_chunks
    UNION ALL SELECT 'memories', count(*) FILTER (WHERE embedding IS NULL)::int FROM kipster.memories
    UNION ALL SELECT 'diary', count(*) FILTER (WHERE embedding IS NULL)::int FROM kipster.diary`)).map(row => [row.t, row.n]))
  const nightRow = async () => (await ctx.rows('SELECT night::text AS night, failures, failure, retry_at FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip]))[0]

  // The provider is down during the run: the thread's work is saved, the night finishes and the rows wait.
  ctx.embeddingState.fail = true
  const threadId = await ctx.thread(ctx.kip, null, 'Garden party PARTY777')
  await ctx.night(at('01:30', '2026-10-13'))
  assert.equal(Number((await ctx.rows('SELECT processed_position FROM kipster.memory_thread_state WHERE thread_id=$1', [threadId]))[0].processed_position), 1)
  assert.deepEqual(await unembedded(), { thread_chunks: 1, memories: 0, diary: 1 })
  assert.deepEqual(await nightRow(), { night: '2026-10-13', failures: 0, failure: null, retry_at: null })
  // No retry within the night.
  const attempts = ctx.embeddingCalls.length
  await ctx.night(at('05:00', '2026-10-13'))
  assert.equal(ctx.embeddingCalls.length, attempts)

  // Still failing at the next sleep time with nothing else to do: tried once, recorded as finished.
  await ctx.night(at('01:30', '2026-10-14'))
  assert.ok(ctx.embeddingCalls.length > attempts, 'the pending rows were tried again')
  assert.deepEqual(await nightRow(), { night: '2026-10-14', failures: 0, failure: null, retry_at: null })
  assert.deepEqual(await unembedded(), { thread_chunks: 1, memories: 0, diary: 1 })

  // The provider recovers: the next night embeds them, with no new message and no model call.
  ctx.embeddingState.fail = false
  const calls = ctx.calls.length
  await ctx.night(at('01:30', '2026-10-15'))
  assert.deepEqual(await unembedded(), { thread_chunks: 0, memories: 0, diary: 0 })
  assert.equal(ctx.calls.length, calls)

  // A card edited through MemoryService on a processed installation is embedded again by the next night.
  const cards = new MemoryService(ctx.db, ctx.installationId)
  const card = await cards.create({ type: 'fact', subject: 'user', statement: 'Hosts a garden party', organizationId: null }, [])
  await ctx.night(at('01:30', '2026-10-16'))
  assert.deepEqual(await unembedded(), { thread_chunks: 0, memories: 0, diary: 0 })
  assert.equal(await cards.update(card, { statement: 'Hosts a garden party every June' }, []), true)
  assert.deepEqual(await unembedded(), { thread_chunks: 0, memories: 1, diary: 0 })
  await ctx.night(at('01:30', '2026-10-17'))
  assert.deepEqual(await ctx.rows('SELECT embedding_model FROM kipster.memories WHERE id=$1', [card]), [{ embedding_model: 'fake-gemma' }])
  assert.equal(ctx.calls.length, calls, 'embedding needs no model call')
  assert.deepEqual(await nightRow(), { night: '2026-10-17', failures: 0, failure: null, retry_at: null })
})

test('an edited card is embedded at the next sleep time of any kip, Kip first when several begin together', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  await ctx.db.query(`UPDATE kipster.agents SET sleep_time = CASE WHEN id=$1 THEN '03:00'::time ELSE '01:00'::time END WHERE id = ANY($2::uuid[])`, [ctx.kip, [ctx.kip, ctx.scout]])
  const nights = async () => Object.fromEntries((await ctx.rows('SELECT agent_id, night::text AS night, started_at IS NOT NULL AS ran FROM kipster.memory_nights')).map(row => [row.agent_id === ctx.kip ? 'kip' : 'scout', { night: row.night, ran: row.ran }]))
  const cards = new MemoryService(ctx.db, ctx.installationId)
  const search = () => searchMemory(ctx.db, ctx.installationId, ctx.runtime.embedding, { query: 'garden party June', memories: 'all', threads: { agents: null, organizations: 'all' }, memoryCount: 10, lessonCount: 0, itemCount: 30, timeoutMs: 5000 })
  const card = await cards.create({ type: 'fact', subject: 'user', statement: 'Hosts a garden party', organizationId: null }, [])

  // Both sleep times begin together: Kip runs for the card alone, Scout's night is recorded idle.
  await ctx.night(at('03:30', '2026-10-13'))
  assert.deepEqual(await nights(), { kip: { night: '2026-10-13', ran: true }, scout: { night: '2026-10-13', ran: false } })
  assert.deepEqual(await ctx.rows('SELECT embedding_model FROM kipster.memories WHERE id=$1', [card]), [{ embedding_model: 'fake-gemma' }])

  // Edited after the night: Scout's sleep time comes first and embeds it, so search finds the edit before Kip's.
  assert.equal(await cards.update(card, { statement: 'Hosts a garden party every June' }, []), true)
  assert.deepEqual((await search()).memories, [])
  await ctx.night(at('01:30', '2026-10-14'))
  assert.deepEqual(await nights(), { kip: { night: '2026-10-13', ran: true }, scout: { night: '2026-10-14', ran: true } })
  assert.deepEqual(await ctx.rows('SELECT embedding_model FROM kipster.memories WHERE id=$1', [card]), [{ embedding_model: 'fake-gemma' }])
  assert.deepEqual((await search()).memories.map(found => found.statement), ['Hosts a garden party every June'])
  // Kip's sleep time then finds nothing waiting.
  const attempts = ctx.embeddingCalls.length
  await ctx.night(at('03:30', '2026-10-14'))
  assert.deepEqual((await nights()).kip.night, '2026-10-14')
  assert.equal(ctx.embeddingCalls.length, attempts)
})

test('without an embedding provider nothing is attempted and nights with only unembedded rows stay idle', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t, { embedding: false })
  await ctx.thread(ctx.kip, null, 'No provider NOPROVIDER888')
  await ctx.night(at('01:30', '2026-10-13'))
  await new MemoryService(ctx.db, ctx.installationId).create({ type: 'fact', subject: 'user', statement: 'Waits for a provider', organizationId: null }, [])
  const calls = ctx.calls.length
  const [ran] = await ctx.rows('SELECT started_at FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip])
  assert.ok(ran.started_at, 'the first night ran')
  await ctx.night(at('01:30', '2026-10-14'))
  assert.equal(ctx.calls.length, calls)
  // The night is recorded idle: no run started, nothing failed, and the rows still wait.
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failures, failure, started_at FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip]), [{ night: '2026-10-14', failures: 0, failure: null, started_at: ran.started_at }])
  assert.deepEqual(await ctx.rows(`SELECT (SELECT count(*)::int FROM kipster.diary WHERE embedding IS NULL) AS diary, (SELECT count(*)::int FROM kipster.memories WHERE embedding IS NULL) AS cards`), [{ diary: 1, cards: 1 }])
})
