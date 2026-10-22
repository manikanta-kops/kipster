import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { textPublicationHost } from '../dist/workflows/text-dispatch.js'
import { adminUrl, noDatabase, taskDataRole } from './support/database.mjs'

const fixtureSettings = { adapterId: 'data-fixture', modelId: 'fixture' }
async function until(read, match, label) {
  for (let n = 0; n < 300; n++) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`Timed out: ${label}`)
}
/** A provider whose turns stay running until the test ends them. */
function adapter() {
  const executions = []
  return {
    id: 'data-fixture', version: '1', contractMajor: 1, executions,
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

test('the admin kip uses any workspace\'s and any kip\'s data tables and vector collections; workspace kips keep their rules', { skip: noDatabase, timeout: 60000 }, async () => {
  const admin = new Postgres(adminUrl), database = `kipsteradmindata_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl); url.pathname = `/${database}`
  const restricted = new URL(url); restricted.username = taskDataRole
  const home = await mkdtemp(join(tmpdir(), 'kipster-admin-data-'))
  let runtime, dispatcher, server, fixture
  try {
    await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
    runtime = await openRuntime({ connectionString: url.href, taskDataConnectionString: restricted.href, home, names: { owner: 'Owner', organization: 'Playground', rootAgent: 'John' },
      embedding: { id: 'fixture-provider', contractMajor: 1, model: 'fixture-one', async embed() { return [1, 0] } } })
    await runtime.vectors.stopIndexing()
    const { installationId, ownerId, organizationId: playground, rootAgentId: john } = runtime.bootstrap
    fixture = adapter(); dispatcher = new TextDispatcher(runtime, fixture)
    server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
    await dispatcher.start()
    const ok = async (method, path, body) => {
      const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.ok(response.ok, `${method} ${path}: ${response.status}`)
      return response.json()
    }
    const studio = (await ok('POST', '/v1/organizations', { version: 1, operationId: randomUUID(), name: 'Studio' })).organization.id
    const scout = (await ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Scout', organizationId: studio })).agent.id
    for (const organization of [playground, studio]) await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1', [organization, JSON.stringify(fixtureSettings)])
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [john, JSON.stringify(fixtureSettings)])
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2', [studio, john])).rows[0].n, 0, 'John is not a Studio member')

    const scope = { installationId, callerId: ownerId }
    const start = async (agentId, context) => {
      const chatId = (await ok('POST', '/v1/direct-chats', { version: 1, context, agentId })).chatId
      const count = fixture.executions.length
      await ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Use the data' }] })
      await until(() => fixture.executions.length, n => n === count + 1, `turn of ${agentId}`)
      return fixture.executions[count].context
    }
    const host = textPublicationHost(dispatcher)
    const tools = attempt => ({
      data: (callId, target, input) => host.invokeTool({ attemptId: attempt, callId, name: 'manage_data_tables', arguments: { target, ...input } }),
      vectors: (callId, target, input) => host.invokeTool({ attemptId: attempt, callId, name: 'manage_vector_collections', arguments: { target, ...input } }),
    })
    const studioTarget = { kind: 'organization', ownerId: studio }, playgroundTarget = { kind: 'organization', ownerId: playground }
    const scoutTarget = { kind: 'agent', ownerId: scout }, johnTarget = { kind: 'agent', ownerId: john }

    // John works in his installation chat, outside every workspace.
    const johnTurn = await start(john, { kind: 'installation', installationId })
    assert.match(johnTurn.tools.find(tool => tool.name === 'manage_data_tables').description, /any workspace/)
    assert.match(johnTurn.tools.find(tool => tool.name === 'manage_vector_collections').description, /any workspace/)
    const asJohn = tools(johnTurn.attemptId)
    for (const [label, target] of [['studio', studioTarget], ['scout', scoutTarget]]) {
      await asJohn.data(`${label}-create`, target, { operation: 'create_table', description: 'Test table', table: 'notes', columns: [{ name: 'note', type: 'text' }] })
      const row = await asJohn.data(`${label}-insert`, target, { operation: 'insert', table: 'notes', values: { note: `${label} note` } })
      await asJohn.data(`${label}-update`, target, { operation: 'update', table: 'notes', id: row.id, values: { note: `${label} note, edited` } })
      assert.deepEqual((await asJohn.data(`${label}-query`, target, { operation: 'query', table: 'notes' })).rows, [{ id: row.id, note: `${label} note, edited` }])
      const collection = await asJohn.vectors(`${label}-collection`, target, { operation: 'create', name: 'notes' })
      assert.equal(collection.actorId, john)
      await asJohn.vectors(`${label}-upsert`, target, { operation: 'upsert', collectionId: collection.collectionId, key: 'one', expectedRevision: 0, text: `${label} vector note` })
      assert.equal((await asJohn.vectors(`${label}-get`, target, { operation: 'get', collectionId: collection.collectionId, key: 'one' })).record.text, `${label} vector note`)
      assert.deepEqual((await asJohn.vectors(`${label}-discover`, target, { operation: 'discover' })).collections.map(item => item.name), ['notes'])
    }
    const receipt = (await runtime.db.query('SELECT actor_id,owner_kind,owner_id FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2', [johnTurn.attemptId, 'studio-insert'])).rows[0]
    assert.deepEqual(receipt, { actor_id: john, owner_kind: 'organization', owner_id: studio })

    // Scout, a Studio kip, keeps today's rules: its own workspace and any live kip's own data, never another workspace.
    const scoutTurn = await start(scout, { kind: 'organization', organizationId: studio })
    assert.doesNotMatch(scoutTurn.tools.find(tool => tool.name === 'manage_data_tables').description, /any workspace/)
    const asScout = tools(scoutTurn.attemptId)
    assert.equal((await asScout.data('scout-reads-studio', studioTarget, { operation: 'query', table: 'notes' })).rows[0].note, 'studio note, edited')
    await assert.rejects(asScout.data('scout-playground', playgroundTarget, { operation: 'discover' }), /Organization target unavailable in this context/)
    await assert.rejects(asScout.vectors('scout-playground-vectors', playgroundTarget, { operation: 'discover' }), /outside active context/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1', [playground])).rows[0].n, 0)
    await asScout.data('scout-john-table', johnTarget, { operation: 'create_table', description: 'Test table', table: 'from_scout', columns: [{ name: 'note', type: 'text' }] })
    await asScout.vectors('scout-john-vectors', johnTarget, { operation: 'discover' })
    // A Studio kip that left Studio keeps its chat but loses the workspace's data.
    await runtime.db.query('DELETE FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2', [studio, scout])
    await assert.rejects(asScout.data('scout-left-studio', studioTarget, { operation: 'discover' }), /not an organization member/)

    // A removed workspace or kip is refused for John too.
    await runtime.db.query('UPDATE kipster.organizations SET provisioned=false WHERE id=$1', [studio])
    await assert.rejects(asJohn.data('removed-studio', studioTarget, { operation: 'discover' }), /Task-data organization unavailable/)
    await assert.rejects(asJohn.vectors('removed-studio-vectors', studioTarget, { operation: 'discover' }), /Vector owner unavailable/)
    await runtime.db.query('UPDATE kipster.organizations SET provisioned=true WHERE id=$1', [studio])
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1', [scout])
    await assert.rejects(asJohn.data('removed-scout', scoutTarget, { operation: 'discover' }), /Task-data owner unavailable/)
    await assert.rejects(asJohn.vectors('removed-scout-vectors', scoutTarget, { operation: 'discover' }), /Vector owner unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1', [scout])

    // The attempt checks stay: a stopped turn of John's reaches nothing.
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1', [johnTurn.attemptId])
    await assert.rejects(asJohn.data('stopped', studioTarget, { operation: 'discover' }), /Attempt no longer owns task data/)
    await assert.rejects(asJohn.vectors('stopped-vectors', studioTarget, { operation: 'discover' }), /no longer owns tools/)
  } finally {
    await fixture?.close(); await dispatcher?.close().catch(() => undefined); await server?.close().catch(() => undefined); await runtime?.close().catch(() => undefined)
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close(); await rm(home, { recursive: true, force: true })
  }
})
