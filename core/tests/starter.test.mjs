import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { Home } from '../dist/platform/home/public.js'
import { openRuntime } from '../dist/runtime.js'
import { readDirectory } from '../dist/modules/administration/public.js'
import { playground, playgroundNames } from '../dist/starter/playground.js'
import { deleteRoutine, hostTimeZone, listRoutines } from '../dist/modules/routines/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// The Playground starter a new installation begins with, against real PostgreSQL.

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_starter_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-starter-home-'))
  t.after(async () => {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return { url: url.href, home }
}

async function start(base, starter) {
  const runtime = await openRuntime({ connectionString: base.url, home: base.home, names: playgroundNames, starter })
  const { installationId, ownerId } = runtime.bootstrap
  return { runtime, directory: () => readDirectory(runtime.db, { installationId, personId: ownerId }) }
}

test('a new installation starts with the owner, Playground and the admin kip with its files, and no other kips or groups', { skip: noDatabase }, async t => {
  const base = await database(t)
  const starter = await playground()
  const { runtime, directory } = await start(base, starter)
  t.after(() => runtime.close())
  const snapshot = await directory()
  const { ownerId, organizationId, rootAgentId } = runtime.bootstrap
  assert.deepEqual((await runtime.db.query('SELECT id, display_name FROM kipster.people')).rows, [{ id: ownerId, display_name: 'Owner' }])
  assert.deepEqual(snapshot.organizations.map(item => [item.id, item.name]), [[organizationId, 'Playground']])
  assert.deepEqual(snapshot.agents.map(item => [item.id, item.name, item.admin]), [[rootAgentId, 'Kip', true]])
  assert.deepEqual(snapshot.memberships.map(item => item.agentId), [rootAgentId])
  assert.deepEqual(snapshot.groups, [])
  assert.equal(Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.agents')).rows[0].n), 1)
  assert.equal(Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.routines')).rows[0].n), 2)

  const home = new Home(base.home)
  for (const [file, content] of Object.entries(starter.rootAgent.files)) assert.equal(await readFile(join(home.agent(rootAgentId), file), 'utf8'), content)
  assert.equal(await home.organizationInstructions(organizationId), starter.organization.instructions)
  // Every starter file has real content, not only a heading.
  for (const content of Object.values(starter.rootAgent.files)) assert.ok(content.trim().split('\n').length > 3)
})

test('a new installation gives the admin kip a morning check-in and an evening wrap-up in the host time zone', { skip: noDatabase }, async t => {
  const base = await database(t)
  const first = await start(base, await playground())
  const { installationId, ownerId, rootAgentId } = first.runtime.bootstrap
  const owner = { installationId, personId: ownerId }
  try {
    const routines = await listRoutines(first.runtime.db, owner)
    assert.deepEqual(routines.map(item => [item.name, item.agentId, item.contextKind, item.triggers, item.timeZone, item.enabled]), [
      ['Morning check-in', rootAgentId, 'installation', [{ type: 'times', times: ['08:00'] }], hostTimeZone(), true],
      ['Evening wrap-up', rootAgentId, 'installation', [{ type: 'times', times: ['18:00'] }], hostTimeZone(), true],
    ])
    assert.ok(routines.every(item => item.nextRunAt), 'both are scheduled')
    assert.match(routines[0].instructions, /still unanswered after two days or more/)
    assert.match(routines[1].instructions, /priority silent/)
    // A routine the person deleted stays deleted on later starts.
    await deleteRoutine(first.runtime.db, owner, routines[0].id)
  } finally { await first.runtime.close() }
  const again = await start(base, await playground())
  t.after(() => again.runtime.close())
  assert.deepEqual((await listRoutines(again.runtime.db, owner)).map(item => item.name), ['Evening wrap-up'])
})
