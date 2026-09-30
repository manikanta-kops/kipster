import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { claimOperation } from '../dist/modules/administration/public.js'
import { operationStatus } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// The administration operation engine against real PostgreSQL: bounded, idempotent step batches that
// commit with their progress, waits that never force, and a restart that continues where it stopped.

async function until(read, predicate, label) {
  let value
  for (let i = 0; i < 400; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
}
const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const unused = { id: 'unused', version: '1', contractMajor: 1, async execute() { throw new Error('unused') }, async close() {} }

async function setup(t) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_operations_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-operations-'))
  const ctx = { url: url.href, home, closers: [] }
  t.after(async () => {
    for (const close of ctx.closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return ctx
}

/** Records an operation of `kind` for the owner and queues it, as a service does in one transaction. */
async function submit(runtime, kind, operationId) {
  const { installationId, ownerId } = runtime.bootstrap
  return runtime.db.transaction(async client => {
    const { operation } = await claimOperation(client, { installationId, actorKind: 'person', actorId: ownerId, operationId }, kind, { kind: 'agent', id: randomUUID() }, {})
    await runtime.jobs.send(client, operation.id, 0, 'administration')
    return operation.id
  })
}

async function crash(ctx, rowId, kill) {
  const script = new URL('./fixtures/operation-crash.mjs', import.meta.url).pathname
  const child = spawn(process.execPath, [script, ctx.url, ctx.home, rowId, kill], { stdio: ['ignore', 'ignore', 'inherit'] })
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
}

test('SIGKILL at step boundaries and inside a batch, then restarts, completes the operation once', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t)
  const runtime = await openRuntime({ connectionString: ctx.url, home: ctx.home, names })
  ctx.closers.push(() => runtime.close())
  await runtime.db.query('CREATE TABLE public.engine_effects(step text NOT NULL, item integer NOT NULL, UNIQUE (step, item))')
  await runtime.db.query('CREATE TABLE public.engine_gate(open boolean)')
  const rowId = await submit(runtime, 'test.steps', 'cleanup-1')
  const effects = async () => (await runtime.db.query('SELECT step, item FROM public.engine_effects ORDER BY step, item')).rows.map(row => `${row.step}:${row.item}`)
  const operation = async () => (await runtime.db.query('SELECT state, step, waiting_for, result, error FROM kipster.admin_operations WHERE id=$1', [rowId])).rows[0]

  assert.deepEqual(await crash(ctx, rowId, 'after:collect:2'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await effects(), ['collect:1', 'collect:2', 'collect:3', 'collect:4'], 'two committed batches')
  assert.deepEqual(await operation(), { state: 'running', step: 'collect', waiting_for: null, result: null, error: null })

  assert.deepEqual(await crash(ctx, rowId, 'inside:collect:1'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await effects(), ['collect:1', 'collect:2', 'collect:3', 'collect:4'], 'the interrupted batch left nothing')

  assert.deepEqual(await crash(ctx, rowId, 'after:await:1'), { code: null, signal: 'SIGKILL' })
  assert.deepEqual(await effects(), ['collect:1', 'collect:2', 'collect:3', 'collect:4', 'collect:5'])
  assert.deepEqual(await operation(), { state: 'waiting', step: 'await', waiting_for: 'Waiting for the provider to end', result: { collected: 5 }, error: null })

  await runtime.db.query('INSERT INTO public.engine_gate VALUES (true)')
  assert.deepEqual(await crash(ctx, rowId, 'never'), { code: 0, signal: null })
  assert.deepEqual(await effects(), ['collect:1', 'collect:2', 'collect:3', 'collect:4', 'collect:5', 'finish:1'])
  assert.deepEqual(await operation(), { state: 'succeeded', step: 'finish', waiting_for: null, result: { collected: 5, finished: true }, error: null })

  // A finished operation is not run again after another restart.
  assert.deepEqual(await crash(ctx, rowId, 'never'), { code: 0, signal: null })
  assert.deepEqual(await effects(), ['collect:1', 'collect:2', 'collect:3', 'collect:4', 'collect:5', 'finish:1'])
})

test('a failing batch is retried and a failed step ends the operation; progress is readable by the owner only', { skip: noDatabase, timeout: 60000 }, async t => {
  const ctx = await setup(t)
  const runtime = await openRuntime({ connectionString: ctx.url, home: ctx.home, names })
  ctx.closers.push(() => runtime.close())
  const dispatcher = new TextDispatcher(runtime, unused)
  ctx.closers.push(() => dispatcher.close())
  let attempts = 0
  dispatcher.operations.register('test.flaky', [{ name: 'flaky', async run() { if (++attempts === 1) throw new Error('Temporary failure'); return { status: 'done', result: { attempts } } } }])
  dispatcher.operations.register('test.refused', [{ name: 'check', async run() { return { status: 'failed', error: 'Target changed' } } }, { name: 'never', async run() { throw new Error('unreachable') } }])
  await dispatcher.start()
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
  ctx.closers.push(() => server.close())
  const status = async operationId => { const response = await fetch(`${server.url}/v1/operations/${encodeURIComponent(operationId)}`); return { status: response.status, body: await response.json() } }

  const flaky = await submit(runtime, 'test.flaky', 'flaky op/1')
  const failed = await until(() => status('flaky op/1'), read => read.body.error === 'Temporary failure', 'failure recorded')
  assert.deepEqual([failed.status, failed.body.state], [200, 'pending'], 'the operation stays open for a retry')
  await dispatcher.operations.process(flaky)
  const done = operationStatus.parse((await status('flaky op/1')).body)
  assert.deepEqual([done.operationId, done.kind, done.state, done.step, done.waitingFor, done.result, done.error], ['flaky op/1', 'test.flaky', 'succeeded', 'flaky', null, { attempts: 2 }, null])

  await submit(runtime, 'test.refused', 'refused-1')
  const refused = await until(() => status('refused-1'), read => read.body.state === 'failed', 'refused')
  assert.deepEqual([refused.body.step, refused.body.error], ['check', 'Target changed'])
  assert.deepEqual((await status('unknown')).status, 404)

  // The owner also reads an operation the admin agent started.
  await runtime.db.query(`INSERT INTO kipster.admin_operations(id, installation_id, actor_kind, actor_id, operation_id, kind, state, request) VALUES (gen_random_uuid(), $1, 'agent', $2, 'attempt:call', 'agent.create', 'succeeded', '{}'::jsonb)`, [actor.installationId, runtime.bootstrap.rootAgentId])
  assert.deepEqual([(await status('attempt:call')).status, (await status('attempt:call')).body.kind], [200, 'agent.create'])

  const stranger = randomUUID()
  await runtime.db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [stranger, actor.installationId, 'Stranger'])
  const other = await startTextServer(runtime, { installationId: actor.installationId, personId: stranger }, { host: '127.0.0.1', port: 0, dispatcher })
  ctx.closers.push(() => other.close())
  assert.equal((await fetch(`${other.url}/v1/operations/refused-1`)).status, 403)
})
