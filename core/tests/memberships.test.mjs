import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { readDirectory } from '../dist/modules/administration/public.js'
import { readEvents, snapshot } from '../dist/modules/synchronization/public.js'
import { agentCreateResult, directorySnapshot, groupOrderResult, groupRemovalResult, groupResult, membershipRemovalResult, membershipResult, organizationResult, textEvent, threadSnapshot } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Agent memberships, organization groups and appearances over HTTP against real PostgreSQL. Work runs
// through the deterministic fixture adapter.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixtureSettings = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_members_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-members-home-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return { url: url.href, home, closers }
}

async function until(read, match, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (match(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}

/** A runtime with an HTTP server and a fixture-backed dispatcher. `run: false` leaves the dispatcher stopped. */
async function setup(t, { run = true } = {}) {
  const base = await database(t)
  const runtime = await openRuntime({ connectionString: base.url, home: base.home, names })
  base.closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  base.closers.push(() => dispatcher.close())
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0, dispatcher })
    base.closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const call = await serve(actor)
  if (run) await dispatcher.start()
  const db = runtime.db
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  const context = organizationId => ({ kind: 'organization', organizationId })
  const ctx = {
    ...base, runtime, db, actor, installationId, ownerId, organizationId, rootAgentId, executions, dispatcher, serve, call, ok,
    appScope: { kind: 'application', installationId, callerId: ownerId },
    organization: async name => organizationResult.parse(await ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name, settings: fixtureSettings })).organization,
    agent: async (name, organizationId) => agentCreateResult.parse(await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name, organizationId })),
    add: async (organizationId, agentId) => membershipResult.parse(await ok('POST', `/v1/organizations/${organizationId}/memberships`, { version: 1, operationId: randomUUID(), agentId })).membership,
    remove: async membershipId => membershipRemovalResult.parse(await ok('DELETE', `/v1/memberships/${membershipId}`, { version: 1, operationId: randomUUID() })).removed,
    group: async (organizationId, name, membershipIds = []) => {
      let group = groupResult.parse(await ok('POST', `/v1/organizations/${organizationId}/groups`, { version: 1, operationId: randomUUID(), name })).group
      for (const membershipId of membershipIds) group = groupResult.parse(await ok('POST', `/v1/groups/${group.id}/appearances`, { version: 1, operationId: randomUUID(), membershipId })).group
      return group
    },
    chat: async (organizationId, agentId) => call('POST', '/v1/direct-chats', { version: 1, context: context(organizationId), agentId }),
    say: (organizationId, chatId, text, threadId) => call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: context(organizationId), chatId }, ...(threadId ? { mode: 'reply', threadId } : { mode: 'root' }), parts: [{ kind: 'text', text }] }),
    control: (organizationId, chatId, receipt, action, attemptId) => call('POST', '/v1/work/controls', { version: 1, operationId: randomUUID(), context: context(organizationId), chatId, threadId: receipt.threadId, runId: receipt.runId, attemptId, action }),
    /** The `index`-th execution of a run, once the dispatcher issued it. */
    execution: async (runId, index = 0) => until(() => executions.filter(e => e.context.runId === runId)[index], Boolean, `execution ${index} of ${runId}`),
    state: async runId => (await db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]?.state,
    events: async cursor => (await readEvents(db, { kind: 'application', installationId, callerId: ownerId }, cursor)).events.map(event => textEvent.parse(event)),
  }
  ctx.settled = async (runId, state) => until(() => ctx.state(runId), value => value === state, `${runId} ${state}`)
  ctx.finish = ({ context, handle }, text) => {
    handle.release({ kind: 'text', attemptId: context.attemptId, messageId: randomUUID(), text, final: true })
    handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
  }
  return ctx
}

/**
 * Applies directory events the way a client does: a record replaces one with an older or equal
 * revision, a removal always applies, and a removed membership leaves every group's appearances.
 */
function merge(directory, events) {
  const next = structuredClone(directory)
  const lists = { organization: 'organizations', agent: 'agents', membership: 'memberships', group: 'groups' }
  for (const event of events) {
    next.cursor = event.cursor
    const [, kind, change] = /^(organization|agent|membership|group)-(changed|removed)$/.exec(event.type) ?? []
    if (!kind) continue
    const list = lists[kind]
    const current = next[list].find(item => item.id === event.resourceId)
    if (change === 'changed' && (!current || current.revision <= event.revision)) next[list] = [...next[list].filter(item => item.id !== event.resourceId), event.data]
    if (change === 'removed') {
      next[list] = next[list].filter(item => item.id !== event.resourceId)
      if (kind === 'organization') for (const owned of ['memberships', 'groups']) next[owned] = next[owned].filter(item => item.organizationId !== event.resourceId)
      if (kind === 'membership') for (const g of next.groups) g.appearances = g.appearances.filter(item => item.membershipId !== event.resourceId)
    }
  }
  return next
}
const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id))
const comparable = d => ({ cursor: d.cursor, organizations: byId(d.organizations), agents: byId(d.agents), memberships: byId(d.memberships), groups: byId(d.groups) })
const ordered = (directory, organizationId) => directory.groups.filter(g => g.organizationId === organizationId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
const count = async (db, sql, values) => Number((await db.query(sql, values)).rows[0].n)

/** Opens a transaction that runs `work` and then holds its locks until released, at the latest when the test ends. */
function hold(ctx, db, work) {
  let release, ready
  const released = new Promise(resolve => { release = resolve })
  const holding = new Promise(resolve => { ready = resolve })
  const done = db.transaction(async client => { await work(client); ready(); await released })
  ctx.closers.push(async () => { release(); await done })
  return { holding, release, done }
}
/** Waits until `n` sessions of the test database wait on a row lock. */
const lockWaiters = (db, n) => until(async () => count(db, `SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event IN ('transactionid','tuple')`), value => value >= n, `${n} lock waiters`)

test('work accepted before a removal finishes: queued, running, waiting on a question or a child, Resume and Retry', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id), helper = await ctx.agent('Helper', org.id)
  const { chatId } = (await ctx.chat(org.id, scout.agent.id)).data
  const accept = async (text, threadId) => {
    const response = await ctx.say(org.id, chatId, text, threadId)
    assert.equal(response.status, 202)
    return response.data
  }

  // Running, with a reply queued behind it in the same thread.
  const running = await accept('Draft the plan')
  const runningExecution = await ctx.execution(running.runId)
  const queued = await accept('Then summarize it', running.threadId)
  // Waiting on a question.
  const asking = await accept('Ask me which market')
  const askingExecution = await ctx.execution(asking.runId)
  const question = await askingExecution.handle.callTool('ask', 'interactions.ask', { prompt: 'Which market?', options: [{ id: 'eu', label: 'Europe' }], freeText: false })
  askingExecution.handle.release({ kind: 'ended', attemptId: askingExecution.context.attemptId, confirmed: true })
  // Waiting on a child delegated to another member.
  const parent = await accept('Ask Helper to check the numbers')
  const parentExecution = await ctx.execution(parent.runId)
  const delegation = await parentExecution.handle.callTool('delegate', 'agents.delegate', { recipientId: helper.agent.id, request: 'Check the numbers' })
  parentExecution.handle.release({ kind: 'ended', attemptId: parentExecution.context.attemptId, confirmed: true })
  const childExecution = await ctx.execution(delegation.childRunId)
  // Failed work held with a reply behind it, for Resume, and failed work for Retry.
  const held = await accept('Try the first approach')
  const heldExecution = await ctx.execution(held.runId)
  const behind = await accept('Then the second', held.threadId)
  heldExecution.handle.release({ kind: 'failed', attemptId: heldExecution.context.attemptId, confirmedEnded: true, message: 'provider failure' })
  const failing = await accept('Try once more')
  const failingExecution = await ctx.execution(failing.runId)
  failingExecution.handle.release({ kind: 'failed', attemptId: failingExecution.context.attemptId, confirmedEnded: true, message: 'provider failure' })
  await ctx.settled(asking.runId, 'waiting')
  await ctx.settled(held.runId, 'failed')
  await ctx.settled(failing.runId, 'failed')
  assert.equal(await ctx.state(parent.runId), 'waiting')
  assert.equal(await ctx.state(queued.runId), 'queued')

  await ctx.remove(scout.membership.id)
  await ctx.remove(helper.membership.id)

  // New work is refused; the chat stays readable.
  for (const response of [await ctx.say(org.id, chatId, 'New topic'), await ctx.say(org.id, chatId, 'One more thing', running.threadId), await ctx.chat(org.id, scout.agent.id)]) {
    assert.deepEqual([response.status, response.data.code], [403, 'membership-removed'])
  }
  const read = await ctx.call('GET', `/v1/threads/${running.threadId}/snapshot`)
  assert.equal(read.status, 200)
  threadSnapshot.parse(read.data)

  // The running run publishes and ends, and the queued reply runs with the organization's defaults.
  ctx.finish(runningExecution, 'Plan drafted')
  await ctx.settled(running.runId, 'completed')
  const queuedExecution = await ctx.execution(queued.runId)
  assert.deepEqual([queuedExecution.context.organizationId, queuedExecution.context.agentId, queuedExecution.context.settings.adapterId], [org.id, scout.agent.id, 'deterministic-fixture'])
  ctx.finish(queuedExecution, 'Summary')
  await ctx.settled(queued.runId, 'completed')

  // The question is answered and the run continues.
  const answer = await ctx.call('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: question.interactionId, threadId: asking.threadId, runId: asking.runId, attemptId: askingExecution.context.attemptId, answer: { kind: 'choice', optionId: 'eu' } })
  assert.equal(answer.data.outcome, 'accepted')
  const continued = await ctx.execution(asking.runId, 1)
  assert.equal(continued.context.continuation.answer.optionId, 'eu')
  ctx.finish(continued, 'Europe it is')
  await ctx.settled(asking.runId, 'completed')

  // The child finishes and its parent continues with the result.
  ctx.finish(childExecution, 'The numbers add up')
  await ctx.settled(delegation.childRunId, 'completed')
  const resumedParent = await ctx.execution(parent.runId, 1)
  assert.deepEqual(resumedParent.context.delegationResults.map(r => r.result), ['The numbers add up'])
  ctx.finish(resumedParent, 'Helper confirmed the numbers')
  await ctx.settled(parent.runId, 'completed')

  // Resume releases the held reply; Retry runs the failed work again.
  assert.equal((await ctx.control(org.id, chatId, held, 'resume', heldExecution.context.attemptId)).data.outcome, 'accepted')
  ctx.finish(await ctx.execution(behind.runId), 'Second approach done')
  await ctx.settled(behind.runId, 'completed')
  assert.equal((await ctx.control(org.id, chatId, failing, 'retry', failingExecution.context.attemptId)).data.outcome, 'accepted')
  ctx.finish(await ctx.execution(failing.runId, 1), 'Worked this time')
  await ctx.settled(failing.runId, 'completed')

  const history = threadSnapshot.parse((await ctx.call('GET', `/v1/threads/${running.threadId}/snapshot`)).data)
  assert.deepEqual(history.messages.flatMap(m => m.parts.map(p => p.text)).sort(), ['Draft the plan', 'Plan drafted', 'Summary', 'Then summarize it'])
})

test('a removal and an acceptance in the same chat serialize: exactly one outcome', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t, { run: false })
  const locks = new Postgres(ctx.url)
  ctx.closers.push(() => locks.close())
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id)
  const { chatId } = (await ctx.chat(org.id, scout.agent.id)).data
  const first = (await ctx.say(org.id, chatId, 'Start')).data
  const messages = async () => count(ctx.db, 'SELECT count(*) AS n FROM kipster.messages WHERE thread_id=$1', [first.threadId])

  // The acceptance holds the membership first: the removal waits, then both succeed.
  const thread = hold(ctx, locks, c => c.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [first.threadId]))
  await thread.holding
  const accepting = ctx.say(org.id, chatId, 'Accepted before the removal', first.threadId)
  await lockWaiters(ctx.db, 1)
  const removing = ctx.call('DELETE', `/v1/memberships/${scout.membership.id}`, { version: 1, operationId: randomUUID() })
  await lockWaiters(ctx.db, 2)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.agent_memberships WHERE id=$1', [scout.membership.id]), 1)
  thread.release()
  await thread.done
  const [accepted, removed] = await Promise.all([accepting, removing])
  assert.deepEqual([accepted.status, removed.status], [202, 200])
  assert.equal(await ctx.state(accepted.data.runId), 'queued')
  assert.equal(await messages(), 2)

  // The removal holds the membership first: the acceptance waits, then is refused and records nothing.
  const again = await ctx.add(org.id, scout.agent.id)
  const team = await ctx.group(org.id, 'Team', [again.id])
  const group = hold(ctx, locks, c => c.query('SELECT 1 FROM kipster.groups WHERE id=$1 FOR UPDATE', [team.id]))
  await group.holding
  const removing2 = ctx.call('DELETE', `/v1/memberships/${again.id}`, { version: 1, operationId: randomUUID() })
  await lockWaiters(ctx.db, 1)
  const submissionId = randomUUID()
  const refused = ctx.call('POST', '/v1/text/submissions', { version: 1, submissionId, scope: { installationId: ctx.installationId, callerId: ctx.ownerId }, target: { context: { kind: 'organization', organizationId: org.id }, chatId }, mode: 'reply', threadId: first.threadId, parts: [{ kind: 'text', text: 'Too late' }] })
  await lockWaiters(ctx.db, 2)
  group.release()
  await group.done
  const [removed2, rejected] = await Promise.all([removing2, refused])
  assert.deepEqual([removed2.status, rejected.status, rejected.data.code], [200, 403, 'membership-removed'])
  assert.equal(await messages(), 2)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.receipts WHERE submission_id=$1', [submissionId]), 0)

  // A retried submission whose response was lost returns its receipt after a removal; new work is refused.
  const joined = await ctx.add(org.id, scout.agent.id)
  const submission = { version: 1, submissionId: randomUUID(), scope: { installationId: ctx.installationId, callerId: ctx.ownerId }, target: { context: { kind: 'organization', organizationId: org.id }, chatId }, mode: 'reply', threadId: first.threadId, parts: [{ kind: 'text', text: 'Sent before the removal' }] }
  const original = await ctx.call('POST', '/v1/text/submissions', submission)
  assert.equal(original.status, 202)
  await ctx.remove(joined.id)
  const retried = await ctx.call('POST', '/v1/text/submissions', submission)
  assert.deepEqual([retried.status, retried.data.runId, retried.data.messageId, retried.data.alreadyAccepted], [202, original.data.runId, original.data.messageId, true])
  assert.equal((await ctx.call('POST', '/v1/text/submissions', { ...submission, submissionId: randomUUID() })).status, 403)

  // Unordered races end the same way: an accepted submission is recorded in full, a refused one not at all.
  for (let round = 0; round < 6; round++) {
    const membership = await ctx.add(org.id, scout.agent.id)
    const before = await messages()
    const [submitted, gone] = await Promise.all([ctx.say(org.id, chatId, `Race ${round}`, first.threadId), ctx.call('DELETE', `/v1/memberships/${membership.id}`, { version: 1, operationId: randomUUID() })])
    assert.equal(gone.status, 200)
    assert.ok([202, 403].includes(submitted.status))
    assert.equal(await messages(), before + (submitted.status === 202 ? 1 : 0))
    if (submitted.status === 202) assert.equal(await ctx.state(submitted.data.runId), 'queued')
  }
})

test('a delegation and the removal of its recipient serialize: exactly one outcome', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const locks = new Postgres(ctx.url)
  ctx.closers.push(() => locks.close())
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id), helper = await ctx.agent('Helper', org.id)
  const { chatId } = (await ctx.chat(org.id, scout.agent.id)).data
  const parent = (await ctx.say(org.id, chatId, 'Ask Helper')).data
  const parentExecution = await ctx.execution(parent.runId)
  const delegate = (callId, request) => parentExecution.handle.callTool(callId, 'agents.delegate', { recipientId: helper.agent.id, request })

  // The delegation holds the recipient's membership first: the removal waits, the child still runs.
  const run = hold(ctx, locks, c => c.query('SELECT 1 FROM kipster.text_runs WHERE id=$1 FOR UPDATE', [parent.runId]))
  await run.holding
  const delegating = delegate('first', 'Check the numbers')
  await lockWaiters(ctx.db, 1)
  const removing = ctx.call('DELETE', `/v1/memberships/${helper.membership.id}`, { version: 1, operationId: randomUUID() })
  await lockWaiters(ctx.db, 2)
  run.release()
  await run.done
  const [delegation, removed] = await Promise.all([delegating, removing])
  assert.equal(removed.status, 200)
  ctx.finish(await ctx.execution(delegation.childRunId), 'Numbers checked')
  await ctx.settled(delegation.childRunId, 'completed')

  // The removal holds the membership first: the delegation waits and is refused.
  const again = await ctx.add(org.id, helper.agent.id)
  const team = await ctx.group(org.id, 'Team', [again.id])
  const group = hold(ctx, locks, c => c.query('SELECT 1 FROM kipster.groups WHERE id=$1 FOR UPDATE', [team.id]))
  await group.holding
  const removing2 = ctx.call('DELETE', `/v1/memberships/${again.id}`, { version: 1, operationId: randomUUID() })
  await lockWaiters(ctx.db, 1)
  const refused = delegate('second', 'Check them again').then(() => null, error => error)
  await lockWaiters(ctx.db, 2)
  group.release()
  await group.done
  assert.equal((await removing2).status, 200)
  assert.match((await refused)?.message ?? '', /Recipient agent unavailable/)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.delegations WHERE parent_run_id=$1', [parent.runId]), 1)

  // A removed sender's run finishes without delegating to a current member.
  await ctx.add(org.id, helper.agent.id)
  await ctx.remove(scout.membership.id)
  await assert.rejects(delegate('third', 'One more check'), /Delegating agent is not an organization member/)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.delegations WHERE parent_run_id=$1', [parent.runId]), 1)
})

test('adding a membership locks the agent before the organization, as the task-data guard does', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const locks = new Postgres(ctx.url)
  ctx.closers.push(() => locks.close())
  const org = await ctx.organization('Northwind')
  const solo = (await ctx.agent('Solo')).agent
  // The guard locks the acting agent, then the organization.
  let agentLocked, next
  const locked = new Promise(resolve => { agentLocked = resolve })
  const proceed = new Promise(resolve => { next = resolve })
  ctx.closers.push(async () => next())
  const guard = locks.transaction(async c => {
    await c.query('SELECT 1 FROM kipster.agents WHERE id=$1 FOR UPDATE', [solo.id])
    agentLocked()
    await proceed
    await c.query('SELECT 1 FROM kipster.organizations WHERE id=$1 FOR UPDATE', [org.id])
  })
  await locked
  const adding = ctx.call('POST', `/v1/organizations/${org.id}/memberships`, { version: 1, operationId: randomUUID(), agentId: solo.id })
  await lockWaiters(ctx.db, 1)
  next()
  await guard
  const added = await adding
  assert.equal(added.status, 200)
  assert.equal(membershipResult.parse(added.data).membership.agentId, solo.id)
})

test('re-adding an agent opens the same chat with its history; group placement is not restored', { skip: noDatabase, timeout: 30000 }, async t => {
  const ctx = await setup(t)
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id)
  const vip = await ctx.group(org.id, 'VIP', [scout.membership.id])
  const sales = await ctx.group(org.id, 'Sales', [scout.membership.id])
  const { chatId } = (await ctx.chat(org.id, scout.agent.id)).data
  const first = (await ctx.say(org.id, chatId, 'Find three leads')).data
  ctx.finish(await ctx.execution(first.runId), 'Here are three leads')
  await ctx.settled(first.runId, 'completed')
  const before = await readDirectory(ctx.db, ctx.actor)

  const removed = await ctx.remove(scout.membership.id)
  assert.deepEqual(removed, { id: scout.membership.id, organizationId: org.id, agentId: scout.agent.id })
  const events = await ctx.events(before.cursor)
  assert.deepEqual(events.map(e => [e.type, e.resourceId]).sort(), [['group-changed', sales.id], ['group-changed', vip.id], ['membership-removed', scout.membership.id]].sort())
  const afterRemoval = await readDirectory(ctx.db, ctx.actor)
  assert.deepEqual(comparable(merge(before, events)), comparable(afterRemoval))
  assert.deepEqual(afterRemoval.groups.map(g => g.appearances), [[], []])
  assert.equal(afterRemoval.memberships.some(m => m.agentId === scout.agent.id && m.organizationId === org.id), false)
  // The summary context places the chat under former members.
  const summary = (await snapshot(ctx.db, ctx.appScope)).threads.find(s => s.threadId === first.threadId)
  assert.deepEqual([summary.contextKind, summary.contextId, summary.agentId], ['organization', org.id, scout.agent.id])

  const again = await ctx.add(org.id, scout.agent.id)
  assert.notEqual(again.id, scout.membership.id)
  assert.equal((await ctx.chat(org.id, scout.agent.id)).data.chatId, chatId)
  const history = threadSnapshot.parse((await ctx.call('GET', `/v1/threads/${first.threadId}/snapshot`)).data)
  assert.deepEqual(history.messages.flatMap(m => m.parts.map(p => p.text)), ['Find three leads', 'Here are three leads'])
  const next = await ctx.say(org.id, chatId, 'Two more', first.threadId)
  assert.equal(next.status, 202)
  ctx.finish(await ctx.execution(next.data.runId), 'Two more leads')
  await ctx.settled(next.data.runId, 'completed')
  const directory = await readDirectory(ctx.db, ctx.actor)
  assert.deepEqual(directory.groups.map(g => g.appearances), [[], []])
  assert.deepEqual(comparable(merge(before, await ctx.events(before.cursor))), comparable(directory))
})

test('deleting a group keeps agents, memberships and other appearances', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id), closer = await ctx.agent('Closer', org.id)
  const vip = await ctx.group(org.id, 'VIP', [scout.membership.id, closer.membership.id])
  const sales = await ctx.group(org.id, 'Sales', [closer.membership.id, scout.membership.id])
  const before = await readDirectory(ctx.db, ctx.actor)

  const deleted = groupRemovalResult.parse(await ctx.ok('DELETE', `/v1/groups/${vip.id}`, { version: 1, operationId: 'delete-vip' }))
  assert.deepEqual(deleted.removed, { id: vip.id, organizationId: org.id })
  const after = await readDirectory(ctx.db, ctx.actor)
  assert.deepEqual(after.groups.map(g => [g.id, g.appearances.map(a => a.membershipId)]), [[sales.id, [closer.membership.id, scout.membership.id]]])
  assert.deepEqual(byId(after.agents), byId(before.agents))
  assert.deepEqual(byId(after.memberships), byId(before.memberships))
  const events = await ctx.events(before.cursor)
  assert.deepEqual(events.map(e => [e.type, e.resourceId, e.data]), [['group-removed', vip.id, { id: vip.id, organizationId: org.id }]])
  assert.deepEqual(comparable(merge(before, events)), comparable(after))
  // Chats of the agents are unaffected.
  assert.equal((await ctx.chat(org.id, scout.agent.id)).status, 200)
  assert.equal((await ctx.call('DELETE', `/v1/groups/${vip.id}`, { version: 1, operationId: 'delete-vip-again' })).status, 404)
})

test('groups and appearances are ordered by the latest full list', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const org = await ctx.organization('Northwind')
  const [a, b, c] = [await ctx.group(org.id, 'A'), await ctx.group(org.id, 'B'), await ctx.group(org.id, 'C')]
  assert.deepEqual([a.position, b.position, c.position], [0, 1, 2])
  const reorder = (ids, operationId = randomUUID()) => ctx.call('PUT', `/v1/organizations/${org.id}/groups/order`, { version: 1, operationId, groupIds: ids })

  const first = groupOrderResult.parse((await reorder([c.id, a.id, b.id])).data)
  assert.deepEqual(first.groups.map(g => [g.id, g.position]), [[c.id, 0], [a.id, 1], [b.id, 2]])
  const second = groupOrderResult.parse((await reorder([b.id, c.id, a.id])).data)
  assert.deepEqual(second.groups.map(g => g.id), [b.id, c.id, a.id])
  assert.deepEqual(ordered(await readDirectory(ctx.db, ctx.actor), org.id).map(g => g.id), [b.id, c.id, a.id])
  // A list that misses a group, or names one that is gone, is stale; a duplicate is invalid.
  const d = await ctx.group(org.id, 'D')
  assert.deepEqual([(await reorder([a.id, b.id, c.id])).status, (await reorder([a.id, b.id, c.id, d.id, randomUUID()])).status], [409, 409])
  assert.deepEqual([(await reorder([a.id, a.id, b.id, c.id])).status], [400])
  assert.deepEqual(ordered(await readDirectory(ctx.db, ctx.actor), org.id).map(g => g.id), [b.id, c.id, a.id, d.id])
  // Concurrent saves never mix: the result is exactly one of the lists.
  const lists = [[d.id, c.id, b.id, a.id], [a.id, b.id, c.id, d.id], [c.id, d.id, a.id, b.id]]
  const saved = await Promise.all(lists.map(ids => reorder(ids)))
  assert.deepEqual(saved.map(r => r.status), [200, 200, 200])
  const final = ordered(await readDirectory(ctx.db, ctx.actor), org.id)
  assert.ok(lists.some(ids => JSON.stringify(ids) === JSON.stringify(final.map(g => g.id))))
  assert.deepEqual(final.map(g => g.position), [0, 1, 2, 3])

  // Appearances follow the same rule within a group; removing one keeps the membership.
  const members = [await ctx.agent('Scout', org.id), await ctx.agent('Closer', org.id), await ctx.agent('Analyst', org.id)].map(r => r.membership.id)
  const team = await ctx.group(org.id, 'Team', members)
  const order = ids => ctx.call('PUT', `/v1/groups/${team.id}/appearances/order`, { version: 1, operationId: randomUUID(), membershipIds: ids })
  assert.deepEqual(groupResult.parse((await order([members[2], members[0], members[1]])).data).group.appearances.map(x => x.membershipId), [members[2], members[0], members[1]])
  const latest = groupResult.parse((await order([members[1], members[2], members[0]])).data).group
  assert.deepEqual(latest.appearances.map(x => x.membershipId), [members[1], members[2], members[0]])
  assert.equal((await order([members[0], members[1]])).status, 409)
  const without = groupResult.parse(await ctx.ok('DELETE', `/v1/groups/${team.id}/appearances/${members[2]}`, { version: 1, operationId: randomUUID() })).group
  assert.deepEqual(without.appearances.map(x => x.membershipId), [members[1], members[0]])
  assert.equal((await readDirectory(ctx.db, ctx.actor)).memberships.some(m => m.id === members[2]), true)
  const renamed = groupResult.parse(await ctx.ok('PUT', `/v1/groups/${team.id}`, { version: 1, operationId: randomUUID(), name: 'Core team' })).group
  assert.deepEqual([renamed.name, renamed.revision > latest.revision], ['Core team', true])
  // A membership of another organization cannot appear in the group.
  const elsewhere = await ctx.agent('Elsewhere', ctx.organizationId)
  assert.equal((await ctx.call('POST', `/v1/groups/${team.id}/appearances`, { version: 1, operationId: randomUUID(), membershipId: elsewhere.membership.id })).status, 404)
})

test('a repeated operation ID returns the recorded result', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Solo')
  const again = async (method, path, body) => {
    const [first, second] = [await ctx.ok(method, path, body), await ctx.ok(method, path, body)]
    assert.deepEqual([first.alreadyApplied, second.alreadyApplied], [false, true])
    assert.deepEqual({ ...second, alreadyApplied: false }, first)
    return first
  }
  const joined = membershipResult.parse(await again('POST', `/v1/organizations/${org.id}/memberships`, { version: 1, operationId: 'join', agentId: scout.agent.id })).membership
  const group = groupResult.parse(await again('POST', `/v1/organizations/${org.id}/groups`, { version: 1, operationId: 'group', name: 'Team' })).group
  await again('POST', `/v1/groups/${group.id}/appearances`, { version: 1, operationId: 'place', membershipId: joined.id })
  await again('PUT', `/v1/groups/${group.id}`, { version: 1, operationId: 'rename', name: 'Core' })
  await again('PUT', `/v1/organizations/${org.id}/groups/order`, { version: 1, operationId: 'order', groupIds: [group.id] })
  await again('PUT', `/v1/groups/${group.id}/appearances/order`, { version: 1, operationId: 'order-members', membershipIds: [joined.id] })
  await again('DELETE', `/v1/groups/${group.id}/appearances/${joined.id}`, { version: 1, operationId: 'unplace' })
  const removal = { version: 1, operationId: 'leave' }
  await again('DELETE', `/v1/memberships/${joined.id}`, removal)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.groups WHERE organization_id=$1', [org.id]), 1)

  // A replayed removal after a re-add returns the old result and keeps the new membership.
  const rejoined = await ctx.add(org.id, scout.agent.id)
  const replayed = membershipRemovalResult.parse(await ctx.ok('DELETE', `/v1/memberships/${joined.id}`, removal))
  assert.deepEqual([replayed.alreadyApplied, replayed.removed.id], [true, joined.id])
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.agent_memberships WHERE id=$1', [rejoined.id]), 1)
  // Replaying an older rename keeps the later name.
  await ctx.ok('PUT', `/v1/groups/${group.id}`, { version: 1, operationId: 'rename-2', name: 'Later' })
  assert.equal(groupResult.parse(await ctx.ok('PUT', `/v1/groups/${group.id}`, { version: 1, operationId: 'rename', name: 'Core' })).group.name, 'Core')
  assert.equal((await readDirectory(ctx.db, ctx.actor)).groups.find(g => g.id === group.id).name, 'Later')
  // Concurrent creations with one ID make one group; an ID reused for another request or target conflicts.
  const racing = await Promise.all([1, 2, 3].map(() => ctx.call('POST', `/v1/organizations/${org.id}/groups`, { version: 1, operationId: 'racing', name: 'Racing' })))
  assert.deepEqual(racing.map(r => r.status), [200, 200, 200])
  assert.equal(new Set(racing.map(r => r.data.group.id)).size, 1)
  assert.equal(await count(ctx.db, `SELECT count(*) AS n FROM kipster.groups WHERE name='Racing'`), 1)
  const other = await ctx.group(org.id, 'Other')
  for (const [method, path, body] of [
    ['PUT', `/v1/groups/${other.id}`, { version: 1, operationId: 'rename', name: 'Core' }],
    ['DELETE', `/v1/groups/${group.id}`, { version: 1, operationId: 'join' }],
  ]) assert.deepEqual([(await ctx.call(method, path, body)).status], [409])
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.groups WHERE id=$1', [group.id]), 1)
})

test('only the installation owner may change memberships and groups', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const org = await ctx.organization('Northwind')
  const scout = await ctx.agent('Scout', org.id)
  const group = await ctx.group(org.id, 'Team', [scout.membership.id])
  const solo = (await ctx.agent('Solo')).agent
  const requests = [
    ['POST', `/v1/organizations/${org.id}/memberships`, { version: 1, operationId: 'x1', agentId: solo.id }],
    ['DELETE', `/v1/memberships/${scout.membership.id}`, { version: 1, operationId: 'x2' }],
    ['POST', `/v1/organizations/${org.id}/groups`, { version: 1, operationId: 'x3', name: 'Rogue' }],
    ['PUT', `/v1/organizations/${org.id}/groups/order`, { version: 1, operationId: 'x4', groupIds: [group.id] }],
    ['PUT', `/v1/groups/${group.id}`, { version: 1, operationId: 'x5', name: 'Rogue' }],
    ['DELETE', `/v1/groups/${group.id}`, { version: 1, operationId: 'x6' }],
    ['POST', `/v1/groups/${group.id}/appearances`, { version: 1, operationId: 'x7', membershipId: scout.membership.id }],
    ['PUT', `/v1/groups/${group.id}/appearances/order`, { version: 1, operationId: 'x8', membershipIds: [scout.membership.id] }],
    ['DELETE', `/v1/groups/${group.id}/appearances/${scout.membership.id}`, { version: 1, operationId: 'x9' }],
  ]
  const person = randomUUID()
  await ctx.db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [person, ctx.installationId, 'Member'])
  await ctx.db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [org.id, person])
  const operations = await count(ctx.db, 'SELECT count(*) AS n FROM kipster.admin_operations')
  const before = await readDirectory(ctx.db, ctx.actor)
  for (const actor of [{ installationId: ctx.installationId, personId: person }, { installationId: randomUUID(), personId: ctx.ownerId }]) {
    const call = await ctx.serve(actor)
    for (const [method, path, body] of requests) {
      const response = await call(method, path, body)
      assert.deepEqual([response.status, response.data.code], [403, 'forbidden'], `${method} ${path}`)
    }
  }
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.admin_operations'), operations)
  assert.deepEqual(comparable(await readDirectory(ctx.db, ctx.actor)), comparable(before))
  // Unknown targets are not found for the owner.
  for (const [method, path, body] of [
    ['DELETE', `/v1/memberships/${randomUUID()}`, { version: 1, operationId: 'y1' }],
    ['POST', `/v1/organizations/${randomUUID()}/groups`, { version: 1, operationId: 'y2', name: 'Nowhere' }],
    ['POST', `/v1/organizations/${org.id}/memberships`, { version: 1, operationId: 'y3', agentId: randomUUID() }],
    ['PUT', `/v1/groups/${randomUUID()}`, { version: 1, operationId: 'y4', name: 'Nowhere' }],
  ]) assert.deepEqual([(await ctx.call(method, path, body)).status], [404], `${method} ${path}`)
  assert.equal((await ctx.call('POST', `/v1/organizations/${org.id}/groups`, { version: 1, operationId: 'y5', name: ' ' })).status, 400)
  assert.equal(await count(ctx.db, 'SELECT count(*) AS n FROM kipster.admin_operations'), operations)
})

test('membership and group events let a client merge the directory to match a fresh read', { skip: noDatabase }, async t => {
  const ctx = await setup(t, { run: false })
  const org = await ctx.organization('Northwind')
  const before = directorySnapshot.parse((await ctx.call('GET', '/v1/directory')).data)
  const scout = await ctx.agent('Scout', org.id), closer = await ctx.agent('Closer')
  const joined = await ctx.add(org.id, closer.agent.id)
  assert.equal((await ctx.add(org.id, closer.agent.id)).id, joined.id)
  const vip = await ctx.group(org.id, 'VIP', [scout.membership.id, joined.id])
  const sales = await ctx.group(org.id, 'Sales', [joined.id])
  await ctx.ok('PUT', `/v1/groups/${vip.id}`, { version: 1, operationId: randomUUID(), name: 'Key accounts' })
  await ctx.ok('PUT', `/v1/organizations/${org.id}/groups/order`, { version: 1, operationId: randomUUID(), groupIds: [sales.id, vip.id] })
  await ctx.ok('PUT', `/v1/groups/${vip.id}/appearances/order`, { version: 1, operationId: randomUUID(), membershipIds: [joined.id, scout.membership.id] })
  await ctx.remove(joined.id)
  await ctx.ok('DELETE', `/v1/groups/${sales.id}`, { version: 1, operationId: randomUUID() })
  await ctx.add(org.id, closer.agent.id)

  const events = await ctx.events(before.cursor)
  const types = events.map(e => e.type)
  for (const type of ['membership-changed', 'group-changed', 'membership-removed', 'group-removed']) assert.ok(types.includes(type), type)
  // A membership that already existed publishes nothing; one event per membership, group change or removal.
  assert.equal(types.filter(type => type === 'membership-changed').length, 3)
  const fresh = directorySnapshot.parse((await ctx.call('GET', '/v1/directory')).data)
  assert.deepEqual(comparable(merge(before, events)), comparable(fresh))
  assert.deepEqual(ordered(fresh, org.id).map(g => [g.name, g.appearances.map(a => a.agentId)]), [['Key accounts', [scout.agent.id]]])
})
