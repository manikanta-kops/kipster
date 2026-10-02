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
import { MAINTENANCE_SWEEP_JOB_ID } from '../dist/modules/memory/public.js'
import { agentResult, directorySnapshot, operationStatus } from '../dist/protocol/admin.js'
import { stableError, textEvent, threadSnapshot } from '../dist/protocol/text.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase, taskDataRole } from './support/database.mjs'

// Permanent deletion of an archived agent over HTTP against real PostgreSQL, with the deterministic
// fixture adapter. The agent's chats, memory, vectors, task data, files and home go; organization
// publications, delegation records in other agents' threads and a tombstone with its name stay.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
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

async function setup(t, { forget = false, learning = false } = {}) {
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
  await runtime.memory.stopIndexing()
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
  if (learning) await runtime.learning.setInstallation(actor, { enabled: true })
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
 * publication, a memory, a vector collection, task data and an identity backup; and work Root
 * delegated to it, in which Scout showed a file and passed it on to Helper.
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
  const memory = await own.call('memory_save', { kind: 'fact', text: 'Scout prefers short reports' })
  const target = { kind: 'agent', ownerId: ctx.scout }
  const collection = await own.call('vectors_space', { target, operation: 'create', name: 'notes' })
  await own.call('vectors_space', { target, operation: 'upsert', collectionId: collection.collectionId, key: 'one', expectedRevision: 0, text: 'A note' })
  await own.call('data_space', { target, operation: 'create_table', table: 'notes', columns: [{ name: 'note', type: 'text' }] })
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
  return { own, parent, delegated, further, shown, unshown, childFile, publication, memory, collection, threads, runs, attempts, messages }
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

  // Memory, vectors, task data, home, identity backups.
  assert.equal(await exists(join(home, 'agents', scout)), false)
  assert.deepEqual(await readdir(join(home, '.trash')), [])
  const schema = `task_a_${scout.replaceAll('-', '')}`
  assert.equal((await ctx.db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0)

  // Nothing else points at the agent or at what was removed with it.
  const removed = [...data.threads, ...data.runs, ...data.attempts, ...data.messages, data.own.chatId, data.shown.id, data.unshown.id, data.childFile.id, data.memory.record.id, data.collection.collectionId]
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

test('deletion waits for a memory task in flight and removes the agent\'s learning state', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t, { forget: true, learning: true })
  const chatId = await ctx.chat()
  /** A conversation with Scout whose extraction is handed to the adapter, with the answer that learns `text`. */
  const extraction = async (text, threadId) => {
    const saved = await ctx.submit(chatId, `Please note: ${text}`)
    ctx.finish(ctx.bind(saved.data, await ctx.execution(saved.data.runId)), 'Noted.')
    await ctx.settled(saved.data.runId, 'completed')
    await ctx.db.transaction(client => ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID))
    const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && e.context.maintenance.sourceRunId === saved.data.runId), Boolean, 'extraction')
    const entry = (await ctx.db.query('SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [saved.data.runId])).rows[0].manifest.entries[0]
    const answer = JSON.stringify({ candidates: [{ kind: 'fact', text, subject: 'office', author_id: entry.author_id, author_class: entry.author_class,
      citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] })
    const run = ctx.bind({}, found)
    ctx.provider(run, threadId)
    return { run, answer, runId: found.context.runId }
  }
  const taskEnded = runId => until(async () => (await ctx.db.query('SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId])).rows[0]?.state, state => ['completed', 'failed'].includes(state), 'memory task ended')
  const learned = await extraction('The office opens at nine', 'codex-extraction-1')
  learned.run.release({ kind: 'text', messageId: 'output', text: learned.answer, final: true })
  learned.run.release({ kind: 'ended', confirmed: true })
  await taskEnded(learned.runId)
  const scoutRows = async () => (await ctx.db.query(`SELECT
      (SELECT count(*)::int FROM kipster.memory_records WHERE owner_id=$1) AS memories,
      (SELECT count(*)::int FROM kipster.maintenance_sources WHERE agent_id=$1) AS sources,
      (SELECT count(*)::int FROM kipster.maintenance_runs WHERE agent_id=$1) AS tasks,
      (SELECT count(*)::int FROM kipster.maintenance_candidate_claims WHERE owner_id=$1) AS claims,
      (SELECT count(*)::int FROM kipster.memory_activity WHERE agent_id=$1) AS activity`, [ctx.scout])).rows[0]
  assert.deepEqual(await scoutRows(), { memories: 1, sources: 1, tasks: 1, claims: 1, activity: 1 })

  // A second extraction is in flight when Scout is archived and deleted.
  const pending = await extraction('The lobby is quiet', 'codex-extraction-2')
  await ctx.ok('POST', `/v1/agents/${ctx.scout}/archive`, { version: 1, operationId: randomUUID() })
  const operationId = randomUUID()
  assert.equal((await ctx.remove(ctx.scout, {}, operationId)).status, 200)
  const waiting = await until(() => ctx.ok('GET', `/v1/operations/${operationId}`), value => value.state === 'waiting', 'waiting operation')
  assert.match(waiting.waitingFor, /0 runs and 1 memory tasks/)
  pending.run.release({ kind: 'text', messageId: 'output', text: pending.answer, final: true })
  pending.run.release({ kind: 'ended', confirmed: true })
  const done = await ctx.operation(operationId)
  assert.equal(done.state, 'succeeded', JSON.stringify(done))
  assert.deepEqual(done.result.providerState, { forgotten: 2, residue: [] })
  assert.deepEqual(ctx.forgotten.flat().sort(), ['codex-extraction-1', 'codex-extraction-2'])
  assert.deepEqual(await scoutRows(), { memories: 0, sources: 0, tasks: 0, claims: 0, activity: 0 })
  assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM kipster.memory_records WHERE text='The lobby is quiet'`)).rows[0].n, 0)
  assert.deepEqual(await references(ctx.db, [ctx.scout]), ['admin_operations.target_id', 'agents.id', 'app_events.resource_id'])
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
  const sharedCollection = await running.call('vectors_space', { target: shared, operation: 'create', name: 'shared_notes' })
  await running.call('data_space', { target: shared, operation: 'create_table', table: 'shared_notes', columns: [{ name: 'note', type: 'text' }] })
  const publishedMemory = await ctx.runtime.memory.publish(ctx.scout, ctx.organizationId, data.memory.record.id, 1)
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
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.memory_records WHERE id=$1', [publishedMemory.id])).rows[0].n, 0)
  assert.equal(await exists(join(ctx.home, 'organizations', ctx.organizationId)), false)
  assert.equal(await exists(join(ctx.home, 'agents', ctx.scout)), true)
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM kipster.memory_records WHERE id=$1',[data.memory.record.id])).rows[0].n,1)
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

test('organization deletion waits for extraction and removes homed learning without deleting the agent', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t, { forget: true, learning: true })
  const chatId = await ctx.chat()
  /** A conversation with Scout whose extraction is handed to the adapter, with the answer that learns `text`. */
  const extraction = async (text, threadId) => {
    const saved = await ctx.submit(chatId, `Please note: ${text}`)
    ctx.finish(ctx.bind(saved.data, await ctx.execution(saved.data.runId)), 'Noted.')
    await ctx.settled(saved.data.runId, 'completed')
    await ctx.db.transaction(client => ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID))
    const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && e.context.maintenance.sourceRunId === saved.data.runId), Boolean, 'extraction')
    const entry = (await ctx.db.query('SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [saved.data.runId])).rows[0].manifest.entries[0]
    const answer = JSON.stringify({ candidates: [{ kind: 'fact', text, subject: 'office', author_id: entry.author_id, author_class: entry.author_class,
      citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] })
    const run = ctx.bind({}, found)
    ctx.provider(run, threadId)
    return { run, answer, runId: found.context.runId }
  }
  const taskEnded = runId => until(async () => (await ctx.db.query('SELECT state FROM kipster.maintenance_runs WHERE id=$1', [runId])).rows[0]?.state, state => ['completed', 'failed'].includes(state), 'memory task ended')
  const learned = await extraction('The office opens at nine', 'codex-extraction-1')
  learned.run.release({ kind: 'text', messageId: 'output', text: learned.answer, final: true })
  learned.run.release({ kind: 'ended', confirmed: true })
  await taskEnded(learned.runId)
  const scoutRows = async () => (await ctx.db.query(`SELECT
      (SELECT count(*)::int FROM kipster.memory_records WHERE owner_id=$1) AS memories,
      (SELECT count(*)::int FROM kipster.maintenance_sources WHERE agent_id=$1) AS sources,
      (SELECT count(*)::int FROM kipster.maintenance_runs WHERE agent_id=$1) AS tasks,
      (SELECT count(*)::int FROM kipster.maintenance_candidate_claims WHERE owner_id=$1) AS claims,
      (SELECT count(*)::int FROM kipster.memory_activity WHERE agent_id=$1) AS activity`, [ctx.scout])).rows[0]
  assert.deepEqual(await scoutRows(), { memories: 1, sources: 1, tasks: 1, claims: 1, activity: 1 })

  // A second extraction is in flight when Scout is archived and deleted.
  const pending = await extraction('The lobby is quiet', 'codex-extraction-2')
  const operationId = randomUUID()
  assert.equal((await ctx.call('DELETE', `/v1/organizations/${ctx.organizationId}`, {version:1,operationId})).status, 200)
  const waiting = await until(() => ctx.ok('GET', `/v1/operations/${operationId}`), value => value.state === 'waiting', 'waiting operation')
  assert.match(waiting.waitingFor, /0 runs and 1 memory tasks/)
  pending.run.release({ kind: 'text', messageId: 'output', text: pending.answer, final: true })
  pending.run.release({ kind: 'ended', confirmed: true })
  const done = await ctx.operation(operationId)
  assert.equal(done.state, 'succeeded', JSON.stringify(done))
  assert.deepEqual(done.result.providerState, { forgotten: 2, residue: [] })
  assert.deepEqual(ctx.forgotten.flat().sort(), ['codex-extraction-1', 'codex-extraction-2'])
  assert.deepEqual(await scoutRows(), { memories: 0, sources: 0, tasks: 0, claims: 0, activity: 1 })
  assert.equal((await ctx.db.query(`SELECT count(*)::int AS n FROM kipster.memory_records WHERE text='The lobby is quiet'`)).rows[0].n, 0)
  assert.equal((await ctx.db.query('SELECT lifecycle FROM kipster.agents WHERE id=$1',[ctx.scout])).rows[0].lifecycle, 'active')
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
