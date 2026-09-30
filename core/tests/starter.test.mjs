import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { Home } from '../dist/platform/home/public.js'
import { loadMigrations, openRuntime } from '../dist/runtime.js'
import { bootstrap, readDirectory } from '../dist/modules/administration/public.js'
import { playground, playgroundNames } from '../dist/starter/playground.js'
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

/** The directory as names: the organizations, agents, each organization's members and its groups with their members. */
function outline(directory) {
  const agent = id => directory.agents.find(item => item.id === id).name
  const membership = id => agent(directory.memberships.find(item => item.id === id).agentId)
  return {
    organizations: directory.organizations.map(item => item.name),
    agents: directory.agents.map(item => [item.name, item.admin, item.description !== '']),
    members: directory.memberships.map(item => agent(item.agentId)).sort(),
    groups: directory.groups.map(group => [group.name, group.appearances.map(item => membership(item.membershipId))]),
  }
}

const expected = {
  organizations: ['Playground'],
  agents: [['Coach', false, true], ['Kip', true, true], ['Planner', false, true], ['Researcher', false, true], ['Writer', false, true]],
  members: ['Coach', 'Kip', 'Planner', 'Researcher', 'Writer'],
  groups: [['Team', ['Planner', 'Researcher', 'Writer']], ['Personal', ['Coach']]],
}

test('a new installation starts with Playground, Kip and four agents in two groups, with their files', { skip: noDatabase }, async t => {
  const base = await database(t)
  const starter = await playground()
  const { runtime, directory } = await start(base, starter)
  t.after(() => runtime.close())
  const snapshot = await directory()
  assert.deepEqual(outline(snapshot), expected)

  const home = new Home(base.home)
  const byName = name => snapshot.agents.find(item => item.name === name).id
  for (const agent of starter.agents) {
    for (const [file, content] of Object.entries(agent.files)) assert.equal(await readFile(join(home.agent(byName(agent.name)), file), 'utf8'), content)
  }
  for (const [file, content] of Object.entries(starter.rootAgent.files)) assert.equal(await readFile(join(home.agent(runtime.bootstrap.rootAgentId), file), 'utf8'), content)
  assert.equal(await home.organizationInstructions(runtime.bootstrap.organizationId), starter.organization.instructions)
  // Every starter file has real content, not only a heading.
  for (const agent of [starter.rootAgent, ...starter.agents]) for (const content of Object.values(agent.files)) assert.ok(content.trim().split('\n').length > 3)
})

test('an interrupted first start finishes the starter agents on the next start', { skip: noDatabase }, async t => {
  const base = await database(t)
  const starter = await playground()
  // The first start stops after the installation was recorded, before the starter agents got their homes.
  const db = new Postgres(base.url)
  await db.migrate(await loadMigrations())
  await bootstrap(db, new Home(base.home), playgroundNames, starter)
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM kipster.agents WHERE NOT provisioned')).rows[0].n), 4)
  await db.close()

  const { runtime, directory } = await start(base, starter)
  t.after(() => runtime.close())
  assert.deepEqual(outline(await directory()), expected)
})

test('a later start keeps changes to the starter', { skip: noDatabase }, async t => {
  const base = await database(t)
  const starter = await playground()
  const first = await start(base, starter)
  const planner = (await first.directory()).agents.find(item => item.name === 'Planner')
  await first.runtime.db.query('UPDATE kipster.agents SET display_name=$2 WHERE id=$1', [planner.id, 'Navigator'])
  const soul = join(new Home(base.home).agent(planner.id), 'soul.md')
  await writeFile(soul, '# Soul\n\nEdited by the owner.\n')
  await first.runtime.close()

  const second = await start(base, starter)
  t.after(() => second.runtime.close())
  const snapshot = await second.directory()
  assert.deepEqual(snapshot.agents.map(item => item.name), ['Coach', 'Kip', 'Navigator', 'Researcher', 'Writer'])
  assert.equal(snapshot.groups.length, 2)
  assert.equal(await readFile(soul, 'utf8'), '# Soul\n\nEdited by the owner.\n')
})
