import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
async function until(read, predicate, label) {
 for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 30)) }
 throw Error(`Timed out: ${label}`)
}
async function setup(t) {
 const admin = new Postgres(adminUrl), name = `kipster_process_${randomUUID().replaceAll('-', '')}`
 await admin.query(`CREATE DATABASE "${name}"`)
 const url = new URL(adminUrl); url.pathname = `/${name}`
 const home = await mkdtemp(join(tmpdir(), 'kipster-process-'))
 const owned = []; let runtime, dispatcher, server
 const ctx = { url, home, owned, get runtime() { return runtime }, get dispatcher() { return dispatcher }, get server() { return server },
  async open(embedding) { runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }, ...(embedding ? { embedding } : {}) }); return runtime },
  async close() { await server?.close(); server = undefined; await dispatcher?.close(); dispatcher = undefined; await runtime?.close(); runtime = undefined },
  async serve() {
   const base = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
   const handles = []
   const adapter = { ...base, handles, async readiness() { const ready = await base.readiness(); return { ...ready, catalog: { ...ready.catalog, models: [{ id: 'fixture-model' }, { id: 'fixture-current' }] } } }, async execute(context) { const handle = await base.execute(context); handles.push(handle); return handle } }
   dispatcher = new TextDispatcher(runtime, adapter)
   server = await startTextServer(runtime, { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
   await dispatcher.start(); return adapter
  },
  child(mode) {
   const child = spawn(process.execPath, [new URL('./fixtures/release-crash.mjs', import.meta.url).pathname, mode, url.href, home], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
   const messages = []; let output = ''
   child.on('message', m => messages.push(m)); child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
   const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
   const entry = { child, exited, async wait(stage) { return until(() => { if (child.exitCode !== null || child.signalCode !== null) throw Error(output || 'fixture exited'); return messages.find(m => m.stage === stage) }, Boolean, stage) }, async kill() { child.kill('SIGKILL'); assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' }); assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }) } }
   owned.push(entry); return entry
  }
 }
 t.after(async () => { for (const e of owned) if (e.child.exitCode === null && e.child.signalCode === null) { e.child.kill('SIGKILL'); await e.exited }; await ctx.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.close(); await rm(home, { recursive: true, force: true }) })
 return ctx
}
const post = async (url, path, data) => { const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok, `${path}: ${response.status}`); return response.json() }
for (const mode of ['streaming', 'waiting', 'asking']) test(`SIGKILL while ${mode} preserves durable work without blind execution`, { skip: noDatabase, timeout: 60000 }, async t => {
 const ctx = await setup(t); let runtime = await ctx.open(); const ids = runtime.bootstrap
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
 await ctx.close()
 const child = ctx.child(mode), { url } = await child.wait('ready')
 const context = { kind: 'installation', installationId: ids.installationId }
 const chat = await post(url, '/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
 const request = { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Durable input' }] }
 const receipt = await post(url, '/v1/text/submissions', request)
 const { context: attempt } = await child.wait('executing')
 await until(async () => (await (await fetch(url + `/v1/threads/${receipt.threadId}/snapshot`)).json()).messages, rows => rows.some(m => m.parts.some(p => p.text === 'Persisted partial output')), 'saved streaming output')
 let card
 if (mode !== 'streaming') {
  card = (await child.wait('question')).card
  await until(async () => (await (await fetch(url + `/v1/threads/${receipt.threadId}/snapshot`)).json()).work, rows => rows.some(r => r.state === 'waiting'), 'durable wait')
 }
 await child.kill()
 runtime = await ctx.open(); assert.deepEqual(runtime.bootstrap, ids)
 const adapter = await ctx.serve()
 const snapshot = await (await fetch(ctx.server.url + `/v1/threads/${receipt.threadId}/snapshot`)).json()
 assert.ok(snapshot.messages.some(m => m.parts.some(p => p.text === 'Persisted partial output')))
 const replay = await post(ctx.server.url, '/v1/text/submissions', { ...request, parts: [{ kind: 'text', text: 'Changed duplicate must not replace' }] })
 assert.equal(replay.runId, receipt.runId); assert.equal(replay.alreadyAccepted, true)
 assert.equal(adapter.contexts.length, 0)
 if (mode === 'streaming') {
  assert.equal(snapshot.work[0].state, 'recovery-needed')
  assert.equal(Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.owned_permits')).rows[0].n), 1)
 } else if (mode === 'asking') {
  // The provider never confirmed its end, so the question cannot start a continuation.
  assert.equal(snapshot.work[0].state, 'recovery-needed')
  assert.equal(snapshot.interactions[0].state, 'superseded')
  const answer = { version: 1, operationId: randomUUID(), interactionId: card.interactionId, threadId: receipt.threadId, runId: receipt.runId, attemptId: attempt.attemptId, answer: { kind: 'choice', optionId: 'yes' } }
  assert.equal((await post(ctx.server.url, '/v1/work/interactions/answer', answer)).outcome, 'rejected')
  assert.equal(adapter.contexts.length, 0)
 } else {
  assert.equal(snapshot.interactions[0].state, 'pending')
  const app = await (await fetch(ctx.server.url + '/v1/app/snapshot')).json()
  assert.ok(app.notifications.some(n => n.runId === receipt.runId && !n.read))
  // Change canonical settings and the authored instruction file after the saved question,
  // before its continuation is admitted. No model behavior is asserted.
  const changed = await fetch(ctx.server.url + `/v1/agents/${ids.rootAgentId}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, operationId: randomUUID(), settings: { modelId: { set: 'fixture-current' } } }) })
  assert.equal(changed.status, 200)
  const marker = 'Current continuation instruction marker'
  await writeFile(join(ctx.home, 'agents', ids.rootAgentId, 'AGENTS.md'), marker + '\n')
  assert.equal(attempt.settings.modelId, 'fixture-model')
  const answer = { version: 1, operationId: randomUUID(), interactionId: card.interactionId, threadId: receipt.threadId, runId: receipt.runId, attemptId: attempt.attemptId, answer: { kind: 'choice', optionId: 'yes' } }
  const results = await Promise.all([post(ctx.server.url, '/v1/work/interactions/answer', answer), post(ctx.server.url, '/v1/work/interactions/answer', { ...answer, operationId: randomUUID() })])
  assert.deepEqual(results.map(r => r.outcome).sort(), ['accepted', 'rejected'])
  await until(() => adapter.contexts, rows => rows.length === 1, 'one continuation')
  assert.equal(adapter.contexts[0].settings.modelId, 'fixture-current')
  assert.ok(adapter.contexts[0].instructions.includes(marker))
  assert.equal(adapter.contexts[0].runId, receipt.runId)
  assert.equal((await runtime.db.query('SELECT thread_id FROM kipster.text_runs WHERE id=$1', [adapter.contexts[0].runId])).rows[0].thread_id, receipt.threadId)
 }
})
test('SIGKILL during indexing preserves Unicode source and recovers expired intent', { skip: noDatabase, timeout: 60000 }, async t => {
 const ctx = await setup(t)
 let runtime = await ctx.open({ ...profile, async embed() { return [1, 0] } })
 await runtime.memory.stopIndexing(); const agent = runtime.bootstrap.rootAgentId
 const text = '日本語の記録 café Москва العربية'
 const saved = await runtime.memory.save(agent, 'fact', text, [{ authorId: agent }])
 await ctx.close()
 const child = ctx.child('index'); await child.wait('index'); await child.kill()
 runtime = await ctx.open({ ...profile, async embed() { return [1, 0] } })
 await runtime.memory.stopIndexing()
 assert.equal((await runtime.memory.get(agent, null, saved.id)).text, text)
 await runtime.db.query("UPDATE kipster.memory_index_intents SET lease_until=now()-interval '1 second' WHERE memory_id=$1", [saved.id])
 await runtime.memory.indexPending(10, true)
 assert.equal((await runtime.memory.get(agent, null, saved.id)).indexStatus, 'ready')
 assert.equal((await runtime.memory.get(agent, null, saved.id)).text, text)
})

test('identical text with distinct submission IDs creates two actions; retrying one ID creates none', { skip: noDatabase, timeout: 60000 }, async t => {
 const ctx = await setup(t), runtime = await ctx.open(), ids = runtime.bootstrap
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
 const adapter = await ctx.serve(), url = ctx.server.url
 const context = { kind: 'installation', installationId: ids.installationId }
 const chat = await post(url, '/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
 const input = { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Intentionally repeated text' }] }
 const [a, b] = await Promise.all([post(url, '/v1/text/submissions', input), post(url, '/v1/text/submissions', { ...input, submissionId: randomUUID() })])
 assert.notEqual(a.runId, b.runId); assert.notEqual(a.threadId, b.threadId); assert.notEqual(a.messageId, b.messageId)
 const retry = await post(url, '/v1/text/submissions', input)
 assert.equal(retry.runId, a.runId); assert.equal(retry.alreadyAccepted, true)
 await until(() => adapter.contexts, rows => rows.length === 2, 'two intentional actions')
 assert.deepEqual(adapter.contexts.map(c => c.runId).sort(), [a.runId, b.runId].sort())
 assert.equal(Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.text_runs')).rows[0].n), 2)
 for (const receipt of [a, b]) {
  const snapshot = await (await fetch(url + `/v1/threads/${receipt.threadId}/snapshot`)).json()
  assert.equal(snapshot.messages.find(m => m.id === receipt.messageId).parts[0].text, input.parts[0].text)
 }
})

for (const settled of [false, true]) test(`SIGKILL after Stop preserves queued replies (${settled ? 'confirmed end' : 'uncertain end'})`, { skip: noDatabase, timeout: 60000 }, async t => {
 const ctx = await setup(t); let runtime = await ctx.open(); const ids = runtime.bootstrap
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [ids.rootAgentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
 await ctx.close()
 const child = ctx.child('stopped'), { url } = await child.wait('ready')
 const context = { kind: 'installation', installationId: ids.installationId }
 const chat = await post(url, '/v1/direct-chats', { version: 1, context, agentId: ids.rootAgentId })
 const input = { version: 1, submissionId: randomUUID(), scope: { installationId: ids.installationId, callerId: ids.ownerId }, target: { context, chatId: chat.chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Stop this active work' }] }
 const root = await post(url, '/v1/text/submissions', input), { context: attempt } = await child.wait('executing')
 const replies = []
 for (const text of ['First saved reply', 'Second saved reply']) replies.push(await post(url, '/v1/text/submissions', { ...input, submissionId: randomUUID(), mode: 'reply', threadId: root.threadId, parts: [{ kind: 'text', text }] }))
 const command = action => ({ version: 1, operationId: randomUUID(), context, chatId: chat.chatId, threadId: root.threadId, runId: root.runId, attemptId: attempt.attemptId, action })
 const stop = command('stop'), stopReceipt = await post(url, '/v1/work/controls', stop)
 assert.equal(stopReceipt.outcome, 'accepted')
 assert.equal((await post(url, '/v1/work/controls', command('resume'))).outcome, 'rejected', 'no Resume before confirmed settlement')
 if (settled) {
  child.child.send({ action: 'confirm-end' })
  await until(async () => (await (await fetch(url + `/v1/threads/${root.threadId}/snapshot`)).json()).work, rows => rows.some(r => r.runId === root.runId && r.state === 'cancelled'), 'confirmed cancellation')
 }
 await child.kill()
 runtime = await ctx.open(); const adapter = await ctx.serve()
 const row = (await runtime.db.query('SELECT state,queue_hold,stop_requested,cancel_delivery FROM kipster.text_runs WHERE id=$1', [root.runId])).rows[0]
 assert.equal(row.queue_hold, true); assert.equal(row.stop_requested, true)
 assert.equal(row.state, settled ? 'cancelled' : 'recovery-needed')
 assert.equal(adapter.contexts.length, 0)
 assert.deepEqual(await post(ctx.server.url, '/v1/work/controls/receipt', stop), stopReceipt)
 for (const reply of replies) assert.equal((await runtime.db.query('SELECT state,current_attempt_id FROM kipster.text_runs WHERE id=$1', [reply.runId])).rows[0].current_attempt_id, null)
 const resume = await post(ctx.server.url, '/v1/work/controls', command('resume'))
 assert.equal(resume.outcome, settled ? 'accepted' : 'rejected')
 if (!settled) {
  assert.equal(row.cancel_delivery, 'uncertain')
  assert.equal(Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.owned_permits')).rows[0].n), 1)
  assert.equal(adapter.contexts.length, 0)
 } else {
  await until(() => adapter.contexts, rows => rows.length === 1, 'first saved reply after Resume')
  assert.equal(adapter.contexts[0].runId, replies[0].runId)
  adapter.handles[0].release({ kind: 'ended', attemptId: adapter.contexts[0].attemptId, confirmed: true })
  await until(() => adapter.contexts, rows => rows.length === 2, 'second saved reply in order')
  assert.deepEqual(adapter.contexts.map(c => c.runId), replies.map(r => r.runId))
  assert.ok(adapter.contexts.every(c => c.runId !== root.runId), 'cancelled root is never revived')
 }
})
