import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { CardService, embedPending } from '../dist/modules/memory/public.js'
import { memoryCardPage, memoryCardRemoval, memoryCardResult, stableError } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Card actions of the Memory view over HTTP and the admin catalog, against real PostgreSQL with the deterministic
// fixture adapter and a fake embedding provider.

const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const embedding = { id: 'fake-embedding', contractMajor: 1, model: 'fake-gemma', async embed() { const vector = new Array(768).fill(0); vector[0] = 1; return vector } }

async function until(read, match, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (match(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}

async function setup(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_memory_cards_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-memory-cards-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' }, executionLimit: 4, embedding })
  closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const serve = async actor => {
    const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
    closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const call = await serve({ installationId, personId: ownerId })
  await dispatcher.start()
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  const refused = async (method, path, body, status, code) => {
    const response = await call(method, path, body)
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.data)}`)
    assert.equal(stableError.parse(response.data).code, code)
    return response.data
  }
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  await ok('PUT', `/v1/organizations/${organizationId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  /** Sends the person's message to Kip and returns its run, with the message as a card source. */
  const start = async (context, text) => {
    const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context, agentId: rootAgentId })
    const response = await call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
    assert.equal(response.status, 202)
    const accepted = response.data
    const execution = await until(() => executions.find(e => e.context.runId === accepted.runId), Boolean, `execution of ${accepted.runId}`)
    return { ...execution, source: { threadId: accepted.threadId, messageId: accepted.messageId }, tool: (callId, operation, args = {}) => execution.handle.callTool(callId, 'run_admin_operation', { operation, arguments: args }) }
  }
  const cards = new CardService(runtime.db, installationId)
  return { runtime, db: runtime.db, installationId, ownerId, organizationId, rootAgentId, serve, call, ok, refused, start, cards }
}

/** An installation card, an organization card, and a card replaced by a newer one. */
async function seed(ctx) {
  const home = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'I am vegetarian and Priya is my sister')
  const garden = await ctx.start({ kind: 'organization', organizationId: ctx.organizationId }, 'The garden budget is 400 euros')
  const sister = await ctx.cards.create({ type: 'person', subject: 'Priya', statement: "User's sister", details: { relation: 'sister' }, organizationId: null }, [home.source])
  const steak = await ctx.cards.create({ type: 'preference', subject: 'user', statement: 'Loves steak', organizationId: null }, [home.source])
  const vegetarian = await ctx.cards.replace(steak, { type: 'preference', subject: 'user', statement: 'Vegetarian since Oct 2026', confirmed: true }, [home.source])
  const budget = await ctx.cards.create({ type: 'fact', subject: 'garden', statement: 'Garden budget is 400 euros', organizationId: ctx.organizationId }, [garden.source])
  return { home, garden, sister, steak, vegetarian, budget }
}

test('the owner lists cards of every organization with paging, and replaced cards on demand', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { home, garden, sister, steak, vegetarian, budget } = await seed(ctx)

  const page = memoryCardPage.parse(await ctx.ok('GET', '/v1/memory/cards'))
  assert.deepEqual(page.cards.map(card => card.id).sort(), [sister, vegetarian, budget].sort(), 'current cards only by default')
  assert.equal(page.nextCursor, null)
  const byId = Object.fromEntries(page.cards.map(card => [card.id, card]))
  assert.equal(byId[budget].organizationId, ctx.organizationId)
  assert.deepEqual(byId[budget].sources, [garden.source])
  assert.equal(byId[sister].organizationId, null)
  assert.deepEqual(byId[sister].sources, [home.source])
  assert.deepEqual(byId[sister].details, { relation: 'sister' })
  assert.equal(byId[vegetarian].confirmed, true)
  assert.equal(byId[sister].confirmed, false)

  const ended = memoryCardPage.parse(await ctx.ok('GET', '/v1/memory/cards?ended=true'))
  const replaced = ended.cards.find(card => card.id === steak)
  assert.equal(ended.cards.length, 4)
  assert.equal(replaced.replacedBy, vegetarian)
  assert.ok(replaced.validTo)

  const seen = []
  let cursor = null
  do {
    const next = memoryCardPage.parse(await ctx.ok('GET', `/v1/memory/cards?ended=true&limit=1${cursor ? `&cursor=${cursor}` : ''}`))
    assert.equal(next.cards.length, 1)
    seen.push(next.cards[0].id)
    cursor = next.nextCursor
  } while (cursor)
  assert.deepEqual(seen, ended.cards.map(card => card.id), 'pages follow the full list in order')

  assert.deepEqual(memoryCardResult.parse(await ctx.ok('GET', `/v1/memory/cards/${budget}`)).card, byId[budget])
  await ctx.refused('GET', `/v1/memory/cards/${randomUUID()}`, undefined, 404, 'not-found')
  for (const query of ['ended=yes', 'limit=0', 'limit=201', 'limit=ten', `cursor=${randomUUID()}`, 'cursor=nope'])
    await ctx.refused('GET', `/v1/memory/cards?${query}`, undefined, 400, 'invalid')

  const stranger = await ctx.serve({ installationId: ctx.installationId, personId: randomUUID() })
  for (const [method, path, body] of [['GET', '/v1/memory/cards'], ['GET', `/v1/memory/cards/${sister}`], ['PUT', `/v1/memory/cards/${sister}`, { version: 1, statement: 'Not mine' }], ['DELETE', `/v1/memory/cards/${sister}`]]) {
    const response = await stranger(method, path, body)
    assert.equal(response.status, 403, `${method} ${path}`)
  }
  assert.equal((await ctx.cards.get(sister)).statement, "User's sister", 'a refused caller changes nothing')
})

test('an edit changes a current card, confirms it and clears its embedding; invalid and replaced edits are refused', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { sister, steak, vegetarian } = await seed(ctx)
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)
  assert.equal((await ctx.cards.get(sister)).embedded, true)

  const edited = memoryCardResult.parse(await ctx.ok('PUT', `/v1/memory/cards/${sister}`, { version: 1, statement: "  User's younger sister ", details: { relation: 'sister', age: 'younger' } })).card
  assert.equal(edited.statement, "User's younger sister")
  assert.deepEqual(edited.details, { relation: 'sister', age: 'younger' })
  assert.deepEqual([edited.type, edited.subject, edited.confirmed, edited.embedded], ['person', 'Priya', true, false])
  assert.deepEqual(await ctx.cards.get(sister), edited)

  const again = memoryCardResult.parse(await ctx.ok('PUT', `/v1/memory/cards/${sister}`, { version: 1, statement: "User's younger sister", type: 'Person' })).card
  assert.deepEqual(again, edited, 'saving the current values changes nothing')

  for (const body of [
    { version: 1 },
    { version: 1, statement: '' },
    { version: 1, statement: '   ' },
    { version: 1, statement: 'x'.repeat(2001) },
    { version: 1, type: 'x'.repeat(41) },
    { version: 1, details: ['sister'] },
    { version: 1, details: { note: 'x'.repeat(5000) } },
    { version: 1, confirmed: false },
    { version: 1, core: true },
    { statement: 'No version' },
  ]) await ctx.refused('PUT', `/v1/memory/cards/${sister}`, body, 400, 'invalid')
  assert.deepEqual(await ctx.cards.get(sister), edited, 'refused edits change nothing')

  await ctx.refused('PUT', `/v1/memory/cards/${steak}`, { version: 1, statement: 'Loves fish' }, 409, 'conflict')
  assert.equal((await ctx.cards.get(steak)).statement, 'Loves steak')
  await ctx.refused('PUT', `/v1/memory/cards/${randomUUID()}`, { version: 1, statement: 'Gone' }, 404, 'not-found')
  assert.equal((await ctx.cards.get(vegetarian)).statement, 'Vegetarian since Oct 2026')
})

test('deleting a card removes it with its sources and embedding; messages and the card it replaced stay', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { home, sister, steak, vegetarian } = await seed(ctx)
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)
  const messages = async () => (await ctx.db.query('SELECT count(*)::int AS n FROM kipster.messages')).rows[0].n
  const before = await messages()

  assert.deepEqual(memoryCardRemoval.parse(await ctx.ok('DELETE', `/v1/memory/cards/${vegetarian}`)), { version: 1, cardId: vegetarian, deleted: true })
  assert.equal(await ctx.cards.get(vegetarian), null)
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM kipster.card_sources WHERE card_id=$1', [vegetarian])).rows[0].n, 0)
  assert.equal(await messages(), before, 'messages stay')
  assert.ok((await ctx.db.query('SELECT 1 FROM kipster.messages WHERE id=$1', [home.source.messageId])).rows.length)
  const replaced = await ctx.cards.get(steak)
  assert.ok(replaced.validTo, 'the card it replaced stays ended')
  assert.equal(replaced.replacedBy, null)
  assert.equal((await ctx.cards.get(sister)).sources.length, 1, 'other cards keep their sources')

  assert.deepEqual(await ctx.ok('DELETE', `/v1/memory/cards/${vegetarian}`), { version: 1, cardId: vegetarian, deleted: false }, 'a repeated delete reports the card gone')
  assert.deepEqual((await ctx.ok('DELETE', `/v1/memory/cards/${steak}`)).deleted, true, 'a replaced card can be deleted')
  await ctx.refused('GET', `/v1/memory/cards/${steak}`, undefined, 404, 'not-found')
})

test('Kip reads, edits and deletes cards through the admin catalog with the same results as HTTP', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { sister, steak, budget } = await seed(ctx)
  const run = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'Fix my memory')

  const listing = await run.handle.callTool('list', 'list_admin_operations', { area: 'memory' })
  assert.deepEqual(listing.areas[0].operations.map(item => item.operation), ['memory.cards_list', 'memory.card_get', 'memory.card_update', 'memory.card_delete'])
  const update = await run.handle.callTool('describe', 'list_admin_operations', { operation: 'memory.card_update' })
  assert.deepEqual([update.kind, update.operationId, update.arguments.required], ['write', 'required', ['cardId']])
  const write = (callId, operation, operationId, args) => run.handle.callTool(callId, 'run_admin_operation', { operation, arguments: args, operationId })

  assert.deepEqual(await run.tool('cards', 'memory.cards_list'), await ctx.ok('GET', '/v1/memory/cards'))
  assert.deepEqual(await run.tool('ended', 'memory.cards_list', { ended: true, limit: 2 }), await ctx.ok('GET', '/v1/memory/cards?ended=true&limit=2'))
  assert.deepEqual(await run.tool('budget', 'memory.card_get', { cardId: budget }), await ctx.ok('GET', `/v1/memory/cards/${budget}`))

  await assert.rejects(run.tool('no-id', 'memory.card_update', { cardId: sister, subject: 'Priya Rao' }), /needs an operationId/)
  const edited = await write('edit', 'memory.card_update', 'edit-sister-a', { cardId: sister, subject: 'Priya Rao' })
  assert.deepEqual([edited.operationId, edited.alreadyApplied, edited.card.subject, edited.card.confirmed], ['edit-sister-a', false, 'Priya Rao', true])
  assert.deepEqual(await ctx.ok('GET', `/v1/memory/cards/${sister}`), { version: 1, card: edited.card })
  const newer = await write('edit-b', 'memory.card_update', 'edit-sister-b', { cardId: sister, subject: 'Priya R.', details: { relation: 'sister', city: 'Pune' } })
  assert.equal(newer.card.subject, 'Priya R.')
  const replay = await write('edit-retry', 'memory.card_update', 'edit-sister-a', { cardId: sister, subject: 'Priya Rao' })
  assert.deepEqual([replay.alreadyApplied, replay.card], [true, newer.card], 'a retried edit returns the card as it is and keeps the newer correction')
  assert.deepEqual((await ctx.ok('GET', `/v1/memory/cards/${sister}`)).card, newer.card)
  await assert.rejects(write('edit-other', 'memory.card_update', 'edit-sister-a', { cardId: sister, subject: 'Someone else' }), /different request/)
  await assert.rejects(write('edit-moved', 'memory.card_update', 'edit-sister-a', { cardId: budget, subject: 'Priya Rao' }), /different request/)
  await assert.rejects(write('bad-edit', 'memory.card_update', 'bad-edit', { cardId: sister, statement: '' }), /Invalid wire value/)
  await assert.rejects(write('no-edit', 'memory.card_update', 'no-edit', { cardId: sister }), /nothing to change/)
  await assert.rejects(write('ended-edit', 'memory.card_update', 'ended-edit', { cardId: steak, statement: 'Loves fish' }), /replaced/)
  await assert.rejects(run.tool('missing', 'memory.card_get', { cardId: 'not-a-card' }), /Card not found/)

  await assert.rejects(run.tool('forget-no-id', 'memory.card_delete', { cardId: budget }), /needs an operationId/)
  assert.deepEqual(await write('forget', 'memory.card_delete', 'forget-budget', { cardId: budget }), { operationId: 'forget-budget', version: 1, cardId: budget, deleted: true, alreadyApplied: false })
  assert.equal(await ctx.cards.get(budget), null)
  assert.deepEqual(await write('forget-retry', 'memory.card_delete', 'forget-budget', { cardId: budget }), { operationId: 'forget-budget', version: 1, cardId: budget, deleted: true, alreadyApplied: true }, 'a retried delete returns the first outcome')
  assert.deepEqual((await write('forget-again', 'memory.card_delete', 'forget-budget-2', { cardId: budget })).deleted, false, 'a new delete of a gone card reports it gone')
  await assert.rejects(write('edit-gone', 'memory.card_update', 'edit-budget', { cardId: budget, statement: 'Garden budget is 500 euros' }), /Card not found/)

  const receipt = await run.tool('receipt', 'operations.get', { operationId: 'edit-sister-a' })
  assert.deepEqual([receipt.kind, receipt.target, receipt.state, receipt.result], ['card.update', { kind: 'card', id: sister }, 'succeeded', { cardId: sister }])
  assert.deepEqual((await run.tool('receipt-delete', 'operations.get', { operationId: 'forget-budget' })).result, { cardId: budget, deleted: true })
  const stored = (await ctx.db.query(`SELECT kind, options::text, request::text, result::text FROM kipster.admin_operations WHERE kind LIKE 'card.%' ORDER BY created_at`)).rows
  assert.deepEqual(stored.map(row => row.kind), ['card.update', 'card.update', 'card.delete', 'card.delete'], 'failed card actions record no receipt')
  assert.ok(stored.every(row => !/Priya|Pune|Garden|euros/.test(row.options + row.request + row.result)), 'receipts keep no card text')
})
