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
import { threadMessage } from '../dist/protocol/index.js'
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

const retiredMemoryTables = ['memory_records', 'memory_sources', 'memory_provenance', 'memory_index_intents', 'memory_tool_receipts', 'memory_relationship_owner_versions',
  'memory_relationships', 'memory_relationship_changes', 'memory_relationship_evidence', 'maintenance_sources', 'maintenance_candidate_claims', 'maintenance_scheduler',
  'memory_activity', 'memory_sleeps', 'maintenance_runs', 'maintenance_operator_intents', 'memory_promotions', 'memory_profiles', 'memory_embedding_generations']
const embedded = { thread_chunks: ['embedding'], cards: ['embedding'], diary: ['embedding'] }

/** The Kip memory schema of decision record 10 is present and the first engine's tables are gone. */
async function assertMemorySchema(db) {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='kipster' AND (table_name LIKE 'memory%' OR table_name LIKE 'maintenance%' OR table_name IN ('thread_chunks','cards','card_sources','diary','embedding_profiles','embedding_generations')) ORDER BY table_name")).rows.map(row => row.table_name)
  assert.deepEqual(tables, ['card_sources', 'cards', 'diary', 'embedding_generations', 'embedding_profiles', 'memory_calls', 'memory_nights', 'memory_thread_state', 'thread_chunks'])
  const owned = (await db.query("SELECT table_name FROM information_schema.columns WHERE table_schema='kipster' AND column_name='installation_id' AND is_nullable='NO' AND table_name IN ('memory_thread_state','thread_chunks','cards','card_sources','diary','memory_nights','memory_calls') ORDER BY table_name")).rows.map(row => row.table_name)
  assert.deepEqual(owned, ['card_sources', 'cards', 'diary', 'memory_calls', 'memory_nights', 'memory_thread_state', 'thread_chunks'])
  for (const name of retiredMemoryTables) assert.equal((await db.query('SELECT to_regclass($1) AS name', [`kipster.${name}`])).rows[0].name, null, name)
  assert.equal((await db.query("SELECT to_regprocedure('kipster.memory_strength(real,integer,bigint)') AS name")).rows[0].name, null)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='kipster' AND column_name='maintenance_counter'")).rows[0].n, 0)
  for (const [table, columns] of Object.entries(embedded)) for (const column of columns) {
    const row = (await db.query(`SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname=$2`, [`kipster.${table}`, column])).rows[0]
    assert.deepEqual(row, { type: 'vector(768)', required: false }, `${table}.${column}`)
    const model = (await db.query('SELECT a.attnotnull AS required FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname=$2', [`kipster.${table}`, 'embedding_model'])).rows[0]
    assert.deepEqual(model, { required: false }, `${table}.embedding_model`)
  }
  const hnsw = (await db.query("SELECT tablename FROM pg_indexes WHERE schemaname='kipster' AND indexdef LIKE '%USING hnsw (embedding vector_cosine_ops)%' ORDER BY tablename")).rows.map(row => row.tablename)
  assert.deepEqual(hnsw, ['cards', 'diary', 'thread_chunks'])
  const current = (await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname='kipster' AND indexname IN ('cards_current','cards_core') ORDER BY indexname")).rows.map(row => row.indexdef)
  assert.match(current[0], /WHERE \(\(valid_to IS NULL\) AND core\)/)
  assert.match(current[1], /WHERE \(valid_to IS NULL\)/)
  // A diary page belongs to one context; a null summary marks a page owing a rebuild.
  const diary = (await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='kipster' AND table_name='diary' AND column_name IN ('organization_id','summary') ORDER BY column_name`)).rows
  assert.deepEqual(diary, [{ column_name: 'organization_id', data_type: 'uuid', is_nullable: 'YES' }, { column_name: 'summary', data_type: 'text', is_nullable: 'YES' }])
  const keys = (await db.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='kipster.diary'::regclass AND contype IN ('p','u','f') ORDER BY conname`)).rows
  assert.deepEqual(keys.filter(key => key.conname === 'diary_page'), [{ conname: 'diary_page', definition: 'UNIQUE NULLS NOT DISTINCT (agent_id, day, organization_id)' }])
  assert.ok(keys.some(key => /FOREIGN KEY \(organization_id\) REFERENCES kipster\.organizations\(id\) ON DELETE CASCADE/.test(key.definition)))
  assert.ok(!keys.some(key => key.conname === 'diary_pkey'))
}

// Seed only with SQL supported by the frozen 001–012 schema, before current Core starts.
async function seed(db, firstEngine) {
  const ids = Object.fromEntries(['installationId', 'ownerId', 'organizationId', 'rootAgentId', 'chatId', 'threadId', 'messageId', 'answerId', 'memoryId', 'sleepId', 'runId', 'attemptId'].map(key => [key, randomUUID()]))
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
    // A base that already replaced the first memory engine has none of its state to seed.
    if (!firstEngine) return
    await client.query("INSERT INTO kipster.memory_records(id,installation_id,scope,owner_id,kind,text,source_hash) VALUES ($1,$2,'agent',$3,'fact',$4,$5)", [ids.memoryId, ids.installationId, ids.rootAgentId, memoryText, checksum(memoryText)])
    await client.query('INSERT INTO kipster.memory_sources(memory_id,revision,text,source_hash) VALUES ($1,1,$2,$3)', [ids.memoryId, memoryText, checksum(memoryText)])
    // The first memory engine's other state, including a sleep run that holds an execution permit.
    await client.query("INSERT INTO kipster.memory_profiles(installation_id,provider,model) VALUES ($1,'fixture-provider','old-model')", [ids.installationId])
    await client.query("INSERT INTO kipster.memory_embedding_generations(installation_id,generation,provider,model) VALUES ($1,1,'fixture-provider','old-model')", [ids.installationId])
    await client.query('INSERT INTO kipster.memory_provenance(id,memory_id,source_thread_id,author_id) VALUES ($1,$2,$3,$4)', [randomUUID(), ids.memoryId, ids.threadId, ids.ownerId])
    await client.query("INSERT INTO kipster.memory_index_intents(memory_id,source_revision,source_hash,generation,status,embedding,dimension) VALUES ($1,1,$2,1,'ready','[1,0]',2)", [ids.memoryId, checksum(memoryText)])
    await client.query("INSERT INTO kipster.memory_activity(agent_id,active_days,active_on) VALUES ($1,3,'2026-10-01')", [ids.rootAgentId])
    await client.query("INSERT INTO kipster.memory_sleeps(id,agent_id,sleep_on,step) VALUES ($1,$2,'2026-10-01','consolidate')", [ids.sleepId, ids.rootAgentId])
    await client.query("INSERT INTO kipster.work_intents(id,installation_id,state,generation) VALUES ($1,$2,'issued',1)", [ids.runId, ids.installationId])
    await client.query("INSERT INTO kipster.attempts(id,intent_id,generation,incarnation,state) VALUES ($1,$2,1,$3,'issued')", [ids.attemptId, ids.runId, randomUUID()])
    await client.query("INSERT INTO kipster.maintenance_runs(id,installation_id,agent_id,state,current_attempt_id,task_kind,sleep_id,input) VALUES ($1,$2,$3,'running',$4,'consolidate',$5,'{}'::jsonb)", [ids.runId, ids.installationId, ids.rootAgentId, ids.attemptId, ids.sleepId])
    await client.query('INSERT INTO kipster.execution_permits(installation_id,maintenance_counter) VALUES ($1,7)', [ids.installationId])
    await client.query('INSERT INTO kipster.owned_permits(attempt_id,installation_id) VALUES ($1,$2)', [ids.attemptId, ids.installationId])
    await client.query("INSERT INTO kipster.memory_promotions(agent_id,memories) VALUES ($1,'[]'::jsonb)", [ids.rootAgentId])
  })
  return { ids, settings, parts, memoryText }
}

for (const prefixOnly of [false, true]) {
  test(prefixOnly ? 'a populated frozen 001–012 database applies a real SQL suffix and starts Core' : 'a populated PR-base database with old memory upgrades with this branch and Core reads the retained data', { skip: noDatabase }, async t => {
    const fixture = await database(t)
    const ref = process.env.KIPSTER_MIGRATION_BASE ?? 'origin/next'
    const manifest = await readMigrationManifest(root, ref)
    const base = manifest.filter(file => !prefixOnly || file.number <= 12).map(file => ({ version: file.version, sql: file.contents.toString('utf8') }))
    t.diagnostic(`Base migrations read from git ${ref}${prefixOnly ? ' (001–012)' : ''}; ${base.length} applied before seeding.`)
    await fixture.db.migrate(base)
    const firstEngine = (await fixture.db.query("SELECT to_regclass('kipster.memory_records') IS NOT NULL AS present")).rows[0].present
    const saved = await seed(fixture.db, firstEngine)
    const current = await loadMigrations()
    if (prefixOnly) assert.ok(current.length > base.length, 'exercise actual forward SQL, even when this PR adds no schema change')
    await fixture.db.migrate(current)
    const runtime = await openRuntime({ ...fixture, names: { owner: 'New name', organization: 'New name', rootAgent: 'New name' } })
    try {
      const { ids, settings, parts } = saved
      assert.deepEqual(runtime.bootstrap, { installationId: ids.installationId, ownerId: ids.ownerId, organizationId: ids.organizationId, rootAgentId: ids.rootAgentId })
      const actor = await trustedOwner(runtime.db)
      assert.deepEqual(actor, { installationId: ids.installationId, personId: ids.ownerId })
      const message = await messageRecord(runtime.db, ids.messageId)
      assert.deepEqual([message.threadId, message.authorId, message.parts, message.position, message.final], [ids.threadId, ids.ownerId, parts, 1, true])
      assert.deepEqual((await messageRecord(runtime.db, ids.answerId)).parts, [{ kind: 'text', text: 'A saved answer.' }])
      const snapshot = await readSettings(runtime.db, actor)
      assert.deepEqual(snapshot.agents.find(agent => agent.id === ids.rootAgentId).settings, settings)
      // The first memory engine is gone with its work and permits; its embedding profile stays for vector collections.
      await assertMemorySchema(runtime.db)
      if (firstEngine) {
        assert.deepEqual((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n, 0)
        assert.deepEqual((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.attempts WHERE id=$1', [ids.attemptId])).rows[0].n, 0)
        assert.deepEqual((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.work_intents WHERE id=$1', [ids.runId])).rows[0].n, 0)
        assert.deepEqual((await runtime.db.query('SELECT provider,model,generation FROM kipster.embedding_profiles WHERE installation_id=$1', [ids.installationId])).rows, [{ provider: 'fixture-provider', model: 'old-model', generation: '1' }])
        assert.deepEqual((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.embedding_generations WHERE installation_id=$1', [ids.installationId])).rows[0].n, 1)
      }
      assert.deepEqual(await history(runtime.db), current.map(item => ({ version: item.version, checksum: checksum(item.sql) })))
      assert.equal((await runtime.db.query('SELECT display_name FROM kipster.people WHERE id=$1', [ids.ownerId])).rows[0].display_name, 'Existing owner')
      assert.equal((await runtime.db.query("SELECT to_regnamespace('kipster_jobs') IS NOT NULL AS started")).rows[0].started, true)
    } finally { await runtime.close() }
  })
}

test(
  'message times upgrade final rows and retained replay without finalizing drafts',
  { skip: noDatabase },
  async (t) => {
    const fixture = await database(t)
    const migrations = await loadMigrations()
    await fixture.db.migrate(migrations.filter((item) => item.version < '030'))
    const { ids } = await seed(fixture.db, false)
    const draftId = randomUUID()
    await fixture.db.query(
      'INSERT INTO kipster.messages(id,thread_id,position,author_id,parts,final) VALUES ($1,$2,3,$3,$4::jsonb,false)',
      [
        draftId,
        ids.threadId,
        ids.rootAgentId,
        JSON.stringify([{ kind: 'text', text: 'unfinished' }]),
      ],
    )
    const rows = (
      await fixture.db.query(
        'SELECT id,thread_id,author_id,parts,final,position FROM kipster.messages ORDER BY position',
      )
    ).rows
    // Replay includes an earlier draft of the now-final answer as well as a still-live draft.
    const events = [rows[0], { ...rows[1], final: false }, rows[1], rows[2]]
    for (const [index, row] of events.entries()) {
      await fixture.db.query(
        'INSERT INTO kipster.thread_events(thread_id,position,event_id,type,resource_id,revision,data) VALUES ($1,$2,$3,$4,$5,1,$6::jsonb)',
        [
          ids.threadId,
          index + 1,
          randomUUID(),
          row.final ? 'message-final' : 'message-draft',
          row.id,
          JSON.stringify({
            id: row.id,
            threadId: row.thread_id,
            authorId: row.author_id,
            parts: row.parts,
            final: row.final,
            revision: 1,
            position: Number(row.position),
          }),
        ],
      )
    }
    await fixture.db.migrate(migrations)
    for (const id of [ids.messageId, ids.answerId]) {
      const final = threadMessage.parse(await messageRecord(fixture.db, id))
      assert.equal(final.finishedAt, final.createdAt)
    }
    const draft = threadMessage.parse(await messageRecord(fixture.db, draftId))
    assert.equal(Object.hasOwn(draft, 'finishedAt'), false)
    assert.equal(
      (
        await fixture.db.query(
          'SELECT finished_at FROM kipster.messages WHERE id=$1',
          [draftId],
        )
      ).rows[0].finished_at,
      null,
    )
    for (const { data } of (
      await fixture.db.query(
        'SELECT data FROM kipster.thread_events ORDER BY position',
      )
    ).rows) {
      const entry = threadMessage.parse(data)
      assert.equal(
        entry.createdAt,
        (await messageRecord(fixture.db, entry.id)).createdAt,
      )
      assert.equal(Object.hasOwn(entry, 'finishedAt'), entry.final)
      if (entry.final) assert.equal(entry.finishedAt, entry.createdAt)
    }
  },
)

test('kip messaging replaces delegation: existing runs start their own chain and hidden threads become visible', { skip: noDatabase }, async t => {
  const fixture = await database(t)
  const migrations = await loadMigrations()
  await fixture.db.migrate(migrations.filter(item => item.version < '033'))
  const { ids } = await seed(fixture.db, false)
  const helper = randomUUID(), hidden = randomUUID()
  await fixture.db.query("INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,'settled')", [ids.runId, ids.installationId])
  await fixture.db.query("INSERT INTO kipster.text_runs(id,thread_id,input_message_id,state,queue_position) VALUES ($1,$2,$3,'completed',1)", [ids.runId, ids.threadId, ids.messageId])
  await fixture.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [helper, ids.installationId, 'Helper'])
  await fixture.db.query('INSERT INTO kipster.threads(id,chat_id,internal) VALUES ($1,$2,true)', [hidden, ids.chatId])
  await fixture.db.query(`INSERT INTO kipster.delegations(id,installation_id,origin_thread_id,root_run_id,parent_run_id,ordinal,call_id,sender_agent_id,recipient_agent_id,context_kind,context_id,responsible_human_id,depth,request,state)
    VALUES ($1,$2,$3,$4,$4,1,'call',$5,$6,'organization',$7,$8,1,'Check','completed')`, [randomUUID(), ids.installationId, ids.threadId, ids.runId, ids.rootAgentId, helper, ids.organizationId, ids.ownerId])
  await fixture.db.migrate(migrations)
  const run = (await fixture.db.query('SELECT trigger_kind,chain_root_id,chain_depth,responsible_person_id,answered_at FROM kipster.text_runs WHERE id=$1', [ids.runId])).rows[0]
  assert.deepEqual(run, { trigger_kind: 'person', chain_root_id: ids.runId, chain_depth: 0, responsible_person_id: ids.ownerId, answered_at: null })
  const exists = async name => (await fixture.db.query('SELECT to_regclass($1) AS name', [name])).rows[0].name
  assert.deepEqual([await exists('kipster.delegations'), await exists('kipster.delegation_calls')], [null, null])
  assert.equal((await fixture.db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='kipster' AND table_name='threads' AND column_name='internal'")).rows[0].n, 0)
  assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM kipster.threads WHERE id=$1', [hidden])).rows[0].n, 1)
  for (const table of ['kipster.kip_links', 'kipster.kip_message_calls']) assert.equal(await exists(table), table.replace('kipster.', 'kipster.'))
})

test('a fresh database gets the Kip memory schema and none of the first engine', { skip: noDatabase }, async t => {
  const fixture = await database(t)
  await fixture.db.migrate(await loadMigrations())
  await assertMemorySchema(fixture.db)
})

test('an upgrade from the 025 diary keeps single-context pages in their context and deletes pages that mix contexts', { skip: noDatabase }, async t => {
  const fixture = await database(t)
  const migrations = await loadMigrations()
  await fixture.db.migrate(migrations.filter(item => Number(item.version.slice(0, 3)) <= 25))
  const id = () => randomUUID()
  const [installation, owner, agent, organization, homeChat, orgChat, home, work, gone] = Array.from({ length: 9 }, id)
  await fixture.db.transaction(async client => {
    await client.query('INSERT INTO kipster.installations(id) VALUES ($1)', [installation])
    await client.query('INSERT INTO kipster.people(id,installation_id,display_name) VALUES ($1,$2,$3)', [owner, installation, 'Owner'])
    await client.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [agent, installation, 'Kip'])
    await client.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [organization, installation, 'Garden'])
    await client.query("INSERT INTO kipster.direct_chats(id,installation_id,caller_id,context_kind,context_id,agent_id) VALUES ($1,$2,$3,'installation',$2,$4),($5,$2,$3,'organization',$6,$4)", [homeChat, installation, owner, agent, orgChat, organization])
    await client.query('INSERT INTO kipster.threads(id,chat_id) VALUES ($1,$2),($3,$4)', [home, homeChat, work, orgChat])
    const page = (day, threadIds) => client.query('INSERT INTO kipster.diary(agent_id,day,installation_id,summary,thread_ids,embedding,embedding_model) VALUES ($1,$2,$3,$4,$5::uuid[],$6::vector,$7)',
      [agent, day, installation, `Page of ${day}`, threadIds, `[${new Array(768).fill(0.1).join(',')}]`, 'fake-gemma'])
    await page('2026-10-01', [home])
    await page('2026-10-02', [work, work])
    await page('2026-10-03', [home, work])
    await page('2026-10-04', [gone])
  })
  await fixture.db.migrate(migrations)
  const pages = (await fixture.db.query('SELECT day::text AS day, organization_id, summary, thread_ids, embedding_model FROM kipster.diary ORDER BY day')).rows
  assert.deepEqual(pages, [
    { day: '2026-10-01', organization_id: null, summary: 'Page of 2026-10-01', thread_ids: [home], embedding_model: 'fake-gemma' },
    { day: '2026-10-02', organization_id: organization, summary: 'Page of 2026-10-02', thread_ids: [work, work], embedding_model: 'fake-gemma' },
  ], 'a mixed page and a page of no surviving thread are deleted')
  // The day now has a page per context, and one page per context only.
  await fixture.db.query("INSERT INTO kipster.diary(agent_id,day,installation_id,organization_id,summary,thread_ids) VALUES ($1,'2026-10-01',$2,$3,'Garden page',ARRAY[$4::uuid])", [agent, installation, organization, work])
  await assert.rejects(fixture.db.query("INSERT INTO kipster.diary(agent_id,day,installation_id,summary) VALUES ($1,'2026-10-01',$2,'Second installation page')", [agent, installation]), /diary_page/)
  await assert.rejects(fixture.db.query("UPDATE kipster.diary SET summary=NULL WHERE day='2026-10-02'"), /diary_owed_unembedded/, 'a page owing a rebuild has no embedding')
  await assertMemorySchema(fixture.db)
})

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
