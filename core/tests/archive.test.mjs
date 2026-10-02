import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { MAINTENANCE_SWEEP_JOB_ID, SleepService } from '../dist/modules/memory/public.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { agentResult, directorySnapshot } from '../dist/protocol/admin.js'
import { stableError } from '../dist/protocol/text.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Archiving and restoring agents over HTTP against real PostgreSQL, with the deterministic fixture
// adapter. An archived agent takes no new work, its work is stopped, its chats stay readable, and a
// restore brings it back with everything it had.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
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
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n)

async function setup(t, { learning = false } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_archive_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-archive-'))
  const time = { now: new Date(2026, 0, 10, 12) }
  const vectors = new Map()
  const runtime = await openRuntime({ connectionString: url.href, home, names, executionLimit: 6, ...(learning ? { clock: () => time.now } : {}),
    embedding: { ...profile, async embed(text) { return vectors.get(text) ?? [0, 0, 1] } } })
  await runtime.memory.stopIndexing()
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const executions = [], cancels = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(context) {
    const handle = await inner.execute(context)
    const cancel = handle.cancel.bind(handle)
    handle.cancel = async () => { cancels.push(context.attemptId); return cancel() }
    executions.push({ context, handle })
    return handle
  } })
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
      return { status: response.status, data: await response.json() }
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
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  if (learning) await runtime.learning.setInstallation(actor, { enabled: true })
  const scout = (await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Scout', organizationId })).agent.id
  const context = { kind: 'organization', organizationId }
  const ctx = { runtime, db: runtime.db, dispatcher, actor, installationId, ownerId, organizationId, root: rootAgentId, scout, context, executions, cancels, time, vectors, call, ok, serve }
  ctx.chat = async (agentId = scout, chatContext = context) => (await ok('POST', '/v1/direct-chats', { version: 1, context: chatContext, agentId })).chatId
  ctx.submit = (chatId, text, extra = {}, chatContext = context) => call('POST', '/v1/text/submissions', {
    version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: chatContext, chatId }, mode: 'root', parts: [{ kind: 'text', text }], ...extra })
  ctx.execution = (runId, from = 0) => until(() => executions.slice(from).find(item => item.context.runId === runId), Boolean, `execution of ${runId}`)
  /** A running execution of the agent with its fixture handle and a tool caller bound to its attempt. */
  ctx.running = async (agentId = scout, text = 'Work on this', chatContext = context) => {
    const chatId = await ctx.chat(agentId, chatContext)
    const saved = await ctx.submit(chatId, text, {}, chatContext)
    assert.equal(saved.status, 202, JSON.stringify(saved.data))
    const found = await ctx.execution(saved.data.runId)
    const attemptId = found.context.attemptId
    return { ...saved.data, chatId, chat: chatContext, found, attemptId, release: event => found.handle.release({ attemptId, ...event }), call: (name, args, callId = randomUUID()) => found.handle.callTool(callId, name, args) }
  }
  /** Ends an execution with a final answer. */
  ctx.finish = ({ found }, text = 'Done') => {
    const attemptId = found.context.attemptId
    found.handle.release({ kind: 'text', attemptId, messageId: `answer-${randomUUID()}`, text, final: true })
    found.handle.release({ kind: 'ended', attemptId, confirmed: true })
  }
  ctx.state = async runId => ({ ...await row(ctx.db, 'SELECT state, stop_requested FROM kipster.text_runs WHERE id=$1', [runId]) })
  ctx.settled = (runId, state) => until(async () => (await ctx.state(runId)).state, value => value === state, `run ${runId} ${state}`)
  ctx.lifecycle = (action, agentId = scout, operationId = randomUUID(), as = call) => as('POST', `/v1/agents/${agentId}/${action}`, { version: 1, operationId })
  ctx.control = (run, action) => ok('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: run.chat, chatId: run.chatId, threadId: run.threadId, runId: run.runId, attemptId: run.attemptId, action })
  ctx.cursor = async () => (await ok('GET', '/v1/app/snapshot')).cursor
  ctx.agentEvents = async (cursor, agentId = scout) => (await readEvents(ctx.db, { kind: 'application', installationId, callerId: ownerId }, cursor)).events.filter(event => event.type === 'agent-changed' && event.resourceId === agentId)
  return ctx
}

test('archiving stops the agent\'s work, fails a waiting parent\'s delegation and refuses new work while its chats stay readable', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  // A parent waiting on work it delegated to Scout.
  const parent = await ctx.running(ctx.root, 'Ask Scout')
  const delegated = await parent.call('agents_delegate', { recipientId: ctx.scout, request: 'Check the numbers' })
  parent.release({ kind: 'ended', confirmed: true })
  const child = await ctx.execution(delegated.childRunId)
  await ctx.settled(parent.runId, 'waiting')
  // Scout's own work: running, queued behind it, and waiting on a question.
  const running = await ctx.running()
  const queued = await ctx.submit(running.chatId, 'After that', { mode: 'reply', threadId: running.threadId })
  const asking = await ctx.running(ctx.scout, 'Ask me something')
  const question = await asking.call('interactions_ask', { prompt: 'Which region?', options: [{ id: 'eu', label: 'Europe' }] })
  asking.release({ kind: 'ended', confirmed: true })
  await ctx.settled(asking.runId, 'waiting')
  const cursor = await ctx.cursor()
  const after = ctx.executions.length

  const archived = await ctx.lifecycle('archive')
  assert.equal(archived.status, 200, JSON.stringify(archived.data))
  const result = agentResult.parse(archived.data)
  assert.deepEqual([result.alreadyApplied, result.agent.id, result.agent.lifecycle], [false, ctx.scout, 'archived'])

  // Running work is stopped and its adapter asked to cancel; queued and waiting work is cancelled.
  assert.deepEqual(new Set(ctx.cancels), new Set([running.attemptId, child.context.attemptId]))
  assert.deepEqual(await ctx.state(queued.data.runId), { state: 'cancelled', stop_requested: true })
  assert.deepEqual(await ctx.state(asking.runId), { state: 'cancelled', stop_requested: true })
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.interactions WHERE id=$1', [question.interactionId])).state, 'cancelled')
  // Output the provider sends afterwards never lands.
  running.release({ kind: 'text', messageId: 'late', text: 'Late output', final: true })
  running.release({ kind: 'ended', confirmed: true })
  child.handle.release({ kind: 'text', attemptId: child.context.attemptId, messageId: 'late-child', text: 'Late child output', final: true })
  child.handle.release({ kind: 'ended', attemptId: child.context.attemptId, confirmed: true })
  await ctx.settled(running.runId, 'cancelled')
  await ctx.settled(delegated.childRunId, 'cancelled')
  for (const text of ['Late output', 'Late child output']) assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.messages WHERE parts @> $1::jsonb', [JSON.stringify([{ kind: 'text', text }])]), 0, text)

  // The waiting parent continues with the child's failure and cannot reach Scout.
  assert.deepEqual({ ...await row(ctx.db, 'SELECT state, failure FROM kipster.delegations WHERE id=$1', [delegated.id]) }, { state: 'failed', failure: 'Agent was archived' })
  const resumed = await ctx.execution(parent.runId, after)
  assert.deepEqual(resumed.context.delegationResults.map(item => [item.recipientAgentId, item.state, item.failure]), [[ctx.scout, 'failed', 'Agent was archived']])
  const tool = (name, args) => resumed.handle.callTool(randomUUID(), name, args)
  assert.equal((await tool('agents_list', {})).agents.some(agent => agent.id === ctx.scout), false)
  await assert.rejects(tool('agents_delegate', { recipientId: ctx.scout, request: 'Try again' }), /Agent is archived/)
  ctx.finish({ found: resumed }, 'Scout is unavailable')
  await ctx.settled(parent.runId, 'completed')

  // Submissions and new chats are refused with the stable code; an existing chat still opens.
  const helper = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Helper', organizationId: ctx.organizationId })).agent.id
  await ctx.ok('POST', `/v1/agents/${helper}/archive`, { version: 1, operationId: randomUUID() })
  for (const refused of [await ctx.submit(running.chatId, 'Anything new?'), await ctx.call('POST', '/v1/direct-chats', { version: 1, context: ctx.context, agentId: helper })]) {
    assert.equal(refused.status, 409)
    assert.equal(stableError.parse({ ...refused.data }).code, 'agent-archived')
  }
  assert.equal(await ctx.chat(), running.chatId)
  // The chat stays readable, with its stopped work visible.
  const snapshot = await ctx.ok('GET', `/v1/threads/${running.threadId}/snapshot`)
  assert.deepEqual(snapshot.work.map(item => item.state).sort(), ['cancelled', 'cancelled'])
  assert.ok((await ctx.ok('GET', '/v1/app/snapshot')).threads.some(thread => thread.threadId === running.threadId && thread.agentId === ctx.scout))
  // The directory lists Scout as archived, still a member; one event says so.
  const directory = directorySnapshot.parse(await ctx.ok('GET', '/v1/directory'))
  assert.equal(directory.agents.find(agent => agent.id === ctx.scout).lifecycle, 'archived')
  assert.ok(directory.memberships.some(item => item.agentId === ctx.scout && item.organizationId === ctx.organizationId))
  const events = await ctx.agentEvents(cursor)
  assert.deepEqual(events.map(event => [event.data.lifecycle, event.revision]), [['archived', result.agent.revision]])
  assert.equal(ctx.executions.slice(after).filter(item => item.context.agentId === ctx.scout).length, 0, 'the archived agent never ran again')
})

/** What an archive must leave untouched: memberships and appearances, settings, memory, files and the home. */
async function belongings(ctx, file) {
  const directory = await ctx.ok('GET', '/v1/directory')
  const settings = (await ctx.ok('GET', '/v1/settings')).agents.find(item => item.id === ctx.scout)
  const memory = (await ctx.db.query('SELECT id, kind, text, revision, updated_at FROM kipster.memory_records WHERE owner_id=$1 ORDER BY id', [ctx.scout])).rows
  const tree = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tree(path) : [[path, createHash('sha256').update(await readFile(path)).digest('hex')]]
  }))).flat().sort()
  return {
    memberships: directory.memberships.filter(item => item.agentId === ctx.scout),
    groups: directory.groups,
    settings,
    memory,
    file: (await ctx.runtime.artifacts.content(ctx.actor, file.id, file.target)).bytes.toString(),
    home: await tree(ctx.runtime.home.agent(ctx.scout)),
  }
}

test('restoring brings the agent back unchanged: stopped work stays stopped, Retry works and new work runs', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  await ctx.ok('PUT', `/v1/agents/${ctx.scout}/settings`, { version: 1, operationId: randomUUID(), settings: { modelId: { set: 'fixture-model' } } })
  const group = (await ctx.ok('POST', `/v1/organizations/${ctx.organizationId}/groups`, { version: 1, operationId: randomUUID(), name: 'Research' })).group
  const membership = (await ctx.ok('GET', '/v1/directory')).memberships.find(item => item.agentId === ctx.scout)
  await ctx.ok('POST', `/v1/groups/${group.id}/appearances`, { version: 1, operationId: randomUUID(), membershipId: membership.id })
  await ctx.runtime.memory.save(ctx.scout, 'fact', 'The desk opens at nine', [{ authorId: ctx.scout }])
  // Scout writes and publishes a file, then its next run fails.
  const writer = await ctx.running(ctx.scout, 'Write the notes')
  const output = await writer.call('artifacts_write', { name: 'notes.txt', content: 'Quarterly notes' })
  const published = await writer.call('artifacts_publish', { outputId: output.outputId })
  await writer.call('conversation_publish', { text: 'Here are the notes', artifactIds: [published.artifact.id] })
  ctx.finish(writer)
  await ctx.settled(writer.runId, 'completed')
  const file = { id: published.artifact.id, target: { installationId: ctx.installationId, callerId: ctx.ownerId, context: ctx.context, chatId: writer.chatId, threadId: writer.threadId } }
  const failed = await ctx.running(ctx.scout, 'This one fails')
  failed.release({ kind: 'failed', confirmedEnded: true, message: 'provider failed' })
  await ctx.settled(failed.runId, 'failed')
  const stopped = await ctx.running(ctx.scout, 'Stopped by the archive')
  const before = await belongings(ctx, file)
  const cursor = await ctx.cursor()

  const archived = (await ctx.lifecycle('archive')).data
  stopped.release({ kind: 'ended', confirmed: true })
  await ctx.settled(stopped.runId, 'cancelled')
  const refused = await ctx.control(failed, 'retry')
  assert.equal(refused.outcome, 'rejected', 'Retry needs a live agent')

  const restored = await ctx.lifecycle('restore')
  assert.equal(restored.status, 200, JSON.stringify(restored.data))
  const result = agentResult.parse(restored.data)
  assert.deepEqual([result.alreadyApplied, result.agent.lifecycle, result.agent.revision], [false, 'active', archived.agent.revision + 1])
  assert.deepEqual(await belongings(ctx, file), before)
  assert.deepEqual((await ctx.agentEvents(cursor)).map(event => event.data.lifecycle), ['archived', 'active'])
  assert.equal(directorySnapshot.parse(await ctx.ok('GET', '/v1/directory')).agents.find(agent => agent.id === ctx.scout).lifecycle, 'active')

  // Work stopped by the archive stays stopped; the failed run can be retried, and new work runs.
  const from = ctx.executions.length
  const retried = await ctx.control(failed, 'retry')
  assert.equal(retried.outcome, 'accepted', JSON.stringify(retried))
  ctx.finish({ found: await ctx.execution(failed.runId, from) }, 'Retried')
  const fresh = await ctx.running(ctx.scout, 'Back to work')
  ctx.finish(fresh, 'Working again')
  await ctx.settled(fresh.runId, 'completed')
  await ctx.settled(failed.runId, 'completed')
  assert.equal((await ctx.state(stopped.runId)).state, 'cancelled')
  assert.equal(ctx.executions.slice(from).some(item => item.context.runId === stopped.runId), false)
})

test('the admin agent cannot be archived; operation IDs are receipts; only the owner archives and restores; the admin agent may restore', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const operations = () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.admin_operations WHERE kind IN ('agent.archive','agent.restore')`)
  const refusedAdmin = await ctx.lifecycle('archive', ctx.root)
  assert.deepEqual([refusedAdmin.status, refusedAdmin.data.code], [403, 'forbidden'])
  assert.equal((await row(ctx.db, 'SELECT lifecycle FROM kipster.agents WHERE id=$1', [ctx.root])).lifecycle, 'active')
  assert.deepEqual([(await ctx.lifecycle('archive', randomUUID())).status, (await ctx.lifecycle('restore', randomUUID())).status], [404, 404])
  assert.equal(await operations(), 0)

  // Another person, or the owner of another installation, is refused and records nothing.
  const person = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [person, ctx.installationId, 'Member'])
  await ctx.db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [ctx.organizationId, person])
  for (const as of [{ installationId: ctx.installationId, personId: person }, { installationId: randomUUID(), personId: ctx.ownerId }]) {
    const stranger = await ctx.serve(as)
    for (const action of ['archive', 'restore']) assert.deepEqual((await ctx.lifecycle(action, ctx.scout, randomUUID(), stranger)).status, 403, action)
  }
  assert.equal(await operations(), 0)
  assert.equal((await row(ctx.db, 'SELECT lifecycle FROM kipster.agents WHERE id=$1', [ctx.scout])).lifecycle, 'active')

  // A repeated operation ID returns the recorded result and changes nothing more.
  const cursor = await ctx.cursor()
  const first = await ctx.lifecycle('archive', ctx.scout, 'archive-1')
  const again = await ctx.lifecycle('archive', ctx.scout, 'archive-1')
  assert.equal(again.status, 200)
  assert.deepEqual({ ...again.data, alreadyApplied: false }, first.data)
  assert.equal(again.data.alreadyApplied, true)
  assert.deepEqual((await ctx.lifecycle('restore', ctx.scout, 'archive-1')).data.code, 'conflict')
  // Archiving again under a new ID is harmless.
  assert.equal((await ctx.lifecycle('archive')).data.agent.revision, first.data.agent.revision)
  assert.equal((await ctx.agentEvents(cursor)).length, 1)

  // The admin agent restores from its installation chat with an explicit stable operation ID.
  const adminRun = await ctx.running(ctx.root, 'Restore Scout', { kind: 'installation', installationId: ctx.installationId })
  assert.equal(adminRun.found.context.tools.some(tool => tool.name === 'admin_call'), true)
  const restored = await adminRun.call('admin_call', { operation: 'agents.restore', operationId: 'restore-operation', arguments: { agentId: ctx.scout } }, 'restore-1')
  assert.deepEqual([restored.operationId, restored.alreadyApplied, restored.agent.lifecycle], ['restore-operation', false, 'active'])
  const replay = await adminRun.call('admin_call', { operation: 'agents.restore', operationId: 'restore-operation', arguments: { agentId: ctx.scout } }, 'restore-1')
  assert.deepEqual([replay.alreadyApplied, replay.agent.revision], [true, restored.agent.revision])
  assert.deepEqual({ ...await row(ctx.db, `SELECT actor_kind, actor_id, kind, target_id, state FROM kipster.admin_operations WHERE operation_id=$1`, [restored.operationId]) },
    { actor_kind: 'agent', actor_id: ctx.root, kind: 'agent.restore', target_id: ctx.scout, state: 'succeeded' })
  const approval = await adminRun.call('admin_call', { operation: 'agents.archive', arguments: { agentId: ctx.scout } })
  assert.equal(approval.status, 'pending')
  assert.ok(approval.interactionId)
  // Restoring an active agent changes nothing.
  const noop = await ctx.lifecycle('restore')
  assert.deepEqual([noop.status, noop.data.agent.revision], [200, restored.agent.revision])
  assert.deepEqual((await ctx.agentEvents(cursor)).map(event => event.data.lifecycle), ['archived', 'active'])
  ctx.finish(adminRun)
})

test('learning and sleep skip an archived agent and resume after a restore', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t, { learning: true })
  await ctx.runtime.learning.setAgent(ctx.actor, ctx.root, { enabled: false })
  const sleep = new SleepService(ctx.db, ctx.installationId, ctx.runtime.home.identity)
  const sleeps = () => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_sleeps WHERE agent_id=$1', [ctx.scout])
  const learns = async () => (await ctx.ok('GET', '/v1/settings/learning')).agents.find(item => item.agentId === ctx.scout).effective
  const handled = new Set()
  /** A finished conversation of Scout whose extraction is handed to the adapter; `answer` scripts what it learned. */
  const extraction = async text => {
    const run = await ctx.running(ctx.scout, `Please note: ${text}`)
    ctx.finish(run, 'Noted.')
    await ctx.settled(run.runId, 'completed')
    await ctx.db.transaction(async client => { await ctx.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
    const found = await until(() => ctx.executions.find(e => e.context.kind === 'maintenance' && e.context.maintenance.sourceRunId === run.runId && !handled.has(e)), Boolean, 'extraction')
    handled.add(found)
    const entry = (await row(ctx.db, 'SELECT manifest FROM kipster.maintenance_sources WHERE run_id=$1', [run.runId])).manifest.entries[0]
    const answer = JSON.stringify({ candidates: [{ kind: 'fact', text, subject: 'office', author_id: entry.author_id, author_class: entry.author_class, citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: 'Please note' }] }] })
    return {
      source: run.runId,
      async answer() {
        const attemptId = found.context.attemptId
        found.handle.release({ kind: 'text', attemptId, messageId: 'output', text: answer, final: true })
        found.handle.release({ kind: 'ended', attemptId, confirmed: true })
        await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]))?.state, state => ['completed', 'failed'].includes(state), 'extraction settled')
      },
    }
  }
  const learned = text => row(ctx.db, 'SELECT id FROM kipster.memory_records WHERE owner_id=$1 AND text=$2', [ctx.scout, text])
  assert.equal(await learns(), true)

  // An extraction in flight when the agent is archived learns nothing.
  const inFlight = await extraction('The office opens at nine')
  await ctx.lifecycle('archive')
  // Restoring before the old provider answers must not revive pre-archive learning.
  await ctx.lifecycle('restore')
  await inFlight.answer()
  assert.equal(await learned('The office opens at nine'), undefined)
  assert.equal((await row(ctx.db, 'SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [inFlight.source])).status, 'fenced')
  await ctx.lifecycle('archive')
  assert.equal(await learns(), false)
  // No sleep begins while it is archived.
  ctx.time.now = new Date(2026, 0, 11, 12)
  await sleep.run(ctx.time.now)
  assert.equal(await sleeps(), 0)

  await ctx.lifecycle('restore')
  assert.equal(await learns(), true)
  const next = await extraction('Parking is behind the office')
  await next.answer()
  assert.ok(await learned('Parking is behind the office'), 'learning resumes')
  assert.equal((await sleep.run(ctx.time.now)).started, 1)
  assert.equal(await sleeps(), 1, 'sleep resumes')
})
