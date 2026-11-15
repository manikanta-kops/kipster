import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { Home } from '../dist/platform/home/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { playgroundNames } from '../dist/starter/playground.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// What first-run onboarding needs from Core, over HTTP against real PostgreSQL: the person's name, the onboarding
// state and the starter kips the person picks.

const fixtureSettings = { adapterId: 'onboarding-fixture', modelId: 'fixture' }
/** A provider that records each execution and ends it at once. */
function adapter() {
  const executions = []
  return {
    id: 'onboarding-fixture', version: '1', contractMajor: 1, executions,
    async execute(context) {
      executions.push(context)
      const events = { async *[Symbol.asyncIterator]() { yield { attemptId: context.attemptId, kind: 'ended', confirmed: true } } }
      return { events, async cancel() { return { acknowledged: true, confirmedEnded: true } }, async reconcile() { return 'ended' } }
    },
    async close() {},
  }
}

async function environment(t) {
  const admin = new Postgres(adminUrl), url = new URL(adminUrl)
  const database = `kipster_onboarding_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-onboarding-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: playgroundNames, executionLimit: 4 })
  const fixture = adapter(), dispatcher = new TextDispatcher(runtime, fixture)
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  await dispatcher.start()
  t.after(async () => {
    await dispatcher.close().catch(() => undefined); await server.close().catch(() => undefined); await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined); await admin.close(); await rm(home, { recursive: true, force: true })
  })
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  const ok = async (method, path, body) => {
    const reply = await call(method, path, body)
    assert.equal(reply.status, 200, `${method} ${path}: ${JSON.stringify(reply.data)}`)
    return reply.data
  }
  return { runtime, fixture, home, installationId, organizationId, rootAgentId, call, ok }
}

test('the person sets their name; the next kip turn names them with it', { skip: noDatabase, timeout: 60000 }, async t => {
  const e = await environment(t)
  assert.deepEqual(await e.ok('GET', '/v1/settings/person'), { version: 1, name: 'Owner' })
  assert.deepEqual(await e.ok('PUT', '/v1/settings/person', { version: 1, name: '  Sam Rivera  ' }), { version: 1, name: 'Sam Rivera' })
  assert.deepEqual(await e.ok('GET', '/v1/settings/person'), { version: 1, name: 'Sam Rivera' })
  const blank = await e.call('PUT', '/v1/settings/person', { version: 1, name: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(blank.data.code, 'invalid')
  assert.deepEqual(await e.ok('GET', '/v1/settings/person'), { version: 1, name: 'Sam Rivera' })

  await e.runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [e.rootAgentId, JSON.stringify(fixtureSettings)])
  const context = { kind: 'installation', installationId: e.installationId }
  const { chatId } = await e.ok('POST', '/v1/direct-chats', { version: 1, context, agentId: e.rootAgentId })
  const submitted = await e.call('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: e.installationId, callerId: (await e.ok('GET', '/v1/bootstrap')).callerId },
    target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Hello' }] })
  assert.equal(submitted.status, 202, JSON.stringify(submitted.data))
  for (let n = 0; n < 300 && !e.fixture.executions.length; n++) await new Promise(resolve => setTimeout(resolve, 30))
  assert.match(e.fixture.executions[0]?.prompt ?? '', /^Current message \[[^\]]+\] from Sam Rivera \(the person\):\nHello$/m)
})

test('onboarding is not finished on a fresh install and keeps its first completion time', { skip: noDatabase }, async t => {
  const e = await environment(t)
  assert.deepEqual(await e.ok('GET', '/v1/settings/onboarding'), { version: 1, completed: false, completedAt: null })
  const first = await e.ok('POST', '/v1/settings/onboarding/complete', { version: 1 })
  assert.equal(first.completed, true)
  assert.ok(Date.parse(first.completedAt) <= Date.now(), first.completedAt)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await e.ok('POST', '/v1/settings/onboarding/complete', { version: 1 }), first)
  assert.deepEqual(await e.ok('GET', '/v1/settings/onboarding'), first)
})

test('the person picks starter kips; exactly those are created in the organization with their identity files', { skip: noDatabase }, async t => {
  const e = await environment(t)
  const catalog = await e.ok('GET', '/v1/starters')
  assert.deepEqual(catalog.starters.map(item => [item.key, item.name]), [['planner', 'Planner'], ['researcher', 'Researcher'], ['writer', 'Writer'], ['coach', 'Coach']])
  assert.ok(catalog.starters.every(item => item.description.length > 20))

  const request = { version: 1, operationId: 'onboarding-starters', organizationId: e.organizationId, keys: ['writer', 'planner'] }
  const created = await e.ok('POST', '/v1/starters', request)
  assert.deepEqual(created.created.map(item => [item.operationId, item.agent.name, item.membership.organizationId, item.alreadyApplied]), [
    ['onboarding-starters:writer', 'Writer', e.organizationId, false], ['onboarding-starters:planner', 'Planner', e.organizationId, false]])

  const directory = await e.ok('GET', '/v1/directory')
  const members = directory.memberships.filter(item => item.organizationId === e.organizationId).map(item => directory.agents.find(agent => agent.id === item.agentId).name)
  assert.deepEqual(members.sort(), ['Kip', 'Planner', 'Writer'])
  assert.deepEqual(directory.agents.map(item => item.name), ['Kip', 'Planner', 'Writer'])
  const home = new Home(e.home)
  for (const item of created.created) {
    const key = item.operationId.split(':').at(-1)
    for (const file of ['soul.md', 'identity.md']) {
      const source = await readFile(new URL(`../dist/starter/playground/${key}/${file}`, import.meta.url), 'utf8')
      assert.equal(await readFile(join(home.agent(item.agent.id), file), 'utf8'), source, `${key}/${file}`)
    }
  }

  // A retry returns the same kips, and an unknown key is refused.
  const again = await e.ok('POST', '/v1/starters', request)
  assert.deepEqual(again.created.map(item => [item.agent.id, item.alreadyApplied]), created.created.map(item => [item.agent.id, true]))
  const unknown = await e.call('POST', '/v1/starters', { ...request, operationId: 'other', keys: ['astronaut'] })
  assert.equal(unknown.status, 400)
  assert.equal((await e.ok('GET', '/v1/directory')).agents.length, 3)
})
