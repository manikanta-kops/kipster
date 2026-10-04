import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
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

test('a continuation after an answered wait reopens the previous provider session; a first attempt and a Retry do not', { skip: noDatabase }, async () => {
  const database = `kipster_resume_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl); await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-resume-'))
  let runtime, dispatcher, server
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, executionLimit: 1 })
    const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'test-adapter', modelId: 'test-model' })])
    const adapter = fixture(); dispatcher = new TextDispatcher(runtime, adapter)
    server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
    await dispatcher.start()
    const post = async (path, data) => { const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); return { status: response.status, data: await response.json() } }
    const context = { kind: 'installation', installationId: actor.installationId }
    const chat = (await post('/v1/direct-chats', { version: 1, context, agentId: runtime.bootstrap.rootAgentId })).data.chatId
    const run = (await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId: chat }, mode: 'root', parts: [{ kind: 'text', text: 'Book a table' }] })).data
    const state = async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [run.runId])).rows[0]?.state
    const provider = async index => {
      adapter.handles[index].emit({ kind: 'provider', attemptId: adapter.contexts[index].attemptId, threadId: 'provider-thread', providerStateScope: 'test-scope', processId: 4242, workingDirectory: home, modelId: 'test-model' })
      await until(async () => (await runtime.db.query('SELECT provider_metadata FROM kipster.attempts WHERE id=$1', [adapter.contexts[index].attemptId])).rows[0].provider_metadata.threadId, id => id === 'provider-thread', 'provider recorded')
    }
    await until(() => adapter.contexts.length, n => n === 1, 'first attempt')
    assert.equal(adapter.contexts[0].resume, undefined, 'a first attempt starts fresh')
    await provider(0)
    const card = await dispatcher.askToolInteraction(adapter.contexts[0].attemptId, 'native:1', { kind: 'approval', prompt: 'Allow Computer Use to use "Arc"?', proposalId: 'p1', proposal: '{"app":"Arc"}' })
    adapter.handles[0].emit({ kind: 'ended', attemptId: adapter.contexts[0].attemptId, confirmed: true })
    await until(state, x => x === 'waiting', 'waiting')
    assert.equal((await post('/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.interactionId, threadId: run.threadId, runId: run.runId, attemptId: adapter.contexts[0].attemptId, proposalId: 'p1', answer: { kind: 'approve' } })).data.outcome, 'accepted')
    await until(() => adapter.contexts.length, n => n === 2, 'continuation')
    const continued = adapter.contexts[1]
    assert.equal(continued.resume.threadId, 'provider-thread')
    assert.equal(continued.resume.providerStateScope, 'test-scope')
    assert.match(continued.resume.prompt, /^Kipster stopped you while you waited/)
    assert.match(continued.resume.prompt, /Allow Computer Use to use \\"Arc\\"\?/)
    assert.doesNotMatch(continued.resume.prompt, /Book a table/, 'the reopened session already holds the conversation')
    assert.match(continued.prompt, /Book a table/, 'the full prompt stays for an adapter that cannot reopen the session')

    await provider(1)
    await dispatcher.askToolInteraction(continued.attemptId, 'native:2', { kind: 'approval', prompt: 'Allow Computer Use to use "Chrome"?', proposalId: 'p2', proposal: '{"app":"Chrome"}' })
    adapter.handles[1].emit({ kind: 'failed', attemptId: continued.attemptId, confirmedEnded: true, message: 'provider crashed' })
    await until(state, x => x === 'failed', 'failed')
    const retried = await post('/v1/work/controls', { version: 1, operationId: randomUUID(), context, chatId: chat, threadId: run.threadId, runId: run.runId, attemptId: continued.attemptId, action: 'retry' })
    assert.equal(retried.data.outcome, 'accepted')
    await until(() => adapter.contexts.length, n => n === 3, 'Retry')
    assert.equal(adapter.contexts[2].resume, undefined, 'Retry after a failure starts fresh')
    adapter.handles[2].emit({ kind: 'ended', attemptId: adapter.contexts[2].attemptId, confirmed: true })
    await until(state, x => x === 'completed', 'completed')
  } finally { await server?.close(); await dispatcher?.close(); await runtime?.close(); await rm(home, { recursive: true, force: true }); await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.close() }
})
