import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { changeLifecycle } from '../dist/modules/administration/public.js'
import { interactionNotificationChanged, readEvents, retainLast } from '../dist/modules/synchronization/public.js'
import { agentCreateResult, appSnapshot, membershipRemovalResult, organizationResult, stableError, textEvent, threadSnapshot } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Client projections over HTTP against real PostgreSQL: durable notifications with their interaction
// state, chronological notification pages, and the refusals clients act on for removed targets. Work
// runs through the deterministic fixture adapter.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixtureSettings = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

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
  const name = `kipster_projections_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-projections-home-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names })
  closers.push(() => runtime.close())
  const { installationId, ownerId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
  closers.push(() => server.close())
  await dispatcher.start()
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.data)}`)
    return response.data
  }
  const db = runtime.db
  const appScope = { kind: 'application', installationId, callerId: ownerId }
  const context = organizationId => ({ kind: 'organization', organizationId })
  const ctx = {
    runtime, db, actor, installationId, ownerId, executions, dispatcher, server, closers, call, ok, appScope,
    organization: async name => organizationResult.parse(await ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name, settings: fixtureSettings })).organization,
    agent: async (name, organizationId) => agentCreateResult.parse(await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId })),
    chat: async (organizationId, agentId) => (await ok('POST', '/v1/direct-chats', { version: 1, context: context(organizationId), agentId })).chatId,
    say: (organizationId, chatId, text, threadId) => call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: context(organizationId), chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] }),
    control: (organizationId, chatId, receipt, action, attemptId) => call('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: context(organizationId), chatId, threadId: receipt.threadId, runId: receipt.runId, attemptId, action }),
    answer: (card, threadId, runId, attemptId, answer) => call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.interactionId, threadId, runId, attemptId, answer }),
    execution: async (runId, index = 0) => until(() => executions.filter(e => e.context.runId === runId)[index], Boolean, `execution ${index} of ${runId}`),
    state: async runId => (await db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]?.state,
    app: async () => appSnapshot.parse(await ok('GET', '/v1/app/snapshot')),
    events: async cursor => (await readEvents(db, appScope, cursor)).events.map(event => textEvent.parse(event)),
    flip: (kind, id, lifecycle) => db.transaction(client => changeLifecycle(client, runtime.jobs, installationId, kind, id, lifecycle, 'Owner changed')),
  }
  ctx.settled = async (runId, state) => until(() => ctx.state(runId), value => value === state, `${runId} ${state}`)
  ctx.finish = ({ context, handle }, text = 'Done') => {
    handle.release({ kind: 'text', attemptId: context.attemptId, messageId: randomUUID(), text, final: true })
    handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
  }
  /** Runs one root message to completion and returns its receipt. */
  ctx.complete = async (organizationId, chatId, text) => {
    const receipt = (await ctx.say(organizationId, chatId, text)).data
    ctx.finish(await ctx.execution(receipt.runId))
    await ctx.settled(receipt.runId, 'completed')
    return receipt
  }
  /** Starts a root message whose execution asks a question and yields, leaving the run waiting. */
  ctx.question = async (organizationId, chatId, callId) => {
    const receipt = (await ctx.say(organizationId, chatId, `Ask ${callId}`)).data
    const execution = await ctx.execution(receipt.runId)
    const card = await ctx.dispatcher.askToolInteraction(execution.context.attemptId, callId, { kind: 'question', prompt: 'Blue or red?', options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }] })
    execution.handle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
    // Asking already makes the run waiting. The provider's end publishes another summary;
    // observe its settlement commit before callers capture application event cursors.
    await until(async () => (await db.query(
      'SELECT r.state,a.state AS attempt_state FROM kipster.text_runs r JOIN kipster.attempts a ON a.id=r.current_attempt_id WHERE r.id=$1 AND a.id=$2',
      [receipt.runId, execution.context.attemptId],
    )).rows[0], value => value?.state === 'waiting' && value.attempt_state === 'settled', `${receipt.runId} waiting with a settled attempt`)
    return { receipt, execution, card }
  }
  ctx.cursor = async () => (await ctx.app()).cursor
  /** The notification events for one interaction after `cursor`. */
  ctx.notices = async (cursor, interactionId) => (await ctx.events(cursor)).filter(e => e.type === 'notification' && e.data.interactionId === interactionId).map(e => ({ revision: e.revision, ...e.data }))
  ctx.notice = async interactionId => (await ctx.app()).notifications.find(n => n.interactionId === interactionId)
  return ctx
}

/** The refusal body: a stable error with the expected HTTP status and code. */
function refused(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.data))
  assert.equal(stableError.parse(response.data).code, code)
}

test('outstanding notifications survive an expired replay with their current interaction state', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Acme')
  const { agent } = await ctx.agent('Scout', org.id)
  const chatId = await ctx.chat(org.id, agent.id)
  const start = await ctx.cursor()
  const asked = await ctx.question(org.id, chatId, 'ask-1')
  const [created] = await ctx.notices(start, asked.card.interactionId)
  assert.equal(created.revision, 1)
  assert.deepEqual([created.kind, created.interactionState, created.read, created.threadId, created.runId], ['interaction', 'pending', false, asked.receipt.threadId, asked.receipt.runId])

  // The replay expires; a snapshot restores the notification with its current state.
  await retainLast(ctx.db, ctx.appScope, 0)
  await assert.rejects(readEvents(ctx.db, ctx.appScope, start), /resync-required/)
  refused(await ctx.call('GET', `/v1/app/events?after=${encodeURIComponent(start)}`), 409, 'resync-required')
  const restored = await ctx.notice(asked.card.interactionId)
  assert.deepEqual({ ...restored }, { ...created })

  // Reading it changes the notification only: the question is still pending and the run still waits.
  const beforeRead = await ctx.cursor()
  await ctx.ok('POST', `/v1/notifications/${restored.id}/read`, { version: 1 })
  const read = await ctx.notice(asked.card.interactionId)
  assert.deepEqual([read.read, read.interactionState, read.revision], [true, 'pending', 2])
  assert.deepEqual((await ctx.notices(beforeRead, asked.card.interactionId)).map(n => [n.revision, n.read, n.interactionState]), [[2, true, 'pending']])
  const thread = threadSnapshot.parse(await ctx.ok('GET', `/v1/threads/${asked.receipt.threadId}/snapshot`))
  assert.equal(thread.interactions.find(card => card.id === asked.card.interactionId).state, 'pending')
  assert.equal(await ctx.state(asked.receipt.runId), 'waiting')
  await ctx.ok('POST', `/v1/notifications/${restored.id}/read`, { version: 1 })
  assert.equal((await ctx.notice(asked.card.interactionId)).revision, 2, 'reading twice changes nothing')

  // An answer re-emits the notification with the settled state.
  const beforeAnswer = await ctx.cursor()
  const answered = await ctx.answer(asked.card, asked.receipt.threadId, asked.receipt.runId, asked.execution.context.attemptId, { kind: 'choice', optionId: 'blue' })
  assert.equal(answered.data.outcome, 'accepted')
  assert.deepEqual((await ctx.notices(beforeAnswer, asked.card.interactionId)).map(n => [n.revision, n.read, n.interactionState]), [[3, true, 'settled']])
  assert.deepEqual([(await ctx.notice(asked.card.interactionId)).interactionState, (await ctx.notice(asked.card.interactionId)).revision], ['settled', 3])

  // Stop cancels the next question; its notification follows.
  const continuation = await ctx.execution(asked.receipt.runId, 1)
  const second = await ctx.dispatcher.askToolInteraction(continuation.context.attemptId, 'ask-2', { kind: 'question', prompt: 'Anything else?', freeText: true })
  continuation.handle.release({ kind: 'ended', attemptId: continuation.context.attemptId, confirmed: true })
  await ctx.settled(asked.receipt.runId, 'waiting')
  const beforeStop = await ctx.cursor()
  assert.equal((await ctx.control(org.id, chatId, asked.receipt, 'stop', continuation.context.attemptId)).data.outcome, 'accepted')
  assert.deepEqual((await ctx.notices(beforeStop, second.interactionId)).map(n => [n.revision, n.read, n.interactionState]), [[2, false, 'cancelled']])

  // A question left pending when its execution fails is superseded.
  const failing = (await ctx.say(org.id, chatId, 'Ask and fail')).data
  const failingExecution = await ctx.execution(failing.runId)
  const third = await ctx.dispatcher.askToolInteraction(failingExecution.context.attemptId, 'ask-3', { kind: 'question', prompt: 'Which file?', freeText: true })
  const beforeFailure = await ctx.cursor()
  failingExecution.handle.release({ kind: 'failed', attemptId: failingExecution.context.attemptId, confirmedEnded: true, message: 'provider failed' })
  await ctx.settled(failing.runId, 'failed')
  assert.deepEqual((await ctx.notices(beforeFailure, third.interactionId)).map(n => [n.revision, n.interactionState]), [[2, 'superseded']])

  // Archiving the agent fences its work and cancels its pending question.
  const fenced = await ctx.question(org.id, chatId, 'ask-4')
  const beforeArchive = await ctx.cursor()
  await ctx.flip('agent', agent.id, 'archived')
  assert.deepEqual((await ctx.notices(beforeArchive, fenced.card.interactionId)).map(n => [n.revision, n.interactionState]), [[2, 'cancelled']])

  // After a second expiry the snapshot holds every notification in its latest state.
  await retainLast(ctx.db, ctx.appScope, 0)
  const final = await ctx.app()
  const states = Object.fromEntries(final.notifications.filter(n => n.kind === 'interaction').map(n => [n.interactionId, [n.interactionState, n.read, n.revision]]))
  assert.deepEqual(states, {
    [asked.card.interactionId]: ['settled', true, 3],
    [second.interactionId]: ['cancelled', false, 2],
    [third.interactionId]: ['superseded', false, 2],
    [fenced.card.interactionId]: ['cancelled', false, 2],
  })
  assert.ok(final.notifications.some(n => n.kind === 'failed' && n.runId === failing.runId))
})

test('a delegated child question on the parent thread is cancelled with the parent', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Acme')
  const lead = (await ctx.agent('Lead', org.id)).agent
  const helper = (await ctx.agent('Helper', org.id)).agent
  const chatId = await ctx.chat(org.id, lead.id)
  const parent = (await ctx.say(org.id, chatId, 'Ask Helper')).data
  const parentExecution = await ctx.execution(parent.runId)
  const delegation = await ctx.dispatcher.agentTool(parentExecution.context.attemptId, 'delegate-1', 'agents.delegate', { recipientId: helper.id, request: 'Check the figures' })
  parentExecution.handle.release({ kind: 'ended', attemptId: parentExecution.context.attemptId, confirmed: true })
  await ctx.settled(parent.runId, 'waiting')
  const child = await ctx.execution(delegation.childRunId)
  const start = await ctx.cursor()
  const card = await ctx.dispatcher.askToolInteraction(child.context.attemptId, 'child-ask', { kind: 'question', prompt: 'Which quarter?', freeText: true })
  child.handle.release({ kind: 'ended', attemptId: child.context.attemptId, confirmed: true })
  await ctx.settled(delegation.childRunId, 'waiting')
  const [created] = await ctx.notices(start, card.interactionId)
  assert.deepEqual([created.threadId, created.interactionState], [parent.threadId, 'pending'])

  const beforeStop = await ctx.cursor()
  assert.equal((await ctx.control(org.id, chatId, parent, 'stop', parentExecution.context.attemptId)).data.outcome, 'accepted')
  await ctx.settled(delegation.childRunId, 'cancelled')
  assert.deepEqual((await ctx.notices(beforeStop, card.interactionId)).map(n => [n.revision, n.threadId, n.interactionState]), [[2, parent.threadId, 'cancelled']])
  assert.equal((await ctx.notice(card.interactionId)).interactionState, 'cancelled')
})

test('notification pages are chronological and stable', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Acme')
  const { agent } = await ctx.agent('Scout', org.id)
  const chatId = await ctx.chat(org.id, agent.id)
  const runs = []
  for (let n = 0; n < 5; n++) runs.push((await ctx.complete(org.id, chatId, `Task ${n}`)).runId)
  const full = await ctx.app()
  assert.deepEqual(full.notifications.map(n => [n.runId, n.kind]), runs.map(runId => [runId, 'completed']), 'oldest first, in the order they happened')
  const times = full.notifications.map(n => Date.parse(n.createdAt))
  assert.deepEqual(times, [...times].sort((a, b) => a - b))

  // A read notification keeps its place.
  await ctx.ok('POST', `/v1/notifications/${full.notifications[2].id}/read`, { version: 1 })
  const paged = async () => {
    const first = appSnapshot.parse(await ctx.ok('GET', '/v1/app/snapshot?limit=2'))
    const items = [...first.notifications]
    let page = first
    while (page.next) {
      const query = new URLSearchParams({ at: first.cursor, limit: '2' })
      if (page.next.afterThreadId) query.set('afterThreadId', page.next.afterThreadId)
      if (page.next.afterNotificationId) query.set('afterNotificationId', page.next.afterNotificationId)
      page = appSnapshot.parse(await ctx.ok('GET', `/v1/app/snapshot?${query}`))
      items.push(...page.notifications)
    }
    return { first, items }
  }
  const { first, items } = await paged()
  assert.equal(first.notifications.length, 2)
  assert.deepEqual(items.map(n => n.id), full.notifications.map(n => n.id))
  assert.deepEqual(items.map(n => n.read), [false, false, true, false, false])
  assert.deepEqual((await paged()).items, items, 'the same pages again')

  // A change between pages asks the client to start over.
  await ctx.complete(org.id, chatId, 'Task 5')
  const query = new URLSearchParams({ at: first.cursor, limit: '2', afterThreadId: first.next.afterThreadId, afterNotificationId: first.next.afterNotificationId })
  refused(await ctx.call('GET', `/v1/app/snapshot?${query}`), 409, 'resync-required')
  assert.equal((await ctx.app()).notifications.at(-1).kind, 'completed')
  assert.equal((await ctx.app()).notifications.length, 6)
})

test('removed targets are refused with stable codes, and gone chats leave the application projection', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Acme')
  const scout = await ctx.agent('Scout', org.id)
  const helper = (await ctx.agent('Helper', org.id)).agent
  const keeper = (await ctx.agent('Keeper', org.id)).agent
  const scoutChat = await ctx.chat(org.id, scout.agent.id)
  const helperChat = await ctx.chat(org.id, helper.id)
  const keeperChat = await ctx.chat(org.id, keeper.id)
  const scoutRun = await ctx.complete(org.id, scoutChat, 'Scout task')
  const helperRun = await ctx.complete(org.id, helperChat, 'Helper task')

  // A removed member's chat stays readable; new work is refused as membership-removed.
  membershipRemovalResult.parse(await ctx.ok('DELETE', `/v1/memberships/${scout.membership.id}`, { version: 1, operationId: randomUUID() }))
  refused(await ctx.say(org.id, scoutChat, 'Still there?'), 403, 'membership-removed')
  refused(await ctx.say(org.id, scoutChat, 'Still there?', scoutRun.threadId), 403, 'membership-removed')
  refused(await ctx.call('POST', '/v1/direct-chats', { version: 1, context: { kind: 'organization', organizationId: org.id }, agentId: scout.agent.id }), 403, 'membership-removed')
  threadSnapshot.parse(await ctx.ok('GET', `/v1/threads/${scoutRun.threadId}/snapshot`))

  // An archived agent's chat stays readable; once it is being deleted, the chat is gone.
  await ctx.flip('agent', helper.id, 'archived')
  threadSnapshot.parse(await ctx.ok('GET', `/v1/threads/${helperRun.threadId}/snapshot`))
  assert.equal(await ctx.chat(org.id, helper.id), helperChat)
  await ctx.flip('agent', helper.id, 'deleting')
  refused(await ctx.call('POST', '/v1/direct-chats', { version: 1, context: { kind: 'organization', organizationId: org.id }, agentId: helper.id }), 410, 'gone')
  refused(await ctx.call('GET', `/v1/threads/${helperRun.threadId}/snapshot`), 410, 'gone')
  refused(await ctx.say(org.id, helperChat, 'Hello?'), 410, 'gone')
  refused(await ctx.control(org.id, helperChat, helperRun, 'retry', null), 410, 'gone')
  const withoutHelper = await ctx.app()
  assert.equal(withoutHelper.threads.some(s => s.chatId === helperChat), false)
  assert.equal(withoutHelper.notifications.some(n => n.threadId === helperRun.threadId), false)
  assert.ok(withoutHelper.threads.some(s => s.chatId === scoutChat))

  // An organization being deleted: its chats are gone and new work is refused as organization-deleted.
  const pending = await ctx.question(org.id, keeperChat, 'keeper-ask')
  const scoutNotice = (await ctx.app()).notifications.find(n => n.runId === scoutRun.runId)
  const threadCursor = threadSnapshot.parse(await ctx.ok('GET', `/v1/threads/${scoutRun.threadId}/snapshot`)).cursor
  const stream = await fetch(`${ctx.server.url}/v1/threads/${scoutRun.threadId}/events?after=${encodeURIComponent(threadCursor)}`)
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  const goneFrame = (async () => {
    let text = ''
    while (!text.includes('event: gone')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text
  })()
  const beforeDeletion = await ctx.cursor()
  await ctx.flip('organization', org.id, 'deleting')
  assert.match(await goneFrame, /event: gone\ndata: \{"version":1,"code":"gone"\}/)
  await reader.cancel().catch(() => undefined)
  assert.deepEqual((await ctx.events(beforeDeletion)).map(e => [e.type, e.data.lifecycle]), [['organization-changed', 'deleting']], 'no thread or notification events for gone chats')
  assert.equal(await ctx.state(pending.receipt.runId), 'cancelled')
  refused(await ctx.call('GET', `/v1/threads/${scoutRun.threadId}/snapshot`), 410, 'gone')
  refused(await ctx.call('GET', `/v1/threads/${scoutRun.threadId}/events?after=${encodeURIComponent(threadCursor)}`), 410, 'gone')
  refused(await ctx.say(org.id, keeperChat, 'Anyone?'), 410, 'organization-deleted')
  refused(await ctx.say(org.id, keeperChat, 'Anyone?', pending.receipt.threadId), 410, 'organization-deleted')
  refused(await ctx.call('POST', '/v1/direct-chats', { version: 1, context: { kind: 'organization', organizationId: org.id }, agentId: keeper.id }), 410, 'organization-deleted')
  refused(await ctx.control(org.id, keeperChat, pending.receipt, 'resume', pending.execution.context.attemptId), 410, 'gone')
  refused(await ctx.answer(pending.card, pending.receipt.threadId, pending.receipt.runId, pending.execution.context.attemptId, { kind: 'choice', optionId: 'blue' }), 410, 'gone')
  refused(await ctx.call('POST', `/v1/notifications/${scoutNotice.id}/read`, { version: 1 }), 410, 'gone')
  const afterDeletion = await ctx.app()
  assert.deepEqual([afterDeletion.threads.length, afterDeletion.notifications.length], [0, 0])

  // Unknown threads, chats and notifications are gone too.
  refused(await ctx.call('GET', `/v1/threads/${randomUUID()}/snapshot`), 410, 'gone')
  refused(await ctx.say(org.id, randomUUID(), 'Hello?'), 410, 'gone')
  refused(await ctx.call('POST', `/v1/notifications/${randomUUID()}/read`, { version: 1 }), 410, 'gone')

  // The installation chat is unaffected.
  const rootChat = (await ctx.ok('POST', '/v1/direct-chats', { version: 1, context: { kind: 'installation', installationId: ctx.installationId }, agentId: ctx.runtime.bootstrap.rootAgentId })).chatId
  assert.ok(rootChat)
})

test('notifications preview the reply, the failure or the question', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Acme')
  const { agent } = await ctx.agent('Scout', org.id)
  const chatId = await ctx.chat(org.id, agent.id)
  const start = await ctx.cursor()
  const preview = async runId => (await ctx.app()).notifications.find(n => n.runId === runId && n.kind !== 'interaction').preview

  // The last final reply of the run, text parts only, on one line.
  const replied = (await ctx.say(org.id, chatId, 'Hello')).data
  const execution = await ctx.execution(replied.runId)
  execution.handle.release({ kind: 'text', attemptId: execution.context.attemptId, messageId: randomUUID(), text: 'Looking into it.', final: true })
  ctx.finish(execution, '  The report is\n\n ready.\tThree files changed.  ')
  await ctx.settled(replied.runId, 'completed')
  assert.equal(await preview(replied.runId), 'The report is ready. Three files changed.')
  const event = (await ctx.events(start)).find(e => e.type === 'notification' && e.data.runId === replied.runId)
  assert.equal(event.data.preview, 'The report is ready. Three files changed.')

  const longer = (await ctx.say(org.id, chatId, 'Longer')).data
  ctx.finish(await ctx.execution(longer.runId), `${'é'.repeat(150)} ${'x'.repeat(100)}`)
  await ctx.settled(longer.runId, 'completed')
  const cut = await preview(longer.runId)
  assert.equal([...cut].length, 200)
  assert.equal(cut, `${'é'.repeat(150)} ${'x'.repeat(48)}…`)

  // A run that published nothing has no preview.
  const silent = (await ctx.say(org.id, chatId, 'Quiet')).data
  const quiet = await ctx.execution(silent.runId)
  quiet.handle.release({ kind: 'ended', attemptId: quiet.context.attemptId, confirmed: true })
  await ctx.settled(silent.runId, 'completed')
  assert.equal(Object.hasOwn((await ctx.app()).notifications.find(n => n.runId === silent.runId), 'preview'), false)

  const failing = (await ctx.say(org.id, chatId, 'Fail')).data
  const failure = await ctx.execution(failing.runId)
  failure.handle.release({ kind: 'failed', attemptId: failure.context.attemptId, confirmedEnded: true, message: 'Provider\nrefused the request' })
  await ctx.settled(failing.runId, 'failed')
  assert.equal(await preview(failing.runId), 'Provider refused the request')

  const asked = await ctx.question(org.id, chatId, 'ask-preview')
  assert.equal((await ctx.notice(asked.card.interactionId)).preview, 'Blue or red?')
})

test('batch read and clear act on the caller\'s notifications only', { skip: noDatabase, timeout: 90000 }, async t => {
  const ctx = await setup(t)
  assert.equal((await ctx.ok('GET', '/v1/bootstrap')).capabilities.notificationActions, true)
  const org = await ctx.organization('Acme')
  const { agent } = await ctx.agent('Scout', org.id)
  const chatId = await ctx.chat(org.id, agent.id)
  const runs = [await ctx.complete(org.id, chatId, 'One'), await ctx.complete(org.id, chatId, 'Two'), await ctx.complete(org.id, chatId, 'Three')]
  const asked = await ctx.question(org.id, chatId, 'ask-batch')
  const listed = (await ctx.app()).notifications
  const [one, two, three] = runs.map(run => listed.find(n => n.runId === run.runId))
  const question = await ctx.notice(asked.card.interactionId)
  // Another person's notification in the same installation.
  const foreign = randomUUID(), stranger = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people(id,installation_id,display_name) VALUES ($1,$2,$3)', [stranger, ctx.installationId, 'Stranger'])
  await ctx.db.query("INSERT INTO kipster.notifications(id,installation_id,recipient_id,thread_id,run_id,kind) VALUES ($1,$2,$3,$4,$5,'failed')", [foreign, ctx.installationId, stranger, one.threadId, one.runId])
  const unknown = randomUUID()

  for (const notificationIds of [[], [one.id, one.id], [one.id, one.id.toUpperCase()], ['not-a-uuid'], Array.from({ length: 201 }, () => randomUUID()), 'x']) {
    refused(await ctx.call('POST', '/v1/notifications/read', { notificationIds }), 400, 'invalid')
    refused(await ctx.call('POST', '/v1/notifications/clear', { notificationIds }), 400, 'invalid')
  }
  refused(await ctx.call('POST', '/v1/notifications/read', { version: 1, notificationIds: [one.id], extra: true }), 400, 'invalid')

  const beforeRead = await ctx.cursor()
  assert.deepEqual(await ctx.ok('POST', '/v1/notifications/read', { version: 1, notificationIds: [one.id, unknown, foreign, two.id] }), { version: 1, status: 'read', notificationIds: [one.id, two.id] })
  assert.deepEqual((await ctx.events(beforeRead)).map(e => [e.type, e.data.id, e.revision, e.data.read]).sort(), [['notification', one.id, 2, true], ['notification', two.id, 2, true]].sort())
  const beforeAgain = await ctx.cursor()
  assert.deepEqual((await ctx.ok('POST', '/v1/notifications/read', { notificationIds: [two.id, three.id] })).notificationIds, [two.id, three.id])
  assert.deepEqual((await ctx.events(beforeAgain)).map(e => [e.type, e.data.id]), [['notification', three.id]], 'already read changes nothing')

  // Clearing removes the notification for every client; a pending question is kept.
  const beforeClear = await ctx.cursor()
  assert.deepEqual(await ctx.ok('POST', '/v1/notifications/clear', { version: 1, notificationIds: [question.id, one.id, unknown, foreign] }), { version: 1, status: 'cleared', cleared: [one.id], kept: [question.id] })
  assert.deepEqual((await ctx.events(beforeClear)).map(e => [e.type, e.resourceId, e.revision, e.data]), [['notification-removed', one.id, 3, { id: one.id, threadId: one.threadId }]])
  assert.deepEqual((await ctx.app()).notifications.map(n => n.id), [two.id, three.id, question.id])
  assert.deepEqual((await ctx.db.query('SELECT read_at,cleared_at FROM kipster.notifications WHERE id=$1', [foreign])).rows[0], { read_at: null, cleared_at: null })

  // An unread notification is read once cleared; clearing again is accepted without another event.
  const beforeUnread = await ctx.cursor()
  assert.deepEqual((await ctx.ok('POST', '/v1/notifications/clear', { notificationIds: [question.id] })).kept, [question.id])
  const answered = await ctx.answer(asked.card, asked.receipt.threadId, asked.receipt.runId, asked.execution.context.attemptId, { kind: 'choice', optionId: 'red' })
  assert.equal(answered.data.outcome, 'accepted')
  assert.deepEqual((await ctx.ok('POST', '/v1/notifications/clear', { notificationIds: [question.id, one.id] })).cleared, [question.id, one.id])
  assert.deepEqual((await ctx.events(beforeUnread)).filter(e => e.type.startsWith('notification')).map(e => [e.type, e.resourceId, e.revision]), [['notification', question.id, 2], ['notification-removed', question.id, 3]])
  assert.notEqual((await ctx.db.query('SELECT read_at FROM kipster.notifications WHERE id=$1', [question.id])).rows[0].read_at, null)

  // A cleared notification stays gone: reading it is refused, and a later interaction change does not publish it again.
  refused(await ctx.call('POST', `/v1/notifications/${one.id}/read`, { version: 1 }), 410, 'gone')
  assert.deepEqual((await ctx.ok('POST', '/v1/notifications/read', { notificationIds: [one.id, question.id] })).notificationIds, [])
  const beforeChange = await ctx.cursor()
  await ctx.db.transaction(client => interactionNotificationChanged(client, asked.card.interactionId))
  assert.deepEqual(await ctx.events(beforeChange), [])
  await retainLast(ctx.db, ctx.appScope, 0)
  assert.deepEqual((await ctx.app()).notifications.map(n => n.id), [two.id, three.id])
})
