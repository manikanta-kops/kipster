import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { textPublicationHost } from '../dist/workflows/text-dispatch.js'
import { appSnapshot, appThreadSummary, threadSnapshot, textEvent } from '../dist/protocol/index.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
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

/** Planner, Researcher and Writer work in Playground, Scout in Studio, and Writer in Studio too. John is the admin kip. */
async function environment({ limit = 8, memory = false } = {}) {
  const database = `kipstermessage_${randomUUID().replaceAll('-', '')}`, admin = new Postgres(adminUrl), url = new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-message-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Playground', rootAgent: 'John' }, executionLimit: limit })
  const fixture = adapter(), dispatcher = new TextDispatcher(runtime, fixture)
  const server = await startTextServer(runtime, { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  const e = { runtime, db: runtime.db, fixture, dispatcher, server, host: textPublicationHost(dispatcher), john: runtime.bootstrap.rootAgentId, playground: runtime.bootstrap.organizationId,
    installationId: runtime.bootstrap.installationId, ownerId: runtime.bootstrap.ownerId, seen: new Set() }
  e.scope = { installationId: e.installationId, callerId: e.ownerId }
  e.actor = { installationId: e.installationId, personId: e.ownerId }
  e.close = async () => {
    await dispatcher.close().catch(() => undefined); await server.close().catch(() => undefined); await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined); await admin.close(); await rm(home, { recursive: true, force: true })
  }
  e.call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const text = await response.text()
    return { status: response.status, data: text && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : text }
  }
  e.ok = async (method, path, body) => { const response = await e.call(method, path, body); assert.ok([200, 202].includes(response.status), `${method} ${path}: ${JSON.stringify(response.data)}`); return response.data }
  await dispatcher.start()
  e.studio = (await e.ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name: 'Studio' })).organization.id
  for (const organization of [e.playground, e.studio]) await e.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1', [organization, JSON.stringify(fixtureSettings)])
  await e.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [e.john, JSON.stringify(fixtureSettings)])
  const create = async (name, organizationId) => (await e.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId })).agent.id
  e.planner = await create('Planner', e.playground)
  e.researcher = await create('Researcher', e.playground)
  e.writer = await create('Writer', e.playground)
  e.scout = await create('Scout', e.studio)
  await e.ok('POST', `/v1/organizations/${e.studio}/memberships`, { version: 1, operationId: randomUUID(), agentId: e.writer })
  await runtime.learning.setInstallation(e.actor, { enabled: !!memory })
  e.installation = { kind: 'installation', installationId: e.installationId }
  e.in = organizationId => ({ kind: 'organization', organizationId })
  e.contextOf = agentId => agentId === e.john ? e.installation : agentId === e.scout ? e.in(e.studio) : e.in(e.playground)
  e.chat = async (agentId, context = e.contextOf(agentId)) => (await e.ok('POST', '/v1/direct-chats', { version: 1, context, agentId })).chatId
  /** The person writes to a kip: a new thread, or a reply in `threadId`. */
  e.say = async (agentId, text, { threadId, context = e.contextOf(agentId), chatId } = {}) => {
    chatId ??= await e.chat(agentId, context)
    return e.ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: e.scope, target: { context, chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] })
  }
  /** The next execution matching `match` that the test has not driven yet. */
  e.turn = async (match, label = 'turn') => {
    const found = await until(() => e.fixture.executions.find(item => !e.seen.has(item.context.attemptId) && match(item.context)), Boolean, label)
    e.seen.add(found.context.attemptId)
    const { context, handle } = found
    // A turn a kip's message started answers that kip; any other turn tells the person.
    const current = context.input.find(message => message.messageId === context.triggerMessageId)
    const asker = current && current.author.kind !== 'person' && !current.kipAnswer ? current.author.id : undefined
    const call = (name, args, callId = randomUUID()) => e.host.invokeTool({ attemptId: context.attemptId, callId, name, arguments: args })
    const send = (recipientId, text, extra = {}, callId = randomUUID()) => call('message_kip', { recipientId, text, ...extra }, callId)
    const reply = (text, priority = 'normal') => call('message_user', { text, priority })
    return {
      context, handle, attemptId: context.attemptId, runId: context.runId, call, send, reply,
      end: async text => { if (text !== undefined) await (asker ? send(asker, text) : reply(text)); handle.emit({ kind: 'ended', confirmed: true }) },
      fail: message => handle.emit({ kind: 'failed', confirmedEnded: true, message }),
    }
  }
  e.run = runId => e.turn(context => context.runId === runId, `run ${runId}`)
  e.state = async runId => (await e.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]?.state
  e.settled = (runId, state) => until(() => e.state(runId), value => value === state, `run ${runId} ${state}`)
  e.runs = async threadId => (await e.db.query('SELECT id,state,trigger_kind,chain_root_id,chain_depth,responsible_person_id,input_message_id,queue_position FROM kipster.text_runs WHERE thread_id=$1 ORDER BY queue_position', [threadId])).rows
  e.messages = async threadId => (await e.db.query('SELECT id,author_id,parts,position FROM kipster.messages WHERE thread_id=$1 ORDER BY position', [threadId])).rows
  e.answers = async threadId => (await e.messages(threadId)).filter(message => message.parts.some(part => part.kind === 'kip-answer'))
  /** The run of the latest answer posted into `threadId`. */
  e.answerRun = (threadId, count = 1) => until(async () => (await e.runs(threadId)).filter(run => run.trigger_kind === 'answer'), runs => runs.length >= count, `answer ${count} in ${threadId}`).then(runs => runs[count - 1])
  e.kipRun = (threadId, count = 1) => until(async () => (await e.runs(threadId)).filter(run => run.trigger_kind === 'kip'), runs => runs.length >= count, `kip run ${count} in ${threadId}`).then(runs => runs[count - 1])
  e.snapshot = async threadId => threadSnapshot.parse(await e.ok('GET', `/v1/threads/${threadId}/snapshot`))
  e.summary = async threadId => appSnapshot.parse(await e.ok('GET', '/v1/app/snapshot')).threads.find(thread => thread.threadId === threadId)
  e.notifications = async threadId => (await e.db.query('SELECT kind,run_id,interaction_id FROM kipster.notifications WHERE thread_id=$1 ORDER BY created_at', [threadId])).rows
  e.text = message => message.parts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
  return e
}
const scenario = (name, options, body) => test(name, { skip: noDatabase, timeout: 60000 }, async () => {
  const e = await environment(options)
  try { await body(e) } finally { await e.close() }
})

scenario('1. the admin kip asks while you wait: the answer lands in your thread and wakes it', {}, async e => {
  const title = 'Can you find out from Planner which launch date the team agreed on last week?'
  const asked = await e.say(e.john, title)
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'Which launch date did the team agree on?')
  assert.equal(sent.status, 'sent')
  assert.equal(sent.recipientId, e.planner)
  // The sender's turn goes on: nothing waits on the message.
  assert.equal(await e.state(asked.runId), 'running')
  await john.end()
  await e.settled(asked.runId, 'completed')
  // The linked thread is in Planner's chat with the person, in its workspace.
  assert.deepEqual((await e.db.query('SELECT c.agent_id,c.caller_id,c.context_kind,c.context_id FROM kipster.direct_chats c WHERE c.id=$1', [sent.chatId])).rows[0],
    { agent_id: e.planner, caller_id: e.ownerId, context_kind: 'organization', context_id: e.playground })
  const source = await e.messages(asked.threadId)
  assert.deepEqual(source.at(-1).parts, [{ kind: 'text', text: 'Which launch date did the team agree on?' }, { kind: 'kip-message', recipientId: e.planner, threadId: sent.threadId, chatId: sent.chatId }])
  assert.equal(source.at(-1).author_id, e.john)
  assert.equal(source.at(-1).id, sent.messageId)
  const incoming = await e.messages(sent.threadId)
  assert.deepEqual(incoming.map(message => [message.author_id, message.parts]), [[e.john, [{ kind: 'text', text: 'Which launch date did the team agree on?' }]]])
  const waiting = await e.summary(asked.threadId)
  assert.equal(waiting.startedBy, e.ownerId)
  assert.deepEqual(waiting.links, [{ agentId: e.planner, threadId: sent.threadId, chatId: sent.chatId, waiting: true }])
  const linked = await e.summary(sent.threadId)
  assert.equal(linked.startedBy, e.john)
  assert.deepEqual(linked.linkedFrom, { threadId: asked.threadId, chatId: asked.chatId, agentId: e.john, title: [...title].slice(0, 55).join('') })
  assert.equal(linked.links, undefined)

  const kipRun = await e.kipRun(sent.threadId)
  assert.deepEqual([kipRun.trigger_kind, kipRun.chain_root_id, kipRun.chain_depth, kipRun.responsible_person_id], ['kip', asked.runId, 1, e.ownerId])
  const planner = await e.run(kipRun.id)
  assert.equal(planner.context.agentId, e.planner)
  assert.equal(planner.context.organizationId, e.playground)
  assert.match(planner.context.prompt, /Which launch date did the team agree on\?/)
  assert.match(planner.context.instructions, new RegExp(`This thread is linked to a conversation of John, another kip \\(thread ${asked.threadId}\\)\\. .*answer them with message_kip to John \\(recipientId ${e.john}\\)`))
  await mkdir(e.runtime.home.agent(e.planner), { recursive: true })
  await writeFile(join(e.runtime.home.agent(e.planner), 'dates.txt'), 'March 3')
  // A provider's own text is not shown; the answer is a message_kip back to John.
  planner.handle.emit({ kind: 'text', messageId: 'progress', text: 'Checking the calendar', final: true, phase: 'progress' })
  const file = await planner.send(e.john, 'The team agreed on March 3.', { attachments: [{ path: 'dates.txt' }] })
  assert.deepEqual([file.status, file.threadId, file.chatId], ['sent', asked.threadId, asked.chatId])
  await planner.end()
  await e.settled(kipRun.id, 'completed')

  const answerRun = await e.answerRun(asked.threadId)
  assert.deepEqual([answerRun.chain_root_id, answerRun.chain_depth], [asked.runId, 0])
  const [answer] = await e.answers(asked.threadId)
  assert.equal(answer.id, answerRun.input_message_id)
  assert.equal(answer.author_id, e.planner)
  assert.deepEqual(answer.parts, [{ kind: 'text', text: 'The team agreed on March 3.' },
    { kind: 'file', artifactId: file.files[0].artifactId, purpose: 'attachment' }, { kind: 'kip-answer', agentId: e.planner, threadId: sent.threadId, chatId: sent.chatId }])
  // The linked thread shows the answer as Planner's message to John.
  assert.deepEqual((await e.messages(sent.threadId)).map(message => [message.author_id, message.parts.map(part => part.kind)]), [[e.john, ['text']], [e.planner, ['text', 'file', 'kip-message']]])
  assert.deepEqual((await e.messages(sent.threadId)).at(-1).parts.at(-1), { kind: 'kip-message', recipientId: e.john, threadId: asked.threadId, chatId: asked.chatId })
  const woken = await e.run(answerRun.id)
  assert.equal(woken.context.agentId, e.john)
  assert.equal(woken.context.triggerMessageId, answer.id)
  assert.match(woken.context.prompt, /The team agreed on March 3\./)
  // The woken sender may read the file it was given.
  assert.ok(woken.context.input.find(message => message.messageId === answer.id).parts.some(part => part.kind === 'file' && part.availability === 'available'))
  assert.deepEqual((await e.summary(asked.threadId)).links, [{ agentId: e.planner, threadId: sent.threadId, chatId: sent.chatId, waiting: false }])
  await woken.end('Planner says the team agreed on March 3.')
  await e.settled(answerRun.id, 'completed')

  // Kip messages, answers and finished turns notify nobody; the woken sender's message to the person does.
  assert.deepEqual((await e.notifications(sent.threadId)), [])
  assert.deepEqual((await e.notifications(asked.threadId)).map(row => [row.kind, row.run_id]), [['message', answerRun.id]])
  for (const event of (await readEvents(e.db, { kind: 'thread', installationId: e.installationId, callerId: e.ownerId, threadId: asked.threadId }, `t:${asked.threadId}:0`, 1000)).events) textEvent.parse(event)
  // Summary events of the source thread show it waiting, then answered.
  const summaries = (await readEvents(e.db, { kind: 'application', installationId: e.installationId, callerId: e.ownerId }, `a:${e.installationId}:0`, 1000)).events
    .filter(event => event.type === 'thread-summary' && event.resourceId === asked.threadId).map(event => appThreadSummary.parse(event.data).links?.[0]?.waiting)
  assert.ok(summaries.includes(true))
  assert.equal(summaries.at(-1), false)
})

scenario('2. you keep talking meanwhile: the answer waits behind your running turn', {}, async e => {
  const asked = await e.say(e.planner, 'Get John\'s feedback on the plan')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.john, 'What do you think of the plan?')
  await planner.end('I asked John.')
  await e.settled(asked.runId, 'completed')
  const followUp = await e.say(e.planner, 'Also add a budget line', { threadId: asked.threadId, chatId: asked.chatId })
  const talking = await e.run(followUp.runId)
  // The admin kip's linked thread is its installation chat with the person.
  assert.deepEqual((await e.db.query('SELECT agent_id,context_kind FROM kipster.direct_chats WHERE id=$1', [sent.chatId])).rows[0], { agent_id: e.john, context_kind: 'installation' })
  const john = await e.run((await e.kipRun(sent.threadId)).id)
  await john.end('Looks good, but start a week later.')
  const answerRun = await e.answerRun(asked.threadId)
  // The answer is queued behind the running turn, in order after the person's message.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await e.state(answerRun.id), 'queued')
  assert.equal(await e.state(followUp.runId), 'running')
  assert.ok(answerRun.queue_position > (await e.runs(asked.threadId)).find(run => run.id === followUp.runId).queue_position)
  assert.equal(e.fixture.executions.some(item => item.context.runId === answerRun.id), false)
  await talking.end('Added a budget line.')
  const woken = await e.run(answerRun.id)
  assert.match(woken.context.prompt, /Also add a budget line[\s\S]*Added a budget line\.[\s\S]*Looks good, but start a week later\./)
  await woken.end('John suggests starting a week later; I updated the plan.')
  await e.settled(answerRun.id, 'completed')
})

scenario('3. an FYI and a question back go through the same linked thread; nothing to add ends silently', {}, async e => {
  const asked = await e.say(e.planner, 'Tell John the budget is approved')
  const planner = await e.run(asked.runId)
  const first = await planner.send(e.john, 'FYI: the budget is approved.')
  await planner.end()
  const john = await e.run((await e.kipRun(first.threadId)).id)
  await john.end('Which project is it for?')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  const second = await woken.send(e.john, 'Project Apollo.')
  assert.equal(second.threadId, first.threadId)
  assert.equal(second.chatId, first.chatId)
  await woken.end('I told John it is for Apollo.')
  const gotIt = await e.run((await e.kipRun(first.threadId, 2)).id)
  assert.match(gotIt.context.prompt, /Which project is it for\?[\s\S]*Project Apollo\./)
  await gotIt.end('Got it.')
  const last = await e.answerRun(asked.threadId, 2)
  const silent = await e.run(last.id)
  // A woken kip with nothing to add ends without a message; its own text is not shown.
  const before = (await e.messages(asked.threadId)).length
  silent.handle.emit({ kind: 'text', messageId: 'draft', text: '', final: false })
  silent.handle.emit({ kind: 'text', messageId: 'final', text: 'Nothing to add.', final: true })
  await silent.end()
  await e.settled(last.id, 'completed')
  assert.equal((await e.messages(asked.threadId)).length, before)
  // Woken turns keep the sender's depth; recipients run one deeper. Answer turns sent nothing back.
  assert.deepEqual((await e.runs(asked.threadId)).map(run => [run.trigger_kind, run.chain_depth]), [['person', 0], ['answer', 0], ['answer', 0]])
  assert.deepEqual((await e.runs(first.threadId)).map(run => [run.trigger_kind, run.chain_depth]), [['kip', 1], ['kip', 1]])
  assert.deepEqual((await e.messages(first.threadId)).map(message => e.text(message)), ['FYI: the budget is approved.', 'Which project is it for?', 'Project Apollo.', 'Got it.'])
})

const memoryOnly = ['search_memory', 'list_threads', 'save_memory', 'forget_memory']
const toolNames = turn => turn.context.tools.map(tool => tool.name)
/** Memory is off unless a test turns it on: neither the installation nor any kip learns. */
const memoryOff = async e => assert.deepEqual((await e.db.query('SELECT bool_or(learning_enabled) AS on FROM kipster.installations')).rows[0], { on: false })
/** A memory-off turn: only the source thread is readable, and the other memory tools are absent and refused. */
async function readsOnlySource(turn, source, others) {
  assert.deepEqual(toolNames(turn).filter(name => name === 'read_thread' || memoryOnly.includes(name)), ['read_thread'])
  assert.match(turn.context.instructions, /If a message lacks a detail you need, read that conversation with read_thread\./)
  const page = await turn.call('read_thread', { threadId: source })
  assert.equal(page.threadId, source)
  for (const threadId of others) await assert.rejects(turn.call('read_thread', { threadId }), /^Error: Thread not found$/)
  await assert.rejects(turn.call('search_memory', { query: 'offsite' }), /Memory is off for this kip/)
  await assert.rejects(turn.call('list_threads', {}), /Memory is off for this kip/)
  await assert.rejects(turn.call('save_memory', { statement: 'The offsite is in Lisbon.', type: 'fact', subject: 'offsite' }), /Memory is off for this kip/)
  await assert.rejects(turn.call('forget_memory', { query: 'Lisbon' }), /Memory is off for this kip/)
  return page
}

scenario('4. kips in one workspace: the recipient reads the source thread, and only that one, with memory off', {}, async e => {
  await memoryOff(e)
  const other = await e.say(e.planner, 'A thread Researcher may not read')
  const otherTurn = await e.run(other.runId)
  // A memory-off kip outside a linked thread gets no read_thread.
  assert.equal(toolNames(otherTurn).includes('read_thread'), false)
  assert.doesNotMatch(otherTurn.context.instructions, /read_thread/)
  await assert.rejects(otherTurn.call('read_thread', { threadId: other.threadId }), /Thread not found/)
  await otherTurn.end('Private notes.')
  await e.settled(other.runId, 'completed')
  const own = await e.say(e.researcher, 'A thread of Researcher\'s own')
  const ownTurn = await e.run(own.runId); await ownTurn.end('Noted.'); await e.settled(own.runId, 'completed')
  const asked = await e.say(e.planner, 'Plan the offsite in Lisbon for twelve people')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.researcher, 'Find three venues for the offsite.')
  await planner.end()
  const researcher = await e.run((await e.kipRun(sent.threadId)).id)
  assert.equal(researcher.context.agentId, e.researcher)
  const page = await readsOnlySource(researcher, asked.threadId, [other.threadId, own.threadId, sent.threadId, randomUUID()])
  assert.match(page.messages[0].text, /Lisbon for twelve people/)
  await researcher.end('Three venues in Lisbon for twelve: A, B and C.')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  assert.match(woken.context.prompt, /Three venues in Lisbon for twelve/)
  assert.equal(toolNames(woken).includes('read_thread'), false)
  await woken.end()
})

scenario('4b. the admin kip with memory off lists and reads every kip\'s threads, and the other memory tools stay off', {}, async e => {
  await memoryOff(e)
  const other = await e.say(e.planner, 'Another thread of Planner')
  const otherTurn = await e.run(other.runId); await otherTurn.end('Noted.'); await e.settled(other.runId, 'completed')
  const own = await e.say(e.john, 'A thread of the admin kip\'s own')
  const ownTurn = await e.run(own.runId)
  assert.deepEqual(toolNames(ownTurn).filter(name => name === 'read_thread' || memoryOnly.includes(name)), ['list_threads', 'read_thread'])
  await ownTurn.end('Noted.'); await e.settled(own.runId, 'completed')
  const asked = await e.say(e.planner, 'Ask John which budget applies to the offsite')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.john, 'Which budget applies?')
  await planner.end()
  const john = await e.run((await e.kipRun(sent.threadId)).id)
  assert.equal(john.context.agentId, e.john)
  assert.deepEqual(toolNames(john).filter(name => name === 'read_thread' || memoryOnly.includes(name)), ['list_threads', 'read_thread'])
  assert.match((await john.call('read_thread', { threadId: asked.threadId })).messages[0].text, /which budget applies to the offsite/)
  for (const thread of [other, own]) assert.equal((await john.call('read_thread', { threadId: thread.threadId })).threadId, thread.threadId)
  const listed = (await john.call('list_threads', {})).threads.map(item => item.threadId)
  for (const thread of [other, own, asked]) assert.ok(listed.includes(thread.threadId))
  await assert.rejects(john.call('search_memory', { query: 'budget' }), /Memory is off for this kip/)
  await assert.rejects(john.call('save_memory', { statement: 'The events budget applies.', type: 'fact', subject: 'offsite' }), /Memory is off for this kip/)
  await john.end('The events budget.')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  await woken.end()
})

scenario('4c. with memory on, a linked recipient reads its own threads and the source thread, with read_thread offered once', { memory: true }, async e => {
  const other = await e.say(e.planner, 'A thread Researcher may not read')
  const otherTurn = await e.run(other.runId); await otherTurn.end('Private notes.'); await e.settled(other.runId, 'completed')
  const own = await e.say(e.researcher, 'A thread of Researcher\'s own')
  const ownTurn = await e.run(own.runId); await ownTurn.end('Noted.'); await e.settled(own.runId, 'completed')
  const asked = await e.say(e.planner, 'Plan the offsite in Lisbon for twelve people')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.researcher, 'Find three venues for the offsite.')
  await planner.end()
  const researcher = await e.run((await e.kipRun(sent.threadId)).id)
  assert.deepEqual(toolNames(researcher).filter(name => name === 'read_thread' || memoryOnly.includes(name)), ['search_memory', 'list_threads', 'read_thread', 'save_memory', 'forget_memory'])
  assert.match(researcher.context.instructions, /read that conversation with read_thread/)
  assert.equal((await researcher.call('read_thread', { threadId: asked.threadId })).threadId, asked.threadId)
  assert.equal((await researcher.call('read_thread', { threadId: own.threadId })).threadId, own.threadId)
  await assert.rejects(researcher.call('read_thread', { threadId: other.threadId }), /Thread not found/)
  await researcher.end('A, B and C.')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  await woken.end()
})

scenario('4d. a turn woken by an answer notifies only when it messages the person with normal priority', {}, async e => {
  const asked = await e.say(e.planner, 'Ask Researcher about venues')
  const planner = await e.run(asked.runId)
  const sent = await planner.send(e.researcher, 'Any venues yet?')
  await planner.end()
  await e.settled(asked.runId, 'completed')
  await (await e.run((await e.kipRun(sent.threadId)).id)).end('Not yet.')
  const silentRun = await e.answerRun(asked.threadId)
  const silent = await e.run(silentRun.id)
  silent.handle.emit({ kind: 'text', messageId: 'final', text: 'Nothing new.', final: true })
  await silent.end()
  await e.settled(silentRun.id, 'completed')
  assert.deepEqual(await e.notifications(asked.threadId), [])
  const followUp = await e.say(e.planner, 'Ask again', { threadId: asked.threadId, chatId: asked.chatId })
  const again = await e.run(followUp.runId)
  await again.send(e.researcher, 'And now?')
  await again.end('Asked again.')
  await e.settled(followUp.runId, 'completed')
  await (await e.run((await e.kipRun(sent.threadId, 2)).id)).end('Venue A.')
  const replyRun = await e.answerRun(asked.threadId, 2)
  const reply = await e.run(replyRun.id)
  assert.equal((await reply.reply('Checking with the venue.', 'silent')).status, 'sent')
  assert.equal((await reply.reply('Researcher found venue A.')).status, 'sent')
  await reply.end()
  await e.settled(replyRun.id, 'completed')
  assert.deepEqual((await e.notifications(asked.threadId)).map(row => [row.kind, row.run_id]), [['message', followUp.runId], ['message', replyRun.id]])
})

scenario('5. the same source thread and recipient share one linked thread; another source thread opens a new one', {}, async e => {
  const first = await e.say(e.planner, 'Start with venues')
  const planner = await e.run(first.runId)
  const venues = await planner.send(e.researcher, 'Find venues.')
  const catering = await planner.send(e.researcher, 'And a caterer, a different topic.')
  assert.equal(catering.threadId, venues.threadId)
  await planner.end()
  const second = await e.say(e.planner, 'Now something else')
  const again = await e.run(second.runId)
  const fresh = await again.send(e.researcher, 'Find venues.')
  assert.notEqual(fresh.threadId, venues.threadId)
  assert.equal(fresh.chatId, venues.chatId)
  await again.end()
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_links WHERE recipient_agent_id=$1', [e.researcher])).rows[0].n, 2)
  assert.deepEqual((await e.runs(venues.threadId)).map(run => run.trigger_kind), ['kip', 'kip'])
})

scenario('6. you step into a kip thread: the kip run still answers its sender, your turn answers only you', {}, async e => {
  const asked = await e.say(e.john, 'Ask Planner to book the venue')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'Please book venue A.')
  await john.end()
  const kipRun = await e.kipRun(sent.threadId)
  const planner = await e.run(kipRun.id)
  // Core offers no steering, so the person's message queues behind the running kip turn.
  const stepIn = await e.say(e.planner, 'Prefer a room with daylight', { threadId: sent.threadId, chatId: sent.chatId })
  assert.equal(stepIn.threadId, sent.threadId)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await e.state(stepIn.runId), 'queued')
  await planner.end('Booked venue A.')
  const answerRun = await e.answerRun(asked.threadId)
  const personTurn = await e.run(stepIn.runId)
  assert.equal((await e.runs(sent.threadId)).find(run => run.id === stepIn.runId).trigger_kind, 'person')
  await personTurn.end('Noted, A has daylight.')
  await e.settled(stepIn.runId, 'completed')
  const woken = await e.run(answerRun.id)
  await woken.end()
  await e.settled(answerRun.id, 'completed')
  const answers = await e.answers(asked.threadId)
  assert.deepEqual(answers.map(message => e.text(message)), ['Booked venue A.'])
  assert.equal((await e.runs(asked.threadId)).filter(run => run.trigger_kind === 'answer').length, 1)
})

scenario('7. a kip asks you while working for another kip: the question shows and notifies in its linked thread', {}, async e => {
  const asked = await e.say(e.john, 'Have Planner book the trip')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'Book the trip to Lisbon.')
  await john.end()
  const kipRun = await e.kipRun(sent.threadId)
  const planner = await e.run(kipRun.id)
  const question = await planner.call('message_user', { priority: 'normal', element: { type: 'approval', prompt: 'Book the 9:00 flight for 240 EUR?', proposalId: 'flight-1', proposal: 'Book flight TP123 at 9:00 for 240 EUR' } })
  await planner.end()
  await e.settled(kipRun.id, 'waiting')
  const linked = await e.snapshot(sent.threadId)
  assert.deepEqual(linked.interactions.map(card => [card.id, card.state]), [[question.interactionId, 'pending']])
  assert.deepEqual((await e.snapshot(asked.threadId)).interactions, [])
  assert.deepEqual((await e.notifications(sent.threadId)).map(row => [row.kind, row.interaction_id]), [['interaction', question.interactionId]])
  // An answer naming the source thread is refused; the card belongs to the linked thread.
  const answer = { version: 1, operationId: randomUUID(), interactionId: question.interactionId, threadId: asked.threadId, runId: kipRun.id, attemptId: planner.attemptId, proposalId: 'flight-1', answer: { kind: 'approve' } }
  assert.notEqual((await e.call('POST', '/v1/work/interactions/answer', answer)).status, 200)
  const accepted = await e.ok('POST', '/v1/work/interactions/answer', { ...answer, operationId: randomUUID(), threadId: sent.threadId })
  assert.equal(accepted.outcome, 'accepted')
  const continued = await e.run(kipRun.id)
  assert.equal(continued.context.continuation.kind, 'approval')
  await continued.end('Booked TP123 at 9:00.')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  assert.match(woken.context.prompt, /Booked TP123 at 9:00\./)
  await woken.end()
})

scenario('8. morning brief mechanics: the admin kip reads kips\' threads, then messages only one kip', { memory: true }, async e => {
  const plannerThread = await e.say(e.planner, 'The offsite is on May 4')
  const p = await e.run(plannerThread.runId); await p.end('Noted.'); await e.settled(plannerThread.runId, 'completed')
  const researcherThread = await e.say(e.researcher, 'Look into venues')
  const r = await e.run(researcherThread.runId); await r.end('Working on it.'); await e.settled(researcherThread.runId, 'completed')
  const brief = await e.say(e.john, 'Write my morning brief')
  const john = await e.run(brief.runId)
  for (const thread of [plannerThread, researcherThread]) assert.equal((await john.call('read_thread', { threadId: thread.threadId })).threadId, thread.threadId)
  const sent = await john.send(e.researcher, 'Which venue did you pick?')
  await john.end()
  const researcher = await e.run((await e.kipRun(sent.threadId)).id)
  await researcher.end('Venue B.')
  const woken = await e.run((await e.answerRun(brief.threadId)).id)
  await woken.end('Brief: offsite May 4 at venue B.')
  await e.settled((await e.answerRun(brief.threadId)).id, 'completed')
  // One message and its answer.
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_message_calls')).rows[0].n, 2)
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.text_runs WHERE trigger_kind=$1', ['kip'])).rows[0].n, 1)
})

scenario('no bouncing: a turn woken by an answer sends nothing back on its own', {}, async e => {
  const asked = await e.say(e.john, 'Ask Writer for a title')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.writer, 'Suggest a title.', { workspaceId: e.playground })
  await john.end()
  const writer = await e.run((await e.kipRun(sent.threadId)).id)
  await writer.end('Spring Launch.')
  const answerRun = await e.answerRun(asked.threadId)
  const woken = await e.run(answerRun.id)
  await woken.end('Writer suggests "Spring Launch". Thanks, Writer!')
  await e.settled(answerRun.id, 'completed')
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.deepEqual((await e.messages(sent.threadId)).map(message => e.text(message)), ['Suggest a title.', 'Spring Launch.'])
  assert.equal((await e.runs(sent.threadId)).length, 1)
  assert.equal((await e.answers(asked.threadId)).length, 1)
})

scenario('failure, stop and removal answer the sender and wake it', {}, async e => {
  const asked = await e.say(e.john, 'Ask around')
  const john = await e.run(asked.runId)
  const failing = await john.send(e.planner, 'Check the budget.')
  const stopping = await john.send(e.researcher, 'Check the venues.')
  const removing = await john.send(e.scout, 'Check the studio.')
  await john.end()
  const planner = await e.run((await e.kipRun(failing.threadId)).id)
  planner.fail('the provider crashed')
  const researcherRun = await e.kipRun(stopping.threadId)
  const researcher = await e.run(researcherRun.id)
  const stopped = await e.ok('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: e.in(e.playground), chatId: stopping.chatId, threadId: stopping.threadId, runId: researcherRun.id, attemptId: researcher.attemptId, action: 'stop' })
  assert.equal(stopped.outcome, 'accepted')
  researcher.fail('cancelled')
  const scoutRun = await e.kipRun(removing.threadId)
  await e.run(scoutRun.id)
  const archived = await e.ok('POST', `/v1/agents/${e.scout}/archive`, { version: 1, operationId: randomUUID() })
  assert.equal(archived.agent.lifecycle, 'archived')
  e.fixture.executions.find(item => item.context.runId === scoutRun.id).handle.emit({ kind: 'failed', confirmedEnded: true, message: 'cancelled' })
  await until(() => e.answers(asked.threadId), answers => answers.length === 3, 'three answers')
  const texts = (await e.answers(asked.threadId)).map(message => [message.author_id, e.text(message)])
  assert.deepEqual(texts.sort(), [[e.planner, 'Planner couldn\'t finish: the provider crashed'], [e.researcher, 'Researcher stopped before answering.'], [e.scout, 'Scout was removed before answering.']].sort())
  assert.equal(await e.state(researcherRun.id), 'cancelled')
  assert.equal(await e.state(scoutRun.id), 'cancelled')
  // Each answer wakes the sender, one turn after the other.
  for (let n = 1; n <= 3; n++) { const run = await e.answerRun(asked.threadId, n); await (await e.run(run.id)).end(); await e.settled(run.id, 'completed') }
  // A failure notifies as usual.
  assert.deepEqual((await e.notifications(failing.threadId)).map(row => row.kind), ['failed'])
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.waiting), [false, false, false])
})

scenario('a queued kip turn whose workspace is deleted answers that its kip was removed', { limit: 1 }, async e => {
  const asked = await e.say(e.john, 'Ask Scout')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.scout, 'Check the studio.')
  const kipRun = await e.kipRun(sent.threadId)
  // One permit: the admin kip's running turn keeps Scout's turn queued.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await e.state(kipRun.id), 'queued')
  await e.ok('DELETE', `/v1/organizations/${e.studio}`, { version: 1, operationId: randomUUID() })
  const [answer] = await until(() => e.answers(asked.threadId), answers => answers.length === 1, 'removal answer')
  assert.equal(e.text(answer), 'Scout was removed before answering.')
  await john.end()
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  await woken.end()
  // The workspace's chats go with it, the linked thread included, and the source thread loses the link.
  await until(async () => (await e.db.query('SELECT count(*)::int AS n FROM kipster.threads WHERE id=$1', [sent.threadId])).rows[0].n, n => n === 0, 'linked thread removed')
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_links')).rows[0].n, 0)
  assert.equal((await e.summary(asked.threadId)).links, undefined)
  assert.equal((await e.answers(asked.threadId)).length, 1)
})

scenario('chain limits: 4 messages per turn, depth 4, 32 messages and answers per chain; answers pass depth and budget', { limit: 40 }, async e => {
  const asked = await e.say(e.planner, 'Ask a lot')
  const planner = await e.run(asked.runId)
  for (let n = 1; n <= 4; n++) await planner.send(e.researcher, `Question ${n}`)
  await assert.rejects(planner.send(e.writer, 'Question 5'), /one turn sends at most 4 kip messages/)
  await planner.end()
  // Depth: Planner (0) → Researcher (1) → Writer (2) → John (3) → Researcher (4) → refused. A message back to the
  // kip a linked thread's messages come from would be an answer, so each hop goes to another kip.
  const chain = await e.say(e.planner, 'Start a chain')
  let turn = await e.run(chain.runId)
  const hops = [e.researcher, e.writer, e.john, e.researcher]
  for (const [index, recipient] of hops.entries()) {
    const sent = await turn.send(recipient, `Hop ${index + 1}`)
    await turn.end()
    const run = await e.kipRun(sent.threadId)
    assert.equal(run.chain_depth, index + 1)
    assert.equal(run.chain_root_id, chain.runId)
    turn = await e.run(run.id)
  }
  await assert.rejects(turn.send(e.planner, 'Hop 5'), /pass through more than 4 kips/)
  await turn.end('Deepest answer.')
  // Budget: lowered to 3 for the test; every message and every answer counts.
  await e.db.query('UPDATE kipster.execution_permits SET delegation_root_budget=3 WHERE installation_id=$1', [e.installationId])
  const budget = await e.say(e.john, 'Use the budget')
  const john = await e.run(budget.runId)
  const one = await john.send(e.planner, 'One')
  await john.send(e.researcher, 'Two')
  await john.end()
  const plannerTurn = await e.run((await e.kipRun(one.threadId)).id)
  await plannerTurn.end('Answer one.')
  const woken = await e.run((await e.answerRun(budget.threadId)).id)
  await assert.rejects(woken.send(e.writer, 'Four'), /already passed 3 kip messages and answers/)
  await woken.end()
  // The second answer goes past the budget and is still delivered.
  const researcherTurn = await e.run((await e.kipRun((await e.db.query('SELECT linked_thread_id FROM kipster.kip_links WHERE source_thread_id=$1 AND recipient_agent_id=$2', [budget.threadId, e.researcher])).rows[0].linked_thread_id)).id)
  await researcherTurn.end('Answer two.')
  const late = await e.answerRun(budget.threadId, 2)
  assert.equal(late.chain_root_id, budget.runId)
  assert.deepEqual((await e.answers(budget.threadId)).map(message => e.text(message)), ['Answer one.', 'Answer two.'])
})

scenario('replaying an attempt and call ID returns the first result and sends nothing new', {}, async e => {
  const asked = await e.say(e.planner, 'Ask once')
  const planner = await e.run(asked.runId)
  const [first, concurrent] = await Promise.all([planner.send(e.researcher, 'Only once', {}, 'call-1'), planner.send(e.researcher, 'Only once', {}, 'call-1')])
  assert.deepEqual(concurrent, first)
  assert.deepEqual(await planner.send(e.researcher, 'Only once', {}, 'call-1'), first)
  await assert.rejects(planner.send(e.researcher, 'Something else', {}, 'call-1'), /already sent a different message/)
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_message_calls')).rows[0].n, 1)
  assert.equal((await e.messages(first.threadId)).length, 1)
  assert.equal((await e.runs(first.threadId)).length, 1)
  assert.equal((await e.messages(asked.threadId)).filter(message => message.parts.some(part => part.kind === 'kip-message')).length, 1)
  // Files attached by path replay too, and a replay cannot change them.
  await mkdir(e.runtime.home.agent(e.planner), { recursive: true })
  await writeFile(join(e.runtime.home.agent(e.planner), 'brief.txt'), 'Brief')
  const withFile = await planner.send(e.researcher, 'See the brief', { attachments: [{ path: 'brief.txt' }] }, 'call-2')
  assert.equal(withFile.files.length, 1)
  assert.deepEqual((await planner.send(e.researcher, 'See the brief', { attachments: [{ path: 'brief.txt' }] }, 'call-2')).messageId, withFile.messageId)
  await assert.rejects(planner.send(e.researcher, 'See the brief', {}, 'call-2'), /already sent a different message/)
  const incoming = (await e.messages(withFile.threadId)).at(-1)
  assert.deepEqual(incoming.parts, [{ kind: 'text', text: 'See the brief' }, { kind: 'file', artifactId: withFile.files[0].artifactId, purpose: 'attachment' }])
  await planner.end()
  const researcher = await e.run((await e.kipRun(first.threadId)).id)
  await researcher.end()
  // The recipient reads the file it was sent.
  const reader = await e.run((await e.kipRun(withFile.threadId, 2)).id)
  assert.ok(reader.context.input.find(message => message.messageId === incoming.id).parts.some(part => part.kind === 'file' && part.availability === 'available'))
  await reader.end()
})

scenario('who can message whom, and which kips each kip sees', {}, async e => {
  const asked = await e.say(e.planner, 'Who is around?')
  const planner = await e.run(asked.runId)
  const seen = await planner.call('list_kips', {})
  assert.deepEqual(seen.agents.map(agent => agent.name), ['John', 'Researcher', 'Writer'])
  assert.equal(seen.agents.some(agent => agent.workspaces), false)
  assert.deepEqual((await planner.call('get_kip', { agentId: e.john })).agent, { id: e.john, name: 'John' })
  assert.equal((await planner.call('get_kip', { agentId: e.scout })).agent, null)
  assert.equal(planner.context.tools.find(tool => tool.name === 'message_kip').inputSchema.properties.workspaceId, undefined)
  assert.ok(!planner.context.tools.some(tool => ['delegate_to_kip', 'check_kip_task'].includes(tool.name)))
  await assert.rejects(planner.send(e.scout, 'Hello Studio'), /works in another workspace.*admin kip/)
  await assert.rejects(planner.send(e.researcher, 'Hi', { workspaceId: e.studio }), /Only the admin kip can name a workspace|Invalid/)
  await assert.rejects(planner.send(e.planner, 'Me'), /cannot message yourself/)
  // A workspace kip messages the admin kip in its installation chat.
  const toJohn = await planner.send(e.john, 'Hello John')
  assert.deepEqual((await e.db.query('SELECT agent_id,context_kind,context_id FROM kipster.direct_chats WHERE id=$1', [toJohn.chatId])).rows[0], { agent_id: e.john, context_kind: 'installation', context_id: e.installationId })
  // A kip in both workspaces gets messages in the sender's.
  const toWriter = await planner.send(e.writer, 'Hello Writer')
  assert.deepEqual((await e.db.query('SELECT context_id FROM kipster.direct_chats WHERE id=$1', [toWriter.chatId])).rows[0].context_id, e.playground)
  await planner.end()

  const brief = await e.say(e.john, 'Talk to everyone')
  const john = await e.run(brief.runId)
  const all = await john.call('list_kips', {})
  assert.deepEqual(all.agents.map(agent => [agent.name, agent.workspaces.map(item => item.name)]), [['Planner', ['Playground']], ['Researcher', ['Playground']], ['Scout', ['Studio']], ['Writer', ['Playground', 'Studio']]])
  assert.deepEqual((await john.call('get_kip', { agentId: e.scout })).agent.workspaces, [{ id: e.studio, name: 'Studio' }])
  assert.equal(john.context.tools.find(tool => tool.name === 'message_kip').inputSchema.properties.workspaceId.type, 'string')
  await assert.rejects(john.send(e.writer, 'Which workspace?'), /Writer works in Playground .*, Studio .*; pass workspaceId/)
  await assert.rejects(john.send(e.scout, 'Elsewhere', { workspaceId: e.playground }), /Scout does not work in that workspace/)
  const inStudio = await john.send(e.writer, 'In Studio', { workspaceId: e.studio })
  assert.deepEqual((await e.db.query('SELECT agent_id,context_kind,context_id FROM kipster.direct_chats WHERE id=$1', [inStudio.chatId])).rows[0], { agent_id: e.writer, context_kind: 'organization', context_id: e.studio })
  const scout = await john.send(e.scout, 'Hello Scout')
  assert.deepEqual((await e.db.query('SELECT context_id FROM kipster.direct_chats WHERE id=$1', [scout.chatId])).rows[0].context_id, e.studio)
  // The same source thread and recipient keep their thread; another workspace for it is refused.
  await assert.rejects(john.send(e.writer, 'Now in Playground', { workspaceId: e.playground }), /already has a thread for this conversation in another workspace/)
  assert.equal((await john.send(e.writer, 'Again', { workspaceId: e.studio })).threadId, inStudio.threadId)
  await john.end()
  // A workspace kip working for the admin kip sees its workspace, not the admin kip's reach.
  const scoutTurn = await e.run((await e.kipRun(scout.threadId)).id)
  assert.deepEqual((await scoutTurn.call('list_kips', {})).agents.map(agent => agent.name), ['John', 'Writer'])
  // A turn started by another kip's message gets no administration tools.
  await scoutTurn.end()
  const plannerToJohn = await e.run((await e.kipRun(toJohn.threadId)).id)
  assert.equal(plannerToJohn.context.agentId, e.john)
  assert.ok(!plannerToJohn.context.tools.some(tool => tool.name === 'run_admin_operation'))
  assert.ok(john.context.tools.some(tool => tool.name === 'run_admin_operation'))
  await plannerToJohn.end()
})

scenario('archive and permanent deletion of a kip handle its linked threads like any other thread', {}, async e => {
  const asked = await e.say(e.john, 'Ask Scout and Planner')
  const john = await e.run(asked.runId)
  const toScout = await john.send(e.scout, 'Hello Scout')
  const toPlanner = await john.send(e.planner, 'Hello Planner')
  await john.end()
  for (const sent of [toScout, toPlanner]) { const turn = await e.run((await e.kipRun(sent.threadId)).id); await turn.end('Hi John') }
  for (let n = 1; n <= 2; n++) { const run = await e.answerRun(asked.threadId, n); await (await e.run(run.id)).end(); await e.settled(run.id, 'completed') }
  // Scout writes from its own thread to Planner, so Scout is the sender of a linked thread in Planner's chat.
  const scoutOwn = await e.say(e.scout, 'Ask Planner something')
  const scoutTurn = await e.run(scoutOwn.runId)
  await assert.rejects(scoutTurn.send(e.planner, 'Hi Planner'), /another workspace/)
  const toJohn = await scoutTurn.send(e.john, 'Hi John')
  await scoutTurn.end()
  const johnTurn = await e.run((await e.kipRun(toJohn.threadId)).id)
  await johnTurn.end('Hi Scout')
  const back = await e.answerRun(scoutOwn.threadId)
  await (await e.run(back.id)).end(); await e.settled(back.id, 'completed')

  // Archive keeps every thread readable.
  await e.ok('POST', `/v1/agents/${e.scout}/archive`, { version: 1, operationId: randomUUID() })
  assert.equal((await e.snapshot(toScout.threadId)).messages.length, 2)
  assert.equal((await e.summary(toScout.threadId)).linkedFrom.threadId, asked.threadId)
  // Permanent deletion removes Scout's chats, its linked threads with them, and the links.
  const operationId = randomUUID()
  await e.ok('DELETE', `/v1/agents/${e.scout}`, { version: 1, operationId })
  await until(() => e.ok('GET', `/v1/operations/${operationId}`), value => ['succeeded', 'failed'].includes(value.state), 'deletion')
  assert.equal((await e.ok('GET', `/v1/operations/${operationId}`)).state, 'succeeded')
  for (const threadId of [toScout.threadId, scoutOwn.threadId]) assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.threads WHERE id=$1', [threadId])).rows[0].n, 0)
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_links WHERE recipient_agent_id=$1 OR sender_agent_id=$1', [e.scout])).rows[0].n, 0)
  // Threads that stay keep the messages and answers of the deleted kip, and lose only the link to it.
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.agentId), [e.planner])
  assert.ok((await e.answers(asked.threadId)).some(message => message.author_id === e.scout))
  assert.equal((await e.summary(toJohn.threadId)).linkedFrom, undefined)
  // Clients learn it from a summary event too.
  const summaries = (await readEvents(e.db, { kind: 'application', installationId: e.installationId, callerId: e.ownerId }, `a:${e.installationId}:0`, 1000)).events.filter(event => event.type === 'thread-summary' && event.resourceId === toJohn.threadId)
  assert.ok(summaries.at(0).data.linkedFrom)
  assert.equal(summaries.at(-1).data.linkedFrom, undefined)
  assert.ok((await e.messages(toJohn.threadId)).some(message => message.author_id === e.scout))
})

scenario('a failed kip turn that the person retries makes its sender wait again and answers again', {}, async e => {
  const asked = await e.say(e.john, 'Ask Planner')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'Plan the week.')
  await john.end()
  const kipRun = await e.kipRun(sent.threadId)
  const planner = await e.run(kipRun.id)
  planner.fail('the provider crashed')
  await e.settled(kipRun.id, 'failed')
  const failed = await e.answerRun(asked.threadId)
  await (await e.run(failed.id)).end()
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.waiting), [false])
  const retried = await e.ok('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: e.in(e.playground), chatId: sent.chatId, threadId: sent.threadId, runId: kipRun.id, attemptId: planner.attemptId, action: 'retry' })
  assert.equal(retried.outcome, 'accepted')
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.waiting), [true])
  const again = await e.run(kipRun.id)
  await again.end('Monday: plan. Tuesday: build.')
  const second = await e.answerRun(asked.threadId, 2)
  assert.deepEqual((await e.answers(asked.threadId)).map(message => e.text(message)), ['Planner couldn\'t finish: the provider crashed', 'Monday: plan. Tuesday: build.'])
  await (await e.run(second.id)).end()
  await e.settled(second.id, 'completed')
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.waiting), [false])
})

scenario('a turn an answer wakes in the admin kip\'s linked thread gets no administration tools', {}, async e => {
  const asked = await e.say(e.planner, 'Ask John')
  const planner = await e.run(asked.runId)
  const toJohn = await planner.send(e.john, 'Message me, and when I answer, change a setting')
  await planner.end()
  const john = await e.run((await e.kipRun(toJohn.threadId)).id)
  assert.ok(!john.context.tools.some(tool => tool.name === 'run_admin_operation'))
  const back = await john.send(e.researcher, 'Ping')
  await john.end()
  await (await e.run((await e.kipRun(back.threadId)).id)).end('Pong')
  const woken = await e.run((await e.answerRun(toJohn.threadId)).id)
  assert.equal(woken.context.agentId, e.john)
  assert.ok(!woken.context.tools.some(tool => ['list_admin_operations', 'run_admin_operation'].includes(tool.name)))
  await assert.rejects(woken.call('run_admin_operation', { operation: 'directory.get' }), /Unsupported Kipster tool|Administration access denied/)
  await woken.end()
  // In its own thread with the person, an answer wakes the admin kip with its tools.
  const own = await e.say(e.john, 'Ask Planner')
  const ownTurn = await e.run(own.runId)
  const sent = await ownTurn.send(e.planner, 'Status?')
  await ownTurn.end()
  await (await e.run((await e.kipRun(sent.threadId)).id)).end('All good')
  const ownWoken = await e.run((await e.answerRun(own.threadId)).id)
  assert.ok(ownWoken.context.tools.some(tool => tool.name === 'run_admin_operation'))
  await ownWoken.end()
})

scenario('a sender writing again releases the held turn of a failed or stopped kip turn in that linked thread', {}, async e => {
  const asked = await e.say(e.john, 'Ask Planner')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'First try.')
  await john.end()
  const first = await e.kipRun(sent.threadId)
  await (await e.run(first.id)).fail('the provider crashed')
  await e.settled(first.id, 'failed')
  const woken = await e.run((await e.answerRun(asked.threadId)).id)
  const again = await woken.send(e.planner, 'Second try.')
  assert.equal(again.threadId, sent.threadId)
  await woken.end()
  const second = await e.kipRun(sent.threadId, 2)
  const turn = await e.run(second.id)
  await turn.end('Done on the second try.')
  await e.answerRun(asked.threadId, 2)
  assert.deepEqual((await e.answers(asked.threadId)).map(message => e.text(message)), ['Planner couldn\'t finish: the provider crashed', 'Done on the second try.'])
  assert.equal((await e.db.query('SELECT queue_hold FROM kipster.text_runs WHERE id=$1', [first.id])).rows[0].queue_hold, false)
})

scenario('a sender writing again leaves the person\'s own held turn in that linked thread held', {}, async e => {
  const asked = await e.say(e.john, 'Ask Planner')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'First question.')
  await john.end()
  await (await e.run((await e.kipRun(sent.threadId)).id)).end('First answer.')
  const answer = await e.answerRun(asked.threadId)
  const own = await e.say(e.planner, 'Do this for me', { threadId: sent.threadId, chatId: sent.chatId })
  await (await e.run(own.runId)).fail('the provider crashed')
  await e.settled(own.runId, 'failed')
  const woken = await e.run(answer.id)
  const again = await woken.send(e.planner, 'Second question.')
  assert.equal(again.threadId, sent.threadId)
  await woken.end()
  const second = await e.kipRun(sent.threadId, 2)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal((await e.db.query('SELECT queue_hold FROM kipster.text_runs WHERE id=$1', [own.runId])).rows[0].queue_hold, true)
  assert.equal(await e.state(second.id), 'queued')
  assert.ok(!e.fixture.executions.some(item => item.context.runId === second.id))
})

scenario('the person opens files a kip sent or answered with in the thread that shows them, and in no other thread', {}, async e => {
  const upload = async (target, text) => {
    const bytes = Buffer.from(text), uploadId = randomUUID()
    const intent = { uploadId, target, name: 'brief.txt', mimeType: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'attachment' }
    const response = await fetch(`${e.server.url}/conversations/media/uploads/${uploadId}?intent=${encodeURIComponent(JSON.stringify(intent))}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
    assert.equal(response.status, 200)
    return (await response.json()).artifact.id
  }
  const download = (id, target) => e.call('GET', `/conversations/media/artifacts/${id}/content?${new URLSearchParams({ target: JSON.stringify({ ...e.scope, ...target }) })}`)
  // An installation file the admin kip forwards to Planner's workspace.
  const johnChat = await e.chat(e.john)
  const sourceFile = await upload({ ...e.scope, context: e.installation, chatId: johnChat }, 'Installation brief')
  const asked = await e.ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: e.scope, target: { context: e.installation, chatId: johnChat }, mode: 'root',
    parts: [{ kind: 'text', text: 'Ask Planner to review this brief' }, { kind: 'file', artifactId: sourceFile, purpose: 'attachment' }] })
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'Review this brief.', { attachments: [{ artifactId: sourceFile }] })
  await john.end()
  const linked = { context: e.in(e.playground), chatId: sent.chatId, threadId: sent.threadId }
  assert.deepEqual(await download(sourceFile, linked), { status: 200, data: 'Installation brief' })
  // A workspace file Planner answers with.
  const planner = await e.run((await e.kipRun(sent.threadId)).id)
  const workspaceFile = await upload({ ...e.scope, ...linked }, 'Workspace brief')
  await e.ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: e.scope, target: { context: linked.context, chatId: linked.chatId }, mode: 'reply', threadId: linked.threadId,
    parts: [{ kind: 'file', artifactId: workspaceFile, purpose: 'attachment' }] })
  assert.equal((await planner.send(e.john, 'Reviewed', { attachments: [{ artifactId: workspaceFile }] })).status, 'sent')
  await planner.end()
  const answerRun = await e.answerRun(asked.threadId)
  assert.deepEqual(await download(workspaceFile, { context: e.installation, chatId: johnChat, threadId: asked.threadId }), { status: 200, data: 'Workspace brief' })
  // Another thread of the same chats shows neither file.
  const other = await e.say(e.planner, 'Something else', { chatId: sent.chatId })
  assert.equal((await download(sourceFile, { context: linked.context, chatId: sent.chatId, threadId: other.threadId })).status, 403)
  const otherSource = await e.say(e.john, 'Something else', { chatId: johnChat })
  assert.equal((await download(workspaceFile, { context: e.installation, chatId: johnChat, threadId: otherSource.threadId })).status, 403)
  await (await e.run(answerRun.id)).end()
  await (await e.run(other.runId)).end()
  await (await e.run(otherSource.runId)).end()
})

scenario('an answer goes back into the source thread and wakes the sender on every call; a turn that ends without one says so', {}, async e => {
  const asked = await e.say(e.john, 'Ask Planner two things')
  const john = await e.run(asked.runId)
  const sent = await john.send(e.planner, 'When is the launch, and where?')
  await john.end()
  await e.settled(asked.runId, 'completed')
  const kipRun = await e.kipRun(sent.threadId)
  const planner = await e.run(kipRun.id)
  const first = await planner.send(e.john, 'March 3.')
  assert.deepEqual([first.status, first.recipientId, first.threadId, first.chatId], ['sent', e.john, asked.threadId, asked.chatId])
  // The first answer ends the wait while Planner still works.
  assert.deepEqual((await e.summary(asked.threadId)).links.map(link => link.waiting), [false])
  await planner.send(e.john, 'In Lisbon.')
  // No second linked thread: both answers land in John's thread, each with its own turn.
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.kip_links')).rows[0].n, 1)
  assert.deepEqual((await e.answers(asked.threadId)).map(message => [message.author_id, e.text(message)]), [[e.planner, 'March 3.'], [e.planner, 'In Lisbon.']])
  const [one, two] = await Promise.all([e.answerRun(asked.threadId, 1), e.answerRun(asked.threadId, 2)])
  assert.deepEqual([one.chain_root_id, one.chain_depth, two.chain_depth], [asked.runId, 0, 0])
  assert.deepEqual((await e.messages(sent.threadId)).map(message => e.text(message)), ['When is the launch, and where?', 'March 3.', 'In Lisbon.'])
  await planner.end()
  await e.settled(kipRun.id, 'completed')
  assert.equal((await e.answers(asked.threadId)).length, 2, 'a turn that answered adds no note')
  for (const run of [one, two]) { await (await e.run(run.id)).end(); await e.settled(run.id, 'completed') }

  // A turn that ends without answering tells the sender; a failure after an answer still does.
  const again = await e.say(e.john, 'Ask once more', { threadId: asked.threadId, chatId: asked.chatId })
  const john2 = await e.run(again.runId)
  await john2.send(e.planner, 'Anything else?')
  await john2.send(e.planner, 'And the budget?')
  await john2.end()
  const quiet = await e.run((await e.kipRun(sent.threadId, 2)).id)
  await quiet.end()
  const failing = await e.run((await e.kipRun(sent.threadId, 3)).id)
  await failing.send(e.john, 'The budget is 10k.')
  failing.fail('the provider crashed')
  await until(() => e.answers(asked.threadId), answers => answers.length === 5, 'notes')
  assert.deepEqual((await e.answers(asked.threadId)).slice(2).map(message => e.text(message)), ['Planner finished without a reply.', 'The budget is 10k.', 'Planner couldn\'t finish: the provider crashed'])

  // Answers count toward the four messages of a turn.
  const third = await e.say(e.john, 'Ask for a list')
  const john3 = await e.run(third.runId)
  const list = await john3.send(e.planner, 'List five venues, one message each.')
  await john3.end()
  const lister = await e.run((await e.kipRun(list.threadId)).id)
  for (let n = 1; n <= 4; n++) await lister.send(e.john, `Venue ${n}`)
  await assert.rejects(lister.send(e.john, 'Venue 5'), /one turn sends at most 4 kip messages/)
  await lister.end()
})
