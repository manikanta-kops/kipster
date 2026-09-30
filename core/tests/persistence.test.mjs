import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Postgres } from '../dist/platform/postgres/public.js'
import { loadMigrations, openRuntime } from '../dist/runtime.js'
import { Home } from '../dist/platform/home/public.js'
import { Jobs } from '../dist/platform/jobs/public.js'
import { trustedOwner, requireOrganizationMember } from '../dist/modules/identity/public.js'
import { bootstrap } from '../dist/modules/administration/public.js'
import { addMembership, changeSettings } from '../dist/modules/administration/public.js'
import { resolveSettings } from '../dist/modules/settings/public.js'
import { acceptIntent, claimPreparation, issueAttempt, markUncertain } from '../dist/modules/work/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const catalog = { complete: true, adapters: [{ id: 'codex', models: [{ id: 'm1', efforts: ['high'] }, { id: 'm2', efforts: [] }] }] }

test('real PostgreSQL persistence, identity, jobs and settings', { skip: noDatabase }, async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kipster_persistence-home-'))
  const admin = new Postgres(adminUrl)
  const database = `kipster_persistence_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl)
  isolated.pathname = `/${database}`
  const db = new Postgres(isolated.href)
  const peer = new Postgres(isolated.href)
  const home = new Home(homeDir)
  const jobs = new Jobs(isolated.href)
  try {
    const migrations = await loadMigrations()
    await Promise.all([db.migrate(migrations), peer.migrate(migrations)])
    await db.migrate(migrations)
    const retro = [{ version: '000_retro.sql', sql: 'CREATE TABLE kipster.retro(id int);' }, ...migrations]
    await assert.rejects(db.migrate(retro), /not a prefix/)
    assert.equal((await db.query("SELECT to_regclass('kipster.retro') AS name")).rows[0].name, null)
    await assert.rejects(db.migrate([{ ...migrations[0], sql: migrations[0].sql + '\n-- changed' }, ...migrations.slice(1)]), /Changed applied migration/)
    await assert.rejects(db.migrate([...migrations, { version: 'zzz_bad.sql', sql: 'CREATE TABLE kipster.bad_migration(id int); SELECT 1/0;' }]), /division by zero/)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM kipster.schema_migrations")).rows[0].n, migrations.length)
    const absent = await db.query("SELECT to_regclass('kipster.bad_migration') AS name")
    assert.equal(absent.rows[0].name, null)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='vector'")).rows[0].n, 1)
    const names = { owner: 'Owner', organization: 'One', rootAgent: 'Root' }
    const blockedSeed = join(homeDir, 'system', 'instructions.md')
    await mkdir(blockedSeed, { recursive: true })
    await assert.rejects(bootstrap(db, home, names), /Unsafe home file/)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.bootstrap')).rows[0].n, 1)
    assert.equal((await db.query('SELECT provisioned FROM kipster.agents')).rows[0].provisioned, false)
    await rm(blockedSeed, { recursive: true })
    const child = spawn(process.execPath, [new URL('./fixtures/bootstrap-crash.mjs', import.meta.url).pathname, isolated.href, homeDir], { stdio: 'ignore' })
    const death = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
    assert.equal(death.signal, 'SIGKILL')
    assert.equal((await db.query('SELECT provisioned FROM kipster.agents')).rows[0].provisioned, false)
    assert.equal(await readFile(join(homeDir, 'system', 'instructions.md'), 'utf8'), '# Kipster system\n\nKipster calls its agents kips. The words mean the same thing: people may say either, and a kip is an agent.\n')
    await writeFile(join(homeDir, 'system', 'instructions.md'), 'authored system instructions\n')
    const [first, second] = await Promise.all([bootstrap(db, home, names), bootstrap(peer, home, names)])
    assert.deepEqual(first, second)
    const owner = await trustedOwner(db)
    assert.deepEqual(owner, { installationId: first.installationId, personId: first.ownerId })
    const otherPerson = randomUUID()
    await db.query('INSERT INTO kipster.people VALUES ($1,$2,$3)', [otherPerson, first.installationId, 'Other'])
    await db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [first.organizationId, otherPerson])
    await assert.rejects(changeSettings(db, { installationId: first.installationId, personId: otherPerson }, randomUUID(), 'agent', first.rootAgentId, { modelId: { set: 'm1' } }), /denied/)
    await assert.rejects(requireOrganizationMember(db, { installationId: first.installationId, personId: otherPerson }, first.organizationId), /denied/)
    const agentFile = join(home.agent(first.rootAgentId), 'AGENTS.md')
    await writeFile(agentFile, 'authored instructions\n')
    await bootstrap(db, home, { owner: 'Changed', organization: 'Changed', rootAgent: 'Changed' })
    assert.equal(await readFile(agentFile, 'utf8'), 'authored instructions\n')
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.agents')).rows[0].n, 1)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.people')).rows[0].n, 2)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.bootstrap')).rows[0].n, 1)
    const wrong = new Home(await mkdtemp(join(tmpdir(), 'kipster_persistence-wrong-')))
    await wrong.initialize(randomUUID())
    await assert.rejects(wrong.initialize(first.installationId), /another installation/)
    await rm(wrong.root, { recursive: true, force: true })
    const secondOrg = randomUUID()
    await db.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [secondOrg, first.installationId, 'Two'])
    await db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [secondOrg, first.ownerId])
    await addMembership(db, owner, randomUUID(), secondOrg, first.rootAgentId)
    await home.provisionOrganization(secondOrg)
    assert.deepEqual(await readdir(join(homeDir, 'agents')), [first.rootAgentId])
    await changeSettings(db, owner, randomUUID(), 'organization', first.organizationId, { adapterId: { set: 'codex' }, modelId: { set: 'm1' }, effort: { set: 'high' }, options: { set: { opaque: 1 } } })
    await changeSettings(db, owner, randomUUID(), 'organization', secondOrg, { adapterId: { set: 'codex' }, modelId: { set: 'm2' } })
    await changeSettings(db, owner, randomUUID(), 'agent', first.rootAgentId, { adapterId: { set: 'codex' }, modelId: { set: 'm1' } })
    let resolved = await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, catalog)
    assert.equal(resolved.status, 'ready')
    assert.equal(resolved.settings.effort, 'high')
    assert.deepEqual(resolved.settings.options, { opaque: 1 })
    assert.equal(resolved.source.modelId, 'agent')
    assert.equal(resolved.instructions.agent, 'authored instructions\n')
    assert.equal(resolved.instructions.system, 'authored system instructions\n')
    await writeFile(join(home.organization(first.organizationId), 'instructions.md'), 'fresh organization instructions\n')
    resolved = await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, catalog)
    assert.equal(resolved.instructions.organization, 'fresh organization instructions\n')
    resolved = await resolveSettings(db, home, owner, first.rootAgentId, secondOrg, catalog)
    assert.equal(resolved.status, 'ready')
    assert.equal(resolved.settings.modelId, 'm1')
    assert.equal(resolved.instructions.agent, 'authored instructions\n')
    assert.equal(resolved.instructions.soul, (await home.instructions(first.rootAgentId, first.organizationId)).soul)
    assert.notEqual(resolved.instructions.organization, (await home.instructions(first.rootAgentId, first.organizationId)).organization)
    const root = await resolveSettings(db, home, owner, first.rootAgentId, null, catalog)
    assert.equal(root.status, 'ready')
    await changeSettings(db, owner, randomUUID(), 'agent', first.rootAgentId, { modelId: { clear: true } })
    assert.equal((await resolveSettings(db, home, owner, first.rootAgentId, null, catalog)).status, 'missing')
    resolved = await resolveSettings(db, home, owner, first.rootAgentId, secondOrg, catalog)
    assert.equal(resolved.settings.modelId, 'm2')
    assert.equal(resolved.source.modelId, 'organization')
    await changeSettings(db, owner, randomUUID(), 'organization', first.organizationId, { effort: { clear: true } })
    resolved = await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, catalog)
    assert.equal(resolved.settings.effort, undefined)
    assert.deepEqual(resolved.settings.options, { opaque: 1 })
    await rm(join(homeDir, 'system', 'instructions.md'))
    assert.equal((await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, catalog)).status, 'missing')
    await writeFile(join(homeDir, 'system', 'instructions.md'), 'restored system instructions\n')
    await changeSettings(db, owner, randomUUID(), 'agent', first.rootAgentId, { modelId: { set: 'missing' } })
    assert.equal((await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, catalog)).status, 'incompatible')
    assert.equal((await resolveSettings(db, home, owner, first.rootAgentId, first.organizationId, null)).status, 'unknown-catalog')
    await assert.rejects(changeSettings(db, owner, randomUUID(), 'agent', first.rootAgentId, { bogus: { set: 'x' } }), /Unknown settings field/)
    await assert.rejects(requireOrganizationMember(db, owner, randomUUID()), /denied/)
    const escaped = await mkdtemp(join(tmpdir(), 'kipster_persistence-escape-'))
    const linkId = randomUUID()
    await symlink(escaped, home.agent(linkId))
    await assert.rejects(home.provisionAgent(linkId), /Unsafe home directory/)
    assert.deepEqual(await readdir(escaped), [])
    await rm(home.agent(linkId))
    const savedAgents = join(homeDir, 'agents_saved')
    await rename(join(homeDir, 'agents'), savedAgents)
    await symlink(escaped, join(homeDir, 'agents'))
    await assert.rejects(home.provisionAgent(randomUUID()), /Unsafe home directory/)
    assert.deepEqual(await readdir(escaped), [])
    await rm(join(homeDir, 'agents'))
    await rename(savedAgents, join(homeDir, 'agents'))
    await rm(escaped, { recursive: true })
    await jobs.start()
    const deniedId = randomUUID()
    await assert.rejects(db.transaction(client => acceptIntent(client, jobs, owner, deniedId, async () => { throw new Error('denied') })), /denied/)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.receipts')).rows[0].n, 0)
    const id = randomUUID()
    const [accepted, duplicate] = await Promise.all([db.transaction(client => acceptIntent(client, jobs, owner, id, async () => {})), peer.transaction(client => acceptIntent(client, jobs, owner, id, async () => {}))])
    assert.equal(accepted.intentId, duplicate.intentId)
    assert.equal([accepted.alreadyAccepted, duplicate.alreadyAccepted].filter(Boolean).length, 1)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.work_intents')).rows[0].n, 1)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n, 1)
    const again = await db.transaction(client => acceptIntent(client, jobs, owner, id, async () => {}))
    assert.equal(again.intentId, accepted.intentId)
    assert.equal(again.alreadyAccepted, true)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n, 1)
    const attempt = await db.transaction(client => claimPreparation(client, accepted.intentId, randomUUID()))
    assert.ok(attempt)
    assert.equal(attempt.state, 'preparing')
    const replacement = await db.transaction(client => claimPreparation(client, accepted.intentId, randomUUID()))
    assert.ok(replacement)
    assert.equal(await db.transaction(client => issueAttempt(client, attempt)), false)
    assert.equal(await db.transaction(client => issueAttempt(client, replacement)), true)
    assert.equal(await db.transaction(client => markUncertain(client, replacement)), true)
    assert.equal(await db.transaction(client => claimPreparation(client, accepted.intentId, randomUUID())), null)
    assert.equal((await db.query('SELECT state FROM kipster.work_intents WHERE id=$1', [accepted.intentId])).rows[0].state, 'uncertain')
    const before = (await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n
    await assert.rejects(db.transaction(async client => {
      await client.query('INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,$3)', [randomUUID(), first.installationId, 'queued'])
      await jobs.send(client, randomUUID())
      throw new Error('rollback')
    }), /rollback/)
    const after = (await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n
    assert.equal(before, after)
    await db.query('CREATE TABLE kipster.test_canonical (intent_id uuid PRIMARY KEY, body text NOT NULL)')
    const composedId = randomUUID()
    await assert.rejects(db.transaction(async client => {
      await acceptIntent(client, jobs, owner, composedId, async () => {}, async (sameClient, intentId) => {
        await sameClient.query('INSERT INTO kipster.test_canonical VALUES ($1,$2)', [intentId, 'first'])
        return { messageId: 'first' }
      })
      throw new Error('rollback after canonical write and enqueue')
    }), /rollback after canonical/)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.test_canonical')).rows[0].n, 0)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.receipts')).rows[0].n, 1)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n, before)
    const composed = await db.transaction(client => acceptIntent(client, jobs, owner, composedId, async () => {}, async (sameClient, intentId) => {
      await sameClient.query('INSERT INTO kipster.test_canonical VALUES ($1,$2)', [intentId, 'second'])
      return { messageId: 'original-message' }
    }))
    const repeated = await db.transaction(client => acceptIntent(client, jobs, owner, composedId, async () => {}, async () => { throw new Error('duplicate callback must not run') }))
    assert.equal(repeated.intentId, composed.intentId)
    assert.equal(repeated.messageId, 'original-message')
    assert.equal(repeated.alreadyAccepted, true)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster.test_canonical')).rows[0].n, 1)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM kipster_jobs.job')).rows[0].n, before + 1)
    // Interrupted private seed write is not published as an authoritative file.
    const additional = randomUUID()
    const base = home.agent(additional)
    await mkdir(base, { recursive: true })
    await writeFile(join(base, 'AGENTS.md.interrupted.tmp'), 'partial')
    await home.provisionAgent(additional)
    assert.equal(await readFile(join(base, 'AGENTS.md'), 'utf8'), '# Agent instructions\n')
  } finally {
    await jobs.stop()
    await db.close()
    await peer.close()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})

test('a server-terminated idle connection is discarded without crashing, and close waits for sockets', { skip: noDatabase }, async () => {
  const admin = new Postgres(adminUrl)
  const database = `kipster_persistence_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl)
  isolated.pathname = `/${database}`
  const lost = []
  const escaped = []
  const observe = error => escaped.push(error)
  process.on('uncaughtException', observe)
  process.on('unhandledRejection', observe)
  const db = new Postgres(isolated.href, 3, undefined, async error => { lost.push(error); throw new Error('observer failure') })
  const sessions = async () => (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n
  const sockets = () => process.getActiveResourcesInfo().filter(kind => kind === 'TCPSocketWrap').length
  const adminSockets = sockets()
  try {
    await Promise.all([1, 2, 3].map(() => db.query('SELECT pg_sleep(0.05)')))
    assert.equal(await sessions(), 3)
    const terminated = await admin.query('SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity WHERE datname=$1', [database])
    assert.deepEqual(terminated.rows.map(row => row.done), [true, true, true])
    for (let i = 0; i < 250 && lost.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lost.length, 3)
    for (const error of lost) {
      assert.match(error.message, /terminating connection due to administrator command/)
      assert.equal('client' in error, false)
    }
    assert.equal((await db.query('SELECT 1 AS one')).rows[0].one, 1)
    await db.transaction(client => client.query('SELECT 1'))
    await db.close()
    assert.equal(sockets(), adminSockets, 'close resolves after pooled sockets close')
    assert.equal(await sessions(), 0)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(escaped, [])
  } finally {
    process.off('uncaughtException', observe)
    process.off('unhandledRejection', observe)
    await db.close()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
  }
})

test('the runtime reports connections lost while idle through onError', { skip: noDatabase }, async () => {
  const admin = new Postgres(adminUrl)
  const database = `kipster_persistence_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(adminUrl)
  isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_persistence-runtime-'))
  const reported = []
  let runtime
  try {
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'One', rootAgent: 'Root' }, onError: async error => { reported.push(error); throw new Error('observer failure') } })
    const pids = (await Promise.all([1, 2].map(() => runtime.db.query('SELECT pg_backend_pid() AS pid, pg_sleep(0.05)')))).map(result => result.rows[0].pid)
    assert.equal(new Set(pids).size, 2)
    await admin.query('SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid', [pids])
    for (let i = 0; i < 250 && reported.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(reported.length, 2)
    for (const error of reported) {
      assert.match(error.message, /terminating connection due to administrator command/)
      assert.equal('client' in error, false)
    }
    assert.equal((await runtime.db.query('SELECT 1 AS one')).rows[0].one, 1)
  } finally {
    await runtime?.close()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    await admin.close()
    await rm(home, { recursive: true, force: true })
  }
})
