import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { readMigrationManifest } from '../scripts/check-migrations.mjs'
import { Postgres } from '../dist/platform/postgres/public.js'
import { loadMigrations, openRuntime } from '../dist/runtime.js'
import { messageRecord } from '../dist/modules/conversations/public.js'
import { trustedOwner } from '../dist/modules/identity/public.js'
import { readSettings } from '../dist/modules/settings/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const command = promisify(execFile)
const checksum = sql => createHash('sha256').update(sql).digest('hex')
const history = async db => (await db.query('SELECT version, checksum FROM kipster.schema_migrations ORDER BY version')).rows

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_migrations_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const db = new Postgres(url.href)
  // Keep the host's control socket path within Unix socket limits.
  const home = await mkdtemp('/tmp/kipster-migrations-home-')
  t.after(async () => {
    await db.close()
    try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`) } finally { await admin.close(); await rm(home, { recursive: true, force: true }) }
  })
  return { db, connectionString: url.href, home }
}

// Seed only with SQL supported by the frozen 001–012 schema, before current Core starts.
async function seed(db) {
  const ids = Object.fromEntries(['installationId', 'ownerId', 'organizationId', 'rootAgentId', 'chatId', 'threadId', 'messageId', 'answerId', 'memoryId'].map(key => [key, randomUUID()]))
  const settings = { adapterId: 'saved-adapter', modelId: 'saved-model', options: { temperature: 0.25 } }
  const parts = [{ kind: 'text', text: 'Keep this conversation across the upgrade — café.' }]
  const memoryText = 'A retained fact from before the upgrade.'
  await db.transaction(async client => {
    await client.query('INSERT INTO kipster.installations(id) VALUES ($1)', [ids.installationId])
    await client.query('INSERT INTO kipster.people(id,installation_id,display_name) VALUES ($1,$2,$3)', [ids.ownerId, ids.installationId, 'Existing owner'])
    await client.query('INSERT INTO kipster.agents(id,installation_id,display_name,settings,provisioned) VALUES ($1,$2,$3,$4::jsonb,true)', [ids.rootAgentId, ids.installationId, 'Existing Kip', JSON.stringify(settings)])
    await client.query('INSERT INTO kipster.agent_roles(agent_id,role) VALUES ($1,$2)', [ids.rootAgentId, 'root-admin'])
    await client.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [ids.organizationId, ids.installationId, 'Existing organization'])
    await client.query('INSERT INTO kipster.human_memberships(organization_id,person_id) VALUES ($1,$2)', [ids.organizationId, ids.ownerId])
    await client.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)', [ids.organizationId, ids.rootAgentId])
    await client.query('INSERT INTO kipster.bootstrap(installation_id,owner_id,initial_organization_id,root_agent_id) VALUES ($1,$2,$3,$4)', [ids.installationId, ids.ownerId, ids.organizationId, ids.rootAgentId])
    await client.query("INSERT INTO kipster.direct_chats(id,installation_id,caller_id,context_kind,context_id,agent_id) VALUES ($1,$2,$3,'organization',$4,$5)", [ids.chatId, ids.installationId, ids.ownerId, ids.organizationId, ids.rootAgentId])
    await client.query('INSERT INTO kipster.threads(id,chat_id,next_message_position) VALUES ($1,$2,3)', [ids.threadId, ids.chatId])
    await client.query('INSERT INTO kipster.messages(id,thread_id,position,author_id,parts) VALUES ($1,$2,1,$3,$4::jsonb),($5,$2,2,$6,$7::jsonb)', [ids.messageId, ids.threadId, ids.ownerId, JSON.stringify(parts), ids.answerId, ids.rootAgentId, JSON.stringify([{ kind: 'text', text: 'A saved answer.' }])])
    await client.query("INSERT INTO kipster.memory_records(id,installation_id,scope,owner_id,kind,text,source_hash) VALUES ($1,$2,'agent',$3,'fact',$4,$5)", [ids.memoryId, ids.installationId, ids.rootAgentId, memoryText, checksum(memoryText)])
    await client.query('INSERT INTO kipster.memory_sources(memory_id,revision,text,source_hash) VALUES ($1,1,$2,$3)', [ids.memoryId, memoryText, checksum(memoryText)])
  })
  return { ids, settings, parts, memoryText }
}

for (const prefixOnly of [false, true]) {
  test(prefixOnly ? 'a populated frozen 001–012 database applies a real SQL suffix and starts Core' : 'a populated PR-base database upgrades with this branch and Core reads the retained data', { skip: noDatabase }, async t => {
    const fixture = await database(t)
    const ref = process.env.KIPSTER_MIGRATION_BASE ?? 'origin/next'
    const manifest = await readMigrationManifest(root, ref)
    const base = manifest.filter(file => !prefixOnly || file.number <= 12).map(file => ({ version: file.version, sql: file.contents.toString('utf8') }))
    t.diagnostic(`Base migrations read from git ${ref}${prefixOnly ? ' (001–012)' : ''}; ${base.length} applied before seeding.`)
    await fixture.db.migrate(base)
    const saved = await seed(fixture.db)
    const current = await loadMigrations()
    if (prefixOnly) assert.ok(current.length > base.length, 'exercise actual forward SQL, even when this PR adds no schema change')
    await fixture.db.migrate(current)
    const runtime = await openRuntime({ ...fixture, names: { owner: 'New name', organization: 'New name', rootAgent: 'New name' } })
    try {
      const { ids, settings, parts, memoryText } = saved
      assert.deepEqual(runtime.bootstrap, { installationId: ids.installationId, ownerId: ids.ownerId, organizationId: ids.organizationId, rootAgentId: ids.rootAgentId })
      const actor = await trustedOwner(runtime.db)
      assert.deepEqual(actor, { installationId: ids.installationId, personId: ids.ownerId })
      const message = await messageRecord(runtime.db, ids.messageId)
      assert.deepEqual([message.threadId, message.authorId, message.parts, message.position, message.final], [ids.threadId, ids.ownerId, parts, 1, true])
      assert.deepEqual((await messageRecord(runtime.db, ids.answerId)).parts, [{ kind: 'text', text: 'A saved answer.' }])
      const snapshot = await readSettings(runtime.db, actor)
      assert.deepEqual(snapshot.agents.find(agent => agent.id === ids.rootAgentId).settings, settings)
      assert.deepEqual((await runtime.db.query('SELECT text,source_hash FROM kipster.memory_records WHERE id=$1', [ids.memoryId])).rows, [{ text: memoryText, source_hash: checksum(memoryText) }])
      assert.deepEqual(await history(runtime.db), current.map(item => ({ version: item.version, checksum: checksum(item.sql) })))
      assert.equal((await runtime.db.query('SELECT display_name FROM kipster.people WHERE id=$1', [ids.ownerId])).rows[0].display_name, 'Existing owner')
      assert.equal((await runtime.db.query("SELECT to_regnamespace('kipster_jobs') IS NOT NULL AS started")).rows[0].started, true)
    } finally { await runtime.close() }
  })
}

for (const kind of ['newer', 'changed', 'out-of-prefix']) {
  test(`migration, runtime and host plainly refuse ${kind} history before applying SQL`, { skip: noDatabase }, async t => {
    const fixture = await database(t)
    const migrations = await loadMigrations()
    await fixture.db.migrate(migrations)
    const nextNumber = Number(migrations.at(-1).version.slice(0, 3)) + 1
    const future = `${String(nextNumber).padStart(3, '0')}_future.sql`
    let message
    if (kind === 'newer') {
      await fixture.db.query('INSERT INTO kipster.schema_migrations(version,checksum) VALUES ($1,$2)', [future, checksum('SELECT 1;')])
      message = `This database was upgraded by a newer Kipster Core (migration ${future}). Install that version or restore a backup.`
    } else if (kind === 'changed') {
      await fixture.db.query('UPDATE kipster.schema_migrations SET checksum=$2 WHERE version=$1', [migrations.at(-1).version, checksum('different SQL')])
      message = `This database's applied migration ${migrations.at(-1).version} differs from this Kipster Core. Install the Core version that applied it or restore a backup. For schema fixes, add a new migration instead of editing ${migrations.at(-1).version.slice(0, 3)}.`
    } else {
      await fixture.db.query('DELETE FROM kipster.schema_migrations WHERE version=$1', [migrations[1].version])
      message = `This database has an incomplete or out-of-order migration history (migration ${migrations[2].version}; expected ${migrations[1].version}). Install a Core version matching this database or restore a backup.`
    }
    const before = await history(fixture.db)
    const probe = { version: `${String(nextNumber + 1).padStart(3, '0')}_probe.sql`, sql: 'CREATE TABLE kipster.should_not_be_created(id int);' }
    await assert.rejects(fixture.db.migrate([...migrations, probe]), { name: 'MigrationHistoryError', message })
    await assert.rejects(openRuntime({ ...fixture, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' } }), { name: 'MigrationHistoryError', message })
    assert.deepEqual(await history(fixture.db), before)
    assert.equal((await fixture.db.query("SELECT to_regclass('kipster.should_not_be_created') AS name")).rows[0].name, null)
    assert.equal((await fixture.db.query("SELECT to_regnamespace('kipster_jobs') AS name")).rows[0].name, null)
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM kipster.bootstrap')).rows[0].n, 0)
    assert.deepEqual(await readdir(fixture.home), [])
    const config = join(fixture.home, 'host.json')
    await writeFile(config, JSON.stringify({ version: 1, home: fixture.home, databaseUrl: fixture.connectionString, listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [] }))
    for (const action of ['setup', 'serve']) {
      await assert.rejects(command(process.execPath, [fileURLToPath(new URL('../dist/host.js', import.meta.url)), action, '--config', config], { timeout: 10000 }), error => {
        assert.equal(error.code, 1)
        assert.equal(error.stderr.trim(), message)
        assert.equal(error.stdout, '')
        return true
      })
    }
    assert.deepEqual(await history(fixture.db), before)
    assert.deepEqual(await readdir(fixture.home), ['host.json'])
  })
}
