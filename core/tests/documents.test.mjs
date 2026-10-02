import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { documentDetail, documentDraftResult, documentList, documentRevisionResult, documentSubmitResult, textEvent } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Rich documents through the owner's HTTP routes and the kip tools, which the deterministic
// fixture adapter calls through the Core tool host against real PostgreSQL.

const names = { owner: 'Owner', organization: 'Org', rootAgent: 'Root' }
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }

async function until(read, match, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (match(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}

async function setup(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_documents_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-documents-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const runtime = await openRuntime({ connectionString: url.href, home, names, executionLimit: 6 })
  closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, dispatcher })
  closers.push(() => server.close())
  await dispatcher.start()
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, headers: response.headers, data: type.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) }
  }
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${response.status} ${JSON.stringify(response.data)}`)
    return response.data
  }
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  await ok('PUT', `/v1/organizations/${organizationId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  const installation = { kind: 'installation', installationId }
  const execution = runId => until(() => executions.find(entry => entry.context.runId === runId), Boolean, `execution of ${runId}`)
  const run = async runId => {
    const found = await execution(runId)
    return { ...found, runId, tool: (callId, toolName, args) => found.handle.callTool(callId, toolName, args), end: () => found.handle.release({ kind: 'ended', attemptId: found.context.attemptId }) }
  }
  return {
    runtime, db: runtime.db, installationId, ownerId, organizationId, rootAgentId, installation, call, ok, run,
    /** A new conversation with the agent; returns its running execution. */
    async start(agentId = rootAgentId, context = installation, text = 'Write a doc') {
      const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context, agentId })
      const accepted = await ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
      return { ...await run(accepted.runId), chatId, threadId: accepted.threadId, context: (await execution(accepted.runId)).context }
    },
    detail: async id => documentDetail.parse(await ok('GET', `/v1/documents/${id}`)),
    settled: (id, check, label) => until(async () => documentDetail.parse(await ok('GET', `/v1/documents/${id}`)), check, label),
    draft: (id, body) => call('PUT', `/v1/documents/${id}/draft`, { version: 1, comments: [], note: '', ...body }),
    events: async () => (await readEvents(runtime.db, { kind: 'application', installationId, callerId: ownerId }, `a:${installationId}:0`, 2000)).events.map(event => textEvent.parse(event)),
  }
}

const tripMarkdown = '# Trip\n\nWhere should we go?\n\n```question\nprompt: Destination\noptions:\n- Lisbon | sunny\n- Oslo\n```\n\n- [ ] Book flights\n- [ ] Pack'

test('a kip writes a doc, the user answers, edits, comments and submits, and the kip revises it', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const writer = await ctx.start()
  const created = await writer.tool('create-1', 'documents.create', { title: 'Trip plan', markdown: tripMarkdown })
  assert.equal(created.revision, 1)
  assert.deepEqual(await writer.tool('create-1', 'documents.create', { title: 'Trip plan', markdown: tripMarkdown }), created, 'one call ID creates one doc')
  const id = created.documentId
  const card = (await ctx.db.query('SELECT parts FROM kipster.messages WHERE id=$1', [created.messageId])).rows[0]
  assert.deepEqual(card.parts, [{ kind: 'document', documentId: id, revision: 1 }])
  writer.end()

  const first = await ctx.detail(id)
  assert.equal(first.document.turn, 'user')
  assert.equal(first.document.currentRevision, 1)
  assert.equal(first.document.pendingQuestions, 1)
  assert.equal(first.document.threadId, writer.threadId)
  assert.deepEqual(first.document.context, ctx.installation)
  assert.equal(first.current.authorKind, 'agent')
  assert.deepEqual(first.current.blocks.map(block => block.type), ['heading', 'paragraph', 'question', 'checklist'])
  assert.deepEqual(first.current.changes.added, first.current.blocks.map(block => block.id))
  assert.deepEqual(documentList.parse(await ctx.ok('GET', '/v1/documents')).documents.map(entry => entry.id), [id])
  assert.equal((await ctx.ok('GET', '/v1/bootstrap')).capabilities.documents, true)

  const [heading, paragraph, question, checklist] = first.current.blocks
  const blocks = [
    heading,
    { ...paragraph, text: 'Where should we go in May?' },
    { ...question, answer: { optionIds: [question.options[1].id], other: '' } },
    { ...checklist, items: checklist.items.map((item, index) => index === 0 ? { ...item, done: true } : item) },
    { id: 'u-budget', type: 'paragraph', text: 'Budget is tight.' },
  ]
  const comments = [{ id: 'k1', blockId: paragraph.id, field: 'text', quote: 'Where', start: 0, end: 5, body: 'Be specific' }]
  assert.equal((await ctx.draft(id, { baseRevision: 0, expectedDraftVersion: 0, title: 'Trip plan', blocks })).status, 409, 'stale base revision')
  assert.equal((await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 1, title: 'Trip plan', blocks })).status, 409, 'no draft exists yet')
  assert.equal((await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 0, title: 'Trip plan', blocks: [...blocks, { id: 'u-budget', type: 'divider' }] })).status, 400, 'duplicate block ID')
  const saved = await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 0, title: 'Trip plan', blocks: blocks.slice(0, 2) })
  assert.equal(saved.status, 200)
  assert.equal(documentDraftResult.parse(saved.data).draftVersion, 1)
  assert.equal((await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 0, title: 'Trip plan', blocks })).status, 409, 'stale draft version')
  const second = await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 1, title: 'Trip plan', blocks, comments, note: 'Looks good' })
  assert.equal(second.data.draftVersion, 2)
  const drafted = await ctx.detail(id)
  assert.equal(drafted.document.hasDraft, true)
  assert.equal(drafted.document.pendingQuestions, 0)
  assert.equal(drafted.draft.note, 'Looks good')

  const operationId = randomUUID()
  assert.equal((await ctx.call('POST', `/v1/documents/${id}/submit`, { version: 1, operationId: randomUUID(), draftVersion: 1 })).status, 409, 'stale draft version')
  const submitted = documentSubmitResult.parse(await ctx.ok('POST', `/v1/documents/${id}/submit`, { version: 1, operationId, draftVersion: 2 }))
  assert.equal(submitted.document.turn, 'agent')
  assert.equal(submitted.document.currentRevision, 2)
  assert.equal(submitted.document.hasDraft, false)
  assert.equal(submitted.document.openComments, 1)
  const repeated = await ctx.ok('POST', `/v1/documents/${id}/submit`, { version: 1, operationId, draftVersion: 2 })
  assert.deepEqual([repeated.messageId, repeated.runId], [submitted.messageId, submitted.runId])
  const posted = (await ctx.db.query('SELECT thread_id,author_id,parts FROM kipster.messages WHERE id=$1', [submitted.messageId])).rows[0]
  assert.equal(posted.thread_id, writer.threadId)
  assert.equal(posted.author_id, ctx.ownerId)
  assert.deepEqual(posted.parts, [{ kind: 'text', text: 'Looks good' }, { kind: 'document', documentId: id, revision: 2 }])
  assert.equal((await ctx.draft(id, { baseRevision: 2, expectedDraftVersion: 0, title: 'Trip plan', blocks })).status, 409, 'the doc is locked on the kip turn')

  const revise = await ctx.run(submitted.runId)
  const input = revise.context.input.find(message => message.messageId === submitted.messageId).parts.map(part => part.text).join('\n')
  assert.match(input, /The user submitted rich doc "Trip plan" \(doc ID [0-9a-f-]+, revision 2\)/)
  assert.match(input, /Note from the user:\nLooks good/)
  assert.match(input, /"Destination" \(block [a-z0-9]+\): Oslo/)
  assert.match(input, /Checked "Book flights"/)
  assert.match(input, new RegExp(`Edited block ${paragraph.id}:\\nWhere should we go in May\\?`))
  assert.match(input, /Added block u-budget:\nBudget is tight\./)
  assert.doesNotMatch(input, new RegExp(`Edited block ${question.id}`), 'an answer is not a content edit')
  assert.match(input, /Comment k1 \(#1\) on block [a-z0-9]+, quoting "Where": Be specific/)
  assert.match(input, /Call documents_read/)
  const history = revise.context.input.find(message => message.messageId !== submitted.messageId && message.parts.some(part => /Shared rich doc/.test(part.text ?? '')))
  assert.ok(history, 'the card the kip posted is in its history')

  const read = await revise.tool('read-1', 'documents.read', { documentId: id })
  assert.equal(read.revision, 2)
  assert.equal(read.turn, 'agent')
  assert.match(read.blocks.find(block => block.id === question.id).markdown, /answer: Oslo/)
  assert.match(read.blocks.find(block => block.id === checklist.id).markdown, /- \[x\] Book flights/)
  assert.deepEqual(read.openComments, [{ id: 'k1', number: 1, blockId: paragraph.id, quote: 'Where', body: 'Be specific' }])
  assert.deepEqual(read.lastSubmission.revision, 2)
  const edited = await revise.tool('edit-1', 'documents.edit', { documentId: id, operations: [
    { op: 'replace', blockId: paragraph.id, markdown: 'We go to **Oslo** in May.' },
    { op: 'delete', blockId: 'u-budget' },
    { op: 'resolve', commentId: 'k1', reply: 'Made it specific' },
  ] })
  assert.equal(edited.publishedRevision, 2)
  assert.deepEqual(edited.resolvedComments, ['k1'])
  const mine = await revise.tool('read-2', 'documents.read', { documentId: id })
  assert.equal(mine.unpublishedEdits, true)
  assert.deepEqual(mine.openComments, [])
  assert.equal(mine.blocks.find(block => block.id === paragraph.id).markdown, 'We go to **Oslo** in May.')
  assert.equal((await ctx.detail(id)).current.number, 2, 'edits stay unpublished while the run works')
  revise.end()

  const revised = await ctx.settled(id, value => value.document.turn === 'user', 'revision after the run')
  assert.equal(revised.current.number, 3)
  assert.equal(revised.current.authorKind, 'agent')
  assert.equal(revised.current.authorId, ctx.rootAgentId)
  assert.deepEqual(revised.current.changes, { added: [], updated: [paragraph.id], removed: ['u-budget'] })
  assert.deepEqual(revised.revisions.map(entry => [entry.number, entry.authorKind]), [[1, 'agent'], [2, 'user'], [3, 'agent']])
  assert.deepEqual(revised.comments.map(comment => [comment.id, comment.number, comment.state, comment.reply, comment.submittedInRevision, comment.resolvedInRevision]), [['k1', 1, 'resolved', 'Made it specific', 2, 3]])
  assert.equal(revised.document.openComments, 0)
  const older = documentRevisionResult.parse(await ctx.ok('GET', `/v1/documents/${id}/revisions/2`))
  assert.deepEqual([older.revision.authorKind, older.revision.note], ['user', 'Looks good'])
  assert.equal((await ctx.call('GET', `/v1/documents/${id}/revisions/9`)).status, 404)

  const reuse = await ctx.draft(id, { baseRevision: 3, expectedDraftVersion: 0, title: 'Trip plan', blocks: revised.current.blocks, comments: [comments[0]] })
  assert.equal(reuse.status, 400, 'a submitted comment ID cannot be reused')
  const next = await ctx.draft(id, { baseRevision: 3, expectedDraftVersion: 0, title: 'Trip plan', blocks: revised.current.blocks, comments: [{ ...comments[0], id: 'k2', body: 'Again' }] })
  const resubmitted = await ctx.ok('POST', `/v1/documents/${id}/submit`, { version: 1, operationId: randomUUID(), draftVersion: next.data.draftVersion })
  assert.deepEqual((await ctx.detail(id)).comments.map(comment => [comment.id, comment.number, comment.state]), [['k1', 1, 'resolved'], ['k2', 2, 'open']])
  assert.deepEqual((await ctx.db.query('SELECT parts FROM kipster.messages WHERE id=$1', [resubmitted.messageId])).rows[0].parts, [{ kind: 'document', documentId: id, revision: 4 }], 'an empty note posts only the card')
  ;(await ctx.run(resubmitted.runId)).end()
  await ctx.settled(id, value => value.document.turn === 'user', 'turn back without edits')
  assert.equal((await ctx.detail(id)).current.number, 4, 'a run without edits adds no revision')

  const changes = (await ctx.events()).filter(event => event.type === 'document-changed' && event.resourceId === id)
  assert.ok(changes.length >= 6)
  assert.deepEqual(changes.map(event => event.revision), [...changes.map(event => event.revision)].sort((a, b) => a - b))
  assert.equal(new Set(changes.map(event => event.revision)).size, changes.length)
  assert.deepEqual([changes.at(-1).data.turn, changes.at(-1).data.currentRevision], ['user', 4])
})

test('turns: the kip takes a clean doc, waits for a dirty one, and loses it on take back', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const writer = await ctx.start()
  const { documentId: id } = await writer.tool('create', 'documents.create', { title: 'Notes', markdown: 'Hello' })
  await writer.tool('edit', 'documents.edit', { documentId: id, operations: [{ op: 'insert', afterBlockId: null, markdown: '# Notes' }] })
  const taken = await ctx.detail(id)
  assert.equal(taken.document.turn, 'agent', 'an edit on a clean doc takes the turn for the run')
  assert.equal((await ctx.draft(id, { baseRevision: 1, expectedDraftVersion: 0, title: 'Notes', blocks: taken.current.blocks })).status, 409)
  writer.end()
  const published = await ctx.settled(id, value => value.document.turn === 'user', 'turn back to the user')
  assert.equal(published.current.number, 2)
  assert.deepEqual(published.current.blocks.map(block => block.type), ['heading', 'paragraph'])

  assert.equal((await ctx.draft(id, { baseRevision: 2, expectedDraftVersion: 0, title: 'Notes', blocks: published.current.blocks })).status, 200)
  const other = await ctx.start(ctx.rootAgentId, ctx.installation, 'Tidy the notes')
  await assert.rejects(other.tool('edit', 'documents.edit', { documentId: id, operations: [{ op: 'title', title: 'Tidy' }] }), /unsubmitted changes.*Ask the user to submit/)
  other.end()
  assert.equal((await ctx.detail(id)).document.turn, 'user')

  const submitted = await ctx.ok('POST', `/v1/documents/${id}/submit`, { version: 1, operationId: randomUUID(), draftVersion: 1 })
  const revise = await ctx.run(submitted.runId)
  await revise.tool('edit-1', 'documents.edit', { documentId: id, operations: [{ op: 'title', title: 'Changed' }] })
  const back = documentDetail.parse(await ctx.ok('POST', `/v1/documents/${id}/take-back`, { version: 1 }))
  assert.equal(back.document.turn, 'user')
  assert.equal((await ctx.call('POST', `/v1/documents/${id}/take-back`, { version: 1, extra: true })).status, 400)
  await assert.rejects(revise.tool('edit-2', 'documents.edit', { documentId: id, operations: [{ op: 'title', title: 'Again' }] }), /took this doc back/)
  revise.end()
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [submitted.runId])).rows[0].state, state => state === 'completed', 'run end')
  const kept = await ctx.detail(id)
  assert.deepEqual([kept.current.number, kept.document.title, kept.document.turn], [3, 'Notes', 'user'], 'taken-back edits are discarded')
  assert.equal(Number((await ctx.db.query('SELECT count(*) AS n FROM kipster.document_working_copies')).rows[0].n), 0)

  const failing = await ctx.ok('POST', `/v1/documents/${id}/submit`, { version: 1, operationId: randomUUID(), draftVersion: 0 })
  const failed = await ctx.run(failing.runId)
  await failed.tool('edit', 'documents.edit', { documentId: id, operations: [{ op: 'title', title: 'From a failed run' }] })
  failed.handle.release({ kind: 'failed', attemptId: failed.context.attemptId, confirmedEnded: true, message: 'provider failed' })
  const afterFailure = await ctx.settled(id, value => value.document.turn === 'user', 'turn back after a failed run')
  assert.deepEqual([afterFailure.current.number, afterFailure.current.title], [5, 'From a failed run'], 'a run that fails still publishes its edits')

  const crashed = await ctx.start(ctx.rootAgentId, ctx.installation, 'Edit again')
  await crashed.tool('edit', 'documents.edit', { documentId: id, operations: [{ op: 'title', title: 'Before the crash' }] })
  // Recovery after a crash moves the run to recovery-needed without the settlement hook; the next read ends the turn.
  await ctx.db.query("UPDATE kipster.text_runs SET state='recovery-needed' WHERE id=$1", [crashed.runId])
  const listed = documentList.parse(await ctx.ok('GET', '/v1/documents')).documents[0]
  assert.deepEqual([listed.turn, listed.currentRevision, listed.title], ['user', 6, 'Before the crash'])
})

test('kips see their workspace, owners delete docs, and doc files are read through the doc', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const scout = (await ctx.ok('POST', '/v1/agents', { version: 1, operationId: randomUUID(), name: 'Scout', organizationId: ctx.organizationId })).agent.id
  const organization = { kind: 'organization', organizationId: ctx.organizationId }
  const root = await ctx.start()
  const { documentId: rootDoc } = await root.tool('c1', 'documents.create', { title: 'Root doc', markdown: 'Private' })
  const { documentId: teamDoc } = await root.tool('c2', 'documents.create', { title: 'Team doc', markdown: 'Shared', organizationId: ctx.organizationId })
  assert.deepEqual((await ctx.detail(teamDoc)).document.context, organization)
  assert.deepEqual(new Set((await root.tool('l1', 'documents.list', {})).documents.map(entry => entry.documentId)), new Set([rootDoc, teamDoc]))

  const member = await ctx.start(scout, organization, 'Hello')
  assert.deepEqual((await member.tool('l1', 'documents.list', {})).documents.map(entry => entry.documentId), [teamDoc])
  await assert.rejects(member.tool('r1', 'documents.read', { documentId: rootDoc }), /Document not found/)
  await assert.rejects(member.tool('c1', 'documents.create', { title: 'Elsewhere', markdown: '', organizationId: randomUUID() }), /Only Kip/)
  const own = await member.tool('c2', 'documents.create', { title: 'Scout notes', markdown: 'Mine' })
  assert.deepEqual((await ctx.detail(own.documentId)).document.context, organization)
  assert.equal((await member.tool('r2', 'documents.read', { documentId: teamDoc })).title, 'Team doc')

  await assert.rejects(root.tool('c3', 'documents.create', { title: ' ', markdown: '' }), /Invalid title/)
  await assert.rejects(root.tool('c4', 'documents.create', { title: 'T', markdown: '', extra: 1 }), /unknown field extra/)
  await assert.rejects(root.tool('c5', 'documents.create', { title: 'T', markdown: '```question\noptions:\n- A\n```' }), /needs a prompt/)
  await assert.rejects(root.tool('c6', 'documents.create', { title: 'T', markdown: `![x](artifact:${randomUUID()})` }), /not readable/)
  await assert.rejects(root.tool('e1', 'documents.edit', { documentId: rootDoc, operations: [{ op: 'rewrite' }] }), /op must be one of/)
  await assert.rejects(root.tool('e2', 'documents.edit', { documentId: rootDoc }), /1 to 100/)
  await assert.rejects(root.tool('r1', 'documents.read', { documentId: rootDoc, revision: 0 }), /positive integer/)
  await assert.rejects(root.tool('l2', 'documents.list', { all: true }), /unknown field all/)
  await assert.rejects(root.tool('d1', 'documents.delete', {}), /documentId is required/)
  assert.equal(Number((await ctx.db.query('SELECT count(*) AS n FROM kipster.documents')).rows[0].n), 3, 'refused calls create nothing')

  const actor = { installationId: ctx.installationId, personId: ctx.ownerId }
  const upload = async (chatId, threadId, context, name, text) => {
    const bytes = Buffer.from(text)
    const target = { installationId: ctx.installationId, callerId: ctx.ownerId, context, chatId, threadId }
    return (await ctx.runtime.artifacts.upload(actor, { uploadId: randomUUID(), target, name, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'attachment' }, (async function* () { yield bytes })())).artifact
  }
  const picture = await upload(root.chatId, root.threadId, ctx.installation, 'cat.png', 'cat pixels')
  const teamPicture = await upload(member.chatId, member.threadId, organization, 'team.png', 'team pixels')
  const current = await ctx.detail(rootDoc)
  const withPicture = [...current.current.blocks, { id: 'img', type: 'image', artifactId: picture.id, caption: 'Cat' }]
  assert.equal((await ctx.draft(rootDoc, { baseRevision: 1, expectedDraftVersion: 0, title: 'Root doc', blocks: [...current.current.blocks, { id: 'img', type: 'image', artifactId: teamPicture.id, caption: '' }] })).status, 400, 'a workspace file is not readable in an installation doc')
  assert.equal((await ctx.draft(rootDoc, { baseRevision: 1, expectedDraftVersion: 0, title: 'Root doc', blocks: withPicture })).status, 200)
  const metadata = await ctx.ok('GET', `/v1/documents/${rootDoc}/artifacts/${picture.id}`)
  assert.deepEqual([metadata.id, metadata.name, metadata.mimeType], [picture.id, 'cat.png', 'image/png'])
  const content = await ctx.call('GET', `/v1/documents/${rootDoc}/artifacts/${picture.id}/content`)
  assert.equal(content.status, 200)
  assert.equal(content.data.toString(), 'cat pixels')
  assert.match(content.headers.get('content-disposition'), /^attachment;/)
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await ctx.call('GET', `/v1/documents/${teamDoc}/artifacts/${picture.id}`)).status, 404, 'another doc does not reference it')
  assert.equal((await ctx.call('GET', `/v1/documents/${rootDoc}/artifacts/${teamPicture.id}/content`)).status, 404)
  assert.equal((await ctx.call('GET', `/v1/documents/${rootDoc}/artifacts/${randomUUID()}`)).status, 404)

  assert.deepEqual(await ctx.ok('DELETE', `/v1/documents/${teamDoc}`), { version: 1, id: teamDoc })
  assert.equal((await ctx.call('GET', `/v1/documents/${teamDoc}`)).status, 404)
  assert.equal((await ctx.call('DELETE', `/v1/documents/${teamDoc}`)).status, 404)
  await assert.rejects(member.tool('r3', 'documents.read', { documentId: teamDoc }), /Document not found/)
  assert.deepEqual(await root.tool('d2', 'documents.delete', { documentId: rootDoc }), { documentId: rootDoc, deleted: true })
  assert.deepEqual(documentList.parse(await ctx.ok('GET', '/v1/documents')).documents.map(entry => entry.id), [own.documentId])
  const removals = (await ctx.events()).filter(event => event.type === 'document-removed').map(event => event.data.id)
  assert.deepEqual(removals, [teamDoc, rootDoc])
  root.end()
  member.end()
})
