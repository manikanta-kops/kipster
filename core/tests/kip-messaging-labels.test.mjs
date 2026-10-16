import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { textPublicationHost } from '../dist/workflows/text-dispatch.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const fixtureSettings = { adapterId: 'kip-fixture', modelId: 'fixture' }
async function until(read, match, label) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error(`Timed out: ${label}`)
}
/** A provider whose turns the test drives: each execution is recorded with a handle to emit its events. */
function adapter() {
  const executions = []
  return {
    id: 'kip-fixture', version: '1', contractMajor: 1, executions,
    async execute(context) {
      const queued = []; let wake, closed = false
      const handle = {
        events: { async *[Symbol.asyncIterator]() { while (!closed || queued.length) { const next = queued.shift() ?? await new Promise(resolve => wake = resolve); if (next) yield next } } },
        emit(event) { const full = { attemptId: context.attemptId, ...event }; if (wake) { const resolve = wake; wake = undefined; resolve(full) } else queued.push(full); if (['ended', 'failed'].includes(event.kind)) closed = true },
        async cancel() { return { acknowledged: true, confirmedEnded: false } }, async reconcile() { return 'unknown' },
      }
      executions.push({ context, handle })
      return handle
    },
    async close() { for (const { handle } of executions) handle.emit({ kind: 'failed', confirmedEnded: false, message: 'closed' }) },
  }
}

/** Planner works in Playground, Writer in Playground and Studio; John is the admin kip. */
async function environment() {
  const database = `kipsterlabels_${randomUUID().replaceAll('-', '')}`, admin = new Postgres(adminUrl), url = new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-labels-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Factory Owner', organization: 'Playground', rootAgent: 'John' }, executionLimit: 8 })
  const fixture = adapter(), dispatcher = new TextDispatcher(runtime, fixture)
  const server = await startTextServer(runtime, { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  const e = { runtime, db: runtime.db, fixture, host: textPublicationHost(dispatcher), john: runtime.bootstrap.rootAgentId, playground: runtime.bootstrap.organizationId, ownerId: runtime.bootstrap.ownerId, seen: new Set() }
  const scope = { installationId: runtime.bootstrap.installationId, callerId: e.ownerId }
  e.close = async () => {
    await dispatcher.close().catch(() => undefined); await server.close().catch(() => undefined); await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined); await admin.close(); await rm(home, { recursive: true, force: true })
  }
  e.ok = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const data = await response.json()
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${JSON.stringify(data)}`)
    return data
  }
  await dispatcher.start()
  e.studio = (await e.ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name: 'Studio' })).organization.id
  for (const organization of [e.playground, e.studio]) await e.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1', [organization, JSON.stringify(fixtureSettings)])
  await e.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [e.john, JSON.stringify(fixtureSettings)])
  const create = async (name, organizationId) => (await e.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId })).agent.id
  e.planner = await create('Planner', e.playground)
  e.writer = await create('Writer', e.playground)
  await e.ok('POST', `/v1/organizations/${e.studio}/memberships`, { version: 1, operationId: randomUUID(), agentId: e.writer })
  /** The person writes to a kip: a new thread, or a reply in `threadId`. */
  e.say = async (agentId, text, { threadId, chatId } = {}) => {
    const context = agentId === e.john ? { kind: 'installation', installationId: scope.installationId } : { kind: 'organization', organizationId: e.playground }
    chatId ??= (await e.ok('POST', '/v1/direct-chats', { version: 1, context, agentId })).chatId
    return e.ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope, target: { context, chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] })
  }
  /** The turn of a run, once the provider receives it. */
  e.run = async runId => {
    const found = await until(() => e.fixture.executions.find(item => !e.seen.has(item.context.attemptId) && item.context.runId === runId), Boolean, `run ${runId}`)
    e.seen.add(found.context.attemptId)
    const { context, handle } = found
    return {
      context, current: context.input.find(message => message.messageId === context.triggerMessageId),
      send: (recipientId, text) => e.host.invokeTool({ attemptId: context.attemptId, callId: randomUUID(), name: 'message_kip', arguments: { recipientId, text } }),
      end: text => { if (text !== undefined) handle.emit({ kind: 'text', messageId: `reply-${randomUUID()}`, text, final: true }); handle.emit({ kind: 'ended', confirmed: true }) },
    }
  }
  e.runs = async (threadId, trigger) => (await e.db.query('SELECT id,input_message_id FROM kipster.text_runs WHERE thread_id=$1 AND trigger_kind=$2 ORDER BY queue_position', [threadId, trigger])).rows
  e.nextRun = (threadId, trigger, count = 1) => until(() => e.runs(threadId, trigger), runs => runs.length >= count, `${trigger} run ${count} in ${threadId}`).then(runs => runs[count - 1])
  e.settled = runId => until(async () => (await e.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]?.state, state => state === 'completed', `run ${runId} completed`)
  return e
}
const scenario = (name, body) => test(name, { skip: noDatabase, timeout: 60000 }, async () => {
  const e = await environment()
  try { await body(e) } finally { await e.close() }
})
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

scenario('the recipient\'s prompt names the sending kip and that the answer goes back; the woken sender\'s names the answering kip', async e => {
  const asked = await e.say(e.john, 'Ask Planner which launch date the team agreed on.')
  const john = await e.run(asked.runId)
  const owner = { kind: 'person', id: e.ownerId, name: 'Factory Owner' }
  assert.deepEqual(john.current.author, owner)
  assert.match(john.context.prompt, new RegExp(`^Current message \\[${asked.messageId}\\] from Factory Owner \\(the person\\):\\nAsk Planner`, 'm'))
  const sent = await john.send(e.planner, 'Which launch date did the team agree on?')
  assert.equal(sent.status, 'sent')
  john.end()
  await e.settled(asked.runId)

  const kipRun = await e.nextRun(sent.threadId, 'kip')
  const planner = await e.run(kipRun.id)
  assert.deepEqual(planner.current.author, { kind: 'admin-kip', id: e.john, name: 'John' })
  assert.ok(planner.context.prompt.endsWith(`Current message [${kipRun.input_message_id}], a message from John (admin kip) sent to you with message_kip. Your final reply is your answer and goes back to John automatically:\nWhich launch date did the team agree on?`), planner.context.prompt)
  planner.end('The team agreed on March 3.')
  await e.settled(kipRun.id)

  const answerRun = await e.nextRun(asked.threadId, 'answer')
  const woken = await e.run(answerRun.id)
  const plannerAuthor = { kind: 'kip', id: e.planner, name: 'Planner', workspaces: ['Playground'] }
  assert.deepEqual(woken.current.author, plannerAuthor)
  assert.equal(woken.current.kipAnswer, true)
  const sentInput = woken.context.input.find(message => message.messageId === sent.messageId)
  assert.deepEqual([sentInput.author, sentInput.kipMessageTo, sentInput.kipAnswer], [{ kind: 'admin-kip', id: e.john, name: 'John' }, plannerAuthor, undefined])
  assert.deepEqual(woken.context.input.find(message => message.messageId === asked.messageId).author, owner)
  const prompt = woken.context.prompt
  assert.match(prompt, new RegExp(`^\\[${asked.messageId}\\] Factory Owner \\(the person\\): Ask Planner which launch date the team agreed on\\.$`, 'm'))
  assert.match(prompt, new RegExp(`^\\[${sent.messageId}\\] John \\(admin kip\\), message sent with message_kip to Planner \\(kip in Playground\\): Which launch date did the team agree on\\?$`, 'm'))
  assert.match(prompt, new RegExp(`^${escape(`Current message [${answerRun.input_message_id}], an answer from Planner (kip in Playground) to your earlier message_kip message. Reply to the person in this thread, not to Planner, and never send anything back on your own; to talk back, send a new message_kip. If the answer needs nothing more, end your turn with an empty reply:`)}\\nThe team agreed on March 3\\.$`, 'm'))
  woken.end()
  await e.settled(answerRun.id)
  // A later turn's history says which kip the answer came from.
  const later = await e.say(e.john, 'Thanks.', { threadId: asked.threadId, chatId: asked.chatId })
  const after = await e.run(later.runId)
  assert.match(after.context.prompt, new RegExp(`^\\[${answerRun.input_message_id}\\] Planner \\(kip in Playground\\), answering a message_kip message sent to it from this thread: The team agreed on March 3\\.$`, 'm'))
  after.end('You are welcome.')
  await e.settled(later.runId)

  // The person writing in the linked thread is the person; the kip's earlier exchange keeps its authors.
  const stepIn = await e.say(e.planner, 'Also check the venue.', { threadId: sent.threadId, chatId: sent.chatId })
  const personTurn = await e.run(stepIn.runId)
  assert.deepEqual(personTurn.current.author, owner)
  assert.ok(personTurn.context.prompt.endsWith(`Current message [${stepIn.messageId}] from Factory Owner (the person):\nAlso check the venue.`))
  assert.match(personTurn.context.prompt, new RegExp(`^\\[${kipRun.input_message_id}\\] John \\(admin kip\\): Which launch date`, 'm'))
  assert.match(personTurn.context.prompt, /^\[[^\]]+\] Planner \(kip in Playground\): The team agreed on March 3\.$/m)
  personTurn.end('Checking.')
  await e.settled(stepIn.runId)
})

scenario('a workspace kip messages a kip of two workspaces, and each prompt names the other kip with its workspaces', async e => {
  const asked = await e.say(e.planner, 'Ask Writer for a tagline.')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.writer, 'A tagline for the launch, please.')
  assert.equal(sent.status, 'sent')
  planner.end()
  await e.settled(asked.runId)

  const kipRun = await e.nextRun(sent.threadId, 'kip')
  const writer = await e.run(kipRun.id)
  assert.deepEqual(writer.current.author, { kind: 'kip', id: e.planner, name: 'Planner', workspaces: ['Playground'] })
  assert.match(writer.context.prompt, /a message from Planner \(kip in Playground\) sent to you with message_kip\. Your final reply is your answer and goes back to Planner automatically:\nA tagline for the launch, please\.$/)
  writer.end('Launch day, every day.')
  await e.settled(kipRun.id)

  const answerRun = await e.nextRun(asked.threadId, 'answer')
  const woken = await e.run(answerRun.id)
  assert.deepEqual(woken.current.author, { kind: 'kip', id: e.writer, name: 'Writer', workspaces: ['Playground', 'Studio'] })
  assert.match(woken.context.prompt, new RegExp(`^\\[${sent.messageId}\\] Planner \\(kip in Playground\\), message sent with message_kip to Writer \\(kip in Playground and Studio\\): A tagline`, 'm'))
  assert.match(woken.context.prompt, /an answer from Writer \(kip in Playground and Studio\) to your earlier message_kip message\. Reply to the person in this thread, not to Writer,[^\n]*\nLaunch day, every day\.$/)
  woken.end()
  await e.settled(answerRun.id)
})
