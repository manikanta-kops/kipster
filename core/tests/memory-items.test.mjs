import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { LessonService, MemoryService, embedPending } from '../dist/modules/memory/public.js'
import { lessonPage, lessonRemoval, lessonResult, memoryPage, memoryRemoval, memoryResult, stableError } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Memory and lesson actions of the Memory view over HTTP and the admin catalog, against real PostgreSQL with the deterministic
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
  const name = `kipster_memory_items_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-memory-items-'))
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
  /** Sends the person's message to Kip and returns its run, with the message as a memory source. */
  const start = async (context, text) => {
    const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context, agentId: rootAgentId })
    const response = await call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
    assert.equal(response.status, 202)
    const accepted = response.data
    const execution = await until(() => executions.find(e => e.context.runId === accepted.runId), Boolean, `execution of ${accepted.runId}`)
    return { ...execution, source: { threadId: accepted.threadId, messageId: accepted.messageId }, tool: (callId, operation, args = {}) => execution.handle.callTool(callId, 'run_admin_operation', { operation, arguments: args }) }
  }
  const memories = new MemoryService(runtime.db, installationId)
  const lessons = new LessonService(runtime.db, installationId)
  return { runtime, db: runtime.db, installationId, ownerId, organizationId, rootAgentId, serve, call, ok, refused, start, memories, lessons }
}

/** An installation memory, an organization memory, and a memory replaced by a newer one. */
async function seed(ctx) {
  const home = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'I am vegetarian and Priya is my sister')
  const garden = await ctx.start({ kind: 'organization', organizationId: ctx.organizationId }, 'The garden budget is 400 euros')
  const sister = await ctx.memories.create({ type: 'person', subject: 'Priya', statement: "User's sister", details: { relation: 'sister' }, organizationId: null }, [home.source])
  const steak = await ctx.memories.create({ type: 'preference', subject: 'user', statement: 'Loves steak', organizationId: null }, [home.source])
  const vegetarian = await ctx.memories.merge([steak], { type: 'preference', subject: 'user', statement: 'Vegetarian since Oct 2026', confirmed: true }, [home.source])
  const budget = await ctx.memories.create({ type: 'fact', subject: 'garden', statement: 'Garden budget is 400 euros', organizationId: ctx.organizationId }, [garden.source])
  return { home, garden, sister, steak, vegetarian, budget }
}

test('the owner lists memories of every organization with paging, and replaced memories on demand', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { home, garden, sister, steak, vegetarian, budget } = await seed(ctx)

  const page = memoryPage.parse(await ctx.ok('GET', '/v1/memory/memories'))
  assert.deepEqual(page.memories.map(item => item.id).sort(), [sister, vegetarian, budget].sort(), 'current memories only by default')
  assert.equal(page.nextCursor, null)
  const byId = Object.fromEntries(page.memories.map(item => [item.id, item]))
  assert.equal(byId[budget].organizationId, ctx.organizationId)
  assert.deepEqual(byId[budget].sources, [garden.source])
  assert.equal(byId[sister].organizationId, null)
  assert.deepEqual(byId[sister].sources, [home.source])
  assert.deepEqual(byId[sister].details, { relation: 'sister' })
  assert.equal(byId[vegetarian].confirmed, true)
  assert.equal(byId[sister].confirmed, false)

  const ended = memoryPage.parse(await ctx.ok('GET', '/v1/memory/memories?ended=true'))
  const replaced = ended.memories.find(item => item.id === steak)
  assert.equal(ended.memories.length, 4)
  assert.equal(replaced.replacedBy, vegetarian)
  assert.ok(replaced.validTo)

  const seen = []
  let cursor = null
  do {
    const next = memoryPage.parse(await ctx.ok('GET', `/v1/memory/memories?ended=true&limit=1${cursor ? `&cursor=${cursor}` : ''}`))
    assert.equal(next.memories.length, 1)
    seen.push(next.memories[0].id)
    cursor = next.nextCursor
  } while (cursor)
  assert.deepEqual(seen, ended.memories.map(item => item.id), 'pages follow the full list in order')

  assert.deepEqual(memoryResult.parse(await ctx.ok('GET', `/v1/memory/memories/${budget}`)).memory, byId[budget])
  await ctx.refused('GET', `/v1/memory/memories/${randomUUID()}`, undefined, 404, 'not-found')
  for (const query of ['ended=yes', 'limit=0', 'limit=201', 'limit=ten', `cursor=${randomUUID()}`, 'cursor=nope'])
    await ctx.refused('GET', `/v1/memory/memories?${query}`, undefined, 400, 'invalid')

  const stranger = await ctx.serve({ installationId: ctx.installationId, personId: randomUUID() })
  for (const [method, path, body] of [['GET', '/v1/memory/memories'], ['GET', `/v1/memory/memories/${sister}`], ['PUT', `/v1/memory/memories/${sister}`, { version: 1, statement: 'Not mine' }], ['DELETE', `/v1/memory/memories/${sister}`]]) {
    const response = await stranger(method, path, body)
    assert.equal(response.status, 403, `${method} ${path}`)
  }
  assert.equal((await ctx.memories.get(sister)).statement, "User's sister", 'a refused caller changes nothing')
})

test('an edit changes a current memory, confirms it and clears its embedding; invalid and replaced edits are refused', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { sister, steak, vegetarian } = await seed(ctx)
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)
  assert.equal((await ctx.memories.get(sister)).embedded, true)

  const edited = memoryResult.parse(await ctx.ok('PUT', `/v1/memory/memories/${sister}`, { version: 1, statement: "  User's younger sister ", details: { relation: 'sister', age: 'younger' } })).memory
  assert.equal(edited.statement, "User's younger sister")
  assert.deepEqual(edited.details, { relation: 'sister', age: 'younger' })
  assert.deepEqual([edited.type, edited.subject, edited.confirmed, edited.embedded], ['person', 'Priya', true, false])
  assert.deepEqual(await ctx.memories.get(sister), edited)

  const again = memoryResult.parse(await ctx.ok('PUT', `/v1/memory/memories/${sister}`, { version: 1, statement: "User's younger sister", type: 'Person' })).memory
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
  ]) await ctx.refused('PUT', `/v1/memory/memories/${sister}`, body, 400, 'invalid')
  assert.deepEqual(await ctx.memories.get(sister), edited, 'refused edits change nothing')

  await ctx.refused('PUT', `/v1/memory/memories/${steak}`, { version: 1, statement: 'Loves fish' }, 409, 'conflict')
  assert.equal((await ctx.memories.get(steak)).statement, 'Loves steak')
  await ctx.refused('PUT', `/v1/memory/memories/${randomUUID()}`, { version: 1, statement: 'Gone' }, 404, 'not-found')
  assert.equal((await ctx.memories.get(vegetarian)).statement, 'Vegetarian since Oct 2026')
})

test('deleting a memory removes it with its sources and embedding; messages and the memory it replaced stay', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { home, sister, steak, vegetarian } = await seed(ctx)
  await embedPending(ctx.db, ctx.installationId, ctx.runtime.embedding)
  const messages = async () => (await ctx.db.query('SELECT count(*)::int AS n FROM kipster.messages')).rows[0].n
  const before = await messages()

  assert.deepEqual(memoryRemoval.parse(await ctx.ok('DELETE', `/v1/memory/memories/${vegetarian}`)), { version: 1, memoryId: vegetarian, deleted: true })
  assert.equal(await ctx.memories.get(vegetarian), null)
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM kipster.memory_sources WHERE memory_id=$1', [vegetarian])).rows[0].n, 0)
  assert.equal(await messages(), before, 'messages stay')
  assert.ok((await ctx.db.query('SELECT 1 FROM kipster.messages WHERE id=$1', [home.source.messageId])).rows.length)
  const replaced = await ctx.memories.get(steak)
  assert.ok(replaced.validTo, 'the memory it replaced stays ended')
  assert.equal(replaced.replacedBy, null)
  assert.equal((await ctx.memories.get(sister)).sources.length, 1, 'other memories keep their sources')

  assert.deepEqual(await ctx.ok('DELETE', `/v1/memory/memories/${vegetarian}`), { version: 1, memoryId: vegetarian, deleted: false }, 'a repeated delete reports the memory gone')
  assert.deepEqual((await ctx.ok('DELETE', `/v1/memory/memories/${steak}`)).deleted, true, 'a replaced memory can be deleted')
  await ctx.refused('GET', `/v1/memory/memories/${steak}`, undefined, 404, 'not-found')
})

test('Kip reads, edits and deletes memories through the admin catalog with the same results as HTTP', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { sister, steak, budget } = await seed(ctx)
  const run = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'Fix my memory')

  const listing = await run.handle.callTool('list', 'list_admin_operations', { area: 'memory' })
  assert.deepEqual(listing.areas[0].operations.map(item => item.operation), ['memory.memories_list', 'memory.memory_get', 'memory.memory_update', 'memory.memory_delete', 'memory.lessons_list', 'memory.lesson_get', 'memory.lesson_update', 'memory.lesson_delete'])
  const update = await run.handle.callTool('describe', 'list_admin_operations', { operation: 'memory.memory_update' })
  assert.deepEqual([update.kind, update.operationId, update.arguments.required], ['write', 'required', ['memoryId']])
  const write = (callId, operation, operationId, args) => run.handle.callTool(callId, 'run_admin_operation', { operation, arguments: args, operationId })

  assert.deepEqual(await run.tool('memories', 'memory.memories_list'), await ctx.ok('GET', '/v1/memory/memories'))
  assert.deepEqual(await run.tool('ended', 'memory.memories_list', { ended: true, limit: 2 }), await ctx.ok('GET', '/v1/memory/memories?ended=true&limit=2'))
  assert.deepEqual(await run.tool('budget', 'memory.memory_get', { memoryId: budget }), await ctx.ok('GET', `/v1/memory/memories/${budget}`))

  await assert.rejects(run.tool('no-id', 'memory.memory_update', { memoryId: sister, subject: 'Priya Rao' }), /needs an operationId/)
  const edited = await write('edit', 'memory.memory_update', 'edit-sister-a', { memoryId: sister, subject: 'Priya Rao' })
  assert.deepEqual([edited.operationId, edited.alreadyApplied, edited.memory.subject, edited.memory.confirmed], ['edit-sister-a', false, 'Priya Rao', true])
  assert.deepEqual(await ctx.ok('GET', `/v1/memory/memories/${sister}`), { version: 1, memory: edited.memory })
  const newer = await write('edit-b', 'memory.memory_update', 'edit-sister-b', { memoryId: sister, subject: 'Priya R.', details: { relation: 'sister', city: 'Pune' } })
  assert.equal(newer.memory.subject, 'Priya R.')
  const replay = await write('edit-retry', 'memory.memory_update', 'edit-sister-a', { memoryId: sister, subject: 'Priya Rao' })
  assert.deepEqual([replay.alreadyApplied, replay.memory], [true, newer.memory], 'a retried edit returns the memory as it is and keeps the newer correction')
  assert.deepEqual((await ctx.ok('GET', `/v1/memory/memories/${sister}`)).memory, newer.memory)
  await assert.rejects(write('edit-other', 'memory.memory_update', 'edit-sister-a', { memoryId: sister, subject: 'Someone else' }), /different request/)
  await assert.rejects(write('edit-moved', 'memory.memory_update', 'edit-sister-a', { memoryId: budget, subject: 'Priya Rao' }), /different request/)
  await assert.rejects(write('bad-edit', 'memory.memory_update', 'bad-edit', { memoryId: sister, statement: '' }), /Invalid wire value/)
  await assert.rejects(write('no-edit', 'memory.memory_update', 'no-edit', { memoryId: sister }), /nothing to change/)
  await assert.rejects(write('ended-edit', 'memory.memory_update', 'ended-edit', { memoryId: steak, statement: 'Loves fish' }), /replaced/)
  await assert.rejects(run.tool('missing', 'memory.memory_get', { memoryId: 'not-a-memory' }), /Memory not found/)

  await assert.rejects(run.tool('forget-no-id', 'memory.memory_delete', { memoryId: budget }), /needs an operationId/)
  assert.deepEqual(await write('forget', 'memory.memory_delete', 'forget-budget', { memoryId: budget }), { operationId: 'forget-budget', version: 1, memoryId: budget, deleted: true, alreadyApplied: false })
  assert.equal(await ctx.memories.get(budget), null)
  assert.deepEqual(await write('forget-retry', 'memory.memory_delete', 'forget-budget', { memoryId: budget }), { operationId: 'forget-budget', version: 1, memoryId: budget, deleted: true, alreadyApplied: true }, 'a retried delete returns the first outcome')
  assert.deepEqual((await write('forget-again', 'memory.memory_delete', 'forget-budget-2', { memoryId: budget })).deleted, false, 'a new delete of a gone memory reports it gone')
  await assert.rejects(write('edit-gone', 'memory.memory_update', 'edit-budget', { memoryId: budget, statement: 'Garden budget is 500 euros' }), /Memory not found/)

  const receipt = await run.tool('receipt', 'operations.get', { operationId: 'edit-sister-a' })
  assert.deepEqual([receipt.kind, receipt.target, receipt.state, receipt.result], ['memory.update', { kind: 'memory', id: sister }, 'succeeded', { memoryId: sister }])
  assert.deepEqual((await run.tool('receipt-delete', 'operations.get', { operationId: 'forget-budget' })).result, { memoryId: budget, deleted: true })
  const stored = (await ctx.db.query(`SELECT kind, options::text, request::text, result::text FROM kipster.admin_operations WHERE kind LIKE 'memory.%' ORDER BY created_at`)).rows
  assert.deepEqual(stored.map(row => row.kind), ['memory.update', 'memory.update', 'memory.delete', 'memory.delete'], 'failed memory actions record no receipt')
  assert.ok(stored.every(row => !/Priya|Pune|Garden|euros/.test(row.options + row.request + row.result)), 'receipts keep no memory text')
})

/** Two lessons of Kip, one learned in the organization, and one of them confirmed more often. */
async function seedLessons(ctx) {
  const home = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'Use the 2026 template for expense reports')
  const garden = await ctx.start({ kind: 'organization', organizationId: ctx.organizationId }, 'Garden invoices go to the shared folder')
  const template = await ctx.lessons.create(ctx.rootAgentId, { statement: 'For expense reports, use the 2026 template', organizationId: null }, [home.source], '2026-10-19')
  await ctx.lessons.update(ctx.rootAgentId, template, {}, [home.source], '2026-10-20')
  const invoices = await ctx.lessons.create(ctx.rootAgentId, { statement: 'Garden invoices go to the shared folder', organizationId: ctx.organizationId }, [garden.source], '2026-10-20')
  return { home, garden, template, invoices }
}
const learned = async ctx => (await ctx.runtime.home.identity.read(ctx.rootAgentId, 'identity.md')).content

test('the owner lists, reads, rewords and deletes lessons; the Learned section of identity.md follows at once', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { home, template, invoices } = await seedLessons(ctx)

  const page = lessonPage.parse(await ctx.ok('GET', '/v1/memory/lessons'))
  assert.deepEqual(page.lessons.map(item => item.id).sort(), [template, invoices].sort())
  const byId = Object.fromEntries(page.lessons.map(item => [item.id, item]))
  assert.deepEqual([byId[template].agentId, byId[template].confirmations, byId[template].lastConfirmedNight, byId[template].organizationId], [ctx.rootAgentId, 2, '2026-10-20', null])
  assert.deepEqual(byId[template].sources, [home.source])
  assert.equal(byId[invoices].organizationId, ctx.organizationId)
  assert.deepEqual(lessonPage.parse(await ctx.ok('GET', `/v1/memory/lessons?agentId=${ctx.rootAgentId}`)).lessons.length, 2)
  assert.deepEqual(lessonPage.parse(await ctx.ok('GET', `/v1/memory/lessons?agentId=${randomUUID()}`)).lessons, [])
  assert.deepEqual(lessonResult.parse(await ctx.ok('GET', `/v1/memory/lessons/${template}`)).lesson, byId[template])
  await ctx.refused('GET', `/v1/memory/lessons/${randomUUID()}`, undefined, 404, 'not-found')
  for (const body of [{ version: 1 }, { version: 1, statement: '' }, { version: 1, statement: 'x'.repeat(1001) }, { statement: 'No version' }])
    await ctx.refused('PUT', `/v1/memory/lessons/${template}`, body, 400, 'invalid')

  const edited = lessonResult.parse(await ctx.ok('PUT', `/v1/memory/lessons/${template}`, { version: 1, statement: 'For expense reports, use the 2026 template in the Finance folder' })).lesson
  assert.deepEqual([edited.statement, edited.confirmations, edited.embedded], ['For expense reports, use the 2026 template in the Finance folder', 2, false])
  let file = await learned(ctx)
  assert.match(file, /## Learned/)
  assert.ok(file.indexOf('use the 2026 template in the Finance folder') < file.indexOf('Garden invoices go to the shared folder (learned in Org)'), 'the most confirmed lesson comes first, with the workspace it came from')

  assert.deepEqual(lessonRemoval.parse(await ctx.ok('DELETE', `/v1/memory/lessons/${template}`)), { version: 1, lessonId: template, deleted: true })
  file = await learned(ctx)
  assert.doesNotMatch(file, /2026 template/)
  assert.match(file, /Garden invoices/)
  assert.deepEqual(await ctx.ok('DELETE', `/v1/memory/lessons/${template}`), { version: 1, lessonId: template, deleted: false })

  const stranger = await ctx.serve({ installationId: ctx.installationId, personId: randomUUID() })
  for (const [method, path, body] of [['GET', '/v1/memory/lessons'], ['PUT', `/v1/memory/lessons/${invoices}`, { version: 1, statement: 'Not mine' }], ['DELETE', `/v1/memory/lessons/${invoices}`]])
    assert.equal((await stranger(method, path, body)).status, 403, `${method} ${path}`)
})

test('Kip manages lessons through the admin catalog with operation IDs, as HTTP does', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const { template, invoices } = await seedLessons(ctx)
  const run = await ctx.start({ kind: 'installation', installationId: ctx.installationId }, 'Fix what you learned')
  const write = (callId, operation, operationId, args) => run.handle.callTool(callId, 'run_admin_operation', { operation, arguments: args, operationId })

  assert.deepEqual(await run.tool('lessons', 'memory.lessons_list', { agentId: ctx.rootAgentId }), await ctx.ok('GET', `/v1/memory/lessons?agentId=${ctx.rootAgentId}`))
  assert.deepEqual(await run.tool('lesson', 'memory.lesson_get', { lessonId: invoices }), await ctx.ok('GET', `/v1/memory/lessons/${invoices}`))
  await assert.rejects(run.tool('no-id', 'memory.lesson_update', { lessonId: template, statement: 'Use the template' }), /needs an operationId/)
  const edited = await write('edit', 'memory.lesson_update', 'edit-lesson', { lessonId: template, statement: 'Use the 2026 template for every expense report' })
  assert.deepEqual([edited.alreadyApplied, edited.lesson.statement], [false, 'Use the 2026 template for every expense report'])
  assert.match(await learned(ctx), /Use the 2026 template for every expense report/)
  assert.deepEqual((await write('edit-retry', 'memory.lesson_update', 'edit-lesson', { lessonId: template, statement: 'Use the 2026 template for every expense report' })).alreadyApplied, true)
  assert.deepEqual(await write('forget', 'memory.lesson_delete', 'forget-lesson', { lessonId: invoices }), { operationId: 'forget-lesson', version: 1, lessonId: invoices, deleted: true, alreadyApplied: false })
  assert.doesNotMatch(await learned(ctx), /Garden invoices/)
  assert.deepEqual((await write('forget-retry', 'memory.lesson_delete', 'forget-lesson', { lessonId: invoices })).alreadyApplied, true)
  const stored = (await ctx.db.query(`SELECT kind, options::text, request::text, result::text FROM kipster.admin_operations WHERE kind LIKE 'lesson.%' ORDER BY created_at`)).rows
  assert.deepEqual(stored.map(row => row.kind), ['lesson.update', 'lesson.delete'])
  assert.ok(stored.every(row => !/template|Garden/.test(row.options + row.request + row.result)), 'receipts keep no lesson text')
})
