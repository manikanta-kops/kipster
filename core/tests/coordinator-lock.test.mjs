import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, match, label) {
  let value
  for (let i = 0; i < 300; i++) { value = await read(); if (match(value)) return value; await sleep(50) }
  throw new Error(`Timed out waiting for ${label}; last ${JSON.stringify(value)}`)
}
function fixture() {
  const handles = []
  return { id: 'lock-adapter', version: '1', contractMajor: 1, handles,
    async execute(context) {
      let finish
      const done = new Promise(resolve => { finish = resolve })
      const handle = {
        context,
        end() { finish({ kind: 'ended', attemptId: context.attemptId }) },
        events: { async *[Symbol.asyncIterator]() { const event = await done; if (event) yield event } },
        cancelled: false,
        async cancel() { handle.cancelled = true; finish(undefined); return { acknowledged: true, confirmedEnded: false } },
        async reconcile() { return 'unknown' },
      }
      handles.push(handle)
      return handle
    },
    async close() { for (const handle of handles) await handle.cancel() } }
}

async function setup(t) {
  const database = `kipsterlock_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-lock-'))
  const opened = []
  const escaped = []
  const observe = error => escaped.push(error)
  process.on('uncaughtException', observe)
  process.on('unhandledRejection', observe)
  t.after(async () => {
    process.off('uncaughtException', observe)
    process.off('unhandledRejection', observe)
    for (const close of opened.reverse()) await close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
    await admin.close()
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names })
  opened.push(() => runtime.close())
  const ids = runtime.bootstrap
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'lock-adapter', modelId: 'model' })])
  const server = await startTextServer(runtime, { installationId: ids.installationId, personId: ids.ownerId }, { host: '127.0.0.1', port: 0 })
  opened.push(() => server.close())
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok(response.ok)
    return response.json()
  }
  const context = { kind: 'installation', installationId: ids.installationId }
  const submit = async text => {
    const chat = await post('/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
    return post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
  }
  const dispatcher = (target, adapter, events, hooks = {}) => {
    const created = new TextDispatcher(target, adapter, undefined, { ...hooks, coordinatorLock: (state, error) => { events.push({ state, error }) } })
    opened.push(() => created.close())
    return created
  }
  const runState = async runId => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).rows[0].state
  const lockHolder = async () => (await admin.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=78315 AND objid=6 AND objsubid=2 AND granted
    AND database=(SELECT oid FROM pg_database WHERE datname=$1)`, [database])).rows[0]?.pid
  const openPeer = async () => {
    const peer = await openRuntime({ connectionString: url.href, home, names })
    opened.push(() => peer.close())
    return peer
  }
  return { url, database, runtime, admin, submit, dispatcher, runState, lockHolder, openPeer, escaped }
}

test('a lost coordinator lock stops new dispatch without crashing, and dispatch resumes after the lock is re-acquired', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const adapter = fixture()
  const events = []
  const dispatcher = ctx.dispatcher(ctx.runtime, adapter, events)
  await dispatcher.start()
  const first = await ctx.submit('in flight across the outage')
  await until(() => adapter.handles.length, n => n === 1, 'first dispatch')

  // Terminate the lock connection and hold the lock from another session, so re-acquisition keeps failing.
  const blocker = new Postgres(ctx.url.href, 1)
  t.after(() => blocker.close())
  const holder = await ctx.lockHolder()
  assert.ok(holder)
  await ctx.admin.query('SELECT pg_terminate_backend($1)', [holder])
  await until(() => events.map(event => event.state), states => states.includes('lost'), 'lock loss report')
  assert.match(events[0].error.message, /terminating connection due to administrator command/)
  await blocker.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query('SELECT pg_advisory_lock(78315, 6)')
  })

  const second = await ctx.submit('submitted while the lock is lost')
  await sleep(2500)
  assert.equal(adapter.handles.length, 1, 'nothing is issued without the lock')
  assert.equal(await ctx.runState(second.runId), 'queued')
  assert.equal(await ctx.runState(first.runId), 'running')
  assert.deepEqual(events.map(event => event.state), ['lost'], 'a lock held elsewhere is not reported as a failure')

  await blocker.query('SELECT pg_advisory_unlock(78315, 6)')
  await until(() => events.map(event => event.state), states => states.includes('restored'), 'lock restored report')
  await until(() => adapter.handles.length, n => n === 2, 'dispatch after re-acquisition')
  assert.equal(await ctx.runState(first.runId), 'running', 'work this process still drives is not recovered as abandoned')
  for (const handle of adapter.handles) handle.end()
  await until(() => Promise.all([ctx.runState(first.runId), ctx.runState(second.runId)]), states => states.every(value => value === 'completed'), 'both runs complete')
  assert.ok(await ctx.lockHolder())
  assert.deepEqual(ctx.escaped, [])
})

test('a second coordinator holding the lock keeps the first stopped, and the first cancels turns the second recovered', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const adapter = fixture()
  const events = []
  const first = ctx.dispatcher(ctx.runtime, adapter, events)
  await first.start()
  const inflight = await ctx.submit('in flight at takeover')
  await until(() => adapter.handles.length, n => n === 1, 'first coordinator dispatch')
  const peer = await ctx.openPeer()
  const peerAdapter = fixture()
  const peerEvents = []
  const second = ctx.dispatcher(peer, peerAdapter, peerEvents)
  await assert.rejects(second.start(), /Text coordinator already active/)

  // The second coordinator takes the lock before the first one's first retry.
  await ctx.admin.query('SELECT pg_terminate_backend($1)', [await ctx.lockHolder()])
  await until(() => ctx.lockHolder(), pid => !pid, 'lock release by the terminated session')
  await second.start()
  assert.equal(await ctx.runState(inflight.runId), 'recovery-needed')
  // The recovered turn has no effect: host calls and settlement require the attempt to be issued. It is cancelled.
  await until(() => adapter.handles[0].cancelled, Boolean, 'recovered turn cancelled')
  const taken = await ctx.submit('handled by the second coordinator')
  await until(() => peerAdapter.handles.length, n => n === 1, 'second coordinator dispatch')
  peerAdapter.handles[0].end()
  await until(() => ctx.runState(taken.runId), value => value === 'completed', 'second coordinator settlement')
  await sleep(2000)
  assert.equal(adapter.handles.length, 1, 'the first coordinator stays stopped')
  assert.equal(await ctx.runState(inflight.runId), 'recovery-needed', 'the cancelled turn settles nothing')
  assert.deepEqual(events.map(event => event.state), ['lost'])

  await second.close()
  await until(() => events.map(event => event.state), states => states.includes('restored'), 'first coordinator restored')
  const resumed = await ctx.submit('handled by the first coordinator again')
  await until(() => adapter.handles.length, n => n === 2, 'first coordinator dispatch')
  adapter.handles[1].end()
  await until(() => ctx.runState(resumed.runId), value => value === 'completed', 'first coordinator settlement')
  assert.equal(peerAdapter.handles.length, 1)
  assert.deepEqual(peerEvents, [])
  assert.deepEqual(ctx.escaped, [])
})

test('closing while the lock is lost fences owned work and returns promptly', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const adapter = fixture()
  const events = []
  const dispatcher = ctx.dispatcher(ctx.runtime, adapter, events)
  await dispatcher.start()
  const owned = await ctx.submit('owned when the lock is lost')
  await until(() => adapter.handles.length, n => n === 1, 'dispatch')
  const blocker = new Postgres(ctx.url.href, 1)
  t.after(() => blocker.close())
  await ctx.admin.query('SELECT pg_terminate_backend($1)', [await ctx.lockHolder()])
  await blocker.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query('SELECT pg_advisory_lock(78315, 6)')
  })
  await until(() => events.length, n => n === 1, 'lock loss report')
  await sleep(1200)
  const started = Date.now()
  await dispatcher.close()
  assert.ok(Date.now() - started < 1000, `close took ${Date.now() - started} ms`)
  assert.equal(await ctx.runState(owned.runId), 'recovery-needed')
  assert.equal(await ctx.lockHolder(), (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  assert.deepEqual(events.map(event => event.state), ['lost'])
  assert.deepEqual(ctx.escaped, [])
})

test('after every database session is terminated, as on a server restart, text is accepted and dispatched without restarting Core', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const adapter = fixture()
  const events = []
  const dispatcher = ctx.dispatcher(ctx.runtime, adapter, events)
  await dispatcher.start()
  const before = await ctx.submit('before the outage')
  await until(() => adapter.handles.length, n => n === 1, 'dispatch before the outage')
  adapter.handles[0].end()
  await until(() => ctx.runState(before.runId), value => value === 'completed', 'completion before the outage')

  await ctx.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [ctx.database])
  await until(() => events.map(event => event.state), states => states.includes('restored'), 'coordinator restored')
  assert.ok(ctx.runtime.jobs.error, 'the queue observed the outage')
  const after = await ctx.submit('after the outage')
  assert.ok(after.runId, JSON.stringify(after))
  await until(() => adapter.handles.length, n => n === 2, 'dispatch after the outage')
  adapter.handles[1].end()
  await until(() => ctx.runState(after.runId), value => value === 'completed', 'completion after the outage')
  assert.equal(ctx.runtime.jobs.error, null)
  assert.deepEqual(ctx.escaped, [])
})

test('a lock lost without any connection error is caught in SQL before a claim or an issue', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  // Simulate a silently dropped lock connection: the dispatcher is never told about the loss.
  const acquire = ctx.runtime.db.acquireCoordinatorLock.bind(ctx.runtime.db)
  ctx.runtime.db.acquireCoordinatorLock = () => acquire()
  const adapter = fixture()
  const events = []
  let release
  const held = new Promise(resolve => { release = resolve })
  let claims = 0
  const dispatcher = ctx.dispatcher(ctx.runtime, adapter, events, { afterClaim: async () => { if (++claims === 1) await held } })
  await dispatcher.start()
  const preparing = await ctx.submit('claimed before the loss')
  await until(() => ctx.runState(preparing.runId), value => value === 'preparing', 'first claim')

  const blocker = new Postgres(ctx.url.href, 1)
  t.after(() => blocker.close())
  await ctx.admin.query('SELECT pg_terminate_backend($1)', [await ctx.lockHolder()])
  await blocker.transaction(async client => {
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query('SELECT pg_advisory_lock(78315, 6)')
  })
  assert.deepEqual(events, [], 'no connection event reached the dispatcher')

  const queued = await ctx.submit('submitted after the silent loss')
  await until(() => events.map(event => event.state), states => states.includes('lost'), 'loss found by the claim check')
  assert.match(events[0].error.message, /no longer held/)
  release()
  await until(() => ctx.runState(preparing.runId), value => value === 'queued', 'issue refused')
  await sleep(1500)
  assert.equal(adapter.handles.length, 0, 'nothing is issued')
  assert.equal(claims, 1, 'nothing else is claimed')
  assert.equal(await ctx.runState(queued.runId), 'queued')

  await blocker.query('SELECT pg_advisory_unlock(78315, 6)')
  await until(() => events.map(event => event.state), states => states.includes('restored'), 'lock restored')
  await until(() => adapter.handles.length, n => n === 2, 'both runs dispatched')
  for (const handle of adapter.handles) handle.end()
  await until(() => Promise.all([ctx.runState(preparing.runId), ctx.runState(queued.runId)]), states => states.every(value => value === 'completed'), 'both runs complete')
  assert.deepEqual(ctx.escaped, [])
})
