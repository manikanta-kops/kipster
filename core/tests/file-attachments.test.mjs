import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { mimeTypeFor } from '../dist/modules/artifacts/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
async function until(read, match, label) { for (let n = 0; n < 200; n++) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 35)) } throw new Error(`Timed out: ${label}`) }
function adapter() {
  const contexts = [], handles = []
  return { id: 'files-fixture', version: '1', contractMajor: 1, contexts, handles, async execute(context) {
    contexts.push(context)
    const queued = []; let wake, closed = false
    const handle = { context, events: { async *[Symbol.asyncIterator]() { while (!closed || queued.length) { const next = queued.shift() ?? await new Promise(resolve => wake = resolve); if (next) yield next } } },
      emit(event) { if (wake) { const resolve = wake; wake = undefined; resolve(event) } else queued.push(event); if (['ended', 'failed'].includes(event.kind)) closed = true },
      async cancel() { return { acknowledged: true, confirmedEnded: false } }, async reconcile() { return 'unknown' } }
    handles.push(handle)
    return handle
  }, async close() { for (const handle of handles) handle.emit({ kind: 'failed', attemptId: handle.context.attemptId, confirmedEnded: false, message: 'closed' }) } }
}

/** Small real files of the common types a kip sends. */
const samples = {
  'song.mp3': Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]),
  'pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  'clip.mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom\x00\x00\x02\x00isomiso2', 'latin1')]),
  'report.pdf': Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  'notes.md': Buffer.from('# Notes\n\n- one\n- two\n'),
  'table.csv': Buffer.from('name,count\napples,3\n'),
  'bundle.zip': Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18)]),
}
const types = { 'song.mp3': 'audio/mpeg', 'pixel.png': 'image/png', 'clip.mp4': 'video/mp4', 'report.pdf': 'application/pdf', 'notes.md': 'text/markdown', 'table.csv': 'text/csv', 'bundle.zip': 'application/zip' }

async function environment(t) {
  const database = `kipster_files_${randomUUID().replaceAll('-', '')}`, admin = new Postgres(adminUrl), url = new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-files-')), outside = await mkdtemp(join(tmpdir(), 'kipster-files-outside-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Agent A' }, executionLimit: 2 })
  const a = runtime.bootstrap.rootAgentId, b = randomUUID(), org = runtime.bootstrap.organizationId, actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  await runtime.home.provisionAgent(b)
  await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [b, actor.installationId, 'Agent B'])
  await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)', [org, b])
  await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1', [org, JSON.stringify({ adapterId: 'files-fixture', modelId: 'fixture' })])
  const fixture = adapter(), dispatcher = new TextDispatcher(runtime, fixture), server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
  await dispatcher.start()
  t.after(async () => {
    await dispatcher.close(); await server.close(); await runtime.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.close()
    await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true })
  })
  const post = async (path, value) => (await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })).json()
  const context = { kind: 'organization', organizationId: org }, scope = { installationId: actor.installationId, callerId: actor.personId }
  const chatId = (await post('/v1/direct-chats', { version: 1, context, agentId: a })).chatId
  const root = await post('/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Send me the files' }] })
  await until(() => fixture.contexts.length, n => n === 1, 'execution')
  const execution = fixture.contexts[0]
  const host = textPublicationHost(dispatcher)
  const call = (name, args, callId = randomUUID(), attemptId = execution.attemptId) => host.invokeTool({ attemptId, callId, name, arguments: args })
  const workspace = runtime.home.agent(a)
  await mkdir(workspace, { recursive: true })
  const count = async (sql, params = []) => (await runtime.db.query(sql, params)).rows[0].n
  const target = { installationId: actor.installationId, callerId: actor.personId, context, chatId, threadId: root.threadId }
  return { runtime, fixture, dispatcher, execution, call, a, b, org, actor, root, target, workspace, outside, count }
}

test('post_chat_message attaches files of any type by absolute and relative path as agent-owned snapshots', { skip: noDatabase, timeout: 60000 }, async t => {
  const e = await environment(t)
  const tools = e.execution.tools.map(tool => tool.name)
  assert.equal(tools.includes('artifacts_write') || tools.includes('artifacts_publish'), false)
  assert.ok(e.execution.tools.find(tool => tool.name === 'post_chat_message').inputSchema.properties.files)
  assert.match(e.execution.instructions, /call post_chat_message with their paths in `files`/)
  await mkdir(join(e.workspace, 'out'), { recursive: true })
  const names = Object.keys(samples), relative = new Set(['notes.md', 'table.csv', 'bundle.zip'])
  const paths = []
  for (const name of names) {
    if (relative.has(name)) { await writeFile(join(e.workspace, 'out', name), samples[name]); paths.push(`out/${name}`) }
    else { await writeFile(join(e.outside, name), samples[name]); paths.push(join(e.outside, name)) }
  }
  const published = await e.call('post_chat_message', { text: 'Here are your files', files: paths }, 'publish-files')
  assert.equal(published.status, 'completed')
  assert.deepEqual(published.files.map(file => [file.name, file.mimeType, file.size]), names.map(name => [name, types[name], samples[name].length]))
  const rows = (await e.runtime.db.query('SELECT id,name,mime_type,size_bytes,sha256,owner_kind,owner_id,author_id,provenance,state FROM kipster.artifacts WHERE id=ANY($1::uuid[])', [published.files.map(file => file.artifactId)])).rows
  for (const file of published.files) {
    const row = rows.find(item => item.id === file.artifactId)
    assert.deepEqual({ ...row, id: undefined }, { id: undefined, name: file.name, mime_type: types[file.name], size_bytes: String(samples[file.name].length), sha256: digest(samples[file.name]), owner_kind: 'agent', owner_id: e.a, author_id: e.a, provenance: 'generated', state: 'ready' })
  }
  const message = (await e.runtime.db.query('SELECT parts,author_id,created_at,finished_at FROM kipster.messages WHERE id=$1', [published.messageId])).rows[0]
  assert.equal(message.author_id, e.a)
  assert.ok(message.created_at instanceof Date && message.finished_at instanceof Date)
  const final = (await e.runtime.db.query("SELECT data FROM kipster.thread_events WHERE resource_id=$1 AND type='message-final' ORDER BY position DESC LIMIT 1", [published.messageId])).rows[0].data
  assert.deepEqual([final.createdAt, final.finishedAt], [message.created_at.toISOString(), message.finished_at.toISOString()])
  assert.deepEqual(message.parts, [{ kind: 'text', text: 'Here are your files' }, ...published.files.map(file => ({ kind: 'file', artifactId: file.artifactId, purpose: 'attachment' }))])
  assert.deepEqual((await e.runtime.db.query('SELECT ordinal,artifact_id FROM kipster.message_artifacts WHERE message_id=$1 ORDER BY ordinal', [published.messageId])).rows, published.files.map((file, index) => ({ ordinal: index + 1, artifact_id: file.artifactId })))
  // The person reads each file as it was when published, whatever happens to the source.
  await writeFile(join(e.outside, 'song.mp3'), 'changed later')
  for (const file of published.files) assert.deepEqual((await e.runtime.artifacts.content(e.actor, file.artifactId, e.target)).bytes, samples[file.name])

  // The same call again returns the same message and files; other arguments under its call ID are refused.
  const artifacts = await e.count('SELECT count(*)::int AS n FROM kipster.artifacts'), messages = await e.count('SELECT count(*)::int AS n FROM kipster.messages')
  assert.deepEqual(await e.call('post_chat_message', { text: 'Here are your files', files: paths }, 'publish-files'), published)
  const conflict = await e.call('post_chat_message', { text: 'Here are your files', files: paths.slice(1) }, 'publish-files')
  assert.equal(conflict.status, 'failed')
  assert.match(conflict.reason, /replay conflict/)
  // Naming the attached files by artifact ID instead is a different request too, and so is adding files to a call that had none.
  const swapped = await e.call('post_chat_message', { text: 'Here are your files', artifactIds: published.files.map(file => file.artifactId) }, 'publish-files')
  assert.deepEqual([swapped.status, swapped.reason], ['failed', 'File attachment replay conflict'])
  const plain = await e.call('post_chat_message', { text: 'Just text' }, 'publish-plain')
  assert.equal(plain.status, 'completed')
  const added = await e.call('post_chat_message', { text: 'Just text', files: paths.slice(0, 1) }, 'publish-plain')
  assert.deepEqual([added.status, added.reason], ['failed', 'File attachment replay conflict'])
  assert.deepEqual(await e.call('post_chat_message', { text: 'Just text' }, 'publish-plain'), plain)
  assert.deepEqual([await e.count('SELECT count(*)::int AS n FROM kipster.artifacts'), await e.count('SELECT count(*)::int AS n FROM kipster.messages')], [artifacts, messages + 1])

  // Files by path follow artifact IDs and count with them; an unknown extension is a generic file.
  await writeFile(join(e.workspace, 'data.unknownext'), 'raw')
  const mixed = await e.call('post_chat_message', { artifactIds: [published.files[0].artifactId], files: ['data.unknownext'] })
  assert.equal(mixed.status, 'completed')
  assert.deepEqual(mixed.files.map(file => file.mimeType), ['application/octet-stream'])
  assert.deepEqual((await e.runtime.db.query('SELECT parts FROM kipster.messages WHERE id=$1', [mixed.messageId])).rows[0].parts.map(part => part.artifactId), [published.files[0].artifactId, mixed.files[0].artifactId])
  assert.equal(mimeTypeFor('Photo.JPEG'), 'image/jpeg')

  // An organization copy of an attached file is independent of it.
  const copy = (await e.call('copy_attachment_to_workspace', { artifactId: published.files[1].artifactId })).artifact
  assert.deepEqual([copy.ownership, copy.name, copy.mimeType, copy.sha256], [{ kind: 'organization', id: e.org }, 'pixel.png', 'image/png', digest(samples['pixel.png'])])

  for (const name of ['artifacts_write', 'artifacts_publish']) await assert.rejects(e.call(name, { name: 'a.txt', content: 'x', outputId: randomUUID() }), /Unsupported Kipster tool/)
})

test('a file that cannot be attached is named with its reason and nothing is published', { skip: noDatabase, timeout: 60000 }, async t => {
  const e = await environment(t)
  await writeFile(join(e.outside, 'fine.txt'), 'fine')
  await mkdir(join(e.workspace, 'folder'))
  const sparse = async (name, megabytes) => { const path = join(e.outside, name), handle = await open(path, 'w'); await handle.truncate(megabytes * 1024 * 1024); await handle.close(); return path }
  const huge = await sparse('huge.wav', 26)
  const parts = [await sparse('part-1.mov', 20), await sparse('part-2.mov', 20), await sparse('part-3.mov', 20)]
  const before = async () => [await e.count('SELECT count(*)::int AS n FROM kipster.artifacts'), await e.count('SELECT count(*)::int AS n FROM kipster.messages'), await e.count('SELECT count(*)::int AS n FROM kipster.artifact_file_attachments')]
  const empty = await before()
  const cases = [
    [[join(e.outside, 'fine.txt'), join(e.outside, 'missing.mp3')], new RegExp(`Cannot attach ${literal(join(e.outside, 'missing.mp3'))}: the file does not exist`)],
    [['folder'], /Cannot attach folder: not a regular file/],
    [[huge], new RegExp(`Cannot attach ${literal(huge)}: larger than the 25 MB limit per file`)],
    [parts, /together they exceed the 50 MB limit per message/],
    [Array.from({ length: 11 }, () => join(e.outside, 'fine.txt')), /more than 10 files/],
    [[join(e.outside, 'fine.txt'), join(e.outside, 'fine.txt')], /listed more than once/],
  ]
  for (const [files, reason] of cases) {
    const result = await e.call('post_chat_message', { text: 'Attached', files })
    assert.equal(result.status, 'failed')
    assert.match(result.reason, reason)
    assert.deepEqual(await before(), empty, 'nothing is stored or published')
  }
  await assert.rejects(e.call('delegate_to_kip', { recipientId: e.b, request: 'Check this', files: ['missing.csv'] }), /Cannot attach missing.csv: the file does not exist/)
  assert.deepEqual(await before(), empty)
  assert.equal(await e.count('SELECT count(*)::int AS n FROM kipster.delegations'), 0)
})

test('delegate_to_kip passes files by path to the recipient and replays without new files', { skip: noDatabase, timeout: 60000 }, async t => {
  const e = await environment(t)
  await writeFile(join(e.workspace, 'brief.pdf'), samples['report.pdf'])
  const args = { recipientId: e.b, request: 'Review the brief', files: ['brief.pdf'] }
  const delegated = await e.call('delegate_to_kip', args, 'delegate-files')
  assert.deepEqual(delegated.files.map(file => [file.name, file.mimeType, file.size]), [['brief.pdf', 'application/pdf', samples['report.pdf'].length]])
  const artifactId = delegated.files[0].artifactId
  const requestMessage = (await e.runtime.db.query('SELECT m.id,m.created_at,m.finished_at FROM kipster.delegations d JOIN kipster.text_runs r ON r.id=d.child_run_id JOIN kipster.messages m ON m.id=r.input_message_id WHERE d.id=$1', [delegated.id])).rows[0]
  assert.ok(requestMessage.created_at instanceof Date && requestMessage.finished_at instanceof Date)
  const requestEvent = (await e.runtime.db.query("SELECT data FROM kipster.thread_events WHERE resource_id=$1 AND type='message-final'", [requestMessage.id])).rows[0].data
  assert.deepEqual([requestEvent.createdAt, requestEvent.finishedAt, requestEvent.parts.at(-1).artifactId], [requestMessage.created_at.toISOString(), requestMessage.finished_at.toISOString(), artifactId])
  assert.deepEqual((await e.runtime.db.query('SELECT owner_kind,owner_id,state FROM kipster.artifacts WHERE id=$1', [artifactId])).rows[0], { owner_kind: 'agent', owner_id: e.a, state: 'ready' })
  const artifacts = await e.count('SELECT count(*)::int AS n FROM kipster.artifacts')
  const replay = await e.call('delegate_to_kip', args, 'delegate-files')
  assert.deepEqual([replay.id, replay.files], [delegated.id, delegated.files])
  assert.equal(await e.count('SELECT count(*)::int AS n FROM kipster.artifacts'), artifacts)
  await assert.rejects(e.call('delegate_to_kip', { ...args, request: 'Something else' }, 'delegate-files'), /replay conflict/)
  await assert.rejects(e.call('delegate_to_kip', { recipientId: e.b, request: 'Review the brief', artifactIds: [artifactId] }, 'delegate-files'), /File attachment replay conflict/)
  const plain = { recipientId: e.b, request: 'No files here' }
  const first = await e.call('delegate_to_kip', plain, 'delegate-plain')
  await assert.rejects(e.call('delegate_to_kip', { ...plain, files: ['brief.pdf'] }, 'delegate-plain'), /File attachment replay conflict/)
  assert.equal((await e.call('delegate_to_kip', plain, 'delegate-plain')).id, first.id)
  // A call answered with the run's identical delegation keeps its call identity too.
  assert.equal((await e.call('delegate_to_kip', plain, 'delegate-same')).id, first.id)
  await assert.rejects(e.call('delegate_to_kip', { ...plain, files: ['brief.pdf'] }, 'delegate-same'), /File attachment replay conflict/)
  await assert.rejects(e.call('delegate_to_kip', { ...plain, request: 'Other work' }, 'delegate-same'), /Delegation identity conflict/)
  assert.equal((await e.call('delegate_to_kip', plain, 'delegate-same')).id, first.id)
  assert.deepEqual([await e.count('SELECT count(*)::int AS n FROM kipster.artifacts'), await e.count('SELECT count(*)::int AS n FROM kipster.delegations')], [artifacts, 2])
  e.fixture.handles[0].emit({ kind: 'ended', attemptId: e.execution.attemptId, confirmed: true })
  await until(() => e.fixture.contexts.length, n => n === 3, 'recipient executions')
  const child = e.fixture.contexts.slice(1).find(context => context.input.some(message => message.parts.some(part => part.kind === 'file')))
  assert.equal(child.agentId, e.b)
  const request = child.input.find(message => message.parts.some(part => part.kind === 'file'))
  const file = request.parts.find(part => part.kind === 'file')
  assert.deepEqual([file.artifactId, file.name, file.mimeType, file.availability], [artifactId, 'brief.pdf', 'application/pdf', 'available'])
})

test('files reused by artifact ID count toward the 50 MB per-message limit, and recorded calls still replay', { skip: noDatabase, timeout: 60000 }, async t => {
  const e = await environment(t)
  for (const name of ['one.bin', 'two.bin', 'three.bin', 'tiny.txt']) await writeFile(join(e.workspace, name), name)
  const seeded = await e.call('post_chat_message', { files: ['one.bin', 'two.bin', 'three.bin'] })
  assert.equal(seeded.status, 'completed')
  const [one, two, three] = seeded.files.map(file => file.artifactId)
  // Calls recorded while the files were small, before they count as two 25 MB files and a 1 MB file.
  const earlier = await e.call('post_chat_message', { text: 'Earlier', artifactIds: [one, two, three] }, 'publish-before')
  assert.equal(earlier.status, 'completed')
  const delegatedEarlier = await e.call('delegate_to_kip', { recipientId: e.b, request: 'Earlier review', artifactIds: [one, two, three] }, 'delegate-before')
  const megabyte = 1024 * 1024
  await e.runtime.db.query('UPDATE kipster.artifacts SET size_bytes=$2 WHERE id=ANY($1::uuid[])', [[one, two], 25 * megabyte])
  await e.runtime.db.query('UPDATE kipster.artifacts SET size_bytes=$2 WHERE id=$1', [three, megabyte])

  const stored = async () => Promise.all(['messages', 'message_artifacts', 'delegations', 'delegation_calls', 'work_intents', 'artifacts'].map(table => e.count(`SELECT count(*)::int AS n FROM kipster.${table}`)))
  const before = await stored()
  const tooLarge = 'Cannot attach these files: together they exceed the 50 MB limit per message'
  assert.deepEqual(await e.call('post_chat_message', { text: 'Reuse these files', artifactIds: [one, two, three] }, 'reuse-51mb'), { status: 'failed', reason: tooLarge })
  await assert.rejects(e.call('delegate_to_kip', { recipientId: e.b, request: 'Review these files', artifactIds: [one, two, three] }, 'delegate-51mb'), { message: tooLarge })
  // With files by path, the shared and new bytes are counted together before any file is read.
  assert.deepEqual(await e.call('post_chat_message', { artifactIds: [one, two], files: ['tiny.txt'] }), { status: 'failed', reason: tooLarge })
  await assert.rejects(e.call('delegate_to_kip', { recipientId: e.b, request: 'With a note', artifactIds: [one, two], files: ['tiny.txt'] }), { message: tooLarge })
  assert.deepEqual(await stored(), before, 'nothing is stored for a refused call')

  // Recorded calls are answered with their results, whatever the files count now.
  assert.deepEqual(await e.call('post_chat_message', { text: 'Earlier', artifactIds: [one, two, three] }, 'publish-before'), earlier)
  assert.equal((await e.call('delegate_to_kip', { recipientId: e.b, request: 'Earlier review', artifactIds: [one, two, three] }, 'delegate-before')).id, delegatedEarlier.id)
  assert.deepEqual(await stored(), before)

  // Exactly 50 MB is accepted.
  const atLimit = await e.call('post_chat_message', { text: 'Exactly the limit', artifactIds: [one, two] }, 'publish-50mb')
  assert.equal(atLimit.status, 'completed')
  assert.deepEqual((await e.runtime.db.query('SELECT artifact_id FROM kipster.message_artifacts WHERE message_id=$1 ORDER BY ordinal', [atLimit.messageId])).rows.map(row => row.artifact_id), [one, two])
  const delegated = await e.call('delegate_to_kip', { recipientId: e.b, request: 'Review exactly the limit', artifactIds: [one, two] }, 'delegate-50mb')
  assert.deepEqual((await e.runtime.db.query('SELECT artifact_ids FROM kipster.delegations WHERE id=$1', [delegated.id])).rows[0].artifact_ids, [one, two])
})
