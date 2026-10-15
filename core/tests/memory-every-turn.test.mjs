process.env.TZ = 'UTC'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { CardService, embedPending } from '../dist/modules/memory/public.js'
import { acceptText, resolveDirectChat } from '../dist/modules/conversations/public.js'
import { addMembership, createAgent, createOrganization } from '../dist/modules/administration/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Kip memory on every turn and the memory tools (decision record 10, sections 5 and 6), against real PostgreSQL with
// the deterministic adapter and a deterministic embedding provider. Mechanics only: no model behaviour.

const memoryTools = ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory']
const fixtureSettings = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

/** A 768-dimension bag of words, so texts sharing words are near. `state.fail` makes it throw. */
function embedder(state) {
  return {
    id: 'fake-embedding', contractMajor: 1, model: 'fake-gemma',
    async embed(text) {
      if (state.fail) throw new Error('embedding down')
      const vector = new Array(768).fill(0)
      vector[767] = 0.01
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) vector[createHash('sha256').update(word).digest().readUInt16BE(0) % 767] += 1
      return vector
    },
  }
}

async function setup(t, { embedding = true } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_turn_memory_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-turn-memory-home-'))
  const embeddingState = { fail: false }
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Sam', organization: 'Garden', rootAgent: 'Kip' }, ...(embedding ? { embedding: embedder(embeddingState) } : {}) })
  const db = runtime.db
  const installationId = runtime.bootstrap.installationId
  const actor = { installationId, personId: runtime.bootstrap.ownerId }
  const kip = runtime.bootstrap.rootAgentId
  const garden = runtime.bootstrap.organizationId
  await db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [kip, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const studio = (await createOrganization(db, runtime.home, actor, 'studio', { name: 'Studio' })).organization.id
  const scout = (await createAgent(db, runtime.home, actor, 'scout', { name: 'Scout', organizationId: garden, settings: fixtureSettings })).agent.id
  await addMembership(db, actor, 'scout-studio', studio, scout)
  const penny = (await createAgent(db, runtime.home, actor, 'penny', { name: 'Penny', organizationId: garden, settings: fixtureSettings })).agent.id

  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(context) { const handle = await inner.execute(context); executions.push({ context, handle }); return handle } })
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
  /** Starts a turn and waits for its execution; `finish()` ends it. */
  async function turn(agentId, organizationId, text, threadId) {
    const chatId = await chat(agentId, organizationId)
    const receipt = await acceptText(db, runtime.jobs, runtime.artifacts, actor, { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: actor.personId }, target: { context: context(organizationId), chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] })
    const index = executions.length
    for (let i = 0; i < 400 && executions.length === index; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const { context: execution, handle } = executions[index]
    let calls = 0
    return {
      receipt, context: execution,
      tool: (name, args) => handle.callTool(`call-${++calls}`, name, args),
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
  /** An earlier thread with the given messages; `user` messages are the owner's. Processed by the nightly run unless `processed` is false. */
  async function thread(agentId, organizationId, messages, { processed = true, at = '2026-10-10T09:00:00Z' } = {}) {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.threads(id, chat_id) VALUES ($1,$2)', [id, await chat(agentId, organizationId)])
    const ids = []
    for (const [index, message] of messages.entries()) {
      const messageId = randomUUID()
      await db.query('UPDATE kipster.threads SET next_message_position=next_message_position+1 WHERE id=$1', [id])
      await db.query('INSERT INTO kipster.messages(id, thread_id, position, author_id, parts, final, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,true,$6)',
        [messageId, id, index + 1, message.author === 'user' ? actor.personId : agentId, JSON.stringify([{ kind: 'text', text: message.text }]), at])
      ids.push(messageId)
    }
    if (processed) await db.query('INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,$3)', [id, installationId, messages.length])
    return { id, messages: ids }
  }
  async function chunk(threadId, agentId, organizationId, text, { at = '2026-10-10T09:00:00Z', end = at } = {}) {
    const id = randomUUID()
    await db.query(`INSERT INTO kipster.thread_chunks(id, installation_id, thread_id, agent_id, organization_id, from_position, to_position, started_at, ended_at, title, text)
      VALUES ($1,$2,$3,$4,$5,1,2,$6,$7,$8,$9)`, [id, installationId, threadId, agentId, organizationId, at, end, text.split(' ').slice(0, 3).join(' '), text])
    return id
  }
  /** A diary page of one context: the installation, or `organizationId`. */
  const diary = (agentId, day, summary, threadIds = [], organizationId = null) => db.query('INSERT INTO kipster.diary(agent_id, day, organization_id, installation_id, summary, thread_ids) VALUES ($1,$2,$3,$4,$5,$6::uuid[])', [agentId, day, organizationId, installationId, summary, threadIds])
  const cards = new CardService(db, installationId, runtime.embedding)
  async function card(statement, { organizationId = null, core = false, subject = 'user', type = 'fact', sources = [] } = {}) {
    const id = await cards.create({ type, subject, statement, organizationId }, sources)
    if (core) await db.query('UPDATE kipster.cards SET core=true WHERE id=$1', [id])
    return id
  }
  const embedAll = () => embedPending(db, installationId, runtime.embedding)
  const rows = (sql, params = []) => db.query(sql, params).then(result => result.rows)
  return { runtime, db, actor, installationId, kip, scout, penny, garden, studio, embeddingState, turn, thread, chunk, diary, card, cards, embedAll, rows }
}

const toolNames = execution => (execution.tools ?? []).map(tool => tool.name)

test('core cards join the stable instructions, capped, without organization cards, and byte-identical between turns', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  await ctx.runtime.learning.setInstallation(ctx.actor, { coreCardCount: 2 })
  const first = await ctx.card('Vegetarian since October', { core: true })
  const second = await ctx.card('Lives in Lisbon', { core: true, type: 'person', subject: 'Priya' })
  const third = await ctx.card('Plays the cello', { core: true })
  const organization = await ctx.card('Garden opens at nine', { core: true, organizationId: ctx.garden })
  const plain = await ctx.card('Not a core card')

  const one = await ctx.turn(ctx.kip, null, 'Hello')
  const instructions = one.context.instructions
  assert.ok(instructions.endsWith(`Core memory: cards about the user, shared by every kip. A card's ID works with forget_memory.
- [card ${first}] fact, user: Vegetarian since October (inferred ${new Date().toISOString().slice(0, 10)})
- [card ${second}] person, Priya: Lives in Lisbon (inferred ${new Date().toISOString().slice(0, 10)})`), instructions)
  for (const absent of [third, organization, plain]) assert.ok(!instructions.includes(absent))
  assert.match(instructions, /list_recent_threads for threads since last night/)
  assert.deepEqual(toolNames(one.context).filter(name => ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'].includes(name)), memoryTools)
  await one.finish()

  // The next turn, in the same thread and in a new one, gets exactly the same instructions.
  const two = await ctx.turn(ctx.kip, null, 'Something else entirely', one.receipt.threadId)
  assert.equal(two.context.instructions, instructions)
  await two.finish()
  const three = await ctx.turn(ctx.kip, null, 'A new thread')
  assert.equal(three.context.instructions, instructions)
  await three.finish()

  // A kip in an organization gets the installation's core cards too, never the organization's.
  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Hello from the garden')
  assert.ok(scout.context.instructions.includes(first) && scout.context.instructions.includes(second))
  assert.ok(!scout.context.instructions.includes(organization))
  await scout.finish()
})

test('memory off adds no memory sections and no memory tools, and refuses memory tool calls', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  await ctx.card('Vegetarian since October', { core: true })
  await ctx.thread(ctx.scout, ctx.garden, [{ author: 'user', text: 'Unprocessed garden talk' }], { processed: false })
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.scout, { enabled: false })
  const off = await ctx.turn(ctx.scout, ctx.garden, 'Vegetarian dinner ideas')
  assert.deepEqual(toolNames(off.context).filter(name => ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'].includes(name)), [])
  assert.ok(!off.context.instructions.includes('Core memory') && !off.context.instructions.includes('search_memory'))
  assert.equal(off.context.memory, undefined)
  assert.doesNotMatch(off.context.prompt, /Memory search|not searchable yet/)
  assert.match(off.context.prompt, /^Current user message \[/, 'a first message has no history section')
  await assert.rejects(off.tool('search_memory', { query: 'dinner' }), /Memory is off for this kip/)
  await off.finish()

  // The installation switch turns it off for Kip too; switched off during a turn, the tools refuse.
  const on = await ctx.turn(ctx.kip, null, 'Vegetarian dinner ideas')
  assert.ok(toolNames(on.context).includes('search_memory'))
  await ctx.runtime.learning.setInstallation(ctx.actor, { enabled: false })
  await assert.rejects(on.tool('list_recent_threads', {}), /Memory is off for this kip/)
  await on.finish()
  const kip = await ctx.turn(ctx.kip, null, 'Vegetarian dinner ideas')
  assert.deepEqual(toolNames(kip.context).filter(name => ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'].includes(name)), [])
  assert.ok(!kip.context.instructions.includes('Core memory'))
  assert.equal(kip.context.memory, undefined)
  await kip.finish()
})

test('the turn\'s memory search shows whole visible cards, chunks and diary pages, nearest first and within the counts', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  await ctx.runtime.learning.setInstallation(ctx.actor, { searchCardCount: 2, searchChunkCount: 3 })
  const long = `Berlin trip planning ${Array.from({ length: 700 }, (_, index) => `detail${index}`).join(' ')} berlin flights end`
  const kipThread = await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'Berlin flights' }, { text: 'Booked' }])
  const kipChunk = await ctx.chunk(kipThread.id, ctx.kip, null, long, { at: '2026-10-10T09:00:00Z', end: '2026-10-11T10:00:00Z' })
  const scoutGarden = await ctx.thread(ctx.scout, ctx.garden, [{ author: 'user', text: 'Berlin garden show' }, { text: 'Noted' }])
  const scoutGardenChunk = await ctx.chunk(scoutGarden.id, ctx.scout, ctx.garden, 'Berlin garden show tickets for the berlin trip')
  const scoutStudio = await ctx.thread(ctx.scout, ctx.studio, [{ author: 'user', text: 'Berlin studio rent' }, { text: 'Noted' }])
  const scoutStudioChunk = await ctx.chunk(scoutStudio.id, ctx.scout, ctx.studio, 'Berlin studio rent for the berlin trip')
  const pennyThread = await ctx.thread(ctx.penny, ctx.garden, [{ author: 'user', text: 'Berlin bakery' }, { text: 'Noted' }])
  const pennyChunk = await ctx.chunk(pennyThread.id, ctx.penny, ctx.garden, 'Berlin bakery list for the berlin trip')
  await ctx.diary(ctx.kip, '2026-10-10', 'Planned the Berlin trip and berlin flights.', [kipThread.id])
  await ctx.diary(ctx.scout, '2026-10-10', 'Talked about the berlin trip garden show.', [scoutGarden.id], ctx.garden)
  await ctx.diary(ctx.scout, '2026-10-10', 'Talked about the berlin trip studio rent.', [scoutStudio.id], ctx.studio)
  const installationCard = await ctx.card('Berlin trip with Priya in December', { sources: [{ threadId: kipThread.id, messageId: kipThread.messages[0] }] })
  const gardenCard = await ctx.card('Berlin garden show in spring', { organizationId: ctx.garden })
  const studioCard = await ctx.card('Berlin studio rent is due', { organizationId: ctx.studio })
  await ctx.card('Likes tea')
  assert.equal((await ctx.embedAll()).failed, false)

  const kip = await ctx.turn(ctx.kip, null, 'What about the berlin trip flights?')
  const [search, ...rest] = kip.context.memory
  assert.deepEqual(rest, [])
  assert.match(search, /^Memory search for the current message: whole items you may see, nearest first\./)
  assert.ok(search.includes(`[thread ${kipThread.id}, messages 1-2, 2026-10-10 to 2026-10-11]\n${long}`), 'a chunk is whole, with its thread and dates')
  assert.ok(search.includes(`[diary 2026-10-10, threads ${kipThread.id}]\nPlanned the Berlin trip and berlin flights.`))
  assert.ok(search.includes(`- [card ${installationCard}] fact, user: Berlin trip with Priya in December (inferred `) && search.includes(`; threads ${kipThread.id})`))
  // Kip's prompt holds only its own chunks and diary, and installation cards: nothing of other kips or organizations.
  for (const hidden of [scoutGardenChunk, scoutStudioChunk, pennyChunk, 'garden show', 'studio rent', 'bakery', gardenCard, studioCard]) assert.ok(!search.includes(hidden), hidden)
  assert.ok(!search.includes(kipChunk), 'chunk IDs are not shown; thread IDs are')
  // The memory sections come first, then the current message; a first message has no history.
  assert.ok(kip.context.prompt.startsWith(`${search}\n\nCurrent user message [`))
  await kip.finish()

  // Scout in the garden sees its own garden chunk and diary, installation and garden cards, within the counts.
  const scout = await ctx.turn(ctx.scout, ctx.garden, 'The berlin trip garden show')
  const scoutSearch = scout.context.memory[0]
  assert.ok(scoutSearch.includes('Berlin garden show tickets for the berlin trip') && scoutSearch.includes('Talked about the berlin trip garden show.'))
  assert.ok(scoutSearch.includes(gardenCard) && scoutSearch.includes(installationCard))
  for (const hidden of ['studio rent', 'bakery', long, studioCard, scoutStudio.id]) assert.ok(!scoutSearch.includes(hidden), hidden.slice(0, 40))
  assert.equal((scoutSearch.match(/^- \[card /gm) ?? []).length, 2)
  await scout.finish()

  // Counts bound the items; a chunk of the current thread is left out, as the history already holds it.
  await ctx.runtime.learning.setInstallation(ctx.actor, { searchCardCount: 0, searchChunkCount: 1 })
  const current = await ctx.turn(ctx.kip, null, 'Berlin flights again')
  await current.finish()
  await ctx.chunk(current.receipt.threadId, ctx.kip, null, 'Berlin flights again and again berlin flights berlin flights')
  await ctx.embedAll()
  const next = await ctx.turn(ctx.kip, null, 'Berlin flights again and again', current.receipt.threadId)
  const nextSearch = next.context.memory[0]
  assert.ok(!nextSearch.includes('again and again') && !nextSearch.includes('Cards:'))
  assert.equal((nextSearch.match(/^\[(thread|diary) /gm) ?? []).length, 1)
  await next.finish()
})

test('without an embedding provider, or when it fails, search is unavailable while core cards and the unprocessed line stay', { skip: noDatabase, timeout: 60000 }, async t => {
  for (const mode of ['none', 'failing']) {
    const ctx = await setup(t, { embedding: mode !== 'none' })
    if (mode === 'failing') ctx.embeddingState.fail = true
    const core = await ctx.card('Vegetarian since October', { core: true })
    await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'Unprocessed' }], { processed: false })
    const kip = await ctx.turn(ctx.kip, null, 'Dinner ideas?')
    assert.equal(kip.context.memory[0], 'Memory search is unavailable this turn.', mode)
    assert.match(kip.context.memory[1], /^1 thread since last night is not searchable yet\./)
    assert.ok(kip.context.instructions.includes(core))
    assert.deepEqual(await kip.tool('search_memory', { query: 'dinner' }), { status: 'unavailable', reason: mode === 'none' ? 'No embedding provider is configured' : 'The embedding provider did not answer' })
    await kip.finish()
  }
})

test('the unprocessed line counts the kip\'s visible threads since last night, and Kip\'s adds other kips\' threads', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'One' }], { processed: false })
  await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'Two' }], { processed: false })
  await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'Done' }])
  await ctx.thread(ctx.scout, ctx.garden, [{ author: 'user', text: 'Garden' }], { processed: false })
  await ctx.thread(ctx.scout, ctx.studio, [{ author: 'user', text: 'Studio' }], { processed: false })
  const kip = await ctx.turn(ctx.kip, null, 'Hi')
  assert.equal(kip.context.memory.at(-1), '2 threads since last night are not searchable yet. If search does not answer, read them with `list_recent_threads`. Other kips\' recent threads are available through the same tool.')
  await kip.finish()
  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Hi')
  assert.equal(scout.context.memory.at(-1), '1 thread since last night is not searchable yet. If search does not answer, read them with `list_recent_threads`.')
  await scout.finish()
  const penny = await ctx.turn(ctx.penny, ctx.garden, 'Hi')
  assert.ok(!penny.context.memory?.some(section => section.includes('not searchable yet')), 'no line when nothing is waiting')
  await penny.finish()
})

test('list_recent_threads and read_thread: Kip reads every kip\'s threads, another kip only its own visible ones', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const scoutGarden = await ctx.thread(ctx.scout, ctx.garden, [{ author: 'user', text: 'Garden plans\nsecond line' }, { text: 'Sure' }, { author: 'user', text: 'Third' }], { processed: false })
  const scoutStudio = await ctx.thread(ctx.scout, ctx.studio, [{ author: 'user', text: 'Studio plans' }], { processed: false })
  const kipThread = await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'Kip plans' }], { processed: false })
  const internal = randomUUID()
  await ctx.db.query('INSERT INTO kipster.threads(id, chat_id, internal) SELECT $1, chat_id, true FROM kipster.threads WHERE id=$2', [internal, scoutGarden.id])
  await ctx.db.query('INSERT INTO kipster.messages(id, thread_id, position, author_id, parts) VALUES ($1,$2,1,$3,$4::jsonb)', [randomUUID(), internal, ctx.scout, JSON.stringify([{ kind: 'text', text: 'Delegated work' }])])

  const kip = await ctx.turn(ctx.kip, null, 'Catch up')
  const page = await kip.tool('read_thread', { threadId: scoutGarden.id, fromPosition: 2 })
  assert.deepEqual(page.messages.map(message => [message.position, message.author, message.text]), [[2, 'kip', 'Sure'], [3, 'user', 'Third']])
  assert.deepEqual([page.agentId, page.organizationId, page.nextPosition], [ctx.scout, ctx.garden, null])
  assert.equal((await kip.tool('read_thread', { threadId: scoutStudio.id })).messages[0].text, 'Studio plans')
  const all = await kip.tool('list_recent_threads', {})
  assert.deepEqual(new Set(all.threads.map(item => item.threadId)), new Set([scoutGarden.id, scoutStudio.id, kipThread.id]))
  assert.equal(all.threads.find(item => item.threadId === scoutGarden.id).firstLine, 'Garden plans')
  const scoutOnly = await kip.tool('list_recent_threads', { agent: ctx.scout })
  assert.deepEqual(new Set(scoutOnly.threads.map(item => item.threadId)), new Set([scoutGarden.id, scoutStudio.id]))
  assert.deepEqual(scoutOnly.threads.map(item => [item.agentName, item.processedPosition]), [['Scout', 0], ['Scout', 0]])
  await kip.finish()

  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Catch up')
  await assert.rejects(scout.tool('read_thread', { threadId: kipThread.id }), /Thread not found/)
  await assert.rejects(scout.tool('read_thread', { threadId: scoutStudio.id }), /Thread not found/, 'another organization of the same kip')
  assert.equal((await scout.tool('read_thread', { threadId: scoutGarden.id, toPosition: 1 })).messages.length, 1)
  assert.deepEqual((await scout.tool('read_thread', { threadId: internal })).internal, true)
  assert.deepEqual((await scout.tool('list_recent_threads', {})).threads.map(item => item.threadId), [scoutGarden.id])
  for (const [name, args] of [['list_recent_threads', { agent: ctx.kip }], ['search_memory', { query: 'plans', agent: ctx.kip }]]) await assert.rejects(scout.tool(name, args), /only Kip may name an agent/)
  await scout.finish()
})

test('search_memory: Kip may search another kip with a date range; other kips search their own visible memory', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const early = await ctx.thread(ctx.scout, ctx.studio, [{ author: 'user', text: 'Studio lamp' }, { text: 'Ok' }])
  await ctx.chunk(early.id, ctx.scout, ctx.studio, 'Studio lamp order', { at: '2026-09-01T09:00:00Z' })
  const late = await ctx.thread(ctx.scout, ctx.garden, [{ author: 'user', text: 'Garden lamp' }, { text: 'Ok' }])
  await ctx.chunk(late.id, ctx.scout, ctx.garden, 'Garden lamp order', { at: '2026-10-05T09:00:00Z' })
  await ctx.diary(ctx.scout, '2026-10-05', 'Ordered a lamp for the garden.', [late.id], ctx.garden)
  const studioCard = await ctx.card('Studio lamp is red', { organizationId: ctx.studio })
  await ctx.embedAll()

  const kip = await ctx.turn(ctx.kip, null, 'Lamps')
  const everything = await kip.tool('search_memory', { query: 'lamp order', agent: ctx.scout })
  assert.equal(everything.status, 'ok')
  assert.deepEqual(new Set(everything.items.map(item => item.kind === 'chunk' ? item.text : item.summary)), new Set(['Studio lamp order', 'Garden lamp order', 'Ordered a lamp for the garden.']))
  assert.ok(everything.cards.some(card => card.id === studioCard), 'Kip\'s tools see every card')
  const october = await kip.tool('search_memory', { query: 'lamp order', from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(new Set(october.items.map(item => item.kind === 'chunk' ? item.text : item.summary)), new Set(['Garden lamp order', 'Ordered a lamp for the garden.']))
  assert.equal((await kip.tool('search_memory', { query: 'lamp order', to: '2026-09-01' })).items.map(item => item.text).join(), 'Studio lamp order')
  await assert.rejects(kip.tool('search_memory', { query: 'lamp', from: 'yesterday' }), /from must be an ISO date/)
  await kip.finish()

  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Lamps')
  const own = await scout.tool('search_memory', { query: 'lamp order' })
  assert.deepEqual(own.items.map(item => item.kind === 'chunk' ? item.text : item.summary).sort(), ['Garden lamp order', 'Ordered a lamp for the garden.'])
  assert.ok(!own.cards.some(card => card.id === studioCard))
  await scout.finish()
})

test('save_memory saves a confirmed card sourced to the current message, in the current context, and embeds it', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Remember that the greenhouse key is under the pot')
  const saved = await scout.tool('save_memory', { statement: 'Greenhouse key is under the pot', type: 'Fact', subject: 'greenhouse', details: { place: 'pot' } })
  assert.deepEqual([saved.card.type, saved.card.subject, saved.card.statement, saved.card.details, saved.card.confirmed, saved.card.organizationId, saved.card.core, saved.embedded],
    ['fact', 'greenhouse', 'Greenhouse key is under the pot', { place: 'pot' }, true, ctx.garden, false, true])
  assert.deepEqual(saved.card.sources, [{ threadId: scout.receipt.threadId, messageId: scout.receipt.messageId }])
  assert.deepEqual(await ctx.rows('SELECT embedding_model FROM kipster.cards WHERE id=$1', [saved.card.id]), [{ embedding_model: 'fake-gemma' }])
  await assert.rejects(scout.tool('save_memory', { statement: '', type: 'fact', subject: 'user' }), /Invalid card statement/)
  await scout.finish()

  const kip = await ctx.turn(ctx.kip, null, 'Remember I am vegetarian')
  ctx.embeddingState.fail = true
  const installation = await kip.tool('save_memory', { statement: 'Vegetarian', type: 'preference', subject: 'user' })
  assert.deepEqual([installation.card.organizationId, installation.card.confirmed, installation.embedded], [null, true, false])
  assert.deepEqual(await ctx.rows('SELECT embedding IS NULL AS waiting FROM kipster.cards WHERE id=$1', [installation.card.id]), [{ waiting: true }], 'left for the nightly run')
  await kip.finish()
})

test('forget_memory deletes visible cards with their sources, by ID or by query, never messages, and refuses over 20 matches', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const source = await ctx.thread(ctx.kip, null, [{ author: 'user', text: 'I love coffee and my cat Tom' }])
  const sources = [{ threadId: source.id, messageId: source.messages[0] }]
  const cat = await ctx.card('Has a cat named Tom', { sources, type: 'person', subject: 'Tom' })
  const studio = await ctx.card('Studio coffee machine', { organizationId: ctx.studio })
  const coffee = []
  for (let index = 0; index < 21; index++) coffee.push(await ctx.card(`Coffee preference ${index}`, { sources }))

  const scout = await ctx.turn(ctx.scout, ctx.garden, 'Forget things')
  await assert.rejects(scout.tool('forget_memory', { cardId: studio }), /Card not found/, 'another organization\'s card is not visible')
  await assert.rejects(scout.tool('forget_memory', {}), /give cardId or query/)
  const tooMany = await scout.tool('forget_memory', { query: 'COFFEE' })
  assert.deepEqual([tooMany.deleted, tooMany.candidates.length, tooMany.hasMore], [[], 21, false])
  assert.match(tooMany.refused, /More than 20 cards match; none were deleted/)
  assert.equal((await ctx.rows('SELECT count(*)::int AS n FROM kipster.cards')).at(0).n, 23)
  const byId = await scout.tool('forget_memory', { cardId: cat })
  assert.deepEqual(byId.deleted.map(item => [item.id, item.subject, item.current]), [[cat, 'Tom', true]])
  await scout.finish()

  await ctx.db.query('DELETE FROM kipster.cards WHERE id = ANY($1::uuid[])', [coffee.slice(0, 2)])
  const kip = await ctx.turn(ctx.kip, null, 'Forget my coffee preferences')
  const byQuery = await kip.tool('forget_memory', { query: 'coffee' })
  assert.deepEqual(new Set(byQuery.deleted.map(item => item.id)), new Set([...coffee.slice(2), studio]), 'Kip sees every card, organization ones included')
  assert.deepEqual(await ctx.rows('SELECT count(*)::int AS n FROM kipster.cards'), [{ n: 0 }])
  assert.deepEqual(await ctx.rows('SELECT count(*)::int AS n FROM kipster.card_sources'), [{ n: 0 }])
  assert.deepEqual(await ctx.rows('SELECT parts FROM kipster.messages WHERE id=$1', [source.messages[0]]), [{ parts: [{ kind: 'text', text: 'I love coffee and my cat Tom' }] }], 'messages stay')
  await kip.finish()
})
