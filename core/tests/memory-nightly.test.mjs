process.env.TZ = 'UTC'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher } from '../dist/runtime.js'
import { CardService, embedPending, removeThreadMemory, settleInterruptedMemoryCalls, sleepDay } from '../dist/modules/memory/public.js'
import { EmbeddingProfile } from '../dist/modules/vectors/public.js'
import { removeThreads } from '../dist/modules/conversations/public.js'
import { NIGHTLY_CALLS } from '../dist/workflows/nightly-dispatch.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Kip memory's nightly run and cards service against real PostgreSQL, with a scripted adapter that answers each nightly
// step with canned structured output and a deterministic embedding provider. Mechanics only: no model behaviour.

const day = '2026-10-12'
const at = (time, date = day) => new Date(`${date}T${time}:00Z`)
const words = (count, word = 'word') => Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ')

/** A 768-dimension bag of words, so texts sharing words are near. */
function embedder(calls = []) {
  return {
    id: 'fake-embedding', contractMajor: 1, model: 'fake-gemma',
    async embed(text) {
      calls.push(text)
      const vector = new Array(768).fill(0)
      vector[767] = 0.01
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) vector[createHash('sha256').update(word).digest().readUInt16BE(0) % 767] += 1
      return vector
    },
  }
}

/** Refs of the lines of `instructions` whose marks include `mark`, such as `citable`. */
function refs(instructions, mark) {
  return [...instructions.matchAll(/^\[(m\d+)\] [^(\n]*\(([^)]*)\)/gm)].filter(match => match[2].split(', ').includes(mark)).map(match => match[1])
}

/** A direct adapter that runs text with the deterministic fixture and answers memory steps from `script`. */
function scripted(host, script) {
  const inner = fixtureAdapter(host)
  const calls = []
  const adapter = {
    id: inner.id, version: inner.version, contractMajor: 1, recoveryVersions: inner.recoveryVersions, recoveryStateScopes: inner.recoveryStateScopes,
    readiness: () => inner.readiness(), durableReconcile: request => inner.durableReconcile(request), close: () => inner.close(),
    async execute(context) {
      if (context.kind !== 'maintenance') return inner.execute(context)
      const call = { context, cancelled: false }
      calls.push(call)
      let finish
      const ended = new Promise(resolve => { finish = resolve })
      const events = (async function* () {
        const answer = await Promise.race([Promise.resolve().then(() => script(context, calls.length)), ended])
        if (call.cancelled) { yield { kind: 'failed', attemptId: context.attemptId, confirmedEnded: true, message: 'cancelled' }; return }
        if (answer instanceof Error) { yield { kind: 'failed', attemptId: context.attemptId, confirmedEnded: true, message: answer.message }; return }
        yield { kind: 'text', attemptId: context.attemptId, messageId: 'answer', text: typeof answer === 'string' ? answer : JSON.stringify(answer), final: true }
        yield { kind: 'ended', attemptId: context.attemptId, confirmed: true }
      })()
      return { events, async cancel() { call.cancelled = true; finish('cancelled'); return { acknowledged: true, confirmedEnded: true } }, async reconcile() { return 'ended' } }
    },
  }
  return { adapter, calls }
}

/** Default answers: one topic per window, no card changes, a diary line per day. */
const quiet = context => {
  const { step, instructions } = context.maintenance
  if (step === 'chunks') return { topics: [{ start: 'm1', title: 'Topic' }] }
  if (step === 'cards') return { changes: [] }
  if (step === 'diary') return { days: [...instructions.matchAll(/^Day (\d{4}-\d\d-\d\d)/gm)].map(match => ({ day: match[1], summary: `Diary of ${match[1]}` })) }
  return { core: [] }
}

async function setup(t, { embedding = true, script = quiet, executionLimit } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_nightly_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-nightly-home-'))
  const clock = { now: at('03:00') }
  const embeddingCalls = []
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Sam', organization: 'Garden', rootAgent: 'Kip' }, clock: () => clock.now, ...(executionLimit ? { executionLimit } : {}), ...(embedding ? { embedding: embedder(embeddingCalls) } : {}) })
  const installationId = runtime.bootstrap.installationId
  const actor = { installationId, personId: runtime.bootstrap.ownerId }
  const kip = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [kip, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const state = { script }
  const host = { now: () => new Date().toISOString(), async invokeTool() { throw new Error('No tools') } }
  const { adapter, calls } = scripted(host, (context, n) => state.script(context, n))
  const dispatchers = []
  const dispatcher = () => { const created = new TextDispatcher(runtime, adapter); dispatchers.push(created); return created }
  const holders = []
  t.after(async () => {
    for (const created of dispatchers) await created.close().catch(() => undefined)
    for (const holder of holders) await holder.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const db = runtime.db
  /** A thread of `agentId` with the given messages; `user` messages are the owner's. */
  async function thread(messages, { agentId = kip, organizationId = null } = {}) {
    let chat = (await db.query('SELECT id FROM kipster.direct_chats WHERE agent_id=$1 AND context_kind=$2 AND context_id=$3', [agentId, organizationId ? 'organization' : 'installation', organizationId ?? installationId])).rows[0]?.id
    if (!chat) {
      chat = randomUUID()
      await db.query('INSERT INTO kipster.direct_chats(id, installation_id, caller_id, context_kind, context_id, agent_id) VALUES ($1,$2,$3,$4,$5,$6)', [chat, installationId, actor.personId, organizationId ? 'organization' : 'installation', organizationId ?? installationId, agentId])
    }
    const id = randomUUID()
    await db.query('INSERT INTO kipster.threads(id, chat_id) VALUES ($1,$2)', [id, chat])
    await append(id, messages, agentId)
    return id
  }
  async function append(threadId, messages, agentId = kip) {
    const ids = []
    for (const message of messages) {
      const position = Number((await db.query('UPDATE kipster.threads SET next_message_position=next_message_position+1 WHERE id=$1 RETURNING next_message_position - 1 AS position', [threadId])).rows[0].position)
      const id = randomUUID()
      await db.query('INSERT INTO kipster.messages(id, thread_id, position, author_id, parts, final, progress, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)',
        [id, threadId, position, message.author === 'user' ? actor.personId : !message.author || message.author === 'kip' ? agentId : message.author, JSON.stringify([{ kind: 'text', text: message.text }]), message.final ?? true, message.progress ?? false, message.at ?? at('09:00')])
      ids.push(id)
    }
    return ids
  }
  const organization = async (name = 'Studio') => {
    const id = randomUUID()
    await db.query(`INSERT INTO kipster.organizations(id, installation_id, display_name, provisioned) VALUES ($1,$2,$3,true)`, [id, installationId, name])
    return id
  }
  const agent = async (name, sleepTime = null) => {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.agents(id, installation_id, display_name, provisioned, sleep_time) VALUES ($1,$2,$3,true,$4)', [id, installationId, name, sleepTime])
    return id
  }
  const rows = (sql, params = []) => db.query(sql, params).then(result => result.rows)
  const processed = async threadId => Number((await rows('SELECT processed_position FROM kipster.memory_thread_state WHERE thread_id=$1', [threadId]))[0]?.processed_position ?? 0)
  const holder = () => { const created = new Postgres(url.href, 1); holders.push(created); return created }
  await runtime.learning.setInstallation(actor, { enabled: true })
  return { runtime, db, actor, installationId, kip, clock, calls, state, dispatcher, thread, append, organization, agent, rows, processed, embeddingCalls, holder, cards: new CardService(db, installationId, runtime.embedding) }
}

test('a nightly run saves full-text chunks, cards with their sources, a diary page and the processed position, then embeds them', { skip: noDatabase }, async t => {
  const ctx = await setup(t, {
    script: context => {
      const { step, instructions } = context.maintenance
      if (step === 'cards') {
        const [first] = refs(instructions, 'citable')
        return { changes: [
          { action: 'add', card: null, type: 'event', subject: 'user', statement: 'Dentist on 13 Oct 2026 at 3 pm', details: [{ key: 'date', value: '2026-10-13' }, { key: 'time', value: '15:00' }], confirmed: true, sources: [first] },
          { action: 'skip', card: null, type: 'fact', subject: 'user', statement: 'ignored', details: [], confirmed: false, sources: [first] },
        ] }
      }
      return quiet(context)
    },
  })
  const threadId = await ctx.thread([
    { author: 'user', text: 'Move my dentist appointment to 13 October at 3 pm.', at: at('09:14') },
    { author: 'kip', text: 'Done, the dentist is now on 13 October at 15:00.', at: at('09:15') },
  ])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()

  // A short thread is one chunk, without a model call for its boundaries.
  assert.deepEqual(ctx.calls.map(call => call.context.maintenance.step), ['cards', 'diary'])
  for (const { context } of ctx.calls) {
    assert.equal(context.kind, 'maintenance')
    assert.equal(context.maintenance.task, 'memory')
    assert.deepEqual(context.maintenance.settings, { adapterId: 'deterministic-fixture', modelId: 'fixture-model' })
    assert.equal(context.agentId, ctx.kip)
    for (const absent of ['tools', 'prompt', 'workingDirectory', 'memory']) assert.equal(context[absent], undefined)
  }
  const [chunk] = await ctx.rows('SELECT * FROM kipster.thread_chunks WHERE thread_id=$1', [threadId])
  assert.equal(chunk.title, 'Move my dentist appointment to 13 October at 3 pm.')
  assert.equal(chunk.text, 'Mon 12 Oct 2026, with Kip\n\nSam, 09:14:\nMove my dentist appointment to 13 October at 3 pm.\n\nKip, 09:15:\nDone, the dentist is now on 13 October at 15:00.')
  assert.deepEqual([Number(chunk.from_position), Number(chunk.to_position), chunk.started_at.toISOString(), chunk.ended_at.toISOString(), chunk.agent_id, chunk.organization_id], [1, 2, at('09:14').toISOString(), at('09:15').toISOString(), ctx.kip, null])
  const [card] = await ctx.rows('SELECT * FROM kipster.cards')
  assert.deepEqual([card.type, card.subject, card.statement, card.details, card.confirmed, card.organization_id, card.valid_to, card.core], ['event', 'user', 'Dentist on 13 Oct 2026 at 3 pm', { date: '2026-10-13', time: '15:00' }, true, null, null, true])
  const userMessage = (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1 AND position=1', [threadId]))[0].id
  assert.deepEqual(await ctx.rows('SELECT card_id, thread_id, message_id FROM kipster.card_sources'), [{ card_id: card.id, thread_id: threadId, message_id: userMessage }])
  assert.deepEqual(await ctx.rows(`SELECT day::text AS day, summary, thread_ids FROM kipster.diary WHERE agent_id=$1`, [ctx.kip]), [{ day, summary: `Diary of ${day}`, thread_ids: [threadId] }])
  assert.equal(await ctx.processed(threadId), 2)
  // Every row is embedded with the document format and names its model.
  for (const table of ['thread_chunks', 'cards', 'diary']) assert.deepEqual(await ctx.rows(`SELECT DISTINCT embedding_model, embedding IS NULL AS missing FROM kipster.${table}`), [{ embedding_model: 'fake-gemma', missing: false }], table)
  assert.ok(ctx.embeddingCalls.includes(`title: Move my dentist appointment to 13 October at 3 pm. | text: ${chunk.text}`))
  // Calls ran as settled work and released their permits.
  assert.deepEqual(await ctx.rows(`SELECT m.step, m.state, i.state AS intent, a.state AS attempt FROM kipster.memory_calls m JOIN kipster.work_intents i ON i.id=m.id JOIN kipster.attempts a ON a.intent_id=m.id ORDER BY m.created_at`),
    [{ step: 'cards', state: 'completed', intent: 'settled', attempt: 'settled' }, { step: 'diary', state: 'completed', intent: 'settled', attempt: 'settled' }])
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 0)
  const [night] = await ctx.rows('SELECT night::text AS night, owner, failures FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip])
  assert.deepEqual(night, { night: '2026-10-13', owner: null, failures: 0 })

  // Nothing new: the next tick and the next night make no calls.
  await dispatcher.nightlyTick()
  ctx.clock.now = at('01:30', '2026-10-14')
  await dispatcher.nightlyTick()
  assert.equal(ctx.calls.length, 2)
})

test('the sleep-time schedule runs each kip with memory on at its own sleep time, once per night, and skips kips with memory off', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const early = await ctx.agent('Early', '00:30')
  const late = await ctx.agent('Late', '05:00')
  const off = await ctx.agent('Off')
  await ctx.db.query('UPDATE kipster.agents SET learning_enabled=false WHERE id=$1', [off])
  const threads = {}
  for (const [name, agentId] of [['kip', ctx.kip], ['early', early], ['late', late], ['off', off]]) threads[name] = await ctx.thread([{ author: 'user', text: `Hello ${name}` }], { agentId })
  // Each kip's last night is the 12th, so the 13th's sleep day starts at its sleep time.
  for (const agentId of [ctx.kip, early, late, off]) await ctx.db.query('INSERT INTO kipster.memory_nights(agent_id, installation_id, night) VALUES ($1,$2,$3)', [agentId, ctx.installationId, day])
  assert.equal(sleepDay(at('00:29', '2026-10-13'), '00:30'), day)
  assert.equal(sleepDay(at('00:30', '2026-10-13'), '00:30'), '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  const ran = () => [...new Set(ctx.calls.map(call => call.context.agentId))]

  ctx.clock.now = at('00:45', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.deepEqual(ran(), [early])
  ctx.clock.now = at('01:00', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.deepEqual(ran(), [early, ctx.kip], 'Kip follows the installation default, 01:00')
  ctx.clock.now = at('04:59', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.deepEqual(ran(), [early, ctx.kip])
  ctx.clock.now = at('05:00', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.deepEqual(ran(), [early, ctx.kip, late])
  assert.equal(await ctx.processed(threads.off), 0, 'memory off: skipped')
  for (const name of ['kip', 'early', 'late']) assert.equal(await ctx.processed(threads[name]), 1, name)

  // A message during the day waits for the next sleep time.
  await ctx.append(threads.early, [{ author: 'user', text: 'Later that day', at: at('12:00', '2026-10-13') }], early)
  ctx.clock.now = at('12:30', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threads.early), 1)
  ctx.clock.now = at('00:30', '2026-10-14')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threads.early), 2)

  // The installation switch turns memory off for every kip.
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: false })
  await ctx.append(threads.kip, [{ author: 'user', text: 'Off now', at: at('12:00', '2026-10-14') }])
  const before = ctx.calls.length
  ctx.clock.now = at('02:00', '2026-10-15')
  await dispatcher.nightlyTick()
  assert.equal(ctx.calls.length, before)
  assert.equal(await ctx.processed(threads.kip), 1)
})

test('a long thread splits at the returned boundaries, the size cap is enforced, and a grown thread has its chunks rewritten', { skip: noDatabase }, async t => {
  const ctx = await setup(t, {
    script: context => {
      if (context.maintenance.step !== 'chunks') return quiet(context)
      const all = [...context.maintenance.instructions.matchAll(/^\[(m\d+)\]/gm)].map(match => match[1])
      // Topics start at m1 and m3; an unknown ref and an out-of-order start are dropped.
      return { topics: [{ start: 'm1', title: 'Berlin flights' }, { start: 'm9', title: 'Unknown' }, { start: 'm3', title: 'Berlin hotel' }, { start: 'm2', title: 'Backwards' }].filter(topic => all.includes(topic.start) || topic.start === 'm9') }
    },
  })
  const threadId = await ctx.thread([
    { author: 'user', text: `Flights to Berlin ${words(150, 'flight')}`, at: at('09:00') },
    { author: 'kip', text: words(150, 'option'), at: at('09:01') },
    { author: 'user', text: `Hotel near Priya ${words(400, 'hotel')}`, at: at('09:02') },
    { author: 'kip', text: words(300, 'room'), at: at('09:03') },
    { author: 'kip', text: 'Progress note', progress: true, at: at('09:03') },
    { author: 'user', text: words(100, 'more'), at: at('09:04') },
  ])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()
  const chunks = async () => (await ctx.rows('SELECT from_position, to_position, title, text FROM kipster.thread_chunks WHERE thread_id=$1 ORDER BY from_position', [threadId]))
    .map(row => ({ from: Number(row.from_position), to: Number(row.to_position), title: row.title, words: row.text.split(/\s+/).length, text: row.text }))
  const first = await chunks()
  // Topic two (messages 3, 4 and 6: 800 words) is split further at a message boundary.
  assert.deepEqual(first.map(({ from, to, title }) => ({ from, to, title })), [
    { from: 1, to: 2, title: 'Berlin flights' }, { from: 3, to: 3, title: 'Berlin hotel' }, { from: 4, to: 6, title: 'Berlin hotel (2)' },
  ])
  for (const chunk of first) assert.ok(chunk.words <= 600 + 30, `${chunk.title}: ${chunk.words} words`)
  assert.ok(first[0].text.includes(`Flights to Berlin ${words(150, 'flight')}`), 'chunks hold messages in full')
  assert.ok(!first.some(chunk => chunk.text.includes('Progress note')), 'progress notes are not conversation')
  assert.equal(await ctx.processed(threadId), 6)

  // The thread grows: chunks are rewritten from the last chunk onward, earlier ones stay.
  const kept = (await ctx.rows('SELECT id FROM kipster.thread_chunks WHERE thread_id=$1 AND from_position < 4', [threadId])).map(row => row.id)
  await ctx.append(threadId, [{ author: 'user', text: 'And a table for dinner', at: at('10:00', '2026-10-13') }])
  ctx.clock.now = at('01:30', '2026-10-14')
  await dispatcher.nightlyTick()
  const second = await chunks()
  assert.deepEqual(second.map(({ from, to }) => [from, to]), [[1, 2], [3, 3], [4, 7]])
  assert.ok(second[2].text.includes('Tue 13 Oct 2026 10:00:\nAnd a table for dinner'), 'a message on another day names its date')
  assert.deepEqual((await ctx.rows('SELECT id FROM kipster.thread_chunks WHERE thread_id=$1 AND from_position < 4', [threadId])).map(row => row.id).sort(), kept.sort())
  assert.equal(await ctx.processed(threadId), 7)
  // The diary has a page per day covered; each day names the thread once.
  assert.deepEqual(await ctx.rows('SELECT day::text AS day, thread_ids FROM kipster.diary ORDER BY day'), [{ day, thread_ids: [threadId] }, { day: '2026-10-13', thread_ids: [threadId] }])

  // Processing stops before a message still being written.
  await ctx.append(threadId, [{ author: 'user', text: 'Final one', at: at('11:00', '2026-10-14') }, { author: 'kip', text: 'Drafting', final: false, at: at('11:01', '2026-10-14') }])
  ctx.clock.now = at('01:30', '2026-10-15')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threadId), 8)
})

test('a card citing a kip message or an unknown ref is rejected; organization cards carry their organization; replace ends the old card', { skip: noDatabase }, async t => {
  const answers = []
  const ctx = await setup(t, {
    script: context => {
      if (context.maintenance.step !== 'cards') return quiet(context)
      const { instructions } = context.maintenance
      const user = refs(instructions, 'citable')
      const kip = [...instructions.matchAll(/^\[(m\d+)\] Kip \(kip/gm)].map(match => match[1])
      const changeable = [...instructions.matchAll(/^\[(k\d+)\] .*\(changeable\)$/gm)].map(match => match[1])
      const card = (statement, sources, extra = {}) => ({ action: 'add', card: null, type: 'preference', subject: 'user', statement, details: [], confirmed: true, sources, ...extra })
      const answer = changeable.length
        ? { changes: [card('Vegetarian since Oct 2026', user, { action: 'replace', card: changeable[0] })] }
        : { changes: [card('Loves steak', user), card('Kip suggested it', kip), card('Unknown ref', ['m99']), card('No sources', [])] }
      answers.push(answer)
      return answer
    },
  })
  const studio = await ctx.organization('Studio')
  const home = await ctx.thread([{ author: 'user', text: 'I love steak' }, { author: 'kip', text: 'Noted, you love steak' }])
  const work = await ctx.thread([{ author: 'user', text: 'At the studio I eat steak' }], { organizationId: studio })
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()
  const cards = await ctx.rows('SELECT id, statement, organization_id, valid_to, replaced_by, core FROM kipster.cards ORDER BY organization_id NULLS FIRST, created_at')
  assert.deepEqual(cards.map(card => [card.statement, card.organization_id, card.core]), [['Loves steak', null, true], ['Loves steak', studio, false]], 'only the card citing the user\'s own message is saved; the organization card is never core')
  const sources = await ctx.rows('SELECT c.organization_id, s.thread_id FROM kipster.card_sources s JOIN kipster.cards c ON c.id=s.card_id ORDER BY c.organization_id NULLS FIRST')
  assert.deepEqual(sources.map(row => [row.organization_id, row.thread_id]), [[null, home], [studio, work]])
  const chunk = (await ctx.rows('SELECT organization_id, text FROM kipster.thread_chunks WHERE thread_id=$1', [work]))[0]
  assert.equal(chunk.organization_id, studio)
  assert.match(chunk.text, /^Mon 12 Oct 2026, with Kip in Studio\n/)

  // A later thread replaces the installation card: the old card keeps its row, ends and points to its replacement.
  const later = await ctx.thread([{ author: 'user', text: 'I am vegetarian now, no more steak', at: at('09:00', '2026-10-13') }])
  ctx.clock.now = at('01:30', '2026-10-14')
  await dispatcher.nightlyTick()
  const [old] = await ctx.rows('SELECT valid_to, replaced_by, core FROM kipster.cards WHERE id=$1', [cards[0].id])
  const [replacement] = await ctx.rows('SELECT id, statement, organization_id, valid_to, core FROM kipster.cards WHERE id=$1', [old.replaced_by])
  assert.ok(old.valid_to instanceof Date)
  assert.equal(old.core, false)
  assert.deepEqual([replacement.statement, replacement.organization_id, replacement.valid_to, replacement.core], ['Vegetarian since Oct 2026', null, null, true])
  assert.equal((await ctx.rows('SELECT thread_id FROM kipster.card_sources WHERE card_id=$1', [replacement.id]))[0].thread_id, later)
  // The organization card was shown for comparison but could not be changed from an installation thread.
  const prompt = ctx.calls.filter(call => call.context.maintenance.step === 'cards').at(-1).context.maintenance
  assert.doesNotMatch(prompt.instructions, /At the studio/)
  assert.deepEqual(prompt.outputSchema.properties.changes.items.properties.card.enum, ['k1', null])
})

test('core cards are re-picked up to the core card count among current installation cards, with the model ranking', { skip: noDatabase }, async t => {
  const ctx = await setup(t, {
    script: context => {
      const { step, instructions } = context.maintenance
      if (step === 'core') {
        // Ranks every card, last listed first, and an unknown ref.
        const listed = [...instructions.matchAll(/^\[(k\d+)\]/gm)].map(match => match[1])
        return { core: ['k99', ...listed.reverse()] }
      }
      if (step === 'cards') return { changes: [{ action: 'add', card: null, type: 'fact', subject: 'user', statement: 'New fact', details: [], confirmed: true, sources: refs(instructions, 'citable') }] }
      return quiet(context)
    },
  })
  const studio = await ctx.organization()
  const source = await ctx.thread([{ author: 'user', text: 'Facts' }])
  const [message] = (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1', [source])).map(row => row.id)
  await ctx.db.query('INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,1)', [source, ctx.installationId])
  for (let i = 0; i < 4; i++) await ctx.cards.create({ type: 'fact', subject: 'user', statement: `Fact ${i}`, organizationId: null }, [{ threadId: source, messageId: message }])
  const work = await ctx.thread([{ author: 'user', text: 'Studio fact' }], { organizationId: studio })
  await ctx.db.query('INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,1)', [work, ctx.installationId])
  const workMessage = (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1', [work]))[0].id
  await ctx.cards.create({ type: 'fact', subject: 'studio', statement: 'Studio fact', organizationId: studio }, [{ threadId: work, messageId: workMessage }])
  await ctx.db.query('UPDATE kipster.cards SET core=true WHERE organization_id IS NOT NULL')
  await ctx.runtime.learning.setInstallation(ctx.actor, { coreCardCount: 3 })
  await ctx.thread([{ author: 'user', text: 'One more fact' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()
  const core = await ctx.rows('SELECT statement FROM kipster.cards WHERE core ORDER BY statement')
  assert.equal(core.length, 3)
  assert.ok(!core.some(card => card.statement === 'Studio fact'), 'organization cards never become core')
  const ranked = ctx.calls.find(call => call.context.maintenance.step === 'core').context.maintenance
  assert.equal(ranked.outputSchema.properties.core.maxItems, 3)
  assert.doesNotMatch(ranked.instructions, /Studio fact/)
  // Five current installation cards, three core: the last three listed, as the model ranked them.
  const listed = [...ranked.instructions.matchAll(/^\[k\d+\] fact \| user \| (.*?)( \(confirmed\))?$/gm)].map(match => match[1])
  assert.deepEqual(core.map(card => card.statement), listed.slice(-3).sort())

  // While they fit the count, every current installation card is core, without a model call.
  await ctx.runtime.learning.setInstallation(ctx.actor, { coreCardCount: 10 })
  await ctx.thread([{ author: 'user', text: 'Yet another', at: at('09:00', '2026-10-13') }])
  ctx.clock.now = at('01:30', '2026-10-14')
  const before = ctx.calls.filter(call => call.context.maintenance.step === 'core').length
  await dispatcher.nightlyTick()
  assert.equal(ctx.calls.filter(call => call.context.maintenance.step === 'core').length, before)
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.cards WHERE core')).at(0).n, 6)
})

test('a failed or cancelled call leaves the position unchanged, and a later run catches up without duplicates', { skip: noDatabase }, async t => {
  let mode = 'fail'
  let started
  const hanging = new Promise(resolve => { started = resolve })
  const ctx = await setup(t, {
    script: context => {
      if (context.maintenance.step === 'diary' && mode === 'fail') return new Error('provider failed')
      if (context.maintenance.step === 'diary' && mode === 'hang') { started(); return new Promise(() => {}) }
      if (context.maintenance.step === 'cards') return { changes: [{ action: 'add', card: null, type: 'fact', subject: 'user', statement: 'Likes tea', details: [], confirmed: true, sources: refs(context.maintenance.instructions, 'citable') }] }
      return quiet(context)
    },
  })
  const threadId = await ctx.thread([{ author: 'user', text: 'I like tea' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const first = ctx.dispatcher()
  await first.start()
  await first.nightlyTick()
  const empty = async () => (await ctx.rows(`SELECT (SELECT count(*) FROM kipster.thread_chunks) + (SELECT count(*) FROM kipster.cards) + (SELECT count(*) FROM kipster.diary)
    + (SELECT count(*) FROM kipster.memory_thread_state) AS n`))[0].n
  assert.equal(Number(await empty()), 0, 'a failed step saves nothing for the thread')
  const [night] = await ctx.rows('SELECT night, failures, failure, retry_at, owner FROM kipster.memory_nights WHERE agent_id=$1', [ctx.kip])
  assert.deepEqual([night.night, night.failures, night.owner], [null, 1, null])
  assert.match(night.failure, /Nightly diary step failed: provider failed/)
  assert.deepEqual(await ctx.rows(`SELECT step, state, failure FROM kipster.memory_calls ORDER BY created_at`), [{ step: 'cards', state: 'completed', failure: null }, { step: 'diary', state: 'failed', failure: 'provider failed' }])
  // Retried after a while, not at once.
  await first.nightlyTick()
  assert.equal(ctx.calls.length, 2)

  // A run cancelled at shutdown also leaves the position, and frees the capacity.
  mode = 'hang'
  await ctx.db.query('UPDATE kipster.memory_nights SET retry_at=NULL')
  const tick = first.nightlyTick()
  await hanging
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 1, 'one nightly attempt holds one permit')
  await first.close()
  await tick
  assert.equal(await ctx.processed(threadId), 0)
  assert.equal(ctx.calls.at(-1).cancelled, true)
  assert.deepEqual((await ctx.rows(`SELECT state, failure FROM kipster.memory_calls ORDER BY created_at DESC LIMIT 1`))[0], { state: 'failed', failure: 'Cancelled at shutdown' })
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 0)
  assert.equal((await ctx.rows('SELECT owner FROM kipster.memory_nights'))[0].owner, null)

  // The next process catches up once: one chunk, one card, one diary page.
  mode = 'ok'
  const second = ctx.dispatcher()
  await second.start()
  await second.nightlyTick()
  assert.equal(await ctx.processed(threadId), 1)
  for (const table of ['thread_chunks', 'cards', 'card_sources', 'diary']) assert.equal((await ctx.rows(`SELECT count(*)::int AS n FROM kipster.${table}`))[0].n, 1, table)
  assert.deepEqual(await ctx.rows('SELECT failures, failure, night::text AS night FROM kipster.memory_nights'), [{ failures: 0, failure: null, night: '2026-10-13' }])
  await second.nightlyTick()
  for (const table of ['thread_chunks', 'cards', 'diary']) assert.equal((await ctx.rows(`SELECT count(*)::int AS n FROM kipster.${table}`))[0].n, 1, table)
})

test('a call lost with its process is failed by the next coordinator and its permit freed', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const threadId = await ctx.thread([{ author: 'user', text: 'Hi' }])
  // A process died during a call: its intent, issued attempt, permit and agent claim remain.
  const intent = randomUUID(), attempt = randomUUID(), lost = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.work_intents(id, installation_id, state, generation) VALUES ($1,$2,'issued',1)`, [intent, ctx.installationId])
  await ctx.db.query(`INSERT INTO kipster.memory_calls(id, installation_id, agent_id, thread_id, step) VALUES ($1,$2,$3,$4,'diary')`, [intent, ctx.installationId, ctx.kip, threadId])
  await ctx.db.query(`INSERT INTO kipster.attempts(id, intent_id, generation, incarnation, state) VALUES ($1,$2,1,$3,'issued')`, [attempt, intent, lost])
  await ctx.db.query('INSERT INTO kipster.owned_permits(attempt_id, installation_id) VALUES ($1,$2)', [attempt, ctx.installationId])
  await ctx.db.query('INSERT INTO kipster.memory_nights(agent_id, installation_id, owner) VALUES ($1,$2,$3)', [ctx.kip, ctx.installationId, lost])
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  assert.deepEqual(await ctx.rows(`SELECT m.state, m.failure, a.state AS attempt, i.state AS intent FROM kipster.memory_calls m JOIN kipster.attempts a ON a.intent_id=m.id JOIN kipster.work_intents i ON i.id=m.id`),
    [{ state: 'failed', failure: 'Interrupted', attempt: 'settled', intent: 'settled' }])
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 0)
  ctx.clock.now = at('01:30', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threadId), 1)
})

test('a failed core re-pick is caught up by the retry, though its threads were saved', { skip: noDatabase }, async t => {
  let fail = true
  const ctx = await setup(t, {
    script: context => {
      const { step, instructions } = context.maintenance
      if (step === 'core') {
        if (fail) return new Error('provider failed')
        return { core: [[...instructions.matchAll(/^\[(k\d+)\] fact \| user \| New fact/gm)][0][1]] }
      }
      if (step === 'cards') return { changes: [{ action: 'add', card: null, type: 'fact', subject: 'user', statement: 'New fact', details: [], confirmed: true, sources: refs(instructions, 'citable') }] }
      return quiet(context)
    },
  })
  // The core set is already full, so only the card change calls for a re-pick.
  const source = await ctx.thread([{ author: 'user', text: 'Old fact' }])
  await ctx.db.query('INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,1)', [source, ctx.installationId])
  const [message] = (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1', [source])).map(row => row.id)
  await ctx.cards.create({ type: 'fact', subject: 'user', statement: 'Old fact', organizationId: null }, [{ threadId: source, messageId: message }])
  await ctx.db.query('UPDATE kipster.cards SET core=true')
  await ctx.runtime.learning.setInstallation(ctx.actor, { coreCardCount: 1 })
  const threadId = await ctx.thread([{ author: 'user', text: 'A new fact' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threadId), 1, 'the thread is saved before the re-pick')
  assert.deepEqual(await ctx.rows('SELECT failures, repick, retry_at FROM kipster.memory_nights'), [{ failures: 1, repick: true, retry_at: at('02:00', '2026-10-13') }])
  assert.deepEqual(await ctx.rows('SELECT statement FROM kipster.cards WHERE core'), [{ statement: 'Old fact' }])

  // No thread waits, but the retry re-picks the core cards.
  fail = false
  ctx.clock.now = at('02:01', '2026-10-13')
  await dispatcher.nightlyTick()
  assert.equal(ctx.calls.filter(call => call.context.maintenance.step === 'core').length, 2)
  assert.deepEqual(await ctx.rows('SELECT statement FROM kipster.cards WHERE core'), [{ statement: 'New fact' }])
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failures, failure, repick, owner FROM kipster.memory_nights'), [{ night: '2026-10-13', failures: 0, failure: null, repick: false, owner: null }])

  // A re-pick still owed after the night gave up is done the next night.
  await ctx.db.query(`UPDATE kipster.memory_nights SET repick=true, failure='gave up', failures=0, retry_at=NULL`)
  ctx.clock.now = at('01:30', '2026-10-14')
  await dispatcher.nightlyTick()
  assert.equal(ctx.calls.filter(call => call.context.maintenance.step === 'core').length, 3)
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failure, repick FROM kipster.memory_nights'), [{ night: '2026-10-14', failure: null, repick: false }])
})

test('a card replaced or deleted while the model ranks the core cards is never made core again', { skip: noDatabase }, async t => {
  const pending = []
  const ctx = await setup(t, {
    script: context => {
      const { step, instructions } = context.maintenance
      if (step === 'core') return new Promise(resolve => pending.push(() => resolve({ core: [[...instructions.matchAll(/^\[(k\d+)\] fact \| user \| Old fact/gm)][0][1]] })))
      if (step === 'cards') return { changes: [{ action: 'add', card: null, type: 'fact', subject: 'user', statement: 'New fact', details: [], confirmed: true, sources: refs(instructions, 'citable') }] }
      return quiet(context)
    },
  })
  const source = await ctx.thread([{ author: 'user', text: 'Old fact' }])
  await ctx.db.query('INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,1)', [source, ctx.installationId])
  const sources = (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1', [source])).map(row => ({ threadId: source, messageId: row.id }))
  const old = await ctx.cards.create({ type: 'fact', subject: 'user', statement: 'Old fact', organizationId: null }, sources)
  await ctx.db.query('UPDATE kipster.cards SET core=true')
  await ctx.runtime.learning.setInstallation(ctx.actor, { coreCardCount: 1 })
  await ctx.thread([{ author: 'user', text: 'A new fact' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  const core = () => ctx.rows('SELECT statement, valid_to IS NOT NULL AS ended FROM kipster.cards WHERE core')

  // Replaced: the ranked card's place goes to its current replacement.
  let tick = dispatcher.nightlyTick()
  while (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  const refined = await ctx.cards.replace(old, { type: 'fact', subject: 'user', statement: 'Refined fact' }, sources)
  assert.equal((await ctx.cards.get(old)).core, false)
  pending.shift()()
  await tick
  assert.deepEqual(await core(), [{ statement: 'Refined fact', ended: false }])
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failure, repick FROM kipster.memory_nights'), [{ night: '2026-10-13', failure: null, repick: false }])

  // Deleted: no card takes its place until the next re-pick.
  await ctx.db.query(`UPDATE kipster.cards SET statement='Old fact' WHERE id=$1`, [refined])
  await ctx.db.query('UPDATE kipster.memory_nights SET repick=true')
  ctx.clock.now = at('01:30', '2026-10-14')
  tick = dispatcher.nightlyTick()
  while (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(await ctx.cards.delete([refined]), 1)
  pending.shift()()
  await tick
  assert.deepEqual(await core(), [])
  assert.deepEqual(await ctx.rows('SELECT night::text AS night, failure, repick FROM kipster.memory_nights'), [{ night: '2026-10-14', failure: null, repick: false }])
  assert.deepEqual((await ctx.rows('SELECT statement, core FROM kipster.cards WHERE id=$1', [old])), [{ statement: 'Old fact', core: false }])
})

test('a former owner\'s late answer or failure neither saves nor changes the new owner\'s claim', { skip: noDatabase }, async t => {
  const pending = []
  const ctx = await setup(t, {
    script: context => context.maintenance.step === 'diary' ? new Promise(resolve => pending.push(resolve)) : quiet(context),
  })
  const threadId = await ctx.thread([{ author: 'user', text: 'Hi' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const former = ctx.dispatcher()
  await former.start()
  const replacement = randomUUID()
  // Recovery by the next coordinator: it fails the call, frees its permit and runs the agent itself.
  const takeOver = async () => {
    while (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
    await ctx.db.transaction(client => settleInterruptedMemoryCalls(client, ctx.installationId, [], null))
    await ctx.db.query('UPDATE kipster.memory_nights SET owner=$1', [replacement])
  }
  const claim = () => ctx.rows('SELECT owner, failures, failure, retry_at, night FROM kipster.memory_nights')

  for (const late of [new Error('late failure'), { days: [{ day, summary: 'Late diary' }] }]) {
    await ctx.db.query('UPDATE kipster.memory_nights SET owner=NULL')
    const tick = former.nightlyTick()
    await takeOver()
    pending.shift()(late)
    await tick
    assert.deepEqual(await claim(), [{ owner: replacement, failures: 0, failure: null, retry_at: null, night: null }])
    assert.equal(await ctx.processed(threadId), 0)
    for (const table of ['thread_chunks', 'diary']) assert.equal((await ctx.rows(`SELECT count(*)::int AS n FROM kipster.${table}`))[0].n, 0, table)
  }
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 0)

  // Once the agent is free again, a run saves the thread.
  await ctx.db.query('UPDATE kipster.memory_nights SET owner=NULL')
  const tick = former.nightlyTick()
  while (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
  pending.shift()({ days: [{ day, summary: 'Diary' }] })
  await tick
  assert.equal(await ctx.processed(threadId), 1)
  assert.deepEqual((await claim()).map(row => row.owner), [null])
})

test('nightly work leaves the last free permit to waiting user turns and is deferred, not failed', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { executionLimit: 1 })
  const threadId = await ctx.thread([{ author: 'user', text: 'Hi' }])
  // A user turn holds the only permit.
  const intent = randomUUID(), attempt = randomUUID()
  await ctx.db.query(`INSERT INTO kipster.work_intents(id, installation_id, state, generation) VALUES ($1,$2,'issued',1)`, [intent, ctx.installationId])
  await ctx.db.query(`INSERT INTO kipster.attempts(id, intent_id, generation, incarnation, state) VALUES ($1,$2,1,$3,'issued')`, [attempt, intent, randomUUID()])
  await ctx.db.query('INSERT INTO kipster.owned_permits(attempt_id, installation_id) VALUES ($1,$2)', [attempt, ctx.installationId])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  // Recovery leaves permits of other work alone.
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.owned_permits'))[0].n, 1)
  const startedAt = Date.now()
  NIGHTLY_CALLS.admissionMs = 1500
  t.after(() => { NIGHTLY_CALLS.admissionMs = 60000 })
  await dispatcher.nightlyTick()
  assert.ok(Date.now() - startedAt >= 1500, 'the call waited for capacity before deferring')
  assert.equal(ctx.calls.length, 0)
  assert.deepEqual(await ctx.rows('SELECT night, failures, owner FROM kipster.memory_nights'), [{ night: null, failures: 0, owner: null }])
  await ctx.db.query('DELETE FROM kipster.owned_permits')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(threadId), 1)
})

test('without an embedding provider rows are saved unembedded, and a later embedPending embeds them', { skip: noDatabase }, async t => {
  const ctx = await setup(t, {
    embedding: false,
    script: context => context.maintenance.step === 'cards'
      ? { changes: [{ action: 'add', card: null, type: 'person', subject: 'Priya', statement: "User's sister", details: [{ key: 'relation', value: 'sister' }], confirmed: true, sources: refs(context.maintenance.instructions, 'citable') }] }
      : quiet(context),
  })
  await ctx.thread([{ author: 'user', text: 'Priya is my sister' }])
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  await dispatcher.nightlyTick()
  for (const table of ['thread_chunks', 'cards', 'diary']) assert.deepEqual(await ctx.rows(`SELECT embedding IS NULL AS missing, embedding_model FROM kipster.${table}`), [{ missing: true, embedding_model: null }], table)
  assert.deepEqual(await embedPending(ctx.db, ctx.installationId, undefined), { embedded: 0, failed: false })
  // Once a provider is configured, embedPending embeds the waiting rows.
  const calls = []
  const profile = new EmbeddingProfile(ctx.db, ctx.installationId, embedder(calls))
  assert.deepEqual(await embedPending(ctx.db, ctx.installationId, profile), { embedded: 3, failed: false })
  for (const table of ['thread_chunks', 'cards', 'diary']) assert.deepEqual(await ctx.rows(`SELECT embedding IS NULL AS missing, embedding_model FROM kipster.${table}`), [{ missing: false, embedding_model: 'fake-gemma' }], table)
  assert.ok(calls.includes("title: person: Priya | text: User's sister\n{\"relation\": \"sister\"}"))
  assert.ok(calls.some(text => text.startsWith('title: Mon 12 Oct 2026 | text: Diary of 2026-10-12')))
})

test('the cards service creates, updates, replaces and deletes cards with sources, and nearest respects visibility', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const other = await ctx.organization('Other')
  const home = await ctx.thread([{ author: 'user', text: 'Berlin trip with Priya' }, { author: 'kip', text: 'Planning Berlin' }])
  const work = await ctx.thread([{ author: 'user', text: 'Studio rent is due monthly' }], { organizationId: studio })
  const elsewhere = await ctx.thread([{ author: 'user', text: 'Other Berlin office' }], { organizationId: other })
  const message = async (threadId, position = 1) => (await ctx.rows('SELECT id FROM kipster.messages WHERE thread_id=$1 AND position=$2', [threadId, position]))[0].id
  const source = async (threadId, position) => ({ threadId, messageId: await message(threadId, position) })
  const messagesBefore = await ctx.rows('SELECT id, parts, revision FROM kipster.messages ORDER BY id')

  const trip = await ctx.cards.create({ type: 'Event', subject: 'Berlin trip', statement: 'Berlin trip with Priya in December', details: { month: '2026-12' }, confirmed: true, organizationId: null }, [await source(home)])
  const rent = await ctx.cards.create({ type: 'commitment', subject: 'studio', statement: 'Studio rent is due monthly', organizationId: studio }, [await source(work)])
  const office = await ctx.cards.create({ type: 'fact', subject: 'office', statement: 'Other Berlin office', organizationId: other }, [await source(elsewhere)])
  const created = await ctx.cards.get(trip)
  assert.deepEqual([created.type, created.subject, created.details, created.confirmed, created.core, created.organizationId, created.embedded, created.sources], ['event', 'Berlin trip', { month: '2026-12' }, true, false, null, false, [await source(home)]])
  // Sources are user messages in the card's own context.
  await assert.rejects(ctx.cards.create({ type: 'fact', subject: 'x', statement: 'From Kip', organizationId: null }, [await source(home, 2)]), /user message/)
  await assert.rejects(ctx.cards.create({ type: 'fact', subject: 'x', statement: 'Leaked', organizationId: null }, [await source(work)]), /user message/)
  await assert.rejects(ctx.cards.create({ type: '', subject: 'x', statement: 'y', organizationId: null }, []), /Invalid card type/)

  // A content change clears the embedding; confirming alone keeps it.
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)
  assert.equal((await ctx.cards.get(trip)).embedded, true)
  assert.equal(await ctx.cards.update(trip, { confirmed: false }, []), true)
  assert.equal((await ctx.cards.get(trip)).embedded, true)
  assert.equal(await ctx.cards.update(trip, { statement: 'Berlin trip with Priya on 5 December' }, [await source(home)]), true)
  const [row] = await ctx.rows('SELECT embedding, embedding_model, statement FROM kipster.cards WHERE id=$1', [trip])
  assert.deepEqual(row, { embedding: null, embedding_model: null, statement: 'Berlin trip with Priya on 5 December' })
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)

  // Nearest: installation cards plus the given organization's, current only, nearest first.
  const scoped = organizationId => ctx.cards.nearest({ text: 'Berlin office' }, { organizationId }, 10)
  assert.deepEqual((await scoped(null)).map(card => card.id), [trip])
  assert.deepEqual(new Set((await scoped(studio)).map(card => card.id)), new Set([trip, rent]))
  assert.deepEqual((await scoped(other)).map(card => card.id), [office, trip], 'the nearer card first')
  assert.equal((await ctx.cards.nearest({ text: 'Berlin' }, 'all', 10)).length, 3)

  // Replace ends the old card in its context and keeps its row.
  const next = await ctx.cards.replace(rent, { type: 'commitment', subject: 'studio', statement: 'Studio rent is due quarterly' }, [await source(work)])
  const ended = await ctx.cards.get(rent)
  assert.equal(ended.replacedBy, next)
  assert.ok(ended.validTo)
  assert.equal((await ctx.cards.get(next)).organizationId, studio)
  assert.equal(await ctx.cards.update(rent, { statement: 'Too late' }, []), false, 'an ended card is not changed')
  assert.equal(await ctx.cards.replace(rent, { type: 'x', subject: 'y', statement: 'z' }, []), null)
  assert.deepEqual((await scoped(studio)).map(card => card.id).sort(), [trip, next].sort())
  // Without a provider, nearest falls back to the same subject, then the most recent.
  const plain = new CardService(ctx.db, ctx.installationId)
  assert.deepEqual((await plain.nearest({ text: 'anything', subject: 'Berlin trip' }, { organizationId: studio }, 1)).map(card => card.id), [trip])
  assert.deepEqual((await plain.nearest({ text: 'anything' }, { organizationId: studio }, 1)).map(card => card.id), [next])
  const listed = await ctx.cards.list({ scope: { organizationId: studio }, limit: 1 })
  assert.equal(listed.cards.length, 1)
  assert.deepEqual((await ctx.cards.list({ scope: { organizationId: studio }, cursor: listed.nextCursor })).cards.length, 1)
  assert.equal((await ctx.cards.list({ ended: true })).cards.length, 4)

  // Delete removes cards with their sources and embeddings; messages stay as they were.
  assert.equal(await ctx.cards.delete([trip, next]), 2)
  assert.equal(await ctx.cards.get(trip), null)
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.card_sources WHERE card_id = ANY($1::uuid[])', [[trip, next]]))[0].n, 0)
  assert.equal((await ctx.cards.get(rent)).replacedBy, null, 'a card replaced by a deleted card keeps its end')
  assert.ok((await ctx.cards.get(rent)).validTo)
  assert.deepEqual(await ctx.rows('SELECT id, parts, revision FROM kipster.messages ORDER BY id'), messagesBefore)
})

test('deleting a thread or a kip during a run fails neither that run nor the others', { skip: noDatabase }, async t => {
  let block
  const blocked = new Promise(resolve => { block = resolve })
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  const ctx = await setup(t, {
    script: async (context) => {
      if (context.maintenance.step === 'diary' && context.maintenance.instructions.includes('Doomed')) { entered(); await blocked }
      return quiet(context)
    },
  })
  const doomed = await ctx.thread([{ author: 'user', text: 'Doomed thread' }])
  const kept = await ctx.thread([{ author: 'user', text: 'Kept thread', at: at('10:00') }])
  const scout = await ctx.agent('Scout')
  const scoutThread = await ctx.thread([{ author: 'user', text: 'Scout thread' }], { agentId: scout })
  ctx.clock.now = at('01:30', '2026-10-13')
  const dispatcher = ctx.dispatcher()
  await dispatcher.start()
  const tick = dispatcher.nightlyTick()
  await waiting
  // The thread goes while its diary step runs, as thread deletion removes it.
  await ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.installationId])
    await removeThreads(client, ctx.installationId, [doomed], async threadId => removeThreadMemory(client, [threadId]))
  })
  block()
  await tick
  assert.equal(await ctx.processed(kept), 1)
  assert.equal(await ctx.processed(scoutThread), 1)
  assert.deepEqual((await ctx.rows('SELECT agent_id, failures, night::text AS night FROM kipster.memory_nights ORDER BY agent_id')).map(row => [row.failures, row.night]), [[0, '2026-10-13'], [0, '2026-10-13']])

  // A kip archived mid-run stops having memory: its run saves nothing more and the next kip still runs.
  await ctx.append(kept, [{ author: 'user', text: 'More', at: at('10:00', '2026-10-13') }])
  await ctx.db.query(`UPDATE kipster.agents SET lifecycle='archived' WHERE id=$1`, [scout])
  ctx.clock.now = at('01:30', '2026-10-14')
  await dispatcher.nightlyTick()
  assert.equal(await ctx.processed(kept), 2)
})
