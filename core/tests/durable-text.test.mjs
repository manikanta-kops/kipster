import test from 'node:test'
import { request as httpRequest } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { retainLast, readEvents } from '../dist/modules/synchronization/public.js'
import { runContext } from '../dist/modules/conversations/public.js'
import { textEvent } from '../dist/protocol/text.js'
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
async function sseUntil(reader, marker) {
  let frames = ''
  for (let i = 0; i < 20 && !frames.includes(marker); i++) {
    const chunk = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; got ${frames}`)), 3000))])
    if (chunk.done) throw new Error(`SSE closed before ${marker}; got ${frames}`)
    frames += new TextDecoder().decode(chunk.value)
  }
  assert.ok(frames.includes(marker), frames)
}

test('durable HTTP text, FIFO/capacity, SSE replay and retained state', { skip: noDatabase }, async () => {
  const database = `kipster_text_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_text-home-'))
  let runtime, dispatcher, server, adapter
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, executionLimit: 1 })
    const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    adapter = fixture()
    dispatcher = new TextDispatcher(runtime, adapter)
    const uiOrigin = 'http://127.0.0.1:4197'
    server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, allowedOrigins: [uiOrigin, 'tauri://localhost'] })
    const defaultOriginServer = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0 })
    try {
      const foreign = await fetch(defaultOriginServer.url + '/v1/bootstrap', { headers: { origin: uiOrigin } })
      assert.equal(foreign.status, 403)
      assert.equal((await fetch(defaultOriginServer.url + '/v1/bootstrap', { headers: { origin: 'tauri://localhost' } })).status, 403)
      const same = await fetch(defaultOriginServer.url + '/v1/bootstrap', { headers: { origin: defaultOriginServer.url } })
      assert.equal(same.status, 200)
    } finally { await defaultOriginServer.close() }
    const post = async (path, value) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); return { status: response.status, data: await response.json() } }
    const get = async path => { const response = await fetch(server.url + path); return { status: response.status, data: await response.json() } }
    const context = { kind: 'installation', installationId: actor.installationId }
    const chatRequest = { version: 1, context, agentId: runtime.bootstrap.rootAgentId }
    const chats = await Promise.all(Array.from({ length: 5 }, () => post('/v1/direct-chats', chatRequest)))
    assert.equal(new Set(chats.map(x => x.data.chatId)).size, 1)
    const chatId = chats[0].data.chatId
    const preflight = await fetch(server.url + '/v1/text/submissions', { method: 'OPTIONS', headers: { origin: uiOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), uiOrigin)
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type')
    for (const origin of ['null','tauri://localhost/','tauri://other','tauri://localhost.evil']) {
      assert.equal((await fetch(server.url + '/v1/bootstrap', { headers: { origin } })).status, 403)
    }
    const native = await fetch(server.url + '/v1/bootstrap', { headers: { origin: 'tauri://localhost' } })
    assert.equal(native.status, 200)
    assert.equal(native.headers.get('access-control-allow-origin'), 'tauri://localhost')
    const nativePreflight = await fetch(server.url + '/v1/direct-chats', { method: 'OPTIONS', headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
    assert.equal(nativePreflight.status, 204)
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(server.url + '/v1/bootstrap', { headers: { origin: 'tauri://localhost', host: 'foreign.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
      request.on('error', reject); request.end()
    })
    assert.equal(foreignHostStatus, 403)
    await assert.rejects(startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, allowedOrigins: ['null'] }), /Invalid/)
    await assert.rejects(startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, allowedOrigins: ['tauri://other'] }), /Invalid/)
    const deniedId = randomUUID()
    const deniedBody = { version: 1, submissionId: deniedId, scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'denied cross-origin write' }] }
    const denied = await fetch(server.url + '/v1/text/submissions', { method: 'POST', headers: { origin: 'http://other.example', 'content-type': 'application/json' }, body: JSON.stringify(deniedBody) })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
    assert.equal((await get(`/v1/text/receipts/${deniedId}`)).status, 404)
    const allowed = await fetch(server.url + '/v1/direct-chats', { method: 'POST', headers: { origin: uiOrigin, 'content-type': 'application/json' }, body: JSON.stringify(chatRequest) })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), uiOrigin)
    const submit = (submissionId, mode, text, threadId) => post('/v1/text/submissions', { version: 1, submissionId, scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId }, mode, ...(threadId ? { threadId } : {}), parts: [{ kind: 'text', text }] })
    const duplicateId = randomUUID()
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => submit(duplicateId, 'root', `same ${index}`)))
    assert.ok(attempts.every(x => x.status === 202))
    assert.equal(new Set(attempts.map(x => x.data.runId)).size, 1)
    assert.equal(attempts.filter(x => !x.data.alreadyAccepted).length, 1)
    const first = attempts[0].data
    const changed = await submit(duplicateId, 'root', 'different payload')
    assert.equal(changed.data.messageId, first.messageId)
    assert.equal(changed.data.alreadyAccepted, true)
    assert.equal((await get(`/v1/text/receipts/${duplicateId}`)).data.runId, first.runId)
    const bad = await submit(randomUUID(), 'reply', 'wrong thread', randomUUID())
    assert.equal(bad.status, 404)
    const before = (await get(`/v1/threads/${first.threadId}/snapshot`)).data
    assert.equal(before.messages.length, 1)
    assert.equal(before.work[0].state, 'queued')
    const appBefore = (await get('/v1/app/snapshot')).data
    const threadStream = await fetch(server.url + `/v1/threads/${first.threadId}/events?after=${encodeURIComponent(before.cursor)}`)
    assert.equal(threadStream.status, 200)
    const threadReader = threadStream.body.getReader()
    const appStream = await fetch(server.url + `/v1/app/events?after=${encodeURIComponent(appBefore.cursor)}`)
    assert.equal(appStream.status, 200)
    const corsStream = await fetch(server.url + `/v1/app/events?after=${encodeURIComponent(appBefore.cursor)}`, { headers: { origin: uiOrigin } })
    assert.equal(corsStream.headers.get('access-control-allow-origin'), uiOrigin)
    await corsStream.body.cancel()
    const nativeStream = await fetch(server.url + `/v1/app/events?after=${encodeURIComponent(appBefore.cursor)}`, { headers: { origin: 'tauri://localhost' } })
    assert.equal(nativeStream.status, 200)
    assert.equal(nativeStream.headers.get('access-control-allow-origin'), 'tauri://localhost')
    await nativeStream.body.cancel()
    const appReader = appStream.body.getReader()
    const wrongScope = await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: randomUUID() }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'forbidden' }] })
    assert.equal(wrongScope.status, 403)
    await dispatcher.start()
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 1, 'first execution')
    assert.equal(adapter.handles[0].context.runId, first.runId)
    const firstHandle = adapter.handles[0]
    await dispatcher.start()
    assert.equal((await get(`/v1/threads/${first.threadId}/snapshot`)).data.work[0].state, 'running')
    const competing = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    const competingDispatcher = new TextDispatcher(competing, fixture())
    try {
      await assert.rejects(competingDispatcher.start(), /already active/)
      await competingDispatcher.close()
      assert.equal((await get(`/v1/threads/${first.threadId}/snapshot`)).data.work[0].state, 'running')
      assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n, 1)
    } finally { await competing.close() }
    const second = (await submit(randomUUID(), 'root', 'second root')).data
    const follow = (await submit(randomUUID(), 'reply', 'follow up', first.threadId)).data
    await waitFor(() => runtime.db.query('SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1', [second.runId]).then(x => x.rows[0].n), n => n >= 1, 'contended worker claim')
    await waitFor(() => get(`/v1/threads/${second.threadId}/snapshot`).then(x => x.data.work[0].state), state => state === 'queued', 'capacity deferral')
    assert.equal(adapter.handles.length, 1)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n, 1)
    firstHandle.release({ kind: 'text', attemptId: firstHandle.context.attemptId, messageId: 'native-1', text: 'draft', final: false })
    await waitFor(() => get(`/v1/threads/${first.threadId}/snapshot`).then(x => x.data), snap => snap.messages.some(x => x.parts[0].text === 'draft'), 'saved draft')
    await sseUntil(threadReader, 'event: message-draft')
    await sseUntil(appReader, 'event: thread-summary')
    await threadReader.cancel(); await appReader.cancel()
    firstHandle.release({ kind: 'text', attemptId: firstHandle.context.attemptId, messageId: 'native-1', text: 'answer', final: true })
    const tool = await dispatcher.publishToolText(firstHandle.context.attemptId, 'native-1', 'answer')
    assert.equal(tool.status, 'completed')
    assert.deepEqual(await dispatcher.publishToolText(firstHandle.context.attemptId, 'native-1', 'answer'), tool)
    assert.equal((await dispatcher.publishToolText(firstHandle.context.attemptId, 'native-1', 'changed')).status, 'failed')
    firstHandle.release({ kind: 'ended', attemptId: firstHandle.context.attemptId, confirmed: true })
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 2, 'next execution')
    assert.ok([second.runId, follow.runId].includes(adapter.handles[1].context.runId))
    const secondHandle = adapter.handles[1]
    secondHandle.release({ kind: 'text', attemptId: secondHandle.context.attemptId, messageId: 'native-2', text: 'second answer', final: true })
    secondHandle.release({ kind: 'ended', attemptId: secondHandle.context.attemptId, confirmed: true })
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 3, 'remaining execution')
    const thirdHandle = adapter.handles[2]
    thirdHandle.release({ kind: 'ended', attemptId: thirdHandle.context.attemptId, confirmed: true })
    await waitFor(() => get(`/v1/threads/${first.threadId}/snapshot`).then(x => x.data), snap => snap.work.every(x => x.state === 'completed'), 'thread completion')
    await waitFor(() => get(`/v1/threads/${second.threadId}/snapshot`).then(x => x.data), snap => snap.work.every(x => x.state === 'completed'), 'independent thread completion')
    assert.equal(adapter.contexts.length, 3)
    assert.equal(Math.max(...(await runtime.db.query(`SELECT count(*)::int AS n FROM kipster.owned_permits`)).rows.map(x => x.n)), 0)
    const followContext = adapter.contexts.find(x => x.runId === follow.runId)
    assert.ok(followContext.input.some(x => x.text === 'answer'))
    assert.ok(followContext.input.some(x => x.text === 'follow up'))
    const history = (await get(`/v1/threads/${first.threadId}/snapshot`)).data
    assert.equal(history.messages.filter(x => x.parts[0].text === 'answer').length, 2)
    const appliedMessages = new Map(before.messages.map(message => [message.id, message]))
    const appliedWork = new Map(before.work.map(work => [work.runId, work]))
    const threadScope = { kind: 'thread', installationId: actor.installationId, callerId: actor.personId, threadId: first.threadId }
    const replayed = (await readEvents(runtime.db, threadScope, before.cursor)).events
    for (const event of replayed) {
      textEvent.parse(event)
      if (event.type === 'message-draft' || event.type === 'message-final') appliedMessages.set(event.data.id, event.data)
      if (event.type === 'work-changed') appliedWork.set(event.data.runId, event.data)
    }
    assert.deepEqual([...appliedMessages.values()].sort((a,b) => a.position-b.position), history.messages)
    assert.deepEqual([...appliedWork.values()].sort((a,b) => a.queuePosition-b.queuePosition), history.work)
    const app = (await get('/v1/app/snapshot')).data
    assert.equal(app.threads.length, 2)
    assert.equal(app.threads.find(x => x.threadId === first.threadId).lastMessageId, history.messages.at(-1).id)
    const savedTimes = await runtime.db.query('SELECT id,created_at FROM kipster.threads WHERE id=ANY($1::uuid[])', [[first.threadId, second.threadId]])
    for (const row of savedTimes.rows) assert.equal(app.threads.find(x => x.threadId === row.id).createdAt, row.created_at.toISOString())
    const summariesAfter = (await readEvents(runtime.db, { kind: 'application', installationId: actor.installationId, callerId: actor.personId }, appBefore.cursor)).events.filter(x => x.type === 'thread-summary')
    assert.ok(summariesAfter.length > 0)
    for (const event of summariesAfter) {
      textEvent.parse(event)
      assert.equal(event.data.createdAt, app.threads.find(x => x.threadId === event.data.threadId).createdAt)
    }
    assert.equal(app.notifications.filter(x => x.kind === 'completed').length, 3)
    const appFirstPage = (await get('/v1/app/snapshot?limit=1')).data
    assert.ok(appFirstPage.next)
    const appPageQuery = `at=${encodeURIComponent(appFirstPage.cursor)}&limit=1&afterThreadId=${appFirstPage.next.afterThreadId}&afterNotificationId=${appFirstPage.next.afterNotificationId}`
    const appSecondPage = (await get(`/v1/app/snapshot?${appPageQuery}`)).data
    assert.equal(appSecondPage.cursor, appFirstPage.cursor)
    assert.notEqual(appSecondPage.threads[0]?.threadId, appFirstPage.threads[0]?.threadId)
    assert.equal((await get(`/v1/app/snapshot?limit=1&afterThreadId=${appFirstPage.next.afterThreadId}`)).status, 400)
    const notificationId = app.notifications[0].id
    assert.equal((await post(`/v1/notifications/${notificationId}/read`, { version: 1 })).status, 200)
    assert.equal((await get(`/v1/app/snapshot?${appPageQuery}`)).status, 409)
    assert.equal((await get('/v1/app/snapshot')).data.notifications.find(x => x.id === notificationId).read, true)
    const replay = await runtime.db.query('SELECT count(*)::int AS n FROM kipster.thread_events WHERE thread_id=$1', [first.threadId])
    assert.ok(replay.rows[0].n >= 7)
    const stale = await runContext(runtime.db, first.runId)
    const countBefore = history.messages.length
    await dispatcher.publishText({ id: firstHandle.context.attemptId, intentId: first.runId, generation: 1, incarnation: randomUUID(), state: 'issued' }, { kind: 'text', attemptId: firstHandle.context.attemptId, messageId: 'late', text: 'late', final: true }, stale)
    assert.equal((await get(`/v1/threads/${first.threadId}/snapshot`)).data.messages.length, countBefore)
    await retainLast(runtime.db, threadScope, 2)
    assert.equal((await get(`/v1/threads/${first.threadId}/events?after=${encodeURIComponent(before.cursor)}`)).status, 409)
    const appScope = { kind: 'application', installationId: actor.installationId, callerId: actor.personId }
    await retainLast(runtime.db, appScope, 2)
    assert.equal((await get(`/v1/app/events?after=${encodeURIComponent(appBefore.cursor)}`)).status, 409)
    assert.equal((await get('/v1/app/snapshot')).data.notifications.length, 3)
    assert.equal((await get(`/v1/threads/${first.threadId}/snapshot`)).data.messages.length, countBefore)
    assert.equal((await get(`/v1/threads/${first.threadId}/events?after=${encodeURIComponent('t:' + second.threadId + ':0')}`)).status, 400)
    const failing = (await submit(randomUUID(), 'root', 'failing run')).data
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 4, 'failure execution')
    const failHandle = adapter.handles[3]
    const beforeFailure = (await get(`/v1/threads/${failing.threadId}/snapshot`)).data
    failHandle.release({ kind: 'failed', attemptId: failHandle.context.attemptId, confirmedEnded: true, message: 'fixture failure' })
    const afterFailure = await waitFor(() => get(`/v1/threads/${failing.threadId}/snapshot`).then(x => x.data), snap => snap.work[0].state === 'failed', 'failure state')
    const failureEvents = (await readEvents(runtime.db, { kind: 'thread', installationId: actor.installationId, callerId: actor.personId, threadId: failing.threadId }, beforeFailure.cursor)).events
    const appliedFailure = new Map(beforeFailure.work.map(work => [work.runId, work]))
    for (const event of failureEvents) { textEvent.parse(event); if (event.type === 'work-changed') appliedFailure.set(event.data.runId, event.data) }
    assert.deepEqual([...appliedFailure.values()], afterFailure.work)
    assert.equal(afterFailure.work[0].failure, 'fixture failure')
    assert.equal((await get('/v1/app/snapshot')).data.notifications.some(x => x.runId === failing.runId && x.kind === 'failed'), true)
    const large = (await submit(randomUUID(), 'root', 'large provider output')).data
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 5, 'large output execution')
    const largeHandle = adapter.handles[4]
    const beforeLarge = (await get(`/v1/threads/${large.threadId}/snapshot`)).data
    const largeStream = await fetch(server.url + `/v1/threads/${large.threadId}/events?after=${encodeURIComponent(beforeLarge.cursor)}`)
    assert.equal(largeStream.status, 200)
    const largeReader = largeStream.body.getReader()
    const largeText = 'L'.repeat(300000)
    largeHandle.release({ kind: 'text', attemptId: largeHandle.context.attemptId, messageId: 'native-large', text: largeText, final: true })
    largeHandle.release({ kind: 'ended', attemptId: largeHandle.context.attemptId, confirmed: true })
    await sseUntil(largeReader, 'event: resync-required')
    await largeReader.cancel()
    const recoveredLarge = await waitFor(() => get(`/v1/threads/${large.threadId}/snapshot`).then(x => x.data), snap => snap.work[0].state === 'completed', 'large output completion')
    assert.equal(recoveredLarge.messages.at(-1).parts[0].text, largeText)
    assert.equal((await get(`/v1/threads/${large.threadId}/events?after=${encodeURIComponent(beforeLarge.cursor)}`)).status, 409)
    const freshStream = await fetch(server.url + `/v1/threads/${large.threadId}/events?after=${encodeURIComponent(recoveredLarge.cursor)}`)
    assert.equal(freshStream.status, 200)
    const freshReader = freshStream.body.getReader()
    const afterLarge = (await submit(randomUUID(), 'reply', 'small follow-up', large.threadId)).data
    await sseUntil(freshReader, 'event: message-final')
    await freshReader.cancel()
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 6, 'post-resync execution')
    const postResyncHandle = adapter.handles[5]
    assert.equal(postResyncHandle.context.runId, afterLarge.runId)
    postResyncHandle.release({ kind: 'ended', attemptId: postResyncHandle.context.attemptId, confirmed: true })
  } finally {
    if (adapter) await adapter.close()
    if (dispatcher) await dispatcher.close()
    if (server) await server.close()
    if (runtime) await runtime.close()
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
  }
})

test('prequeued replies stay out of earlier execution context', { skip: noDatabase }, async () => {
  const database = `kipster_textcontext_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_text-context-'))
  let runtime, dispatcher, server, adapter
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    const ids = runtime.bootstrap
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    adapter = fixture()
    let releaseClaim, claimed
    const claimGate = new Promise(resolve => { releaseClaim = resolve })
    const claimSeen = new Promise(resolve => { claimed = resolve })
    let rootRunId
    dispatcher = new TextDispatcher(runtime, adapter, undefined, { afterClaim: async runId => { if (runId === rootRunId) { claimed(); await claimGate } } })
    server = await startTextServer(runtime, { installationId: ids.installationId, personId: ids.ownerId }, { host: '127.0.0.1', port: 0 })
    const post = async (path, data) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok); return response.json() }
    const context = { kind: 'installation', installationId: ids.installationId }
    const chat = await post('/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
    const submit = (text, threadId) => post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: threadId ? 'reply' : 'root', ...(threadId ? { threadId } : {}), parts: [{ kind: 'text', text }] })
    const root = await submit('root')
    rootRunId = root.runId
    const a = await submit('A', root.threadId)
    const b = await submit('B', root.threadId)
    await dispatcher.start()
    await claimSeen
    const c = await submit('C during preparation', root.threadId)
    releaseClaim()
    const expected = [
      [root.runId, ['root']],
      [a.runId, ['root', 'root answer', 'A']],
      [b.runId, ['root', 'root answer', 'A', 'A answer', 'B']],
      [c.runId, ['root', 'root answer', 'A', 'A answer', 'B', 'C during preparation']],
    ]
    for (let index = 0; index < expected.length; index++) {
      await waitFor(() => Promise.resolve(adapter.handles.length), n => n === index + 1, `context run ${index}`)
      const handle = adapter.handles[index]
      assert.equal(handle.context.runId, expected[index][0])
      assert.deepEqual(handle.context.input.map(x => x.text), expected[index][1])
      if (index < 2) handle.release({ kind: 'text', attemptId: handle.context.attemptId, messageId: `answer-${index}`, text: index === 0 ? 'root answer' : 'A answer', final: true })
      handle.release({ kind: 'ended', attemptId: handle.context.attemptId, confirmed: true })
    }
    await waitFor(() => runtime.db.query('SELECT count(*)::int AS n FROM kipster.text_runs WHERE state=$1', ['completed']).then(x => x.rows[0].n), n => n === 4, 'all queued replies')
    const generations = (await runtime.db.query('SELECT generation FROM kipster.work_intents ORDER BY created_at')).rows.map(x => Number(x.generation))
    assert.deepEqual(generations, [1,1,1,1])
  } finally {
    if (adapter) await adapter.close()
    if (dispatcher) await dispatcher.close()
    if (server) await server.close()
    if (runtime) await runtime.close()
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
  }
})

test('a kip segment with no content publishes no message, progress notes are marked, and replies name their run', { skip: noDatabase }, async () => {
  const database = `kipster_textempty_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_text-empty-'))
  let runtime, dispatcher, server, adapter
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    const ids = runtime.bootstrap
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    adapter = fixture()
    dispatcher = new TextDispatcher(runtime, adapter)
    server = await startTextServer(runtime, { installationId: ids.installationId, personId: ids.ownerId }, { host: '127.0.0.1', port: 0 })
    const post = async (path, data) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok); return response.json() }
    const get = async path => (await fetch(server.url + path)).json()
    const context = { kind: 'installation', installationId: ids.installationId }
    const chat = await post('/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
    const root = await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'book a table' }] })
    const before = await get(`/v1/threads/${root.threadId}/snapshot`)
    await dispatcher.start()
    await waitFor(() => Promise.resolve(adapter.handles.length), n => n === 1, 'dispatch')
    const handle = adapter.handles[0], attemptId = handle.context.attemptId
    handle.release({ kind: 'text', attemptId, messageId: 'opening', text: 'Opening the booking page.', final: true, phase: 'progress' })
    handle.release({ kind: 'text', attemptId, messageId: 'found', text: 'I found the restaurant.', final: true, phase: 'answer' })
    handle.release({ kind: 'text', attemptId, messageId: 'silent', text: '', final: true })
    handle.release({ kind: 'ended', attemptId, confirmed: true })
    await waitFor(() => runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [root.runId]).then(x => x.rows[0].state), state => state === 'completed', 'run completed')
    const snapshot = await get(`/v1/threads/${root.threadId}/snapshot`)
    assert.deepEqual(snapshot.messages.map(m => [m.authorId, m.runId, m.progress, m.parts]), [
      [ids.ownerId, undefined, undefined, [{ kind: 'text', text: 'book a table' }]],
      [ids.rootAgentId, root.runId, true, [{ kind: 'text', text: 'Opening the booking page.' }]],
      [ids.rootAgentId, root.runId, undefined, [{ kind: 'text', text: 'I found the restaurant.' }]],
    ])
    const { events } = await readEvents(runtime.db, { kind: 'thread', installationId: ids.installationId, callerId: ids.ownerId, threadId: root.threadId }, before.cursor)
    const published = events.filter(e => e.type === 'message-final' && e.data.authorId === ids.rootAgentId)
    assert.deepEqual(published.map(e => [e.data.runId, e.data.progress]), [[root.runId, true], [root.runId, undefined]])
    assert.equal(textEvent.parse(published[0]).data.progress, true)
  } finally {
    if (adapter) await adapter.close()
    if (dispatcher) await dispatcher.close()
    if (server) await server.close()
    if (runtime) await runtime.close()
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
  }
})

test('bounded shutdown fences silent provider and releases coordinator', { skip: noDatabase }, async () => {
  const database = `kipster_textclose_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_text-close-'))
  let runtime, peer, dispatcher, peerDispatcher, server
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    const ids = runtime.bootstrap
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'silent-adapter', modelId: 'model' })])
    let executeCount = 0
    const silent = { id: 'silent-adapter', version: '1', contractMajor: 1,
      async execute() { executeCount++; return { events: { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } }, async cancel() { return { acknowledged: true, confirmedEnded: false } }, async reconcile() { return 'unknown' } } },
      async close() { await new Promise(() => {}) } }
    dispatcher = new TextDispatcher(runtime, silent)
    server = await startTextServer(runtime, { installationId: ids.installationId, personId: ids.ownerId }, { host: '127.0.0.1', port: 0 })
    const post = async (path, data) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok); return response.json() }
    const context = { kind: 'installation', installationId: ids.installationId }
    const chat = await post('/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
    await dispatcher.start()
    const receipt = await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'silent' }] })
    await waitFor(() => Promise.resolve(executeCount), n => n === 1, 'silent provider dispatch')
    const snap = await (await fetch(server.url + `/v1/threads/${receipt.threadId}/snapshot`)).json()
    const sse = await fetch(server.url + `/v1/threads/${receipt.threadId}/events?after=${encodeURIComponent(snap.cursor)}`)
    const reader = sse.body.getReader()
    const serverClose = server.close(); server = null
    const ended = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE close timed out')), 1000))])
    assert.equal(ended.done, true)
    await serverClose
    const started = Date.now()
    await dispatcher.close()
    assert.ok(Date.now() - started < 5500)
    assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [receipt.runId])).rows[0].state, 'recovery-needed')
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n, 1)
    peer = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
    peerDispatcher = new TextDispatcher(peer, { id: 'silent-adapter', version: '1', contractMajor: 1, async execute() { throw new Error('must not re-execute') }, async close() {} })
    await peerDispatcher.start()
    assert.equal((await peer.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [receipt.runId])).rows[0].state, 'recovery-needed')
    assert.equal(executeCount, 1)
  } finally {
    if (peerDispatcher) await peerDispatcher.close()
    if (peer) await peer.close()
    if (server) await server.close()
    if (dispatcher) await dispatcher.close()
    if (runtime) await runtime.close()
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
  }
})
