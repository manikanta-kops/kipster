import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { textPublicationHost } from '../dist/workflows/text-dispatch.js'
import { ROUTINE_TIMER } from '../dist/workflows/routine-dispatch.js'
import { nextRunAfter, parseTriggers } from '../dist/modules/routines/public.js'
import { appSnapshot, routineList, routineResult, routineRunList, routineRunResult, routineSettings } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const fixtureSettings = { adapterId: 'kip-fixture', modelId: 'fixture' }
async function until(read, match, label) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error(`Timed out: ${label}`)
}
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

/** Planner and Researcher work in Playground, Scout in Studio; John is the admin kip. The clock starts Wed 21 Oct 2026, 08:00 UTC. */
async function environment() {
  const database = `kipsterroutine_${randomUUID().replaceAll('-', '')}`, admin = new Postgres(adminUrl), url = new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-routine-'))
  const clock = { now: new Date('2026-10-21T08:00:00Z') }
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Playground', rootAgent: 'John' }, executionLimit: 8, clock: () => clock.now })
  const fixture = adapter(), dispatcher = new TextDispatcher(runtime, fixture)
  const server = await startTextServer(runtime, { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  const e = { runtime, db: runtime.db, clock, fixture, dispatcher, host: textPublicationHost(dispatcher), john: runtime.bootstrap.rootAgentId, playground: runtime.bootstrap.organizationId, ownerId: runtime.bootstrap.ownerId, seen: new Set() }
  e.close = async () => {
    await e.dispatcher.close().catch(() => undefined); await server.close().catch(() => undefined); await runtime.close().catch(() => undefined)
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
  e.scout = await create('Scout', e.studio)
  e.in = organizationId => ({ kind: 'organization', organizationId })
  e.contextOf = agentId => agentId === e.john ? { kind: 'installation', installationId: runtime.bootstrap.installationId } : agentId === e.scout ? e.in(e.studio) : e.in(e.playground)
  e.chat = async agentId => (await e.ok('POST', '/v1/direct-chats', { version: 1, context: e.contextOf(agentId), agentId })).chatId
  e.say = async (agentId, text) => e.ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: runtime.bootstrap.installationId, callerId: e.ownerId }, target: { context: e.contextOf(agentId), chatId: await e.chat(agentId) }, mode: 'root', parts: [{ kind: 'text', text }] })
  e.turn = async (match, label = 'turn') => {
    const found = await until(() => e.fixture.executions.find(item => !e.seen.has(item.context.attemptId) && match(item.context)), Boolean, label)
    e.seen.add(found.context.attemptId)
    const { context, handle } = found
    const call = (name, args, callId = randomUUID()) => e.host.invokeTool({ attemptId: context.attemptId, callId, name, arguments: args })
    return { context, handle, call, end: () => handle.emit({ kind: 'ended', confirmed: true }) }
  }
  /** A turn of `agentId` that the person started, kept open for tool calls. */
  e.open = async agentId => { const { runId } = await e.say(agentId, 'Set up my routines.'); return e.turn(context => context.runId === runId, `turn of ${agentId}`) }
  e.routineThreads = async agentId => (await e.db.query(`SELECT rr.thread_id,rr.state,rr.late,rr.scheduled_for,t.chat_id FROM kipster.routine_runs rr LEFT JOIN kipster.threads t ON t.id=rr.thread_id WHERE rr.agent_id=$1 ORDER BY rr.started_at,rr.scheduled_for`, [agentId])).rows
  e.tick = async at => { e.clock.now = new Date(at); await e.dispatcher.routinesTick() }
  return e
}
const scenario = (name, body) => test(name, { skip: noDatabase, timeout: 60000 }, async () => {
  const e = await environment()
  try { await body(e) } finally { await e.close() }
})

test('triggers fire at wall-clock times of their time zone', () => {
  const zone = 'America/New_York', now = new Date('2026-10-21T19:00:00Z') // Wed 15:00 in New York
  const triggers = parseTriggers([{ type: 'times', times: ['14:30'], days: ['mon', 'tue'] }, { type: 'times', times: ['06:00'], days: ['wed', 'fri'] }], zone, now)
  assert.equal(nextRunAfter(triggers, zone, now).toISOString(), '2026-10-23T10:00:00.000Z', 'Friday 06:00')
  const window = parseTriggers([{ type: 'every', minutes: 120, from: '09:00', until: '19:00' }], zone, now)
  const times = []; let at = now
  for (let n = 0; n < 3; n++) times.push((at = nextRunAfter(window, zone, at)).toISOString())
  assert.deepEqual(times, ['2026-10-21T21:00:00.000Z', '2026-10-21T23:00:00.000Z', '2026-10-22T13:00:00.000Z'])
  // 02:30 does not exist on 14 March 2027; that run moves to 03:30. After the clocks go back on 1 November, 09:00 stays 09:00.
  const early = parseTriggers([{ type: 'times', times: ['02:30'] }], zone, new Date('2027-03-13T12:00:00Z'))
  assert.equal(nextRunAfter(early, zone, new Date('2027-03-13T12:00:00Z')).toISOString(), '2027-03-14T07:30:00.000Z')
  assert.equal(nextRunAfter(parseTriggers([{ type: 'times', times: ['09:00'] }], zone, now), zone, new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-01T14:00:00.000Z')
  const once = parseTriggers([{ type: 'once', at: '2026-10-22T15:00' }], zone, now)
  assert.equal(nextRunAfter(once, zone, now).toISOString(), '2026-10-22T19:00:00.000Z')
  assert.equal(nextRunAfter(once, zone, new Date('2026-10-23T00:00:00Z')), null)
  for (const [bad, message] of [
    [[{ type: 'once', at: '2026-10-20T10:00' }], /not in the future/], [[{ type: 'every', minutes: 0 }], /minutes/], [[{ type: 'times', times: ['25:00'] }], /24-hour/],
    [[{ type: 'times', times: ['10:00'], days: ['monday'] }], /weekdays/], [[{ type: 'every', minutes: 60, from: '10:00', until: '09:00' }], /later than from/], [[], /1 to 10/],
  ]) assert.throws(() => parseTriggers(bad, zone, now), message)
})

scenario('a kip creates its own routine; each due time starts one new thread with the routine header', async e => {
  const planner = await e.open(e.planner)
  assert.ok(['create_routine', 'edit_routine', 'list_routines', 'delete_routine'].every(name => planner.context.tools.some(tool => tool.name === name)))
  assert.match(planner.context.instructions, /create a routine with create_routine/)
  const created = await planner.call('create_routine', { name: 'Morning check', instructions: 'Check the overnight build and tell the person if it failed.', triggers: [{ type: 'times', times: ['09:00', '17:00'] }], timeZone: 'UTC' }, 'create-1')
  assert.equal(created.routine.agentId, e.planner)
  assert.equal(created.routine.nextRunAt, '2026-10-21T09:00:00.000Z')
  assert.equal(created.routine.nextRun, 'Wed, 21 Oct 2026, 09:00 (UTC)')
  // A repeated call returns the first routine.
  assert.equal((await planner.call('create_routine', { name: 'Morning check', instructions: 'x', triggers: [{ type: 'times', times: ['09:00'] }], timeZone: 'UTC' }, 'create-1')).routine.id, created.routine.id)
  assert.deepEqual((await planner.call('list_routines', {})).routines.map(routine => routine.id), [created.routine.id])
  planner.end()

  await e.tick('2026-10-21T08:59:00Z')
  assert.equal((await e.routineThreads(e.planner)).length, 0, 'nothing is due before 09:00')
  await e.tick('2026-10-21T09:00:00Z')
  await e.dispatcher.routinesTick()
  const [run] = await e.routineThreads(e.planner)
  assert.deepEqual({ state: run.state, late: run.late, chat: run.chat_id }, { state: 'started', late: false, chat: await e.chat(e.planner) })
  assert.equal((await e.routineThreads(e.planner)).length, 1, 'a time runs once')
  const turn = await e.turn(context => context.threadId === run.thread_id, 'routine turn')
  assert.match(turn.context.prompt, /the instructions of your routine "Morning check", run for Wed, 21 Oct 2026, 09:00 \(UTC\)\. The person is not watching\./)
  assert.match(turn.context.prompt, /Check the overnight build/)
  const [message] = (await e.db.query('SELECT author_id,parts FROM kipster.messages WHERE thread_id=$1 ORDER BY position', [run.thread_id])).rows
  assert.equal(message.author_id, e.planner, 'the kip that wrote the routine authors its instructions')
  assert.equal((await e.db.query('SELECT trigger_kind FROM kipster.text_runs WHERE thread_id=$1', [run.thread_id])).rows[0].trigger_kind, 'routine')
  const summary = appSnapshot.parse(await e.ok('GET', '/v1/app/snapshot')).threads.find(thread => thread.threadId === run.thread_id)
  assert.deepEqual(summary.routine, { id: created.routine.id, name: 'Morning check' })
  // Nothing to report: the turn ends without a message and notifies nobody.
  turn.end()
  await until(async () => (await e.db.query('SELECT state FROM kipster.text_runs WHERE thread_id=$1', [run.thread_id])).rows[0].state, state => state === 'completed', 'routine run completed')
  assert.equal((await e.db.query('SELECT count(*)::int AS n FROM kipster.notifications WHERE thread_id=$1', [run.thread_id])).rows[0].n, 0)
  assert.equal((await e.db.query('SELECT next_run_at FROM kipster.routines WHERE id=$1', [created.routine.id])).rows[0].next_run_at.toISOString(), '2026-10-21T17:00:00.000Z')
})

scenario('a run sees the previous three runs and what each sent the person', async e => {
  await e.ok('PUT', '/v1/settings/routines', { version: 1, dailyRunLimit: 3 })
  const planner = await e.open(e.planner)
  await planner.call('create_routine', { name: 'Tip', instructions: 'Send one productivity tip.', triggers: [{ type: 'every', minutes: 10 }], timeZone: 'UTC' })
  planner.end()
  const run = async (at, act) => {
    await e.tick(at)
    const latest = (await e.routineThreads(e.planner)).at(-1)
    if (latest.state === 'skipped') return null
    const turn = await e.turn(context => context.threadId === latest.thread_id, `run at ${at}`)
    await act?.(turn)
    turn.end()
    await until(async () => (await e.db.query('SELECT state FROM kipster.text_runs WHERE thread_id=$1', [latest.thread_id])).rows[0].state, state => state === 'completed', `run at ${at} completed`)
    return { turn, threadId: latest.thread_id }
  }
  const long = `Batch your email.\n\n${'Check it at set times. '.repeat(20)}`
  const first = await run('2026-10-21T08:10:00Z', turn => turn.call('message_user', { text: long, priority: 'normal' }))
  assert.doesNotMatch(first.turn.context.prompt, /Earlier runs/, 'the first run has no earlier runs')
  const second = await run('2026-10-21T08:20:00Z')
  const third = await run('2026-10-21T08:30:00Z', turn => turn.call('message_user', { text: 'Try the two-minute rule.', priority: 'silent' }))
  assert.equal(await run('2026-10-21T08:40:00Z'), null, 'past the daily limit')
  // The next day the missed 08:50 runs late and sees the three runs before it.
  const late = await run('2026-10-22T00:01:00Z')
  const sent = JSON.stringify(long.replace(/\s+/g, ' ').slice(0, 300) + '…')
  assert.ok(late.turn.context.prompt.includes([
    'Earlier runs of this routine (newest first), so you build on them instead of repeating them:',
    '- Wed, 21 Oct 2026, 08:40 (UTC): skipped, past the daily limit',
    `- Wed, 21 Oct 2026, 08:30 (UTC), thread ${third.threadId}: sent "Try the two-minute rule."`,
    `- Wed, 21 Oct 2026, 08:20 (UTC), thread ${second.threadId}: sent nothing`,
    'Read a run in full with read_thread.',
  ].join('\n')), late.turn.context.prompt)
  assert.ok(!late.turn.context.prompt.includes(first.threadId), 'only three runs are shown')
  assert.ok(third.turn.context.prompt.includes(`thread ${first.threadId}: sent ${sent}`), 'a long message is cut to 300 characters')
})

scenario('missed times run once, late, then the routine goes on at its next time', async e => {
  const planner = await e.open(e.planner)
  const { routine } = await planner.call('create_routine', { name: 'Hourly scan', instructions: 'Scan the trends.', triggers: [{ type: 'every', minutes: 60, from: '09:00', until: '18:00' }], timeZone: 'UTC' })
  planner.end()
  // Off from 08:00 until 13:20: 09:00 to 13:00 were missed.
  await e.tick('2026-10-21T13:20:00Z')
  const runs = await e.routineThreads(e.planner)
  assert.equal(runs.length, 1)
  assert.deepEqual({ state: runs[0].state, late: runs[0].late, scheduled: runs[0].scheduled_for.toISOString() }, { state: 'started', late: true, scheduled: '2026-10-21T09:00:00.000Z' })
  const turn = await e.turn(context => context.threadId === runs[0].thread_id)
  assert.match(turn.context.prompt, /late because Kipster was off or the computer was asleep/)
  turn.end()
  assert.equal((await e.db.query('SELECT next_run_at FROM kipster.routines WHERE id=$1', [routine.id])).rows[0].next_run_at.toISOString(), '2026-10-21T14:00:00.000Z')
})

scenario('the daily limit counts every routine of a kip and records skipped times', async e => {
  assert.deepEqual(routineSettings.parse(await e.ok('GET', '/v1/settings/routines')), { version: 1, dailyRunLimit: 50 })
  assert.deepEqual(await e.ok('PUT', '/v1/settings/routines', { version: 1, dailyRunLimit: 2 }), { version: 1, dailyRunLimit: 2 })
  const planner = await e.open(e.planner)
  await planner.call('create_routine', { name: 'A', instructions: 'Do A.', triggers: [{ type: 'every', minutes: 10 }], timeZone: 'UTC' })
  await planner.call('create_routine', { name: 'B', instructions: 'Do B.', triggers: [{ type: 'times', times: ['08:10'] }], timeZone: 'UTC' })
  planner.end()
  await e.tick('2026-10-21T08:10:00Z')
  await e.tick('2026-10-21T08:20:00Z')
  const runs = await e.routineThreads(e.planner)
  assert.deepEqual(runs.map(run => run.state).sort(), ['skipped', 'started', 'started'])
  assert.equal(runs.find(run => run.state === 'skipped').thread_id, null)
})

scenario('pausing stops runs; resuming continues from now without catching up', async e => {
  const planner = await e.open(e.planner)
  const { routine } = await planner.call('create_routine', { name: 'Ping', instructions: 'Ping.', triggers: [{ type: 'every', minutes: 30 }], timeZone: 'UTC' })
  const paused = await planner.call('edit_routine', { routineId: routine.id, enabled: false })
  assert.deepEqual({ enabled: paused.routine.enabled, next: paused.routine.nextRunAt }, { enabled: false, next: null })
  planner.end()
  await e.tick('2026-10-21T10:00:00Z')
  assert.equal((await e.routineThreads(e.planner)).length, 0)
  const resumed = routineResult.parse(await e.ok('PATCH', `/v1/routines/${routine.id}`, { version: 1, enabled: true }))
  assert.equal(resumed.routine.nextRunAt, '2026-10-21T10:30:00.000Z')
})

scenario('kips manage routines of the kips they can message, in that kip\'s chat', async e => {
  const planner = await e.open(e.planner)
  const forResearcher = await planner.call('create_routine', { name: 'Weekly review', instructions: 'Review the week.', triggers: [{ type: 'times', times: ['09:00'], days: ['sat'] }], agentId: e.researcher, timeZone: 'UTC' })
  assert.equal(forResearcher.routine.agentId, e.researcher)
  assert.equal(forResearcher.routine.chatId, await e.chat(e.researcher))
  assert.equal(forResearcher.routine.createdBy, e.planner)
  await assert.rejects(planner.call('create_routine', { name: 'X', instructions: 'X.', triggers: [{ type: 'times', times: ['09:00'] }], agentId: e.scout }), /only your own routines/)
  assert.equal((await planner.call('list_routines', { agentId: e.researcher })).routines.length, 1)
  planner.end()
  const john = await e.open(e.john)
  const forScout = await john.call('create_routine', { name: 'Studio digest', instructions: 'Summarise Studio.', triggers: [{ type: 'times', times: ['18:00'] }], agentId: e.scout, timeZone: 'UTC' })
  assert.deepEqual({ context: forScout.routine.contextKind, workspace: forScout.routine.contextId }, { context: 'organization', workspace: e.studio })
  assert.deepEqual(await john.call('delete_routine', { routineId: forResearcher.routine.id }), { routineId: forResearcher.routine.id, deleted: true })
  john.end()
})

scenario('the person creates, runs now, reads history and deletes a routine over HTTP', async e => {
  const chatId = await e.chat(e.planner)
  const operationId = randomUUID()
  const body = { version: 1, operationId, context: e.contextOf(e.planner), chatId, name: 'Inbox sweep', instructions: 'Sweep the inbox.', triggers: [{ type: 'times', times: ['07:15'] }], timeZone: 'Asia/Kolkata' }
  const { routine } = routineResult.parse(await e.ok('POST', '/v1/routines', body))
  assert.equal((routineResult.parse(await e.ok('POST', '/v1/routines', body))).routine.id, routine.id, 'a repeat returns the first routine')
  assert.equal(routine.nextRunAt, '2026-10-22T01:45:00.000Z')
  assert.equal(routineList.parse(await e.ok('GET', `/v1/routines?agentId=${e.planner}`)).routines.length, 1)
  const bad = await e.call('POST', '/v1/routines', { ...body, operationId: randomUUID(), triggers: [{ type: 'times', times: ['7:15'] }] })
  assert.notEqual(bad.status, 200)

  const start = { version: 1, operationId: randomUUID() }
  const first = routineRunResult.parse(await e.ok('POST', `/v1/routines/${routine.id}/run`, start))
  assert.equal(routineRunResult.parse(await e.ok('POST', `/v1/routines/${routine.id}/run`, start)).run.id, first.run.id, 'a repeat starts nothing new')
  const turn = await e.turn(context => context.threadId === first.run.threadId, 'run now')
  await turn.call('message_user', { text: 'Inbox is clear.', priority: 'normal' })
  turn.end()
  assert.deepEqual(routineRunList.parse(await e.ok('GET', `/v1/routines/${routine.id}/runs`)).runs.map(run => run.id), [first.run.id])
  assert.equal((await e.db.query("SELECT count(*)::int AS n FROM kipster.notifications WHERE thread_id=$1 AND kind='message'", [first.run.threadId])).rows[0].n, 1)

  assert.deepEqual(await e.ok('DELETE', `/v1/routines/${routine.id}`), { version: 1, routineId: routine.id, deleted: true })
  assert.equal(routineList.parse(await e.ok('GET', '/v1/routines')).routines.length, 0)
  const summary = appSnapshot.parse(await e.ok('GET', '/v1/app/snapshot')).threads.find(thread => thread.threadId === first.run.threadId)
  assert.deepEqual(summary.routine, { id: null, name: 'Inbox sweep' }, 'the run\'s thread stays marked')
})

scenario('the timer starts a due routine on its own', async e => {
  const saved = { ...ROUTINE_TIMER }
  Object.assign(ROUTINE_TIMER, { maxSleepMs: 50 })
  try {
    const planner = await e.open(e.planner)
    await planner.call('create_routine', { name: 'Soon', instructions: 'Do it.', triggers: [{ type: 'times', times: ['08:05'] }], timeZone: 'UTC' })
    planner.end()
    e.clock.now = new Date('2026-10-21T08:05:00Z')
    const [run] = await until(() => e.routineThreads(e.planner), runs => runs.length === 1, 'timer run')
    assert.equal(run.state, 'started')
  } finally { Object.assign(ROUTINE_TIMER, saved) }
})

scenario('after a restart Core reads routines from the database and catches up once', async e => {
  const planner = await e.open(e.planner)
  await planner.call('create_routine', { name: 'Digest', instructions: 'Send the digest.', triggers: [{ type: 'times', times: ['09:00', '12:00'] }], timeZone: 'UTC' })
  planner.end()
  await e.dispatcher.close()
  // Core was stopped through both times.
  e.clock.now = new Date('2026-10-21T13:00:00Z')
  e.dispatcher = new TextDispatcher(e.runtime, e.fixture)
  e.host = textPublicationHost(e.dispatcher)
  await e.dispatcher.start()
  const runs = await until(() => e.routineThreads(e.planner), rows => rows.length > 0, 'catch-up run')
  assert.deepEqual(runs.map(run => ({ state: run.state, late: run.late, scheduled: run.scheduled_for.toISOString() })), [{ state: 'started', late: true, scheduled: '2026-10-21T09:00:00.000Z' }])
})
