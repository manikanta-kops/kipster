import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { agentResult, directorySnapshot, operationStatus } from '../dist/protocol/admin.js'
import { stableError, textEvent, threadSnapshot } from '../dist/protocol/text.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase, taskDataRole } from './support/database.mjs'

// Permanent deletion of an archived agent over HTTP against real PostgreSQL, with the deterministic
// fixture adapter. The agent's chats, memory, vectors, task data, files and home go; organization
// publications, delegation records in other agents' threads and a tombstone with its name stay.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const profile = { id: 'fixture-provider', contractMajor: 1, model: 'fixture-embedding' }
const sha256 = text => createHash('sha256').update(text).digest('hex')
const exists = path => access(path).then(() => true, () => false)
async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 800; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 300)})`)
}

async function setup(t, { forget = false } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_deletion_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const restricted = new URL(url)
  restricted.username = taskDataRole
  const home = await mkdtemp(join(tmpdir(), 'kipster-deletion-'))
  const runtime = await openRuntime({ connectionString: url.href, taskDataConnectionString: restricted.href, home, names, executionLimit: 6,
    embedding: { ...profile, async embed() { return [0, 0, 1] } } })
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const executions = [], forgotten = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  const adapter = { ...inner, async execute(context) {
    const handle = await inner.execute(context)
    executions.push({ context, handle })
    return handle
  }, ...(forget ? { async forgetProviderState(request) { forgotten.push([...request.threadIds]) } } : {}) }
  dispatcher = new TextDispatcher(runtime, adapter)
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0, dispatcher })
    closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      const text = await response.text()
      return { status: response.status, data: text && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text }
    }
  }
  const call = await serve(actor)
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  await dispatcher.start()
  await ok('PUT', `/v1/organizations/${organizationId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  const create = async (name, organization = organizationId) => (await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId: organization })).agent.id
  const scout = await create('Scout')
  const helper = await create('Helper')
  const context = { kind: 'organization', organizationId }
  const ctx = { runtime, db: runtime.db, dispatcher, actor, installationId, ownerId, organizationId, root: rootAgentId, scout, helper, context, executions, forgotten, home, url, call, ok, serve, create }
  ctx.chat = async (agentId = scout, chatContext = context) => (await ok('POST', '/v1/direct-chats', { version: 1, context: chatContext, agentId })).chatId
  ctx.submit = (chatId, text, chatContext = context) => call('POST', '/v1/text/submissions', {
    version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: chatContext, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
  ctx.execution = (runId, from = 0) => until(() => executions.slice(from).find(item => item.context.runId === runId), Boolean, `execution of ${runId}`)
  /** A running execution of the agent, with a tool caller bound to its attempt. */
  ctx.running = async (agentId = scout, text = 'Work on this', chatContext = context) => {
    const chatId = await ctx.chat(agentId, chatContext)
    const saved = await ctx.submit(chatId, text, chatContext)
    assert.equal(saved.status, 202, JSON.stringify(saved.data))
    return ctx.bind({ ...saved.data, chatId, chat: chatContext }, await ctx.execution(saved.data.runId))
  }
  ctx.bind = (run, found) => {
    const attemptId = found.context.attemptId
    return { ...run, found, attemptId, release: event => found.handle.release({ attemptId, ...event }), call: (name, args) => found.handle.callTool(randomUUID(), name, args) }
  }
  ctx.finish = (run, text = 'Done') => {
    run.release({ kind: 'text', messageId: `answer-${randomUUID()}`, text, final: true })
    run.release({ kind: 'ended', confirmed: true })
  }
  ctx.settled = (runId, state) => until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]?.state, value => value === state, `run ${runId} ${state}`)
  ctx.provider = (run, threadId) => run.release({ kind: 'provider', threadId, processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  ctx.remove = (agentId, body = {}, operationId = randomUUID(), as = call) => as('DELETE', `/v1/agents/${agentId}`, { version: 1, operationId, ...body })
  ctx.operation = operationId => until(() => ok('GET', `/v1/operations/${operationId}`), value => ['succeeded', 'failed'].includes(value.state), `operation ${operationId}`)
  ctx.cursor = async () => (await ok('GET', '/v1/app/snapshot')).cursor
  ctx.events = async cursor => (await readEvents(ctx.db, { kind: 'application', installationId, callerId: ownerId }, cursor, 1000)).events
  return ctx
}

/**
 * Gives Scout a chat of its own with a file it showed there, a file it never showed, an organization
 * publication, a vector collection, task data and an identity backup; and work Root delegated to
 * it, in which Scout showed a file and passed it on to Helper. Both threads carry memory.
 */
async function populate(ctx) {
  const own = await ctx.running(ctx.scout, 'Write the report')
  ctx.provider(own, 'codex-scout-own')
  const written = await own.call('artifacts_write', { name: 'report.txt', content: 'Quarterly numbers' })
  const shown = (await own.call('artifacts_publish', { outputId: written.outputId })).artifact
  await own.call('conversation_publish', { text: 'Here is the report', artifactIds: [shown.id] })
  const publication = (await own.call('artifacts_copy_to_organization', { artifactId: shown.id })).artifact
  const draft = await own.call('artifacts_write', { name: 'draft.txt', content: 'Draft only' })
  const unshown = (await own.call('artifacts_publish', { outputId: draft.outputId })).artifact
  const target = { kind: 'agent', ownerId: ctx.scout }
  const collection = await own.call('vector_collections', { target, operation: 'create', name: 'notes' })
  await own.call('vector_collections', { target, operation: 'upsert', collectionId: collection.collectionId, key: 'one', expectedRevision: 0, text: 'A note' })
  await own.call('data_tables', { target, operation: 'create_table', table: 'notes', columns: [{ name: 'note', type: 'text' }] })
  ctx.finish(own)
  await ctx.settled(own.runId, 'completed')

  const identity = await ctx.runtime.home.identity.write(ctx.scout, 'identity.md', '# Identity\nScout checks numbers.\n', sha256('# Identity\n'), 'owner')
  assert.ok(identity.sha256)

  // Root delegates to Scout; Scout shows a file in its reply thread and passes it on to Helper.
  const parent = await ctx.running(ctx.root, 'Ask Scout for the numbers')
  const delegated = await parent.call('agents_delegate', { recipientId: ctx.scout, request: 'Check the numbers' })
  parent.release({ kind: 'ended', confirmed: true })
  await ctx.settled(parent.runId, 'waiting')
  const child = ctx.bind({ runId: delegated.childRunId }, await ctx.execution(delegated.childRunId))
  ctx.provider(child, 'codex-scout-child')
  const checked = await child.call('artifacts_write', { name: 'checked.txt', content: 'Checked numbers' })
  const childFile = (await child.call('artifacts_publish', { outputId: checked.outputId })).artifact
  await child.call('conversation_publish', { text: 'Checked', artifactIds: [childFile.id] })
  const further = await child.call('agents_delegate', { recipientId: ctx.helper, request: 'Double-check this file', artifactIds: [childFile.id] })
  let mark = ctx.executions.length
  child.release({ kind: 'ended', confirmed: true })
  ctx.finish(ctx.bind({}, await ctx.execution(further.childRunId)), 'Looks right')
  await ctx.settled(further.childRunId, 'completed')
  ctx.finish(ctx.bind({}, await ctx.execution(delegated.childRunId, mark)), 'The numbers are fine')
  await ctx.settled(delegated.childRunId, 'completed')
  mark = ctx.executions.length
  ctx.finish(ctx.bind({}, await ctx.execution(parent.runId, mark)), 'Scout says fine')
  await ctx.settled(parent.runId, 'completed')

  const threads = (await ctx.db.query('SELECT thread_id AS id FROM kipster.text_runs WHERE id = ANY($1::uuid[])', [[own.runId, delegated.childRunId]])).rows.map(row => row.id)
  const runs = [own.runId, delegated.childRunId]
  const attempts = (await ctx.db.query('SELECT id FROM kipster.attempts WHERE intent_id = ANY($1::uuid[])', [runs])).rows.map(row => row.id)
  const messages = (await ctx.db.query('SELECT id FROM kipster.messages WHERE thread_id = ANY($1::uuid[])', [threads])).rows.map(row => row.id)
  const data = { own, parent, delegated, further, shown, unshown, childFile, publication, collection, threads, runs, attempts, messages }
  return { ...data, memory: await seedMemory(ctx, data) }
}

/** A 768-dimension embedding literal. */
const vector = value => `[${Array(768).fill(value).join(',')}]`

/**
 * Memory derived from Scout's own thread and from Root's thread: chunks, processing state, diary pages,
 * a card learned only in Scout's thread, one learned in both, one learned only in Root's thread, and
 * an ended card that Scout's card replaced.
 */
async function seedMemory(ctx, data) {
  const { db, installationId, organizationId } = ctx
  const input = async runId => (await db.query('SELECT input_message_id AS id FROM kipster.text_runs WHERE id=$1', [runId])).rows[0].id
  const scoutThread = data.own.threadId, rootThread = data.parent.threadId
  const scoutMessage = await input(data.own.runId), rootMessage = await input(data.parent.runId)
  const chunk = async (threadId, agentId, embedded) => {
    const id = randomUUID()
    await db.query(`INSERT INTO kipster.thread_chunks(id,installation_id,thread_id,agent_id,organization_id,from_position,to_position,started_at,ended_at,title,text,embedding,embedding_model)
      VALUES ($1,$2,$3,$4,$5,1,2,now(),now(),'Mon 12 Oct 2026, with a kip','The messages in full',$6::vector,$7)`, [id, installationId, threadId, agentId, organizationId, embedded ? vector(0.1) : null, embedded ? 'fixture-embedding' : null])
    return id
  }
  const card = async (statement, sources, extra = {}) => {
    const id = randomUUID()
    await db.query(`INSERT INTO kipster.cards(id,installation_id,type,subject,statement,details,confirmed,organization_id,valid_to,replaced_by)
      VALUES ($1,$2,'fact','user',$3,'{}',true,$4,CASE WHEN $5::boolean THEN now() END,$6)`, [id, installationId, statement, extra.organizationId ?? null, extra.ended ?? false, extra.replacedBy ?? null])
    for (const [threadId, messageId] of sources) await db.query('INSERT INTO kipster.card_sources(card_id,installation_id,thread_id,message_id) VALUES ($1,$2,$3,$4)', [id, installationId, threadId, messageId])
    return id
  }
  const diary = (agentId, day, threadIds) => db.query('INSERT INTO kipster.diary(agent_id,day,installation_id,summary,thread_ids) VALUES ($1,$2,$3,$4,$5::uuid[])', [agentId, day, installationId, `What happened on ${day}`, threadIds])
  const memory = {
    scoutChunk: await chunk(scoutThread, ctx.scout, true),
    rootChunk: await chunk(rootThread, ctx.root, true),
    scoutCard: await card('Prefers short reports', [[scoutThread, scoutMessage]]),
    sharedCard: await card('Works on quarterly numbers', [[scoutThread, scoutMessage], [rootThread, rootMessage]]),
    rootCard: await card('Asks Scout for numbers', [[rootThread, rootMessage]]),
    scoutMessage, rootMessage,
  }
  memory.endedCard = await card('Prefers long reports', [[rootThread, rootMessage]], { ended: true, replacedBy: memory.scoutCard })
  for (const threadId of [scoutThread, rootThread]) await db.query('INSERT INTO kipster.memory_thread_state(thread_id,installation_id,processed_position) VALUES ($1,$2,2)', [threadId, installationId])
  await diary(ctx.scout, '2026-10-11', [scoutThread])
  await diary(ctx.root, '2026-10-11', [scoutThread, rootThread])
  await diary(ctx.root, '2026-10-10', [scoutThread])
  return memory
}

/** Every uuid column in Core's tables that still holds one of the IDs, as `table.column`. */
async function references(db, ids) {
  const columns = (await db.query(`SELECT c.table_schema, c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema IN ('kipster','task_data') AND c.data_type='uuid' AND t.table_type='BASE TABLE' ORDER BY 1,2,3`)).rows
  const found = []
  for (const column of columns) {
    const { n } = (await db.query(`SELECT count(*)::int AS n FROM "${column.table_schema}"."${column.table_name}" WHERE "${column.column_name}" = ANY($1::uuid[])`, [ids])).rows[0]
    if (n) found.push(`${column.table_name}.${column.column_name}`)
  }
  return found
}

async function deleteScout(ctx, options) {
  const cursor = await ctx.cursor()
  const archived = await ctx.ok('POST', `/v1/agents/${ctx.scout}/archive`, { version: 1, operationId: randomUUID() })
  assert.equal(archived.agent.lifecycle, 'archived')
  const operationId = randomUUID()
  const started = await ctx.remove(ctx.scout, options, operationId)
  assert.equal(started.status, 200, JSON.stringify(started.data))
  const result = agentResult.parse(started.data)
  assert.equal(result.agent.lifecycle, 'deleting')
  assert.equal(result.alreadyApplied, false)
  const operation = operationStatus.parse({ version: 1, ...await ctx.operation(operationId) })
  assert.equal(operation.state, 'succeeded', JSON.stringify(operation))
  assert.equal(operation.kind, 'agent.delete')
  const events = await ctx.events(cursor)
  for (const event of events) textEvent.parse(event)
  return { operationId, operation, events }
}

async function assertRemoved(ctx, data, events, { copies }) {
  const { scout, home } = ctx
  // Directory: a tombstone with the last name and no memberships.
  const directory = directorySnapshot.parse(await ctx.ok('GET', '/v1/directory'))
  const tombstone = directory.agents.find(agent => agent.id === scout)
  assert.equal(tombstone.name, 'Scout')
  assert.equal(tombstone.lifecycle, 'deleted')
  assert.ok(tombstone.deletedAt)
  assert.equal(directory.memberships.filter(item => item.agentId === scout).length, 0)
  assert.deepEqual(events.filter(event => event.type === 'agent-changed' && event.resourceId === scout).map(event => event.data.lifecycle), ['archived', 'deleting', 'deleted'])
  assert.deepEqual(events.filter(event => event.type === 'thread-removed').map(event => event.data), [{ threadId: data.own.threadId, chatId: data.own.chatId }])
  assert.equal(events.filter(event => event.type === 'membership-removed' && event.data.agentId === scout).length, data.memberships ?? 1)
  const agentRow = (await ctx.db.query('SELECT settings, description, sleep_time FROM kipster.agents WHERE id=$1', [scout])).rows[0]
  assert.deepEqual(agentRow, { settings: {}, description: '', sleep_time: null })

  // Its chat is gone; the delegation in Root's thread stays and names Scout.
  const gone = await ctx.call('GET', `/v1/threads/${data.own.threadId}/snapshot`)
  assert.ok([403, 410].includes(gone.status), JSON.stringify(gone))
  stableError.parse(gone.data)
  const rootThread = threadSnapshot.parse(await ctx.ok('GET', `/v1/threads/${data.parent.threadId}/snapshot`))
  const toScout = rootThread.delegations.find(item => item.id === data.delegated.id)
  assert.equal(toScout.recipientAgentId, scout)
  assert.equal(toScout.childRunId, null)
  assert.equal(toScout.state, 'completed')
  const fromScout = rootThread.delegations.find(item => item.id === data.further.id)
  assert.equal(fromScout.senderAgentId, scout)
  assert.equal(fromScout.parentRunId, null)
  assert.equal(fromScout.childRunId, data.further.childRunId)
  const results = (await ctx.db.query('SELECT result FROM kipster.delegations WHERE id=$1', [data.delegated.id])).rows[0]
  assert.equal(results.result, 'Checked\n\nThe numbers are fine')
  assert.ok(events.some(event => event.type === 'thread-summary' && event.resourceId === data.parent.threadId), 'Root\'s thread is told about the changed delegations')

  // The message Helper received keeps its text; the file becomes the organization copy or a removed part.
  const request = (await ctx.db.query('SELECT m.id, m.parts FROM kipster.messages m JOIN kipster.text_runs r ON r.input_message_id=m.id WHERE r.id=$1', [data.further.childRunId])).rows[0]
  const attached = (await ctx.db.query('SELECT artifact_id FROM kipster.message_artifacts WHERE message_id=$1', [request.id])).rows.map(row => row.artifact_id)
  if (copies) {
    const copy = copies.get(data.childFile.id)
    assert.deepEqual(request.parts, [{ kind: 'text', text: 'Double-check this file' }, { kind: 'file', artifactId: copy, purpose: 'attachment' }])
    assert.deepEqual(attached, [copy])
  } else {
    assert.deepEqual(request.parts, [{ kind: 'text', text: 'Double-check this file' }, { kind: 'removed', artifactId: data.childFile.id }])
    assert.deepEqual(attached, [])
  }

  // The organization publication, and copies when asked for, stay readable in the organization.
  const rootChat = await ctx.chat(ctx.root)
  const target = encodeURIComponent(JSON.stringify({ installationId: ctx.installationId, callerId: ctx.ownerId, context: ctx.context, chatId: rootChat }))
  const content = async id => ctx.call('GET', `/conversations/media/artifacts/${id}/content?target=${target}`)
  assert.equal((await content(data.publication.id)).data, 'Quarterly numbers')
  for (const [source, copy] of copies ?? []) {
    const bytes = (await content(copy)).data
    assert.equal(bytes, source === data.shown.id ? 'Quarterly numbers' : 'Checked numbers')
  }
  for (const file of [data.shown, data.unshown, data.childFile]) {
    assert.equal(await exists(join(home, 'artifacts', 'objects', file.id)), false)
    assert.notEqual((await content(file.id)).status, 200)
  }

  // Memory derived from its threads goes: chunks, processing state, card sources, cards left with no
  // source and its diary. Root's thread keeps its memory; its diary page loses the removed thread, and its
  // summary and embedding with it, until the next nightly run rebuilds it from Root's thread.
  const memory = data.memory
  const rows = async (sql, params = []) => (await ctx.db.query(sql, params)).rows
  assert.deepEqual(await rows('SELECT id, embedding IS NOT NULL AS embedded FROM kipster.thread_chunks'), [{ id: memory.rootChunk, embedded: true }])
  assert.deepEqual(await rows('SELECT thread_id FROM kipster.memory_thread_state'), [{ thread_id: data.parent.threadId }])
  const sources = id => rows('SELECT thread_id, message_id FROM kipster.card_sources WHERE card_id=$1', [id])
  assert.deepEqual(await rows('SELECT id FROM kipster.cards WHERE id=$1', [memory.scoutCard]), [])
  assert.deepEqual(await sources(memory.sharedCard), [{ thread_id: data.parent.threadId, message_id: memory.rootMessage }])
  assert.deepEqual(await sources(memory.rootCard), [{ thread_id: data.parent.threadId, message_id: memory.rootMessage }])
  assert.deepEqual(await rows('SELECT replaced_by, valid_to IS NOT NULL AS ended FROM kipster.cards WHERE id=$1', [memory.endedCard]), [{ replaced_by: null, ended: true }])
  assert.deepEqual(await rows("SELECT agent_id, day::text AS day, thread_ids, summary, embedding IS NULL AS unembedded FROM kipster.diary"), [{ agent_id: ctx.root, day: '2026-10-11', thread_ids: [data.parent.threadId], summary: null, unembedded: true }])

  // Vectors, task data, home, identity backups.
  assert.equal(await exists(join(home, 'agents', scout)), false)
  assert.deepEqual(await readdir(join(home, '.trash')), [])
  const schema = `task_a_${scout.replaceAll('-', '')}`
  assert.equal((await ctx.db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0)

  // Nothing else points at the agent or at what was removed with it.
  const removed = [...data.threads, ...data.runs, ...data.attempts, ...data.messages, data.own.chatId, data.shown.id, data.unshown.id, data.childFile.id, data.memory.scoutChunk, data.memory.scoutCard, data.collection.collectionId]
  assert.deepEqual(await references(ctx.db, removed), ['app_events.resource_id'])
  assert.deepEqual(await references(ctx.db, [scout]), ['admin_operations.target_id', 'agents.id', 'app_events.resource_id', 'artifacts.author_id', 'delegations.recipient_agent_id', 'delegations.sender_agent_id', 'messages.author_id'])
}

test('permanent deletion removes the agent\'s chats, memory, files and home and keeps a named tombstone', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t)
  const data = await populate(ctx)
  assert.equal(await exists(join(ctx.home, 'agents', ctx.scout, 'backups', 'identity.md', '1.md')), true)
  const { operation, events } = await deleteScout(ctx, {})
  // The fixture adapter cannot forget provider state, so the operation reports what stays.
  assert.deepEqual(operation.result, { providerState: { forgotten: 0, residue: [
    { adapterId: 'deterministic-fixture', reason: 'The adapter cannot forget provider state', threadIds: ['codex-scout-child', 'codex-scout-own'] }] } })
  await assertRemoved(ctx, data, events, { copies: null })
  // The organization publication lost its source link only.
  assert.equal((await ctx.db.query('SELECT source_id FROM kipster.artifacts WHERE id=$1', [data.publication.id])).rows[0].source_id, null)
})

test('copying files keeps each file shown in an organization\'s chats in that organization', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t, { forget: true })
  const data = await populate(ctx)
  // Scout also works in a second organization and shows a file there.
  const second = (await ctx.ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name: 'Second', settings: fixture })).organization.id
  for (const agentId of [ctx.scout, ctx.helper]) await ctx.ok('POST', `/v1/organizations/${second}/memberships`, { version: 1, operationId: randomUUID(), agentId })
  const secondContext = { kind: 'organization', organizationId: second }
  const there = await ctx.running(ctx.scout, 'Summarize', secondContext)
  const summary = (await there.call('artifacts_publish', { outputId: (await there.call('artifacts_write', { name: 'summary.txt', content: 'Summary' })).outputId })).artifact
  await there.call('conversation_publish', { text: 'Summary attached', artifactIds: [summary.id] })
  ctx.finish(there)
  await ctx.settled(there.runId, 'completed')

  const { operation, events } = await deleteScout(ctx, { copyFilesToOrganizations: true })
  assert.deepEqual(operation.result, { files: { copied: 2, unavailable: 0 }, providerState: { forgotten: 2, residue: [] } })
  assert.deepEqual(ctx.forgotten, [['codex-scout-child', 'codex-scout-own']])
  // Each shown file is in the organization whose chat showed it. The report already had the
  // organization's publication, and the draft was never shown, so neither is copied.
  const rows = (await ctx.db.query(`SELECT id, name, owner_kind, owner_id, provenance, source_id FROM kipster.artifacts WHERE author_id=$1 AND id <> $2 ORDER BY name`, [ctx.scout, data.publication.id])).rows
  assert.deepEqual(rows.map(row => [row.name, row.owner_kind, row.owner_id, row.provenance, row.source_id]), [
    ['checked.txt', 'organization', ctx.organizationId, 'published', null],
    ['summary.txt', 'organization', second, 'published', null],
  ])
  const helperChat = await ctx.chat(ctx.helper, secondContext)
  const target = encodeURIComponent(JSON.stringify({ installationId: ctx.installationId, callerId: ctx.ownerId, context: secondContext, chatId: helperChat }))
  assert.equal((await ctx.call('GET', `/conversations/media/artifacts/${rows[1].id}/content?target=${target}`)).data, 'Summary')
  assert.notEqual((await ctx.call('GET', `/conversations/media/artifacts/${rows[0].id}/content?target=${target}`)).status, 200)
  data.threads.push(there.threadId)
  data.memberships = 2
  data.runs.push(there.runId)
  await assertRemoved(ctx, data, events.filter(event => event.type !== 'thread-removed' || event.resourceId !== there.threadId), { copies: new Map([[data.childFile.id, rows[0].id]]) })
  assert.equal(events.filter(event => event.type === 'thread-removed' && event.resourceId === there.threadId).length, 1)
})

test('only an archived agent can be deleted, by the owner, once per operation ID', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const refused = async (response, status, code) => {
    assert.equal(response.status, status, JSON.stringify(response.data))
    assert.equal(stableError.parse(response.data).code, code)
  }
  const operations = async () => Number((await ctx.db.query(`SELECT count(*) AS n FROM kipster.admin_operations WHERE kind='agent.delete'`)).rows[0].n)
  await refused(await ctx.remove(ctx.scout), 409, 'conflict')
  await refused(await ctx.remove(ctx.root), 409, 'conflict')
  await refused(await ctx.remove(randomUUID()), 404, 'not-found')
  assert.equal(await operations(), 0)
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [ctx.scout])).rows[0].lifecycle, 'active')

  await ctx.ok('POST', `/v1/agents/${ctx.scout}/archive`, { version: 1, operationId: randomUUID() })
  // Another installation's owner and a person who is not the owner are refused.
  const stranger = await ctx.serve({ installationId: ctx.installationId, personId: randomUUID() })
  await refused(await ctx.remove(ctx.scout, {}, randomUUID(), stranger), 403, 'forbidden')
  assert.equal(await operations(), 0)

  const operationId = randomUUID()
  const first = agentResult.parse((await ctx.remove(ctx.scout, {}, operationId)).data)
  const again = agentResult.parse((await ctx.remove(ctx.scout, {}, operationId)).data)
  assert.equal(first.alreadyApplied, false)
  assert.equal(again.alreadyApplied, true)
  await ctx.operation(operationId)
  assert.equal(await operations(), 1)
  await refused(await ctx.remove(ctx.scout), 409, 'conflict')
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [ctx.scout])).rows[0].lifecycle, 'deleted')
  // A deleted agent cannot be restored.
  await refused(await ctx.call('POST', `/v1/agents/${ctx.scout}/restore`, { version: 1, operationId: randomUUID() }), 404, 'not-found')
})

test('deletion waits for work that can still write, then finishes', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const running = await ctx.running(ctx.scout, 'Keep going')
  await ctx.ok('POST', `/v1/agents/${ctx.scout}/archive`, { version: 1, operationId: randomUUID() })
  await ctx.settled(running.runId, 'cancellation-requested')
  const operationId = randomUUID()
  assert.equal((await ctx.remove(ctx.scout, {}, operationId)).status, 200)
  const waiting = await until(() => ctx.ok('GET', `/v1/operations/${operationId}`), value => value.state === 'waiting', 'waiting operation')
  assert.equal(waiting.step, 'wait-for-work')
  assert.match(waiting.waitingFor, /1 runs/)
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM kipster.text_runs WHERE id=$1', [running.runId])).rows[0].n, 1)
  // The provider ends; the deletion continues on its own.
  running.release({ kind: 'ended', confirmed: true })
  const done = await ctx.operation(operationId)
  assert.equal(done.state, 'succeeded')
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM kipster.text_runs WHERE id=$1', [running.runId])).rows[0].n, 0)
})

test('a restart in the middle of the cleanup finishes it once', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t)
  const data = await populate(ctx)
  // More threads than one batch removes.
  for (let i = 0; i < 6; i++) {
    const run = await ctx.running(ctx.scout, `Task ${i}`)
    ctx.finish(run)
    await ctx.settled(run.runId, 'completed')
  }
  const threads = (await ctx.db.query('SELECT t.id FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE c.agent_id=$1 ORDER BY t.id', [ctx.scout])).rows.map(row => row.id)
  assert.equal(threads.length, 7)
  const cursor = await ctx.cursor()
  await ctx.ok('POST', `/v1/agents/${ctx.scout}/archive`, { version: 1, operationId: randomUUID() })
  // Another process runs the deletion from here on.
  await ctx.dispatcher.close()
  const operationId = randomUUID()
  assert.equal((await ctx.remove(ctx.scout, { copyFilesToOrganizations: true }, operationId)).status, 200)
  const crash = kill => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./fixtures/deletion-crash.mjs', import.meta.url).pathname, ctx.url.href, ctx.home, operationId, kill], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const progress = async () => (await ctx.db.query(`SELECT state, step FROM kipster.admin_operations WHERE kind='agent.delete'`)).rows[0]
  assert.deepEqual(await crash('after:copy-files:1'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await progress(), { state: 'running', step: 'forget-provider-state' })
  assert.deepEqual(await crash('after:delete-chats:1'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await progress(), { state: 'running', step: 'delete-chats' })
  const left = (await ctx.db.query('SELECT count(*)::int AS n FROM kipster.threads WHERE id = ANY($1::uuid[])', [threads])).rows[0].n
  assert.ok(left > 0 && left < 7, `threads left after one batch: ${left}`)
  assert.deepEqual(await crash('after:remove-home:1'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await progress(), { state: 'running', step: 'tombstone' })
  assert.deepEqual(await crash('never'), { code: 0, signal: null })
  assert.deepEqual(await progress(), { state: 'succeeded', step: 'tombstone' })

  const events = await ctx.events(cursor)
  assert.deepEqual(events.filter(event => event.type === 'agent-changed' && event.resourceId === ctx.scout).map(event => event.data.lifecycle), ['archived', 'deleting', 'deleted'])
  const removedThreads = events.filter(event => event.type === 'thread-removed').map(event => event.resourceId).sort()
  assert.deepEqual(removedThreads, threads)
  const copies = (await ctx.db.query(`SELECT name FROM kipster.artifacts WHERE owner_kind='organization' AND author_id=$1 AND id <> $2 ORDER BY name`, [ctx.scout, data.publication.id])).rows.map(row => row.name)
  assert.deepEqual(copies, ['checked.txt'])
  assert.equal(await exists(join(ctx.home, 'agents', ctx.scout)), false)
  assert.deepEqual(await references(ctx.db, [ctx.scout]), ['admin_operations.target_id', 'agents.id', 'app_events.resource_id', 'artifacts.author_id', 'delegations.recipient_agent_id', 'delegations.sender_agent_id', 'messages.author_id'])
})

test('organization deletion fences work, removes owned resources and preserves global agents and other organizations', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t, { forget: true })
  const data = await populate(ctx)
  const second = (await ctx.ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name: 'Other', settings: fixture })).organization.id
  await ctx.ok('POST', `/v1/organizations/${second}/memberships`, { version: 1, operationId: randomUUID(), agentId: ctx.scout })
  const other = await ctx.running(ctx.scout, 'Independent work', { kind: 'organization', organizationId: second })
  const running = await ctx.running(ctx.helper, 'Work before deletion')
  const deletionCursor = await ctx.cursor()
  const shared = { kind: 'organization', ownerId: ctx.organizationId }
  const sharedCollection = await running.call('vector_collections', { target: shared, operation: 'create', name: 'shared_notes' })
  await running.call('data_tables', { target: shared, operation: 'create_table', table: 'shared_notes', columns: [{ name: 'note', type: 'text' }] })
  // Cards learned in the other organization's thread: one carries the deleted organization, one is global.
  const otherMessage = (await ctx.db.query('SELECT input_message_id AS id FROM kipster.text_runs WHERE id=$1', [other.runId])).rows[0].id
  const card = async organizationId => {
    const id = randomUUID()
    await ctx.db.query(`INSERT INTO kipster.cards(id,installation_id,type,subject,statement,organization_id) VALUES ($1,$2,'fact','user','Works with Scout',$3)`, [id, ctx.installationId, organizationId])
    await ctx.db.query('INSERT INTO kipster.card_sources(card_id,installation_id,thread_id,message_id) VALUES ($1,$2,$3,$4)', [id, ctx.installationId, other.threadId, otherMessage])
    return id
  }
  const organizationCard = await card(ctx.organizationId), globalCard = await card(null)
  const stranger = await ctx.serve({ installationId: ctx.installationId, personId: randomUUID() })
  assert.equal((await stranger('DELETE', `/v1/organizations/${ctx.organizationId}`, { version: 1, operationId: randomUUID() })).status, 403)

  const operationId = randomUUID()
  const body = { version: 1, operationId }
  assert.equal((await ctx.call('DELETE', `/v1/organizations/${ctx.organizationId}`, body)).status, 200)
  const waiting = await until(() => ctx.ok('GET', `/v1/operations/${operationId}`), r => r.state === 'waiting', 'organization waits')
  assert.equal(waiting.step, 'wait-for-work')
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.owned_permits WHERE attempt_id=$1', [running.attemptId])).rows[0].n, 1)
  running.release({ kind: 'text', messageId: 'late', text: 'Must not survive', final: true })
  running.release({ kind: 'ended', confirmed: true })
  assert.equal((await ctx.operation(operationId)).state, 'succeeded')
  assert.equal((await ctx.call('DELETE', `/v1/organizations/${ctx.organizationId}`, body)).data.alreadyApplied, true)
  assert.equal((await ctx.call('GET', `/v1/threads/${data.own.threadId}/snapshot`)).status, 410)
  const removedEvents = (await ctx.events(deletionCursor)).map(event => textEvent.parse(event))
  assert.ok(removedEvents.some(event => event.type === 'notification-removed'))
  assert.ok(removedEvents.some(event => event.type === 'organization-removed' && event.resourceId === ctx.organizationId))
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1', [ctx.scout])).rows[0].lifecycle, 'active')
  assert.equal((await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [other.runId])).rows[0].state, 'running')
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.agent_memberships WHERE organization_id=$1', [ctx.organizationId])).rows[0].n, 0)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2', [second, ctx.scout])).rows[0].n, 1)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.vector_collections WHERE id=$1', [sharedCollection.collectionId])).rows[0].n, 0)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM pg_namespace WHERE nspname=$1', [`task_o_${ctx.organizationId.replaceAll('-', '')}`])).rows[0].n, 0)
  // Its cards and the memory of its threads are gone; the global card stays.
  assert.deepEqual((await ctx.db.query('SELECT id FROM kipster.cards ORDER BY id')).rows, [{ id: globalCard }])
  assert.notEqual(organizationCard, globalCard)
  for (const table of ['thread_chunks', 'memory_thread_state', 'diary']) assert.equal((await ctx.db.query(`SELECT count(*)::int n FROM kipster.${table}`)).rows[0].n, 0, table)
  assert.equal(await exists(join(ctx.home, 'organizations', ctx.organizationId)), false)
  assert.equal(await exists(join(ctx.home, 'agents', ctx.scout)), true)
  assert.equal((await ctx.db.query("SELECT count(*)::int n FROM kipster.artifacts WHERE owner_kind='organization' AND owner_id=$1", [ctx.organizationId])).rows[0].n, 0)
  assert.ok((await ctx.db.query("SELECT count(*)::int n FROM kipster.artifacts WHERE owner_kind='agent' AND owner_id=$1", [ctx.scout])).rows[0].n > 0)
  ctx.finish(other)
  await ctx.settled(other.runId, 'completed')
})

test('organization cleanup survives SIGKILL at destructive boundaries without recreating bootstrap organization', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t)
  await populate(ctx)
  for (let i = 0; i < 6; i++) { const run = await ctx.running(); ctx.finish(run); await ctx.settled(run.runId, 'completed') }
  await ctx.dispatcher.close()
  const operationId = randomUUID()
  await ctx.ok('DELETE', `/v1/organizations/${ctx.organizationId}`, { version: 1, operationId })
  const crash = kill => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./fixtures/deletion-crash.mjs', import.meta.url).pathname, ctx.url.href, ctx.home, operationId, kill], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  for (const step of ['forget-provider-state', 'delete-chats', 'delete-memory', 'delete-files', 'remove-home']) {
    assert.deepEqual(await crash(`after:${step}:1`), { code: null, signal: 'SIGKILL' }, step)
  }
  assert.deepEqual(await crash('never'), { code: 0, signal: null })
  assert.deepEqual(await crash('never'), { code: 0, signal: null })
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.organizations WHERE id=$1', [ctx.organizationId])).rows[0].lifecycle, 'deleted')
  assert.equal(await exists(join(ctx.home, 'organizations', ctx.organizationId)), false)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.organizations')).rows[0].n, 1)
})

test('a selected file-copy destination that begins deletion cannot receive a late organization copy', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const data = await populate(ctx)
  await ctx.dispatcher.close()
  // A copy batch selected the organization while live, then lost the race to deletion.
  await ctx.ok('DELETE', `/v1/organizations/${ctx.organizationId}`, { version: 1, operationId: randomUUID() })
  const copyId = randomUUID()
  const copied = await ctx.db.transaction(client => ctx.runtime.artifacts.copyIntoOrganization(client, data.shown.id, ctx.organizationId, copyId))
  assert.equal(copied, false)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.artifacts WHERE id=$1', [copyId])).rows[0].n, 0)
})
