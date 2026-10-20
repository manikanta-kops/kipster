import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { appSnapshot } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// A kip reaches the person only with message_user (decision record 12), driven by the deterministic fixture adapter
// through the Core tool host against real PostgreSQL.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

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
  const name = `kipster_message_user_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-message-user-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names, executionLimit: 6 })
  closers.push(() => runtime.close())
  const { installationId, ownerId, rootAgentId } = runtime.bootstrap
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  closers.push(() => server.close())
  await dispatcher.start()
  const ok = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const data = await response.json()
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(data)}`)
    return data
  }
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  const context = { kind: 'installation', installationId }
  const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context, agentId: rootAgentId })
  const execution = (runId, index = 0) => until(() => executions.filter(entry => entry.context.runId === runId)[index], Boolean, `execution ${index} of ${runId}`)
  const db = runtime.db
  return {
    db, ok, rootAgentId,
    /** A new turn from the person; returns its running execution with a tool caller. */
    async start(text) {
      const accepted = await ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
      return this.run(accepted.runId, accepted.threadId)
    },
    async run(runId, threadId, index = 0) {
      const found = await execution(runId, index)
      return {
        ...found, runId, threadId,
        tool: (callId, toolName, args) => found.handle.callTool(callId, toolName, args),
        end: () => found.handle.release({ kind: 'ended', attemptId: found.context.attemptId, confirmed: true }),
      }
    },
    state: runId => until(async () => (await db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0].state, state => !['queued', 'preparing', 'running'].includes(state), `settled run ${runId}`),
    messages: async threadId => (await db.query('SELECT id,author_id,parts FROM kipster.messages WHERE thread_id=$1 ORDER BY position', [threadId])).rows,
    notifications: async () => (await db.query('SELECT kind,run_id,message_id,interaction_id FROM kipster.notifications ORDER BY created_at,id')).rows,
    app: async () => appSnapshot.parse(await ok('GET', '/v1/app/snapshot')),
    answer: (run, interactionId, answer) => ok('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId, threadId: run.threadId, runId: run.runId, attemptId: run.context.attemptId, answer }),
  }
}

test('message_user is the only way to the person: attachments keep their order and only normal messages notify', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start('Send me the report')
  await writeFile(join(run.context.workingDirectory, 'report.txt'), 'Quarterly numbers')
  const doc = await run.tool('doc-1', 'create_rich_doc', { title: 'Plan', markdown: '# Plan\n\nNext steps.' })
  assert.deepEqual(Object.keys(doc).sort(), ['documentId', 'revision'])
  const agentMessages = async () => (await ctx.messages(run.threadId)).filter(message => message.author_id === ctx.rootAgentId)
  assert.deepEqual(await agentMessages(), [], 'creating a doc posts nothing')

  // A provider's own text is never shown.
  run.handle.release({ kind: 'text', attemptId: run.context.attemptId, messageId: 'native-1', text: 'Thinking out loud', final: false })
  run.handle.release({ kind: 'text', attemptId: run.context.attemptId, messageId: 'native-1', text: 'My final answer', final: true })

  const silent = await run.tool('progress-1', 'message_user', { text: 'Working on it', priority: 'silent' })
  assert.equal(silent.status, 'sent')
  const args = { text: 'Here is the report', priority: 'normal', attachments: [{ path: 'report.txt' }, { documentId: doc.documentId }] }
  const sent = await run.tool('report-1', 'message_user', args)
  assert.equal(sent.status, 'sent')
  assert.equal(sent.files.length, 1)
  const fileId = sent.files[0].artifactId
  assert.deepEqual(await run.tool('report-1', 'message_user', args), sent, 'a repeated call ID returns the first result')
  await assert.rejects(run.tool('report-1', 'message_user', { ...args, text: 'Another report' }), /already sent a different message/)
  const again = await run.tool('again-1', 'message_user', { priority: 'normal', attachments: [{ documentId: doc.documentId }, { artifactId: fileId }] })
  await assert.rejects(run.tool('missing-1', 'message_user', { text: 'Gone', priority: 'normal', attachments: [{ documentId: randomUUID() }] }), /Document not found/)
  await assert.rejects(run.tool('empty-1', 'message_user', { priority: 'normal' }), /needs text, an attachment or an element/)

  const shown = await agentMessages()
  assert.deepEqual(shown.map(message => message.parts), [
    [{ kind: 'text', text: 'Working on it' }],
    [{ kind: 'text', text: 'Here is the report' }, { kind: 'file', artifactId: fileId, purpose: 'attachment' }, { kind: 'document', documentId: doc.documentId, revision: 1 }],
    [{ kind: 'document', documentId: doc.documentId, revision: 1 }, { kind: 'file', artifactId: fileId, purpose: 'attachment' }],
  ])
  assert.deepEqual(shown.slice(1).map(message => message.id), [sent.messageId, again.messageId])
  assert.deepEqual((await ctx.db.query('SELECT message_id,ordinal FROM kipster.message_artifacts WHERE artifact_id=$1 ORDER BY ordinal', [fileId])).rows, [{ message_id: sent.messageId, ordinal: 1 }, { message_id: again.messageId, ordinal: 1 }])

  run.end()
  assert.equal(await ctx.state(run.runId), 'completed')
  // Each normal message notifies once; the silent one and the finished turn notify nobody.
  assert.deepEqual((await ctx.notifications()).map(row => [row.kind, row.message_id]), [['message', sent.messageId], ['message', again.messageId]])
  const notices = (await ctx.app()).notifications
  assert.deepEqual(notices.map(notice => [notice.kind, notice.messageId, notice.preview]), [['message', sent.messageId, 'Here is the report'], ['message', again.messageId, undefined]])
  assert.ok(!(await ctx.messages(run.threadId)).some(message => JSON.stringify(message.parts).includes('final answer')))
})

test('an element waits for the answer: a normal one notifies of the element only, a silent one nobody', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start('Pick a color with me')
  // Kips ask with message_user; the old tools are only an adapter's way to show a provider's own question.
  await assert.rejects(run.tool('old-1', 'ask_user_question', { prompt: 'Color?', options: [{ id: 'blue', label: 'Blue' }], freeText: false }), /Unsupported Kipster tool/)
  await assert.rejects(run.tool('bad-1', 'message_user', { text: 'Pick', priority: 'normal', element: { type: 'choice', prompt: 'Color?' } }), /Question needs a choice or free text/)
  assert.deepEqual(await ctx.messages(run.threadId).then(rows => rows.filter(row => row.author_id === ctx.rootAgentId)), [], 'an invalid element posts nothing')

  const asked = await run.tool('ask-1', 'message_user', { text: 'Two options left.', priority: 'normal', element: { type: 'choice', prompt: 'Color?', options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }] } })
  assert.equal(asked.status, 'pending')
  assert.ok(asked.messageId && asked.interactionId)
  assert.deepEqual(await run.tool('ask-1', 'message_user', { text: 'Two options left.', priority: 'normal', element: { type: 'choice', prompt: 'Color?', options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }] } }), asked)
  run.end()
  assert.equal(await ctx.state(run.runId), 'waiting', 'the run waits once the provider turn ends')
  assert.deepEqual((await ctx.notifications()).map(row => [row.kind, row.interaction_id]), [['interaction', asked.interactionId]])

  await ctx.answer(run, asked.interactionId, { kind: 'choice', optionId: 'red' })
  const resumed = await ctx.run(run.runId, run.threadId, 1)
  assert.equal(resumed.context.continuation.answer.optionId, 'red')
  assert.equal(resumed.context.interactions[0].prompt, 'Color?')

  const quiet = await resumed.tool('ask-2', 'message_user', { priority: 'silent', element: { type: 'approval', prompt: 'Paint it red?', proposalId: 'paint-red', proposal: 'Paint the fence red.' } })
  assert.equal(quiet.status, 'pending')
  assert.equal(quiet.messageId, undefined, 'an element alone posts no message')
  resumed.end()
  assert.equal(await ctx.state(run.runId), 'waiting')
  assert.deepEqual((await ctx.notifications()).map(row => row.kind), ['interaction'], 'a silent element notifies nobody')
})

test('a failed turn still notifies though it sent nothing', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const run = await ctx.start('Try something')
  run.handle.release({ kind: 'failed', attemptId: run.context.attemptId, confirmedEnded: true, message: 'Provider broke' })
  assert.equal(await ctx.state(run.runId), 'failed')
  assert.deepEqual((await ctx.notifications()).map(row => row.kind), ['failed'])
  assert.equal((await ctx.app()).notifications[0].preview, 'Provider broke')
})
