import test from 'node:test'
import { ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { eventSignals, publishAppEvent, readEvents } from '../dist/modules/synchronization/public.js'
import { runContext } from '../dist/modules/conversations/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const waitFor = async (read, predicate, label) => {
  for (let i = 0; i < 100; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(`Timed out: ${label}`)
}
function fixture() {
  const handles = []
  const contexts = []
  return { id: 'test-adapter', version: '1', contractMajor: 1, handles, contexts,
    async execute(context) {
      contexts.push(context)
      const queue = []
      let next
      let closed = false
      const handle = {
        context,
        events: { async *[Symbol.asyncIterator]() { while (!closed || queue.length) { const event = queue.shift() ?? await new Promise(resolve => { next = resolve }); if (event) yield event } } },
        release(event) { if (next) { const resolve = next; next = undefined; resolve(event) } else queue.push(event); if (event.kind === 'ended' || event.kind === 'failed') closed = true },
        abort() { closed = true; next?.(undefined) },
        async cancel() { return { acknowledged: true, confirmedEnded: false } },
        async reconcile() { return 'unknown' },
      }
      handles.push(handle)
      return handle
    }, async close() { for (const handle of handles) handle.abort() } }
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function stream(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200)
  const reader = response.body.getReader(), events = []
  let buffer = ''
  const task = (async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += new TextDecoder().decode(chunk.value)
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (data) events.push(JSON.parse(data.slice(6)))
      }
    }
  })()
  return { events, async close() { await reader.cancel(); await task } }
}

test('streaming drafts, coalescing, replay, listener reconnect, idle delivery and sealed interruptions', { skip: noDatabase, timeout: 30000 }, async () => {
  const database = `kipster_stream_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-stream-'))
  let runtime, dispatcher, server
  const clients = []
  let releaseWrite
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    const adapter = fixture()
    let block = true
    dispatcher = new TextDispatcher(runtime, adapter, undefined, { async afterOutput(id) {
      if (id === 'one' && block) { block = false; await new Promise(resolve => { releaseWrite = resolve }) }
    } })
    server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
    const post = async (path, value) => {
      const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      assert.ok(response.ok, await response.clone().text()); return response.json()
    }
    const get = async path => (await fetch(server.url + path)).json()
    const context = { kind: 'installation', installationId: actor.installationId }
    const { chatId } = await post('/v1/direct-chats', { version: 1, context, agentId: runtime.bootstrap.rootAgentId })
    const submit = () => post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'stream' }] })
    await dispatcher.start()
    const first = await submit()
    await waitFor(() => Promise.resolve(adapter.handles), h => h.length === 1, 'execution')
    const handle = adapter.handles[0]
    const snap = () => get(`/v1/threads/${first.threadId}/snapshot`)
    const before = await snap()
    const url = cursor => server.url + `/v1/threads/${first.threadId}/events?after=${encodeURIComponent(cursor)}`
    const live = await stream(url(before.cursor)); clients.push(live)
    const text = (id, text, final = false) => handle.release({ kind: 'text', attemptId: handle.context.attemptId, messageId: id, text, final })
    text('one', 'First draft')
    await waitFor(() => Promise.resolve(live.events), e => e.some(x => x.type === 'message-draft'), 'draft before completion')
    assert.equal((await snap()).work[0].state, 'running')
    await waitFor(() => Promise.resolve(releaseWrite), Boolean, 'blocked output')
    for (let i = 0; i < 3; i++) text('one', `fragment ${i}`)
    text('two', 'Second draft')
    await pause(50)
    releaseWrite()
    await waitFor(snap, s => s.messages.some(m => m.parts[0]?.text === 'fragment 2') && s.messages.some(m => m.parts[0]?.text === 'Second draft'), 'coalesced drafts')
    const saved = await snap()
    const writes = (await runtime.db.query("SELECT count(*)::int AS n FROM kipster.thread_events WHERE thread_id=$1 AND type='message-draft'", [first.threadId])).rows[0].n
    assert.ok(writes <= 3, `only initial/latest drafts written: ${writes}`)
    const replay = await stream(url(saved.cursor)); clients.push(replay)
    text('one', 'First final', true); text('two', 'Second final', true)
    text('one', 'stale draft')
    await waitFor(snap, s => s.messages.filter(m => m.authorId !== actor.personId && m.final).length === 2, 'authoritative finals')
    const attempt = (await runtime.db.query('SELECT id,intent_id,generation,incarnation,state FROM kipster.attempts WHERE id=$1', [handle.context.attemptId])).rows[0]
    await dispatcher.publishText({ ...attempt, intentId: attempt.intent_id, generation: Number(attempt.generation) }, { kind: 'text', attemptId: attempt.id, messageId: 'one', text: 'late direct draft', final: false }, await runContext(runtime.db, first.runId))
    handle.release({ kind: 'ended', attemptId: handle.context.attemptId, confirmed: true })
    await waitFor(snap, s => s.work[0].state === 'completed', 'completion')
    await waitFor(() => Promise.resolve(replay.events), e => e.filter(x => x.type === 'message-final').length === 2, 'replay finals')
    const finals = replay.events.filter(x => x.type === 'message-final')
    assert.equal(new Set(finals.map(e => e.resourceId)).size, 2)
    assert.ok(finals.every(e => saved.messages.some(m => m.id === e.resourceId)))
    const after = await snap()
    assert.equal(after.messages.length, 3)
    assert.ok(after.messages.every(m => m.final))
    assert.ok(!after.messages.some(m => m.parts[0]?.text === 'stale draft'))
    const scope = { kind: 'thread', installationId: actor.installationId, callerId: actor.personId, threadId: first.threadId }
    assert.deepEqual(replay.events.map(e => e.eventId), (await readEvents(runtime.db, scope, saved.cursor)).events.map(e => e.eventId))
    // The listener is shared, reconnects after a real connection loss, and wakes readers.
    const listeners = await runtime.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN kipster_events'")
    assert.equal(listeners.rows.length, 1)
    await runtime.db.query('SELECT pg_terminate_backend($1)', [listeners.rows[0].pid])
    await waitFor(() => runtime.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN kipster_events'"), r => r.rows.length === 1 && r.rows[0].pid !== listeners.rows[0].pid, 'LISTEN reconnect')
    const hub = await eventSignals(runtime.db)
    let notifications = 0
    const unsubscribe = hub.subscribe(`a:${actor.installationId}`, () => notifications++)
    const publish = client => publishAppEvent(client, actor.installationId, 'test', randomUUID(), 1, {})
    await assert.rejects(runtime.db.transaction(async client => { await publish(client); throw new Error('rollback') }), /rollback/)
    await pause(50)
    assert.equal(notifications, 0, 'rolled-back events never wake subscribers')
    await runtime.db.transaction(async client => { await publish(client); await pause(50); assert.equal(notifications, 0, 'uncommitted event stays private') })
    await waitFor(() => Promise.resolve(notifications), n => n === 1, 'committed notification')
    unsubscribe(); hub.close()
    // No 200 ms event reads while idle (the defensive 30 second fallback is intentional).
    const transaction = runtime.db.transaction.bind(runtime.db)
    let eventReads = 0
    runtime.db.transaction = work => transaction(client => work({ query(sql, values) { if (sql.includes('FROM kipster.thread_events')) eventReads++; return client.query(sql, values) } }))
    await pause(150)
    const count = eventReads
    await pause(1000)
    assert.equal(eventReads, count)
    runtime.db.transaction = transaction
    for (const outcome of ['failed', 'cancelled']) {
      const run = await submit()
      await waitFor(() => Promise.resolve(adapter.handles), hs => hs.some(h => h.context.runId === run.runId), 'next execution')
      const h = adapter.handles.find(h => h.context.runId === run.runId)
      let slow, fast
      if (outcome === 'failed') {
        const current = await get(`/v1/threads/${run.threadId}/snapshot`)
        const address = server.url + `/v1/threads/${run.threadId}/events?after=${encodeURIComponent(current.cursor)}`
        const original = ServerResponse.prototype.writeHead
        let slowResponse
        ServerResponse.prototype.writeHead = function (...args) { if (args[1]?.['content-type']?.startsWith('text/event-stream')) slowResponse = this; return original.apply(this, args) }
        try { slow = await stream(address); clients.push(slow) } finally { ServerResponse.prototype.writeHead = original }
        assert.ok(slowResponse)
        // Hold this connection under backpressure without a drain signal.
        slowResponse.write = () => false
        fast = await stream(address); clients.push(fast)
      }
      h.release({ kind: 'text', attemptId: h.context.attemptId, messageId: outcome, text: 'Partial answer', final: false })
      if (fast) {
        await waitFor(() => Promise.resolve(fast.events), events => events.some(e => e.type === 'message-draft'), 'fast client progresses while slow client is blocked')
        await slow.close()
      }

      const state = () => get(`/v1/threads/${run.threadId}/snapshot`)
      await waitFor(state, s => s.messages.some(m => !m.final), 'partial')
      if (outcome === 'cancelled') await dispatcher.control(actor, { operationId: randomUUID(), action: 'stop', context, chatId, threadId: run.threadId, runId: run.runId, attemptId: h.context.attemptId })
      h.release(outcome === 'failed' ? { kind: 'failed', attemptId: h.context.attemptId, confirmedEnded: true, message: 'fixture failure' } : { kind: 'ended', attemptId: h.context.attemptId, confirmed: true })
      const settled = await waitFor(state, s => s.work[0].state === outcome, outcome)
      assert.ok(settled.messages.every(m => m.final))
      assert.equal(settled.messages[1].parts[0].text, 'Partial answer')
      const events = (await runtime.db.query("SELECT type FROM kipster.thread_events WHERE resource_id=$1 AND type='message-final'", [settled.messages[1].id])).rows
      assert.equal(events.length, 1)
    }
    const application = { kind: 'application', installationId: actor.installationId, callerId: actor.personId }
    const old = await get('/v1/app/snapshot')
    await runtime.db.transaction(async client => { for (let i = 0; i < 2304; i++) await publishAppEvent(client, actor.installationId, 'test', randomUUID(), 1, {}) })
    const retained = (await runtime.db.query('SELECT count(*)::int AS n FROM kipster.app_events WHERE installation_id=$1', [actor.installationId])).rows[0].n
    assert.ok(retained >= 2048 && retained < 2176, `bounded replay: ${retained}`)
    await assert.rejects(readEvents(runtime.db, application, old.cursor), /resync-required/)
    assert.equal((await snap()).messages.length, 3, 'retention preserves canonical messages')
  } finally {
    releaseWrite?.()
    for (const client of clients) await client.close()
    await server?.close(); await dispatcher?.close(); await runtime?.close()
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.close()
  }
})
