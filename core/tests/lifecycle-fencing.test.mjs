import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { changeLifecycle, claimOperation } from '../dist/modules/administration/public.js'
import { fenceAffectedWork } from '../dist/modules/work/public.js'
import { acceptText, resolveDirectChat } from '../dist/modules/conversations/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase, taskDataRole } from './support/database.mjs'

// Lifecycle fencing against real PostgreSQL with the deterministic fixture adapter. A lifecycle change
// locks the owner row after the capacity lock; every writer locks its owner too, so a write commits
// before the change and is then stopped, or it waits for the change and is refused.

const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const stream = bytes => (async function* () { yield bytes })()
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 300; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
}
const row = async (db, sql, params = []) => (await db.query(sql, params)).rows[0]
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n)
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))

async function setup(t, { transcribe } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_fence_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const restricted = new URL(url)
  restricted.username = taskDataRole
  const home = await mkdtemp(join(tmpdir(), 'kipster-fence-'))
  const embedding = { gate: null, embed: async () => { if (embedding.gate) await embedding.gate.promise; return [1, 0] } }
  const voice = { calls: 0, id: 'fixture-transcription', contractMajor: 1, async readiness() { return { ready: true } }, async transcribe() { voice.calls++; return { status: 'succeeded', text: 'spoken', provider: 'fixture-transcription' } }, async close() {} }
  const runtime = await openRuntime({ connectionString: url.href, taskDataConnectionString: restricted.href, home, executionLimit: 6, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' },
    embedding: { ...profile, embed: (...args) => embedding.embed(...args) }, ...(transcribe ? { transcription: voice } : {}) })
  await runtime.memory.stopIndexing()
  await runtime.vectors.stopIndexing()
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const scout = randomUUID()
  await runtime.home.provisionAgent(scout)
  await runtime.db.query('INSERT INTO kipster.agents(id, installation_id, display_name, provisioned) VALUES ($1,$2,$3,true)', [scout, installationId, 'Scout'])
  await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [organizationId, scout])
  await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1', [organizationId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const executions = [], cancels = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  const adapter = { ...inner, async execute(context) {
    const handle = await inner.execute(context)
    const cancel = handle.cancel.bind(handle)
    handle.cancel = async () => { cancels.push(context.attemptId); return cancel() }
    executions.push({ context, handle })
    return handle
  } }
  dispatcher = new TextDispatcher(runtime, adapter)
  const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
  await dispatcher.start()
  const locks = new Postgres(url.href)
  const context = { kind: 'organization', organizationId }
  const ctx = { runtime, db: runtime.db, dispatcher, server, actor, context, scout, root: rootAgentId, organizationId, installationId, executions, cancels, embedding, voice, host: textPublicationHost(dispatcher) }
  t.after(async () => {
    await dispatcher.close().catch(() => undefined)
    await server.close().catch(() => undefined)
    await locks.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  ctx.chat = async (agentId = scout) => (await resolveDirectChat(ctx.db, actor, context, agentId)).chatId
  ctx.submit = async (chatId, text, extra = {}) => acceptText(ctx.db, runtime.jobs, runtime.artifacts, actor, {
    version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }], ...extra })
  ctx.execution = (runId, from = 0) => until(() => executions.slice(from).find(item => item.context.runId === runId), Boolean, `execution of ${runId}`)
  /** A running execution of the agent in its organization chat, with a tool caller bound to its attempt. */
  ctx.running = async (agentId = scout, text = 'Work on this') => {
    const chatId = await ctx.chat(agentId)
    const saved = await ctx.submit(chatId, text)
    const found = await ctx.execution(saved.runId)
    const attemptId = found.context.attemptId
    return { ...saved, chatId, found, attemptId, call: (name, args, callId = randomUUID()) => ctx.host.invokeTool({ attemptId, callId, name, arguments: args }) }
  }
  ctx.state = async runId => row(ctx.db, 'SELECT state, stop_requested, cancel_delivery FROM kipster.text_runs WHERE id=$1', [runId])
  ctx.flip = (id = scout, lifecycle = 'archived', kind = 'agent') => ctx.db.transaction(client => changeLifecycle(client, runtime.jobs, installationId, kind, id, lifecycle, 'Agent was archived'))
  /** A lifecycle change that has fenced its work and stays uncommitted until `commit()`. */
  ctx.heldFlip = async (id = scout, lifecycle = 'archived', kind = 'agent') => {
    const flipped = deferred(), release = deferred()
    const done = ctx.db.transaction(async client => {
      const result = await changeLifecycle(client, runtime.jobs, installationId, kind, id, lifecycle, 'Agent was archived')
      flipped.resolve(result)
      await release.promise
      return result
    })
    await flipped.promise
    return { commit: () => { release.resolve(); return done } }
  }
  /** Holds a row lock (or an uncommitted row) in its own transaction until `release()`, which rolls back. */
  ctx.hold = async (sql, params) => {
    const held = deferred(), release = deferred()
    const done = locks.transaction(async client => { await client.query(sql, params); held.resolve(); await release.promise; throw new Error('released') }).catch(() => undefined)
    await held.promise
    return { release: () => { release.resolve(); return done } }
  }
  ctx.waiting = n => until(() => count(locks, `SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`), value => value >= n, `${n} lock waiters`)
  return ctx
}

const threadLock = run => ['SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [run.threadId]]
const runLock = run => ['SELECT 1 FROM kipster.text_runs WHERE id=$1 FOR UPDATE', [run.runId]]

/** Each writer: the lock that pauses it after it holds its owner, the write, and how many writes landed. */
const writers = {
  memory: {
    barrier: threadLock,
    write: (ctx, run, key) => run.call('memory.save', { kind: 'fact', text: `Remember ${key}` }),
    landed: (ctx, key) => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_records WHERE text=$1', [`Remember ${key}`]),
  },
  relationships: {
    barrier: threadLock,
    async prepare(ctx) {
      const first = await ctx.runtime.memory.save(ctx.scout, 'fact', 'The desk opens at nine', [{ authorId: ctx.scout }])
      const second = await ctx.runtime.memory.save(ctx.scout, 'observation', 'Visitors arrive early', [{ authorId: ctx.scout }])
      return { first: first.id, second: second.id }
    },
    write: (ctx, run, key, prepared) => run.call('memory.link', { owner: { kind: 'agent', ownerId: ctx.scout }, fromId: prepared.first, toId: prepared.second, fromRevision: 1, toRevision: 1, kind: 'supports', weight: 0.5, evidence: [{ memoryId: prepared.first, revision: 1 }] }),
    landed: ctx => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.memory_relationships'),
  },
  vectors: {
    barrier: threadLock,
    write: (ctx, run, key) => run.call('vectors.space', { operation: 'create', target: { kind: 'agent', ownerId: ctx.scout }, name: `notes_${key}` }),
    landed: (ctx, key) => count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.vector_collections WHERE name=$1', [`notes_${key}`]),
  },
  'task data': {
    // The task write runs in its own transaction after the namespace is provisioned; an uncommitted
    // receipt with the same call ID pauses it right before its commit, after its guard.
    barrier: (run, callId, ctx) => [`INSERT INTO task_data.receipts(attempt_id, call_id, actor_id, owner_kind, owner_id, operation, payload_hash, result) VALUES ($1,$2,$3,'agent',$3,'held','held','{}')`, [run.attemptId, callId, ctx.scout]],
    write: (ctx, run, key, prepared, callId) => ctx.dispatcher.structuredTool(run.attemptId, callId, { operation: 'create_table', target: { kind: 'agent', ownerId: ctx.scout }, table: `t_${key}`, columns: [{ name: 'title', type: 'text' }] }),
    landed: (ctx, key) => count(ctx.db, `SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE tablename=$1`, [`t_${key}`]),
  },
  'text publication': {
    barrier: threadLock,
    write: async (ctx, run, key, prepared, callId) => {
      const published = await ctx.dispatcher.publishToolText(run.attemptId, callId, `Published ${key}`)
      if (published.status !== 'completed') throw new Error(published.reason)
      return published
    },
    landed: (ctx, key) => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.messages WHERE parts @> $1::jsonb`, [JSON.stringify([{ kind: 'text', text: `Published ${key}` }])]),
  },
}

for (const [name, writer] of Object.entries(writers)) {
  test(`${name}: a write just before the lifecycle change commits and its run is then stopped`, { skip: noDatabase, timeout: 60000 }, async t => {
    const ctx = await setup(t)
    const prepared = await writer.prepare?.(ctx)
    const run = await ctx.running()
    const callId = randomUUID()
    const [sql, params] = writer.barrier(run, callId, ctx)
    const barrier = await ctx.hold(sql, params)
    const writing = outcome(writer.write(ctx, run, 'before', prepared, callId))
    await ctx.waiting(1)
    const flipping = ctx.flip()
    await ctx.waiting(2)
    await barrier.release()
    const written = await writing
    assert.equal(written.error, undefined, 'the earlier write commits')
    await flipping
    assert.equal(await writer.landed(ctx, 'before'), 1)
    assert.deepEqual(await ctx.state(run.runId), { state: 'cancellation-requested', stop_requested: true, cancel_delivery: 'requested' })
    const late = await outcome(writer.write(ctx, run, 'late', prepared, randomUUID()))
    assert.ok(late.error, 'a write after the stop is refused')
    assert.equal(await writer.landed(ctx, 'late'), name === 'relationships' ? 1 : 0)
  })

  test(`${name}: a write just after the lifecycle change waits for it and is refused`, { skip: noDatabase, timeout: 60000 }, async t => {
    const ctx = await setup(t)
    const prepared = await writer.prepare?.(ctx)
    const run = await ctx.running()
    const flip = await ctx.heldFlip()
    const writing = outcome(writer.write(ctx, run, 'after', prepared, randomUUID()))
    await ctx.waiting(1)
    await flip.commit()
    assert.ok((await writing).error, 'the write is refused')
    assert.equal(await writer.landed(ctx, 'after'), 0)
    assert.equal((await ctx.state(run.runId)).stop_requested, true)
  })
}

test('artifacts: a write claimed before the change is fenced before it lands; one after is refused', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.running()
  const written = (key, callId = randomUUID()) => outcome(run.call('artifacts.write', { name: `${key}.txt`, content: key }, callId))
  const outputs = state => count(ctx.db, `SELECT count(*)::int AS n FROM kipster.artifact_output_writes WHERE state=$1`, [state])
  const ready = await written('earlier')
  assert.equal(ready.value.status, 'completed', 'a write finished before the change stays')
  const [sql, params] = runLock(run)
  const barrier = await ctx.hold(sql, params)
  const writing = written('racing')
  await ctx.waiting(1)
  const flipping = ctx.flip()
  await ctx.waiting(2)
  await barrier.release()
  const raced = await writing
  await flipping
  assert.match(raced.error?.message ?? '', /not live/, 'the claim committed before the change; the file never becomes ready')
  assert.deepEqual([await outputs('ready'), await outputs('failed')], [1, 1])
  assert.equal((await ctx.state(run.runId)).stop_requested, true)
  const after = await written('after')
  assert.match(after.error?.message ?? '', /not live/)
  assert.equal(await outputs('staging'), 0)
})

test('artifacts: an organization upload racing the organization change waits and is refused', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const chatId = await ctx.chat()
  const bytes = Buffer.from('quarterly figures')
  const upload = () => ctx.runtime.artifacts.upload(ctx.actor, { uploadId: randomUUID(), target: { installationId: ctx.installationId, callerId: ctx.actor.personId, context: ctx.context, chatId }, name: 'figures.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest(bytes), purpose: 'attachment' }, stream(bytes))
  assert.equal((await upload()).status, 'accepted')
  const flip = await ctx.heldFlip(ctx.organizationId, 'deleting', 'organization')
  const racing = outcome(upload())
  await ctx.waiting(1)
  await flip.commit()
  assert.match((await racing).error?.message ?? '', /Organization access denied/)
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.artifacts WHERE owner_kind='organization'`), 1)
})

test('voice: a transcription claimed before the change never lands its result; one after is refused unheard', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t, { transcribe: true })
  const chatId = await ctx.chat()
  const bytes = Buffer.from('RIFFtest')
  const target = { installationId: ctx.installationId, callerId: ctx.actor.personId, context: ctx.context, chatId }
  const recording = (await ctx.runtime.artifacts.upload(ctx.actor, { uploadId: randomUUID(), target, name: 'note.wav', mimeType: 'audio/wav', size: bytes.length, sha256: digest(bytes), purpose: 'attachment' }, stream(bytes))).artifact.id
  const saved = await ctx.submit(chatId, 'Listen to this', { parts: [{ kind: 'text', text: 'Listen to this' }, { kind: 'file', artifactId: recording, purpose: 'attachment' }] })
  const found = await ctx.execution(saved.runId)
  const attemptId = found.context.attemptId
  const results = () => ctx.db.query('SELECT call_id, status, result FROM kipster.voice_tool_calls ORDER BY call_id').then(result => result.rows)
  const barrier = await ctx.hold('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [saved.threadId])
  const before = ctx.dispatcher.transcribeTool(attemptId, 'a-before', recording)
  await ctx.waiting(1)
  const flipping = ctx.flip()
  await ctx.waiting(2)
  await barrier.release()
  await flipping
  assert.deepEqual(await before, { status: 'unavailable', reason: 'cancelled' })
  assert.deepEqual((await results()).map(item => [item.call_id, item.status, item.result]), [['a-before', 'preparing', null]], 'the claim committed; its result never did')
  const heard = ctx.voice.calls
  assert.deepEqual(await ctx.dispatcher.transcribeTool(attemptId, 'b-after', recording), { status: 'unavailable', reason: 'cancelled' })
  assert.equal(ctx.voice.calls, heard, 'nothing is transcribed after the change')
  assert.equal((await results()).length, 1)
})

test('delegation: work delegated just before the recipient changes fails back to the parent; later delegation is refused', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const parent = await ctx.running(ctx.root, 'Ask Scout')
  const delegate = key => outcome(parent.call('agents.delegate', { recipientId: ctx.scout, request: `Check ${key}` }))
  const barrier = await ctx.hold('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [parent.threadId])
  const racing = delegate('before')
  await ctx.waiting(1)
  const flipping = ctx.flip()
  await ctx.waiting(2)
  await barrier.release()
  const delegated = await racing
  assert.equal(delegated.error, undefined)
  await flipping
  const record = await row(ctx.db, 'SELECT state, failure, child_run_id FROM kipster.delegations WHERE id=$1', [delegated.value.id])
  assert.deepEqual([record.state, record.failure], ['failed', 'Agent was archived'])
  assert.equal((await ctx.state(record.child_run_id)).state, 'cancelled')
  assert.equal((await ctx.state(parent.runId)).stop_requested, false, 'the surviving parent is not stopped')
  assert.match((await delegate('after')).error?.message ?? '', /Agent is archived/)
  // The parent continues once its provider turn ends and sees the failure.
  const from = ctx.executions.length
  parent.found.handle.release({ kind: 'ended', attemptId: parent.attemptId, confirmed: true })
  const resumed = await ctx.execution(parent.runId, from)
  assert.deepEqual(resumed.context.delegationResults.map(item => [item.recipientAgentId, item.state, item.failure]), [[ctx.scout, 'failed', 'Agent was archived']])
  assert.equal(ctx.executions.filter(item => item.context.agentId === ctx.scout).length, 0, 'the archived agent never ran')
})

test('fenceAffectedWork stops queued, running and waiting work as Stop does', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const running = await ctx.running()
  const queued = await ctx.submit(running.chatId, 'After that', { mode: 'reply', threadId: running.threadId })
  const asking = await ctx.running(ctx.scout, 'Ask me something')
  const question = await asking.call('interactions.ask', { prompt: 'Which region?', options: [{ id: 'eu', label: 'Europe' }] })
  asking.found.handle.release({ kind: 'ended', attemptId: asking.attemptId, confirmed: true })
  await until(async () => (await ctx.state(asking.runId)).state, state => state === 'waiting', 'question wait')
  const other = await ctx.running(ctx.root, 'Unaffected work')
  const fenced = await ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.installationId])
    return fenceAffectedWork(client, ctx.runtime.jobs, ctx.installationId, { agentId: ctx.scout }, 'Agent was archived')
  })
  assert.deepEqual(new Set(fenced.runs), new Set([running.runId, queued.runId, asking.runId]))
  assert.deepEqual(fenced.cancelAttempts, [running.attemptId])
  assert.deepEqual(await ctx.state(running.runId), { state: 'cancellation-requested', stop_requested: true, cancel_delivery: 'requested' })
  assert.deepEqual(await ctx.state(queued.runId), { state: 'cancelled', stop_requested: true, cancel_delivery: 'not-needed' })
  assert.deepEqual(await ctx.state(asking.runId), { state: 'cancelled', stop_requested: true, cancel_delivery: 'not-needed' })
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.interactions WHERE id=$1', [question.interactionId])).state, 'cancelled')
  assert.equal((await ctx.state(other.runId)).stop_requested, false)
  // Stopped work stays visible in its thread.
  const snapshot = await (await fetch(`${ctx.server.url}/v1/threads/${running.threadId}/snapshot`)).json()
  assert.deepEqual(snapshot.work.map(item => item.state).sort(), ['cancellation-requested', 'cancelled'])
  // The adapter is asked to cancel; a late output is rejected and the run ends cancelled.
  await ctx.dispatcher.deliverCancellations()
  await until(async () => (await ctx.state(running.runId)).cancel_delivery, value => value === 'acknowledged', 'cancellation delivered')
  assert.deepEqual(ctx.cancels, [running.attemptId])
  running.found.handle.release({ kind: 'text', attemptId: running.attemptId, messageId: 'late', text: 'Late output', final: true })
  running.found.handle.release({ kind: 'ended', attemptId: running.attemptId, confirmed: true })
  await until(async () => (await ctx.state(running.runId)).state, state => state === 'cancelled', 'run cancelled')
  assert.equal(await count(ctx.db, `SELECT count(*)::int AS n FROM kipster.messages WHERE parts @> $1::jsonb`, [JSON.stringify([{ kind: 'text', text: 'Late output' }])]), 0)
  assert.equal(await count(ctx.db, 'SELECT count(*)::int AS n FROM kipster.owned_permits'), 1, 'only the unaffected run holds a permit')
})

test('fenceAffectedWork of an organization stops every run in its chats, delegated children included', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const parent = await ctx.running(ctx.root, 'Ask Scout')
  const delegated = await parent.call('agents.delegate', { recipientId: ctx.scout, request: 'Check the numbers' })
  parent.found.handle.release({ kind: 'ended', attemptId: parent.attemptId, confirmed: true })
  const child = await ctx.execution(delegated.childRunId)
  const own = await ctx.running(ctx.scout, 'Own work')
  const flip = await ctx.heldFlip(ctx.organizationId, 'deleting', 'organization')
  await flip.commit()
  for (const runId of [parent.runId, delegated.childRunId, own.runId]) assert.equal((await ctx.state(runId)).stop_requested, true, runId)
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.delegations WHERE id=$1', [delegated.id])).state, 'cancelled', 'a stopped parent cancels its child')
  await ctx.dispatcher.deliverCancellations()
  await until(() => ctx.cancels.length, n => n === 2, 'both attempts cancelled')
  assert.deepEqual(new Set(ctx.cancels), new Set([child.context.attemptId, own.attemptId]))
})

test('new work is refused for an agent that is not live, and its chats stay readable', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.running()
  run.found.handle.release({ kind: 'text', attemptId: run.attemptId, messageId: 'answer', text: 'Done', final: true })
  run.found.handle.release({ kind: 'failed', attemptId: run.attemptId, confirmedEnded: true, message: 'provider failed' })
  await until(async () => (await ctx.state(run.runId)).state, state => state === 'failed', 'run failed')
  await ctx.flip()
  await assert.rejects(ctx.submit(run.chatId, 'Anything new?'), /Agent is archived/)
  assert.deepEqual(await resolveDirectChat(ctx.db, ctx.actor, ctx.context, ctx.scout), { chatId: run.chatId }, 'an existing chat still opens')
  const helper = randomUUID()
  await ctx.runtime.home.provisionAgent(helper)
  await ctx.db.query('INSERT INTO kipster.agents(id, installation_id, display_name, provisioned) VALUES ($1,$2,$3,true)', [helper, ctx.installationId, 'Helper'])
  await ctx.db.query('INSERT INTO kipster.agent_memberships(organization_id, agent_id) VALUES ($1,$2)', [ctx.organizationId, helper])
  await ctx.flip(helper)
  await assert.rejects(resolveDirectChat(ctx.db, ctx.actor, ctx.context, helper), /Agent is archived/, 'no new chat with an archived agent')
  const retry = await ctx.dispatcher.control(ctx.actor, { operationId: randomUUID(), context: ctx.context, chatId: run.chatId, threadId: run.threadId, runId: run.runId, attemptId: run.attemptId, action: 'retry' })
  assert.deepEqual([retry.outcome, retry.reason], ['rejected', 'Agent is not available for new work'])
  const snapshot = await fetch(`${ctx.server.url}/v1/threads/${run.threadId}/snapshot`)
  assert.equal(snapshot.status, 200)
  assert.ok((await snapshot.json()).messages.some(message => message.parts.some(part => part.text === 'Done')))
  const settings = await fetch(`${ctx.server.url}/v1/agents/${ctx.scout}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, operationId: randomUUID(), settings: { effort: { set: 'low' } } }) })
  assert.equal(settings.status, 404, 'administration writes need a live agent')
  // Restoring makes it live again.
  await ctx.flip(ctx.scout, 'active')
  const again = await ctx.submit(run.chatId, 'Back again')
  await ctx.execution(again.runId)
})

test('dispatch stops queued work of an agent that stopped being live without running it', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const chatId = await ctx.chat()
  await ctx.dispatcher.close()
  const saved = await ctx.submit(chatId, 'Queued while offline')
  // A lifecycle row changed without fencing still never runs.
  await ctx.db.query(`UPDATE kipster.agents SET lifecycle='archived' WHERE id=$1`, [ctx.scout])
  const restarted = new TextDispatcher(ctx.runtime, { ...fixtureAdapter({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('unused') } }), async execute() { throw new Error('must not run') } })
  try {
    await restarted.start()
    await until(async () => (await ctx.state(saved.runId)).state, state => state === 'cancelled', 'queued run cancelled')
    assert.equal((await ctx.state(saved.runId)).stop_requested, true)
  } finally { await restarted.close() }
})

test('indexing leases that complete after the owner stops being live write nothing', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const memory = await ctx.runtime.memory.save(ctx.scout, 'fact', 'The archive room is on floor two', [{ authorId: ctx.scout }])
  const run = await ctx.running()
  const collection = await run.call('vectors.space', { operation: 'create', target: { kind: 'agent', ownerId: ctx.scout }, name: 'notes' })
  await run.call('vectors.space', { operation: 'upsert', target: { kind: 'agent', ownerId: ctx.scout }, collectionId: collection.collectionId, key: 'room', expectedRevision: 0, text: 'Floor two', metadata: {} })
  const intents = () => ctx.db.query(`SELECT 'memory' AS kind, status, embedding IS NULL AS empty FROM kipster.memory_index_intents WHERE memory_id=$1
    UNION ALL SELECT 'vector', status, embedding IS NULL FROM kipster.vector_index_intents`, [memory.id]).then(result => result.rows)
  for (const [kind, indexer] of [['memory', ctx.runtime.memory], ['vector', ctx.runtime.vectors]]) {
    ctx.embedding.gate = deferred()
    const indexing = indexer.indexPending(1, true)
    await until(intents, rows => rows.some(item => item.kind === kind && item.status === 'processing'), `${kind} lease claimed`)
    await ctx.flip()
    ctx.embedding.gate.resolve()
    assert.deepEqual(await indexing, { processed: 1, ready: 0, failed: 0, stale: 1 })
    await ctx.flip(ctx.scout, 'active')
  }
  ctx.embedding.gate = null
  assert.deepEqual((await intents()).map(item => [item.kind, item.status, item.empty]), [['memory', 'processing', true], ['vector', 'processing', true]], 'the leases changed nothing')
  // Once the owner is live and the leases expire, indexing finishes; while it is not live, nothing is claimed.
  await ctx.db.query(`UPDATE kipster.memory_index_intents SET lease_until=now() - interval '1 second'`)
  await ctx.db.query(`UPDATE kipster.vector_index_intents SET lease_until=now() - interval '1 second'`)
  await ctx.flip()
  assert.equal((await ctx.runtime.memory.indexPending(5, true)).processed, 0)
  assert.equal((await ctx.runtime.vectors.indexPending(5, true)).processed, 0)
  await ctx.flip(ctx.scout, 'active')
  assert.equal((await ctx.runtime.memory.indexPending(5, true)).ready, 1)
  assert.equal((await ctx.runtime.vectors.indexPending(5, true)).ready, 1)
})

test('a reply accepted into a parent thread while the delegated child is fenced does not deadlock', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  // The root agent's run waits on Scout's delegated child; Scout also has work of its own.
  const parent = await ctx.running(ctx.root, 'Ask Scout')
  const delegated = await parent.call('agents.delegate', { recipientId: ctx.scout, request: 'Check the numbers' })
  parent.found.handle.release({ kind: 'ended', attemptId: parent.attemptId, confirmed: true })
  await until(async () => (await ctx.state(parent.runId)).state, state => state === 'waiting', 'parent waits on its child')
  const own = await ctx.running(ctx.scout, 'Own work')
  // An acceptance into the parent's thread locks the thread, then publishes to the application stream.
  const locked = deferred(), publish = deferred()
  const accepting = ctx.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [parent.threadId])
    locked.resolve()
    await publish.promise
    await client.query('SELECT 1 FROM kipster.app_streams WHERE installation_id=$1 FOR UPDATE', [ctx.installationId])
  })
  await locked.promise
  const flipping = outcome(ctx.flip())
  await ctx.waiting(1)
  publish.resolve()
  await accepting
  assert.equal((await flipping).error, undefined, 'the lifecycle change completes')
  assert.equal((await ctx.state(own.runId)).stop_requested, true)
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.delegations WHERE id=$1', [delegated.id])).state, 'failed')
  const reply = await ctx.submit(parent.chatId, 'Any news?', { mode: 'reply', threadId: parent.threadId })
  assert.ok(reply.runId, 'a reply into the parent thread is accepted')
})

test('an operation step that fences work gets its adapter cancellations delivered at once', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.running()
  ctx.dispatcher.operations.register('test.archive', [{ name: 'fence', async run(client, operation) {
    await changeLifecycle(client, ctx.runtime.jobs, ctx.installationId, 'agent', operation.targetId, 'archived', 'Agent was archived')
    return { status: 'done' }
  } }])
  const id = await ctx.db.transaction(async client => {
    const { operation } = await claimOperation(client, { installationId: ctx.installationId, actorKind: 'person', actorId: ctx.actor.personId, operationId: 'archive-1' }, 'test.archive', { kind: 'agent', id: ctx.scout }, {})
    await ctx.runtime.jobs.send(client, operation.id, 0, 'administration')
    return operation.id
  })
  await until(() => ctx.cancels.length, n => n === 1, 'cancellation delivered after the step')
  assert.deepEqual(ctx.cancels, [run.attemptId])
  assert.equal((await row(ctx.db, 'SELECT state FROM kipster.admin_operations WHERE id=$1', [id])).state, 'succeeded')
})

test('operation wake-ups are single per operation, and a stopped engine runs no more batches', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  let batches = 0
  ctx.dispatcher.operations.register('test.waiting', [{ name: 'wait', async run() { return { status: 'wait', reason: 'Waiting for the provider to end' } } }])
  ctx.dispatcher.operations.register('test.endless', [{ name: 'batch', async run() { batches++; await new Promise(resolve => setTimeout(resolve, 20)); return { status: 'more' } } }])
  const submit = (kind, operationId) => ctx.db.transaction(async client => {
    const { operation } = await claimOperation(client, { installationId: ctx.installationId, actorKind: 'person', actorId: ctx.actor.personId, operationId }, kind, { kind: 'agent', id: ctx.scout }, {})
    await ctx.runtime.jobs.send(client, operation.id, 0, 'administration')
    return operation.id
  })
  const waiting = await submit('test.waiting', 'wait-1')
  await until(async () => (await row(ctx.db, 'SELECT state FROM kipster.admin_operations WHERE id=$1', [waiting])).state, state => state === 'waiting', 'operation waits')
  for (let n = 0; n < 3; n++) await ctx.dispatcher.operations.start()
  const queued = () => count(ctx.db, `SELECT count(*)::int AS n FROM kipster_jobs.job WHERE name='administration' AND singleton_key=$1 AND state='created'`, [waiting])
  assert.equal(await queued(), 1, 'one waiting wake-up however often the engine starts')
  await submit('test.endless', 'endless-1')
  await until(() => batches, n => n >= 3, 'batches run')
  await ctx.dispatcher.operations.stop()
  await new Promise(resolve => setTimeout(resolve, 100))
  const stopped = batches
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(batches, stopped, 'no batch runs after the engine stops')
})
