import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, AdapterRegistry, textPublicationHost } from '../dist/runtime.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const fixture = `export function createAdapter(host){return {id:'disconnect-fixture',version:'1',contractMajor:1,
  async readiness(){return {ready:true,catalog:{models:[{id:'test'}],supportedOptions:[],capabilities:{text:true,publication:true,cancellation:true,steering:false,nativeResume:false}}}},
  async execute(context){void host.invokeTool({attemptId:context.attemptId,callId:'publication-1',name:'conversation.publish',arguments:{text:'PERSISTED_BEFORE_DISCONNECT'}}).catch(()=>{});
    return {events:(async function*(){await new Promise(()=>{})})(),async cancel(){return {acknowledged:false,confirmedEnded:false}},async reconcile(){return 'unknown'}}},
  async close(){}}}`
async function waitFor(read, predicate) {
  for (let n = 0; n < 100; n++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('Timed out waiting for adapter disconnect state')
}

test('committed tool publication survives runner disconnect, restart does not replay and shutdown is bounded', { skip: noDatabase, timeout: 30000 }, async () => {
  const database = `kipster_disconnectipc_${randomUUID().replaceAll('-', '')}`
  const admin = new Postgres(adminUrl)
  const isolated = new URL(adminUrl); isolated.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster_disconnect-ipc-home-'))
  const installation = await mkdtemp(join(tmpdir(), 'kipster_disconnect-ipc-install-'))
  let runtime, registry, dispatcher, server, repeated, nextRuntime, nextRegistry, nextDispatcher
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let committed
  const committedPromise = new Promise(resolve => { committed = resolve })
  try {
    await admin.query(`CREATE DATABASE "${database}"`)
    await mkdir(join(installation, 'dist'))
    await writeFile(join(installation, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(installation, 'dist/index.mjs'), fixture)
    runtime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, executionLimit: 1 })
    const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [runtime.bootstrap.rootAgentId, JSON.stringify({ adapterId: 'disconnect-fixture', modelId: 'test' })])
    const publication = textPublicationHost({ publishToolText: (...args) => dispatcher.publishToolText(...args) })
    registry = new AdapterRegistry({ now: publication.now, async invokeTool(request) { const result = await publication.invokeTool(request); committed(result); await barrier; return result } }, join(home, 'generations'))
    await registry.register('disconnect-fixture', installation, 'dist/index.mjs')
    dispatcher = new TextDispatcher(runtime, registry)
    server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0 })
    const post = async (path, body) => (await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
    const context = { kind: 'installation', installationId: actor.installationId }
    const chat = await post('/v1/direct-chats', { version: 1, context, agentId: runtime.bootstrap.rootAgentId })
    await dispatcher.start()
    const receipt = await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'publish once' }] })
    const publicationResult = await Promise.race([committedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Publication did not commit')), 10000))])
    assert.equal(publicationResult.status, 'completed')
    registry.current.get('disconnect-fixture').child.disconnect()
    release()
    const snapshot = await waitFor(async () => (await fetch(server.url + `/v1/threads/${receipt.threadId}/snapshot`)).json(), value => value.work[0]?.state === 'recovery-needed')
    assert.equal(snapshot.messages.filter(message => message.parts[0]?.text === 'PERSISTED_BEFORE_DISCONNECT').length, 1)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS count FROM kipster.owned_permits')).rows[0].count, 1)
    const closeStart = Date.now()
    await dispatcher.close(); await registry.close(); await server.close(); await runtime.close()
    assert.ok(Date.now() - closeStart < 5000)
    dispatcher = registry = server = runtime = undefined
    nextRuntime = await openRuntime({ connectionString: isolated.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, executionLimit: 1 })
    nextRegistry = new AdapterRegistry({ now: publication.now, async invokeTool() { throw new Error('Replay is forbidden') } }, join(home, 'next-generations'))
    await nextRegistry.register('disconnect-fixture', installation, 'dist/index.mjs')
    nextDispatcher = new TextDispatcher(nextRuntime, nextRegistry)
    await nextDispatcher.start()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal((await nextRuntime.db.query('SELECT count(*)::int AS count FROM kipster.attempts WHERE intent_id=$1', [receipt.runId])).rows[0].count, 1)
    assert.equal((await nextRuntime.db.query('SELECT count(*)::int AS count FROM kipster.messages WHERE source_attempt_id=(SELECT current_attempt_id FROM kipster.text_runs WHERE id=$1) AND publication_source=$2', [receipt.runId, 'tool'])).rows[0].count, 1)
  } finally {
    release?.()
    await nextDispatcher?.close(); await nextRegistry?.close(); await nextRuntime?.close()
    await dispatcher?.close(); await registry?.close(); await server?.close(); await runtime?.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close()
    await rm(home, { recursive: true, force: true })
    await rm(installation, { recursive: true, force: true })
  }
})
