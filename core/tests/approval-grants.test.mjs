import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { permissionSettings, threadSnapshot } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'

async function until(read, predicate, label) { for (let i = 0; i < 150; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)) } throw new Error(`Timed out: ${label}`) }
function fixture() {
  const handles = [], contexts = []
  return { id: 'test-adapter', version: '1', contractMajor: 1, handles, contexts,
    async execute(context) {
      contexts.push(context)
      const events = []; let wake, closed = false
      const handle = { context, events: { async *[Symbol.asyncIterator]() { while (!closed || events.length) { const value = events.shift() ?? await new Promise(resolve => wake = resolve); if (value) yield value } } },
        emit(event) { if (wake) { const resolve = wake; wake = undefined; resolve(event) } else events.push(event); if (['ended', 'failed'].includes(event.kind)) closed = true },
        async cancel() { return { acknowledged: true, confirmedEnded: false } }, async reconcile() { return 'unknown' } }
      handles.push(handle)
      return handle
    },
    async close() { for (const h of handles) h.emit({ kind: 'failed', attemptId: h.context?.attemptId, confirmedEnded: false, message: 'closed' }) } }
}

test('approval grants cover the conversation or every kip, reach executions and can be removed', { skip: noDatabase }, async () => {
  const database = `kipster_grants_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl); await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-grants-'))
  let runtime, dispatcher, server
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, executionLimit: 1 })
    const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    const adapter = fixture(); dispatcher = new TextDispatcher(runtime, adapter)
    const host = textPublicationHost(dispatcher)
    server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
    await dispatcher.start()
    const call = async (method, path, data) => { const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }); return { status: response.status, data: await response.json() } }
    const context = { kind: 'installation', installationId: actor.installationId }
    const chat = (await call('POST', '/v1/direct-chats', { version: 1, context, agentId: runtime.bootstrap.rootAgentId })).data.chatId
    const submit = async text => (await call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId: chat }, mode: 'root', parts: [{ kind: 'text', text }] })).data
    const card = (key, scopes = ['conversation', 'always']) => ({ prompt: 'Allow Computer Use to use "Arc"?', proposalId: `p-${randomUUID()}`, proposal: 'get_app_state Arc', grant: { key, label: 'Computer Use in Arc', scopes } })
    const answer = (asked, attemptId, threadId, runId, value) => call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: asked.interactionId, threadId, runId, attemptId, proposalId: asked.proposalId, answer: value })

    const first = await submit('Book a table')
    await until(() => adapter.contexts.length, n => n === 1, 'first execution')
    assert.deepEqual(adapter.contexts[0].approvalGrants, [])
    const attempt = adapter.contexts[0].attemptId
    await assert.rejects(host.invokeTool({ attemptId: attempt, callId: 'tool-1', name: 'interactions_request_approval', arguments: card('test:arc') }), /Invalid interaction fields/, 'a kip cannot offer itself a grant')
    await assert.rejects(host.invokeTool({ attemptId: attempt, callId: 'native:bad', name: 'interactions_request_approval', arguments: card('test:arc', ['forever']) }), /Invalid approval grant/)
    const arguments_ = card('test:arc', ['conversation'])
    const asked = { ...await host.invokeTool({ attemptId: attempt, callId: 'native:1', name: 'interactions_request_approval', arguments: arguments_ }), proposalId: arguments_.proposalId }
    adapter.handles[0].emit({ kind: 'ended', attemptId: attempt, confirmed: true })
    await until(async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [first.runId])).rows[0]?.state, x => x === 'waiting', 'waiting')
    const page = threadSnapshot.parse(await (await fetch(`${server.url}/v1/threads/${first.threadId}/snapshot`)).json())
    assert.deepEqual(page.interactions[0].grant, { label: 'Computer Use in Arc', scopes: ['conversation'] }, 'the key stays in Core')
    assert.equal((await answer(asked, attempt, first.threadId, first.runId, { kind: 'approve', scope: 'always' })).data.outcome, 'rejected', 'only offered scopes')
    const accepted = await answer(asked, attempt, first.threadId, first.runId, { kind: 'approve', scope: 'conversation' })
    assert.equal(accepted.data.outcome, 'accepted')
    assert.equal(accepted.data.interaction.response.answer.scope, 'conversation')
    await until(() => adapter.contexts.length, n => n === 2, 'continuation')
    assert.deepEqual(adapter.contexts[1].approvalGrants, ['test:arc'])
    adapter.handles[1].emit({ kind: 'ended', attemptId: adapter.contexts[1].attemptId, confirmed: true })
    await until(async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [first.runId])).rows[0]?.state, x => x === 'completed', 'first completed')
    assert.deepEqual((await call('GET', '/v1/settings/permissions')).data.alwaysAllowed, [], 'a conversation grant is not listed in Settings')

    const otherChat = (await call('POST', '/v1/direct-chats', { version: 1, context, agentId: runtime.bootstrap.rootAgentId })).data.chatId
    const elsewhere = (await call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId: otherChat }, mode: 'root', parts: [{ kind: 'text', text: 'Open Chrome' }] })).data
    await until(() => adapter.contexts.length, n => n === 3, 'other conversation')
    assert.notEqual(elsewhere.threadId, first.threadId)
    assert.deepEqual(adapter.contexts[2].approvalGrants, [], 'a conversation grant stays in its conversation')
    const chrome = card('test:chrome')
    const askedChrome = { ...await host.invokeTool({ attemptId: adapter.contexts[2].attemptId, callId: 'native:2', name: 'interactions_request_approval', arguments: chrome }), proposalId: chrome.proposalId }
    adapter.handles[2].emit({ kind: 'ended', attemptId: adapter.contexts[2].attemptId, confirmed: true })
    await until(async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [elsewhere.runId])).rows[0]?.state, x => x === 'waiting', 'waiting on Chrome')
    const before = permissionSettings.parse((await call('GET', '/v1/settings/permissions')).data).revision
    assert.equal((await answer(askedChrome, adapter.contexts[2].attemptId, elsewhere.threadId, elsewhere.runId, { kind: 'approve', scope: 'always' })).data.outcome, 'accepted')
    const settings = permissionSettings.parse((await call('GET', '/v1/settings/permissions')).data)
    assert.equal(settings.revision, before + 1)
    assert.deepEqual(settings.alwaysAllowed.map(item => item.label), ['Computer Use in Arc'])
    await until(() => adapter.contexts.length, n => n === 4, 'Chrome continuation')
    assert.deepEqual(adapter.contexts[3].approvalGrants, ['test:chrome'])
    adapter.handles[3].emit({ kind: 'ended', attemptId: adapter.contexts[3].attemptId, confirmed: true })

    await submit('A new conversation')
    await until(() => adapter.contexts.length, n => n === 5, 'new conversation')
    assert.deepEqual(adapter.contexts[4].approvalGrants, ['test:chrome'], 'always grants reach every conversation; conversation grants do not')
    adapter.handles[4].emit({ kind: 'ended', attemptId: adapter.contexts[4].attemptId, confirmed: true })

    assert.equal((await call('PUT', '/v1/settings/permissions', { version: 1 })).status, 400)
    const removed = await call('PUT', '/v1/settings/permissions', { version: 1, removeAlwaysAllowed: [settings.alwaysAllowed[0].id, 'not-an-id'] })
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.data.alwaysAllowed, [])
    assert.equal(removed.data.revision, settings.revision + 1)
    assert.equal(removed.data.mode, 'auto')
    const events = (await runtime.db.query("SELECT data FROM kipster.app_events WHERE type='permissions-changed' ORDER BY position")).rows.map(row => row.data.alwaysAllowed.length)
    assert.deepEqual(events, [1, 0])
  } finally { await server?.close(); await dispatcher?.close(); await runtime?.close(); await rm(home, { recursive: true, force: true }); await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.close() }
})
